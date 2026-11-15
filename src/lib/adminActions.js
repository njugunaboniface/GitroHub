const users = require('./users');
const github = require('./github');
const notificationMutes = require('./notificationMutes');
const logger = require('./logger');
const config = require('../config');
const roles = require('./roles');
const accounts = require('./accounts');
const { pool } = require('../db/postgres');

/** Admins are immune to Ban/Suspend/Delete through the Dashboard — not
 * just to protect against ever repeating the exact mistake of an admin
 * locking themselves out, but as a blanket rule: nobody, including a
 * fellow admin, should be able to knock an admin account out of the bot
 * from this UI. Checked here (the one choke point every ban/suspend/
 * delete path already runs through) rather than trusting every call site
 * to remember to check it themselves.
 *
 * Covers config.ADMIN_IDS (the env-seeded admins) AND anyone with an
 * admin_roles row at all (roles.hasRole) — a user a super_admin promoted
 * straight from their User Detail card is just as protected as one
 * listed in .env, at EVERY tier including Guest. This is deliberate, not
 * an oversight: Guest is "view-only, no actions" in terms of what THEY
 * can do, but it's still a role a super_admin explicitly granted, and
 * the safer default is that granting any Dashboard standing at all also
 * grants immunity from a peer's one-tap Ban, rather than only granting
 * it starting at Moderator. To ban/suspend/delete someone a super_admin
 * promoted, use 👑 Admins → 🗑️ Revoke Completely first — demoting them to
 * Guest is NOT enough on its own, since Guest still has a role row (see
 * lib/roles.js's revokeRole for the exact distinction between the two). */
async function isProtectedAdmin(telegramId) {
  return config.ADMIN_IDS.includes(Number(telegramId)) || (await roles.hasRole(Number(telegramId)));
}

/** 🏆 The owner's repositories, data and limits are off-limits to every OTHER
 * admin, whatever tier they hold (v1.1.24-multi). ban/suspend/delete already
 * refused protected admins; the repo-moderation actions (list, download,
 * delete, visibility, license), the data export and limit overrides did not,
 * so any moderator could open, download or delete the owner's repos. Enforced
 * here, at the action layer, so a stale or hand-crafted button can never get
 * around the friendlier guards in the dashboard handlers. The owner acting on
 * their own account is fine. */
function assertNotOwnerTarget(actorId, targetTelegramId) {
  if (roles.isOwner(targetTelegramId) && Number(actorId) !== Number(targetTelegramId)) {
    const err = new Error('The owner\u2019s repositories and data can\u2019t be accessed through the Dashboard.');
    err.code = 'OWNER_PROTECTED';
    throw err;
  }
}

/** 🛡 Repo Shield (v1.2.0-multi): repository moderation (list / download /
 * delete / visibility / license) is refused for accounts the owner has
 * protected. The owner is never blocked; blocked attempts are audit-logged. */
async function assertRepoModerationAllowed(actorId, targetTelegramId) {
  assertNotOwnerTarget(actorId, targetTelegramId);
  if (roles.isOwner(actorId)) return;
  const target = await users.getUser(targetTelegramId);
  if (target && target.repos_protected) {
    await auditLog(actorId, targetTelegramId, 'repo_access_blocked', 'blocked by Repo Shield').catch(() => {});
    const err = new Error('This user\u2019s repositories are protected by the owner and can\u2019t be viewed or changed from the Dashboard.');
    err.code = 'REPOS_PROTECTED';
    throw err;
  }
}

/** Records one line into admin_action_log — the audit trail of what the
 * admin themselves did, separate from activity_log (which is "what a
 * user did with their own account"). Never throws — an audit-log write
 * failing should never be the reason an admin action itself fails. */
async function auditLog(adminId, targetTelegramId, action, detail = null) {
  try {
    await pool.query(
      'INSERT INTO admin_action_log (admin_id, target_telegram_id, action, detail) VALUES ($1, $2, $3, $4)',
      [adminId, targetTelegramId, action, detail]
    );
  } catch (err) {
    logger.error('Admin audit log write failed', { message: err.message });
  }
}

// ─── ↩️ Undo ledger ──────────────────────────────────────────────────
// See schema.sql's admin_undo_log comment for why only these four action
// types are eligible, and why delete/purge never are.
const UNDOABLE_ACTIONS = new Set(['ban', 'suspend', 'bulk_suspend', 'bulk_mute']);

async function recordUndo(adminId, actionType, targetIds, previousState) {
  if (!UNDOABLE_ACTIONS.has(actionType)) return null;
  const { rows } = await pool.query(
    `INSERT INTO admin_undo_log (admin_id, action_type, target_ids, previous_state, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id`,
    [adminId, actionType, JSON.stringify(targetIds), JSON.stringify(previousState)]
  );
  return rows[0].id;
}

/** Looks up one undo entry without consuming it — used to show its
 * status (ok / already-undone / expired) before actually reverting. */
async function getUndoable(undoId) {
  const { rows } = await pool.query(
    `SELECT id, admin_id, action_type, target_ids, previous_state, created_at, expires_at, undone_at
     FROM admin_undo_log WHERE id = $1`,
    [undoId]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  if (row.undone_at) return { ...row, status: 'already-undone' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ...row, status: 'expired' };
  return { ...row, status: 'ok', targetIds: JSON.parse(row.target_ids), previousState: JSON.parse(row.previous_state) };
}

/** Reverts one undoable admin action. `performedBy` is the admin tapping
 * ↩️ Undo, which may be a different admin than the one who took the
 * original action — the Dashboard is shared moderation surface, not a
 * per-admin sandbox, so any admin can undo any other admin's still-live
 * undo entry. Both the original action and the undo itself get their own
 * audit_log rows, so "who did what" stays fully traceable either way. */
async function undoAction(performedBy, undoId, bot) {
  const entry = await getUndoable(undoId);
  if (!entry) return { ok: false, reason: 'not_found' };
  if (entry.status === 'already-undone') return { ok: false, reason: 'already-undone' };
  if (entry.status === 'expired') return { ok: false, reason: 'expired' };

  const { action_type: actionType, targetIds, previousState } = entry;
  if (actionType === 'ban') {
    const targetId = targetIds[0];
    await users.setBlocked(targetId, false);
    if (bot) {
      await bot.telegram.sendMessage(targetId, '✅ An admin reversed your ban — your access is restored. Send /start to pick back up (you\u2019ll need to reconnect GitHub, since the ban revoked it).').catch(() => {});
    }
  } else if (actionType === 'suspend') {
    const targetId = targetIds[0];
    await users.setSuspended(targetId, previousState.suspended_until || null);
    if (bot) {
      await bot.telegram.sendMessage(targetId, '✅ An admin lifted your suspension early — you\u2019re free to use the bot again.').catch(() => {});
    }
  } else if (actionType === 'bulk_suspend') {
    // previousState is { [telegramId]: suspended_until_before | null }
    for (const targetId of targetIds) {
      await users.setSuspended(targetId, previousState[targetId] || null);
    }
  } else if (actionType === 'bulk_mute') {
    // previousState is { [telegramId]: { [repoName]: wasMutedBefore } }
    // for every pair the bulk action touched — restore each back to
    // exactly that, not a blanket unmute.
    for (const targetId of targetIds) {
      const perRepo = previousState[targetId] || {};
      for (const [repoName, wasMuted] of Object.entries(perRepo)) {
        if (wasMuted) await notificationMutes.mute(targetId, repoName);
        else await notificationMutes.unmute(targetId, repoName);
      }
    }
  }

  await pool.query('UPDATE admin_undo_log SET undone_at = now() WHERE id = $1', [undoId]);
  await auditLog(performedBy, targetIds.length === 1 ? targetIds[0] : null, `undo_${actionType}`, `reverted undo #${undoId}`);
  return { ok: true, actionType, targetIds };
}

/** Tears down every live GitHub webhook for a user and wipes their token —
 * the exact same sequence settings.js's Disconnect uses, extracted here so
 * Ban (admin-initiated) and Disconnect (self-initiated) can't drift apart
 * into two different "what actually gets cleaned up" answers. Must run
 * BEFORE users.disconnect()/setBlocked() wipes the token — once it's gone
 * there's no way to call GitHub's API to remove anything. */
async function revokeGithubConnection(telegramId) {
  // Bans and deletions drop GitroHub's whole authorization on GitHub, not just
  // the token. Never blocks the moderation action itself: the shared teardown
  // swallows GitHub-side failures and always ends the local connection, even
  // when the stored token can't be decrypted.
  return require('./connectionTeardown').teardownGithubConnection(telegramId, { revokeGrant: true, all: true });
}

/** 🚫 Ban = is_blocked + revoke, exactly per the locked design decision.
 * Notifies the banned user once (so it isn't a silent mystery to them
 * the moment before the gate goes fully quiet) — everything after this
 * point is the same zero-reply silence as any other blocked sender. */
async function banUser(adminId, targetTelegramId, reason, bot, days = null) {
  if (await isProtectedAdmin(targetTelegramId)) throw new Error('admin_protected');
  await revokeGithubConnection(targetTelegramId);
  const until = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
  await users.setBlocked(targetTelegramId, true, reason, until);
  await auditLog(adminId, targetTelegramId, 'ban', `${reason || ''}${days ? ` (${days}d)` : ' (permanent)'}`.trim());
  // Note: undo restores the BAN FLAG only, not the revoked GitHub
  // connection/webhooks — a ban's token wipe is destructive by the same
  // rule delete/purge are excluded from the ledger entirely; unlike
  // those, though, a reversed ban still meaningfully un-blocks the
  // person immediately, they just need to reconnect GitHub, which the
  // undo notification below says explicitly.
  const undoId = await recordUndo(adminId, 'ban', [targetTelegramId], {});
  if (bot) {
    // v1.2.0-multi: a structured notice — exactly why, what it means, any earlier
    // warning, and how to appeal — instead of a one-line "revoked: <reason>".
    const warnings = require('./wardenBrain/warnings');
    const priorWarning = await require('./wardenBrain/cases').lastWarning(targetTelegramId).catch(() => null);
    await bot.telegram.sendMessage(
      targetTelegramId,
      warnings.enforcementNotice({
        action: 'ban', reason, priorWarning,
        durationText: days ? `${days} day${days === 1 ? '' : 's'}` : null,
        untilText: until ? `until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC` : null,
      })
    ).catch(() => {});
  }
  return { undoId };
}

async function unbanUser(adminId, targetTelegramId, bot) {
  await users.setBlocked(targetTelegramId, false);
  await auditLog(adminId, targetTelegramId, 'unban');
  if (bot) {
    await bot.telegram.sendMessage(
      targetTelegramId,
      `✅ Your access to this bot has been restored. Send /start to pick back up — you\u2019ll need to reconnect GitHub.`
    ).catch(() => {});
  }
}

async function suspendUser(adminId, targetTelegramId, hours, bot, reason = null) {
  if (await isProtectedAdmin(targetTelegramId)) throw new Error('admin_protected');
  const before = await users.getUser(targetTelegramId);
  const until = new Date(Date.now() + hours * 60 * 60 * 1000);
  await users.setSuspended(targetTelegramId, until, reason);
  await auditLog(adminId, targetTelegramId, 'suspend', `${hours}h${reason ? ` — ${reason}` : ''}`);
  const undoId = await recordUndo(adminId, 'suspend', [targetTelegramId], {
    suspended_until: before && before.suspended_until ? before.suspended_until : null,
  });
  if (bot) {
    const warnings = require('./wardenBrain/warnings');
    const priorWarning = await require('./wardenBrain/cases').lastWarning(targetTelegramId).catch(() => null);
    await bot.telegram.sendMessage(
      targetTelegramId,
      warnings.enforcementNotice({
        action: 'suspend', reason, priorWarning,
        durationText: `${hours} hour${hours === 1 ? '' : 's'}`,
        untilText: `until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      })
    ).catch(() => {});
  }
  return { undoId };
}

async function unsuspendUser(adminId, targetTelegramId) {
  await users.setSuspended(targetTelegramId, null);
  await auditLog(adminId, targetTelegramId, 'unsuspend');
}

async function setTrusted(adminId, targetTelegramId, trusted) {
  await users.setTrusted(targetTelegramId, trusted);
  await auditLog(adminId, targetTelegramId, trusted ? 'trust' : 'untrust');
}

async function setLimitOverrides(adminId, targetTelegramId, overrides) {
  assertNotOwnerTarget(adminId, targetTelegramId);
  await users.setLimitOverrides(targetTelegramId, overrides);
  await auditLog(adminId, targetTelegramId, 'limit_override', JSON.stringify(overrides));
}

/** 🗑️ Delete User — permanent. Tears down GitHub side first (same as
 * Ban), then wipes every owned row. */
async function deleteUser(adminId, targetTelegramId) {
  if (await isProtectedAdmin(targetTelegramId)) throw new Error('admin_protected');
  await revokeGithubConnection(targetTelegramId);
  await users.deleteUserAndData(targetTelegramId);
  await auditLog(adminId, targetTelegramId, 'delete_user');
}

/** 📢 Broadcast — fans one message out to every non-blocked user.
 * v1.3.0-multi: sends with the admin's own message `entities` (bold,
 * italic, links, etc. exactly as typed in Telegram) instead of a fixed
 * "📢 " prefix and no formatting — this can be a real announcement/ad,
 * and forcing an emoji + plain text onto every single one made it look
 * like spam no matter what the admin actually wrote. `entities` is
 * optional — a plain-text broadcast with no formatting still works,
 * `entities` is just omitted from the send. Failures (blocked the bot on
 * Telegram's side, deactivated account, etc.) are expected and silently
 * skipped per-recipient; one bad delivery must never stop the rest of
 * the fleet from getting the message. */
async function broadcast(adminId, bot, text, entities = null) {
  const { sendWithRetry } = require('./telegramRetry');
  const { rows } = await pool.query('SELECT telegram_id FROM users WHERE is_blocked = FALSE');
  const counts = { sent: 0, blocked: 0, failed: 0 };
  // Paced below Telegram's ~30 messages/second global limit; flood-control (429) responses are waited
  // out and retried a bounded number of times instead of silently losing the message.
  const GAP_MS = Number(process.env.BROADCAST_GAP_MS) || 40;
  for (const { telegram_id: telegramId } of rows) {
    const result = await sendWithRetry(() => bot.telegram.sendMessage(telegramId, text, entities && entities.length ? { entities } : undefined));
    counts[result]++;
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  // Honest accounting: "blocked" is expected (people who stopped the bot); "failed" is not.
  await auditLog(adminId, null, 'broadcast', `${counts.sent}/${rows.length} delivered (${counts.blocked} blocked the bot, ${counts.failed} failed)`);
  return { sent: counts.sent, total: rows.length, blocked: counts.blocked, failed: counts.failed };
}

/** 🧹 Bulk Purge — deletes every account that never connected GitHub AND
 * was created more than `days` ago. Deliberately narrow (never-connected
 * only) — someone who connected once and went quiet has a real GitHub
 * link and real activity history; that's a judgment call for a targeted
 * per-user Delete, not something a bulk sweep should ever guess at.
 * `days === null` means "Never" — no age filter at all, every
 * never-connected account regardless of when it was created. */
async function bulkPurgeNeverConnected(adminId, days) {
  const query = days === null
    ? `SELECT telegram_id FROM users WHERE connected_at IS NULL AND is_admin = FALSE`
    : `SELECT telegram_id FROM users WHERE connected_at IS NULL AND is_admin = FALSE AND created_at < now() - ($1 || ' days')::interval`;
  const { rows } = await pool.query(query, days === null ? [] : [days]);
  for (const { telegram_id: telegramId } of rows) {
    await users.deleteUserAndData(telegramId);
  }
  await auditLog(adminId, null, 'bulk_purge', `${rows.length} accounts, never-connected${days === null ? ' (all ages)' : ` >${days}d`}`);
  return rows.length;
}

/** ⏸️ Bulk Suspend — suspends every currently-active (not already banned)
 * account matching a filter, for a fixed duration. Scoped to 'stale' and
 * 'all' only — deliberately not exposed for 'connected'/'never_connected'
 * since those aren't meaningful groups to pause all at once the way
 * "everyone" or "everyone gone quiet" are. `is_admin = FALSE` in both
 * queries is what makes "EVERY non-banned user" not actually mean every
 * single one — admins are excluded on purpose, always. */
async function bulkSuspend(adminId, scope, hours, bot) {
  const where = scope === 'stale'
    ? `is_blocked = FALSE AND is_admin = FALSE AND (last_active_at IS NULL OR last_active_at < now() - interval '30 days')`
    : `is_blocked = FALSE AND is_admin = FALSE`;
  const until = new Date(Date.now() + hours * 60 * 60 * 1000);
  // v1.2.3-multi: ONE atomic statement. The old SELECT-then-UPDATE pair could suspend an
  // account that qualified between the two (with no undo entry), and it overwrote an
  // existing suspension even when that one ran LONGER than the new one. Now only accounts
  // whose current suspension is absent or shorter are touched, and each one's previous
  // value is captured by the same statement that changes it — anyone already
  // mid-suspension keeps their real prior value on undo.
  const { rows } = await pool.query(
    `WITH target AS (
       SELECT telegram_id, suspended_until AS previous FROM users
       WHERE ${where} AND (suspended_until IS NULL OR suspended_until < $1)
       FOR UPDATE
     )
     UPDATE users u SET suspended_until = $1 FROM target t
     WHERE u.telegram_id = t.telegram_id
     RETURNING u.telegram_id, t.previous AS suspended_until`,
    [until]
  );
  await auditLog(adminId, null, 'bulk_suspend', `${rows.length} accounts, scope=${scope}, ${hours}h`);
  const targetIds = rows.map((r) => r.telegram_id);
  const previousState = {};
  for (const r of rows) previousState[r.telegram_id] = r.suspended_until;
  const undoId = await recordUndo(adminId, 'bulk_suspend', targetIds, previousState);
  return { count: rows.length, undoId };
}

/** 🔇 Bulk Mute — fleet-wide maintenance mode: mutes every registered
 * webhook's notification delivery at once (reuses the same
 * notificationMutes table a self-serve per-repo mute would use, just
 * applied across every repo everyone has registered). Does NOT touch
 * anyone's GitHub connection or webhooks themselves — purely a "don't
 * deliver notifications right now" switch, reversible by re-running with
 * unmute = true. */
async function bulkMuteAll(adminId, mute = true) {
  const { rows } = await pool.query('SELECT DISTINCT telegram_id, repo_name FROM repo_webhooks');
  // Only meaningful going INTO mute — records the PRIOR muted/unmuted
  // state of every (user, repo) pair in the bulk set before anything
  // changes, so undo can put each one back exactly as it was instead of
  // just blanket-unmuting everything (which would also clear mutes that
  // had nothing to do with this bulk action).
  const previousState = {};
  if (mute) {
    for (const { telegram_id: telegramId, repo_name: repoName } of rows) {
      const wasMuted = await notificationMutes.isMuted(telegramId, repoName);
      previousState[telegramId] = previousState[telegramId] || {};
      previousState[telegramId][repoName] = wasMuted;
    }
  }
  for (const { telegram_id: telegramId, repo_name: repoName } of rows) {
    if (mute) await notificationMutes.mute(telegramId, repoName);
    else await notificationMutes.unmute(telegramId, repoName);
  }
  await auditLog(adminId, null, mute ? 'bulk_mute' : 'bulk_unmute', `${rows.length} repo(s) across all users`);
  const targetIds = [...new Set(rows.map((r) => r.telegram_id))];
  const undoId = mute ? await recordUndo(adminId, 'bulk_mute', targetIds, previousState) : null;
  return { count: rows.length, undoId };
}

/** 🗑️ Bulk Delete Banned — permanently removes every account that is
 * CURRENTLY banned. Narrow and safe by construction: it can only ever
 * touch accounts an admin already explicitly banned (via 🚫 Ban above),
 * never a live/active account, so there's no way for this to accidentally
 * sweep up someone who's simply been quiet. */
async function bulkDeleteBanned(adminId) {
  const { rows } = await pool.query('SELECT telegram_id FROM users WHERE is_blocked = TRUE AND is_admin = FALSE');
  for (const { telegram_id: telegramId } of rows) {
    await users.deleteUserAndData(telegramId); // GitHub side already revoked at ban time
  }
  await auditLog(adminId, null, 'bulk_delete_banned', `${rows.length} banned accounts removed`);
  return rows.length;
}

/** 📣 Nudge Never-Connected — a fixed, templated re-engagement message
 * (deliberately NOT free-text like 📢 Broadcast — this is a specific,
 * repeatable nudge, not a general announcement), sent only to accounts
 * that signed up but never finished connecting GitHub. */
async function nudgeNeverConnected(adminId, bot) {
  // v1.1.2 fix: this was the one bulk-ish action that never excluded
  // admins — Purge/Suspend/Delete Banned all already did. Same is_admin
  // filter as those, now reliable end-to-end (see lib/users.js's
  // ensureUser and lib/roles.js's setRole for why it wasn't always).
  const { rows } = await pool.query('SELECT telegram_id FROM users WHERE connected_at IS NULL AND is_blocked = FALSE AND is_admin = FALSE');
  const message = `👋 Still here? You started setting up GitroHub but never connected a GitHub account — tap ⚙️ Settings → 🔗 Connect GitHub to finish in under a minute.`;
  let sent = 0;
  for (const { telegram_id: telegramId } of rows) {
    try {
      await bot.telegram.sendMessage(telegramId, message);
      sent++;
    } catch (_) { /* expected for inactive/blocked-the-bot recipients */ }
  }
  await auditLog(adminId, null, 'nudge_never_connected', `${sent}/${rows.length} delivered`);
  return { sent, total: rows.length };
}

/** 💬 Direct Message — a single free-text message to exactly one user,
 * distinct from 📢 Broadcast (everyone) and 📣 Nudge (a fixed template to
 * a fixed segment). Prefixed so it's unmistakably from moderation, not a
 * random unlabelled DM — same reasoning as the ban/suspend notices above,
 * which are also always clearly attributed to the bot's admin side. */
/** 💬 Direct Message — a single message to exactly one user, distinct
 * from 📢 Broadcast (everyone) and 📣 Nudge (a fixed template to a fixed
 * segment). Prefixed so it's unmistakably from moderation, not a random
 * unlabelled DM — same reasoning the ban/suspend notices already use.
 * `payload` is one of `{ text }`, `{ photoFileId, caption }`, or
 * `{ documentFileId, caption }` — attachments let this actually carry
 * evidence (a screenshot of a ToS violation, a log file) instead of
 * being text-only. Legacy 'Markdown' parse_mode (not MarkdownV2) is used
 * deliberately for the text case — same reasoning 📢 Broadcast doesn't
 * force admin-typed text through MarkdownV2 escaping either, it would
 * mangle anything that looks like Markdown but wasn't meant as such. A
 * caption follows the same rule and additionally gets hard-truncated to
 * Telegram's 1024-char caption ceiling. */
async function messageUser(adminId, targetTelegramId, payload, bot) {
  const { text, photoFileId, documentFileId, caption } = payload;
  if (photoFileId || documentFileId) {
    const cap = `💬 Message from an admin:${caption ? `\n\n${caption.slice(0, 900)}` : ''}`;
    if (photoFileId) await bot.telegram.sendPhoto(targetTelegramId, photoFileId, { caption: cap });
    else await bot.telegram.sendDocument(targetTelegramId, documentFileId, { caption: cap });
    await auditLog(adminId, targetTelegramId, 'message', `[${photoFileId ? 'photo' : 'document'}] ${(caption || '').slice(0, 250)}`);
  } else {
    const prefixed = `💬 *Message from an admin:*\n\n${text}`;
    await bot.telegram.sendMessage(targetTelegramId, prefixed, { parse_mode: 'Markdown' });
    await auditLog(adminId, targetTelegramId, 'message', text.slice(0, 300));
  }
}

/** 📝 Admin Notes — see users.setAdminNotes for the storage half; this
 * layer just adds the audit trail, same as every other admin write. */
async function setNotes(adminId, targetTelegramId, notes) {
  const clean = await users.setAdminNotes(targetTelegramId, notes);
  await auditLog(adminId, targetTelegramId, clean ? 'notes_set' : 'notes_cleared');
  return clean;
}

/** 📂 Repo moderation — lists a target user's repos using THEIR OWN
 * token (there's no admin-wide GitHub credential; moderation only works
 * for accounts that are actually connected). Read-only. */
async function listUserRepos(targetTelegramId, actorId = null, { accountLogin = null } = {}) {
  await assertRepoModerationAllowed(actorId, targetTelegramId);
  // v1.2.5-multi: a person can have several GitHub accounts — the admin picks WHICH one to look at. With no
  // account given, it is the person's active account, exactly as before.
  const cred = await adminCredentials(targetTelegramId, accountLogin, { allowNone: true });
  if (!cred) return { connected: false, login: null, accountLogin: null, repos: [] };
  const repos = await github.listRepos(cred.token);
  return { connected: true, login: cred.login, accountLogin: cred.accountLogin, repos };
}

/**
 * The token and owner login an admin repo action runs with (v1.2.5-multi). With `accountLogin` it is THAT
 * connected account (never "whichever one is active now" — a list opened for one account can't end up acting
 * on another after the person switches); without it, the person's active account as before.
 * `allowNone` returns null instead of throwing when the person isn't connected.
 */
async function adminCredentials(targetTelegramId, accountLogin = null, { allowNone = false } = {}) {
  if (accountLogin) {
    let acc = await accounts.tokenFor(targetTelegramId, accountLogin);
    if (!acc) {
      // The active account always has a token on the users row, even if (very old data) its account row is missing.
      const active = await accounts.activeLoginOf(targetTelegramId).catch(() => null);
      if (active && String(active).toLowerCase() === String(accountLogin).toLowerCase()) {
        const token = await users.getDecryptedToken(targetTelegramId);
        if (token) acc = { login: active, token };
      }
    }
    if (!acc) {
      const err = new Error(`The GitHub account @${accountLogin} is no longer connected.`);
      err.code = 'ACCOUNT_GONE';
      throw err;
    }
    return { token: acc.token, login: acc.login, accountLogin: acc.login };
  }
  const token = await users.getDecryptedToken(targetTelegramId);
  if (!token) {
    if (allowNone) return null;
    throw new Error('target_not_connected');
  }
  const repoCache = require('./repoCache');
  const ghUser = await repoCache.getUser(targetTelegramId, token);
  const active = await accounts.activeLoginOf(targetTelegramId).catch(() => null);
  // The admin list is the account's OWN repos, so the owner is the account login — never an organisation the
  // person may have switched to in their own view (that mismatch made actions address "<org>/<repo>").
  const own = active || ghUser.personalLogin || ghUser.login;
  return { token, login: own, accountLogin: own };
}

/** 🔕 Silent by default — every repo-moderation action (delete, privacy
 * change, license change) notifies the affected user ONLY if an admin
 * has explicitly turned that on via ⚙️ Global Config's 🔔 Notify Users
 * toggle. Defaults off: a user finding out their repo was inspected only
 * because something visibly changed is a deliberate choice, not an
 * oversight — moderation work-in-progress (checking repos before
 * deciding what, if anything, to do) shouldn't itself alert anyone. The
 * admin's own audit trail (auditLog calls) is never gated by this — it's
 * for admins, not the affected user, and always records regardless. */
async function notifyUserIfEnabled(targetTelegramId, message, bot) {
  if (!bot) return;
  const globalConfig = require('./globalConfig');
  if (globalConfig.get('notify_users_on_repo_mod') !== '1') return;
  await bot.telegram.sendMessage(targetTelegramId, message).catch(() => {});
}

/** 🗑️ Admin-initiated repo delete — same GitHub call a user's own Delete
 * Repo uses, just invoked with the TARGET's token (again: moderation can
 * only act on what that person's own connection can reach) and logged to
 * admin_action_log instead of their personal activity as an admin act,
 * with a mirrored line in their own Activity Log too. github.deleteRepo()
 * is awaited BEFORE any of that — if GitHub rejects the delete (404, rate
 * limit, revoked token, anything), the throw happens here and none of
 * audit/activity/notify ever run, so the caller's catch block is always
 * showing a real failure, never a false "deleted" after GitHub actually
 * said no. */
async function deleteUserRepo(adminId, targetTelegramId, repoName, bot, { accountLogin = null } = {}) {
  await assertRepoModerationAllowed(adminId, targetTelegramId);
  const { token, login: ownerLogin } = await adminCredentials(targetTelegramId, accountLogin);
  const repoCache = require('./repoCache');
  const ghUser = { login: ownerLogin };
  await github.deleteRepo(token, ghUser.login, repoName);
  repoCache.invalidateRepos(targetTelegramId);
  await auditLog(adminId, targetTelegramId, 'delete_repo', `${ghUser.login}/${repoName}`);
  const activity = require('./activity');
  await activity.log(targetTelegramId, '🛡️', `Repo removed by an admin → ${repoName}`, {});
  await notifyUserIfEnabled(targetTelegramId, `🛡️ An admin removed your repository "${repoName}" from GitHub via GitroHub moderation.`, bot);
}

/** ⬇️ Admin-initiated ZIP download — straight passthrough to the same
 * downloadZip() a user's own repo view uses, on the target's token.
 * `defaultBranch` must be passed by the caller (from the repo object
 * already in hand from listUserRepos/the cached repo list) rather than
 * left null — a v1.1.2 audit found this used to pass `null` as the ref,
 * unlike every OTHER downloadZip() call site in the codebase (repoView,
 * search, bulkActions, automation, index.js), all of which always pass
 * an explicit branch; Octokit templates the ref straight into the
 * request URL, so `null` was very likely producing a broken request
 * rather than sensibly defaulting. No notify: this is read-only and the
 * least invasive of the four repo actions, so it's never worth alerting
 * over even when the toggle is on — see setUserRepoVisibility/
 * setUserRepoLicense for the two that do. */
async function downloadUserRepoZip(adminId, targetTelegramId, repoName, defaultBranch, { accountLogin = null } = {}) {
  await assertRepoModerationAllowed(adminId, targetTelegramId);
  const { token, login: ownerLogin } = await adminCredentials(targetTelegramId, accountLogin);
  const ghUser = { login: ownerLogin };
  const buffer = await github.downloadZip(token, ghUser.login, repoName, defaultBranch);
  await auditLog(adminId, targetTelegramId, 'download_repo', `${ghUser.login}/${repoName}`);
  return { buffer, login: ghUser.login };
}

/** 🔒/🌐 Admin-initiated visibility change — github.setVisibility() is
 * awaited first, same ordering discipline as deleteUserRepo: a rejected
 * API call throws before audit/notify ever run. */
async function setUserRepoVisibility(adminId, targetTelegramId, repoName, isPrivate, bot, { accountLogin = null } = {}) {
  await assertRepoModerationAllowed(adminId, targetTelegramId);
  const { token, login: ownerLogin } = await adminCredentials(targetTelegramId, accountLogin);
  const repoCache = require('./repoCache');
  const ghUser = { login: ownerLogin };
  await github.setVisibility(token, ghUser.login, repoName, isPrivate);
  repoCache.invalidateRepos(targetTelegramId);
  await auditLog(adminId, targetTelegramId, 'repo_visibility', `${ghUser.login}/${repoName} → ${isPrivate ? 'private' : 'public'}`);
  await notifyUserIfEnabled(targetTelegramId, `🛡️ An admin changed "${repoName}" to ${isPrivate ? 'private' : 'public'}.`, bot);
  return ghUser.login;
}

/** ⚖️ Admin-initiated license change — GitHub has no "set license" field
 * (see github.getLicenseText's own comment); this writes/replaces a
 * LICENSE file, same mechanism github.com's own "Add license" button
 * uses. Checks for an existing LICENSE file first so an update replaces
 * it (correct sha) rather than erroring on a create-conflict; a 404
 * (no LICENSE yet) is expected and swallowed, any OTHER failure from
 * that check is re-thrown rather than silently treated as "no license
 * file" — misreading a real error as "safe to create" is exactly the
 * kind of false-positive this whole function is built to avoid. */
async function setUserRepoLicense(adminId, targetTelegramId, repoName, licenseKey, licenseLabel, bot, { accountLogin = null } = {}) {
  await assertRepoModerationAllowed(adminId, targetTelegramId);
  const { token, login: ownerLogin } = await adminCredentials(targetTelegramId, accountLogin);
  const repoCache = require('./repoCache');
  const ghUser = { login: ownerLogin };
  const licenseText = await github.getLicenseText(token, licenseKey);
  let existingSha = null;
  try {
    const existing = await github.getFileContent(token, ghUser.login, repoName, 'LICENSE');
    existingSha = existing.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  await github.putFile(token, ghUser.login, repoName, 'LICENSE', licenseText, `Add ${licenseLabel} license (via admin moderation)`, existingSha);
  repoCache.invalidateRepos(targetTelegramId);
  await auditLog(adminId, targetTelegramId, 'repo_license', `${ghUser.login}/${repoName} → ${licenseKey}`);
  await notifyUserIfEnabled(targetTelegramId, `🛡️ An admin added/changed the license on "${repoName}" \u2192 ${licenseLabel}.`, bot);
  return ghUser.login;
}

/** 📤 Bulk Export All — fleet-wide metadata dump, one row per user.
 * Deliberately a summary (not each person's full activity history dumped
 * together, which would balloon fast and drift toward the exact kind of
 * cross-user content the Admin Dashboard's privacy line rules out
 * elsewhere) — counts and metadata only, same boundary as everywhere
 * else in the Dashboard. */
async function exportAllUsers(adminId) {
  const { rows } = await pool.query(
    `SELECT telegram_id, telegram_username, telegram_first_name, github_username,
            is_admin, is_blocked, is_trusted, total_actions, rate_limit_hits,
            connected_at, created_at, last_active_at
     FROM users ORDER BY created_at ASC`
  );
  await auditLog(adminId, null, 'export_all');
  return {
    content: JSON.stringify({ exportedAt: new Date().toISOString(), userCount: rows.length, users: rows }, null, 2),
    filename: `gitrohub-fleet-export-${new Date().toISOString().slice(0, 10)}.json`,
  };
}

/** Best-effort per-user data export for the Admin Dashboard — reuses the
 * exact same export shape a user would get themselves (📦 Storage & Data
 * → Export), so there's exactly one export format in the whole bot. */
async function exportUserData(adminId, targetTelegramId) {
  assertNotOwnerTarget(adminId, targetTelegramId);
  const dataStore = require('./dataStore');
  const content = await dataStore.exportData(targetTelegramId, 'json');
  await auditLog(adminId, targetTelegramId, 'export');
  return { content, filename: `gitrohub-user-${targetTelegramId}-export.json` };
}

module.exports = {
  assertNotOwnerTarget, assertRepoModerationAllowed,
  isProtectedAdmin,
  banUser,
  unbanUser,
  suspendUser,
  unsuspendUser,
  setTrusted,
  setLimitOverrides,
  deleteUser,
  broadcast,
  bulkPurgeNeverConnected,
  bulkSuspend,
  bulkMuteAll,
  bulkDeleteBanned,
  nudgeNeverConnected,
  exportAllUsers,
  exportUserData,
  auditLog,
  messageUser,
  setNotes,
  listUserRepos,
  adminCredentials,
  deleteUserRepo,
  downloadUserRepoZip,
  setUserRepoVisibility,
  setUserRepoLicense,
  getUndoable,
  undoAction,
};
