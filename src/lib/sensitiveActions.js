/**
 * 🛡️ Warden Watch (v1.2.5-multi) — tiered monitoring of what people do with the powerful buttons.
 *
 *   note()   scores a sensitive action (transfer, rollback, forced revert, access changes, deletes…), stores it, and
 *            flags it when the score is high or a burst of them arrives. Optionally tells the admins.
 *   gate()   optional owner confirmation: with "hold risky actions" ON, an ordinary person's riskiest actions wait
 *            for the owner's one-time OK instead of running at once. Off by default. Admins are never held.
 *   audit()  one line per ⚡ Manage / 💼 Workspace tap — who, under which GitHub account, which area and action.
 *   pause    an admin can pause one feature area for one person without touching anyone else.
 *
 * Tokens, secrets and file contents are never stored here or shown to anyone — only names and ids.
 * Everything is best-effort: monitoring can never be the reason a person's action fails.
 */
const { pool } = require('../db/postgres');
const { BoundedMap } = require('./boundedMap');
const globalConfig = require('./globalConfig');
const logger = require('./logger');

/** Base risk per action (0–100). Unknown actions score 5. */
const WEIGHTS = Object.freeze({
  transfer: 40, repo_delete: 35, branch_rollback: 30, bulk_delete: 30, revert_forced: 25, deploy_key_add: 25,
  visibility_change: 20, collab_remove: 20, collab_add: 15, secret_change: 15, account_added: 10, account_removed: 10, revert: 8,
});
const LABELS = Object.freeze({
  transfer: 'Transferred a repo', repo_delete: 'Deleted a repo', branch_rollback: 'Rolled a branch back', bulk_delete: 'Bulk delete',
  revert_forced: 'Forced revert (overwrote later edits)', deploy_key_add: 'Added a deploy key', visibility_change: 'Changed repo visibility',
  collab_remove: 'Removed a collaborator', collab_add: 'Invited a collaborator', secret_change: 'Changed a secret',
  account_added: 'Added a GitHub account', account_removed: 'Removed a GitHub account', revert: 'Reverted a change',
});
/** Actions that can be held for the owner's OK when "hold risky actions" is on. */
const HOLDABLE = new Set(['transfer', 'branch_rollback', 'revert_forced']);

const FLAG_SCORE = 40;
const BURST_WINDOW_MIN = 10;
const DEFAULT_BURST = 5;

const burstLimit = () => {
  const n = Number(globalConfig.get('sens_burst'));
  return Number.isInteger(n) && n >= 2 && n <= 50 ? n : DEFAULT_BURST;
};
const isOn = (key, def = false) => { const v = globalConfig.get(key); return v == null ? def : v === 'on'; };

/**
 * The score for one action given what the person did lately. Pure — easy to test.
 * @param {{action:string, recent:number, newAccount?:boolean}} p `recent` = their sensitive actions in the last 10 min (before this one)
 */
function score({ action, recent = 0, newAccount = false }) {
  const base = WEIGHTS[action] != null ? WEIGHTS[action] : 5;
  const burst = Math.min(40, Math.max(0, recent - 1) * 10);
  return Math.min(100, base + burst + (newAccount ? 15 : 0));
}
const shouldFlag = ({ total, recent }) => total >= FLAG_SCORE || recent + 1 >= burstLimit();

async function adminRecipients(exceptId) {
  const config = require('../config');
  const ids = new Set([config.OWNER_ID, ...(config.ADMIN_IDS || [])]);
  try {
    const { rows } = await pool.query(`SELECT telegram_id FROM admin_roles WHERE role IN ('admin', 'super_admin')`);
    for (const r of rows) ids.add(Number(r.telegram_id));
  } catch (_) { /* roles table unavailable → config ids only */ }
  ids.delete(Number(exceptId));
  return [...ids].filter(Number.isFinite);
}

async function tellAdmins(telegram, actorId, text, buttons) {
  if (!telegram) return 0;
  let sent = 0;
  for (const id of await adminRecipients(actorId)) {
    try { await telegram.sendMessage(id, text, buttons ? { reply_markup: { inline_keyboard: buttons } } : undefined); sent++; } catch (_) { /* blocked the bot */ }
  }
  return sent;
}

/** Records and scores one sensitive action. Never throws. Resolves to { score, flagged } or null. */
async function note(ctx, { action, repo = null, owner = null, detail = '' }) {
  try {
    const id = ctx && ctx.from && ctx.from.id;
    if (!id) return null;
    const accounts = require('./accounts');
    const [account, recentRes, userRes] = await Promise.all([
      accounts.activeLoginOf(id).catch(() => null),
      pool.query(`SELECT COUNT(*)::int AS c FROM sensitive_actions WHERE telegram_id = $1 AND created_at > now() - ($2 || ' minutes')::interval`, [id, String(BURST_WINDOW_MIN)]),
      pool.query('SELECT connected_at FROM users WHERE telegram_id = $1', [id]),
    ]);
    const recent = (recentRes.rows[0] && recentRes.rows[0].c) || 0;
    const connectedAt = userRes.rows[0] && userRes.rows[0].connected_at;
    const newAccount = !!connectedAt && Date.now() - new Date(connectedAt).getTime() < 24 * 3600 * 1000;
    const total = score({ action, recent, newAccount });
    const flagged = shouldFlag({ total, recent });
    await pool.query(
      `INSERT INTO sensitive_actions (telegram_id, account_login, owner_login, action, repo_name, detail, score, flagged)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, account ? String(account).toLowerCase() : null, owner ? String(owner).toLowerCase() : null, action, repo, String(detail || '').slice(0, 200), total, flagged]
    );
    if (flagged && isOn('sens_notify_admins')) {
      let first = true;
      try {
        const redis = require('../db/redis').client;
        first = !(await redis.exists(`sens-notified:${id}`));
        if (first) await redis.set(`sens-notified:${id}`, '1', { EX: 600 });
      } catch (_) { /* no redis → notify anyway, once per action */ }
      if (first) {
        const who = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || `#${id}`);
        await tellAdmins(ctx.telegram, id,
          `🛡️ Warden Watch — flagged\n${who}${account ? ` (GitHub ${account})` : ''}\n${LABELS[action] || action}${repo ? ` · ${repo}` : ''}\nRisk ${total}/100${recent + 1 >= burstLimit() ? ` · ${recent + 1} sensitive actions in ${BURST_WINDOW_MIN} min` : ''}`,
          [[{ text: '👤 Open user', callback_data: `admin:user:${id}` }]]);
      }
    }
    return { score: total, flagged };
  } catch (err) {
    logger.debug('sensitive action note failed', { error: err && err.message });
    return null;
  }
}

/**
 * Optional owner confirmation. → { ok: true } to proceed, or { ok: false, message } to show the person.
 * Only ordinary people are held (never admins or the owner), only when switched on, only for HOLDABLE actions.
 */
async function gate(ctx, { action, repo = null }) {
  try {
    if (!isOn('sens_hold') || !HOLDABLE.has(action)) return { ok: true };
    const id = ctx.from.id;
    if (ctx.state && ctx.state.isAdmin) return { ok: true };
    const redis = require('../db/redis').client;
    const key = `sens-ok:${id}:${action}:${repo || ''}`;
    if (await redis.get(key)) { await redis.del(key); return { ok: true }; }
    const { rows: pending } = await pool.query(
      `SELECT id FROM sensitive_approvals WHERE telegram_id = $1 AND action = $2 AND COALESCE(repo_name, '') = $3 AND status = 'pending' AND created_at > now() - interval '1 day'`,
      [id, action, repo || '']
    );
    let reqId = pending[0] && pending[0].id;
    if (!reqId) {
      const ins = await pool.query(`INSERT INTO sensitive_approvals (telegram_id, action, repo_name) VALUES ($1, $2, $3) RETURNING id`, [id, action, repo]);
      reqId = ins.rows[0].id;
      const who = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || `#${id}`);
      const owner = require('../config').OWNER_ID;
      await ctx.telegram.sendMessage(owner, `🛡️ Warden Watch — approval needed\n${who} wants to: ${LABELS[action] || action}${repo ? ` · ${repo}` : ''}`, {
        reply_markup: { inline_keyboard: [[{ text: '✅ Allow once', callback_data: `admin:mon:appr:${reqId}:ok` }, { text: '🚫 Deny', callback_data: `admin:mon:appr:${reqId}:no` }]] },
      }).catch(() => {});
    }
    return { ok: false, message: '⏳ For safety this action needs the owner’s OK first. I’ve asked — you’ll get a message here as soon as it’s decided, then tap the button again.' };
  } catch (err) {
    logger.debug('sensitive gate failed open', { error: err && err.message });
    return { ok: true }; // monitoring never blocks people by accident
  }
}

/** Owner's decision on a held action. → { ok, userId } */
async function decide(ownerCtx, requestId, allow) {
  const { rows } = await pool.query(
    `UPDATE sensitive_approvals SET status = $2, decided_by = $3, decided_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING telegram_id, action, repo_name`,
    [requestId, allow ? 'approved' : 'denied', ownerCtx.from.id]
  );
  if (!rows[0]) return { ok: false };
  const r = rows[0];
  if (allow) {
    try { await require('../db/redis').client.set(`sens-ok:${r.telegram_id}:${r.action}:${r.repo_name || ''}`, '1', { EX: 15 * 60 }); } catch (_) { /* below */ }
  }
  await ownerCtx.telegram.sendMessage(Number(r.telegram_id), allow ? `✅ Approved: ${LABELS[r.action] || r.action}${r.repo_name ? ` · ${r.repo_name}` : ''}. Tap the button again within 15 minutes.` : `🚫 The owner declined: ${LABELS[r.action] || r.action}${r.repo_name ? ` · ${r.repo_name}` : ''}.`).catch(() => {});
  return { ok: true, userId: Number(r.telegram_id) };
}

// ── Manage audit ─────────────────────────────────────────────────────────────

const CHANGE_RE = /(ok|do|done|save|create|merge|close|reopen|del|delete|send|add|remove|rm|set|toggle|tog|rv|pok|fok|recok|jrec|rbok|unrollok|gbok)$/;

/** One line per Manage tap. Fire-and-forget. */
async function audit(telegramId, area, action, repo) {
  try {
    if (action === 'home' || !telegramId) return;
    const account = await require('./accounts').activeLoginOf(telegramId).catch(() => null);
    await pool.query(
      `INSERT INTO manage_audit (telegram_id, account_login, area, action, repo_name, is_change) VALUES ($1, $2, $3, $4, $5, $6)`,
      [telegramId, account ? String(account).toLowerCase() : null, String(area).slice(0, 30), String(action).slice(0, 30), repo ? String(repo).slice(0, 100) : null, CHANGE_RE.test(String(action))]
    );
  } catch (_) { /* best-effort */ }
}

// ── Per-person feature pauses ────────────────────────────────────────────────

const pauseCache = new BoundedMap({ max: 5000, name: 'featurePauses' }); // `${id}` -> { set:Set, at }
const PAUSE_TTL_MS = 15 * 1000;

async function pausedFor(telegramId) {
  const hit = pauseCache.get(String(telegramId));
  if (hit && Date.now() - hit.at < PAUSE_TTL_MS) return hit.set;
  let set = new Set();
  try {
    const { rows } = await pool.query(`SELECT feature_key FROM user_feature_pauses WHERE telegram_id = $1 AND (expires_at IS NULL OR expires_at > now())`, [telegramId]);
    set = new Set(rows.map((r) => r.feature_key));
  } catch (_) { /* fail open */ }
  pauseCache.set(String(telegramId), { set, at: Date.now() });
  return set;
}
const isPaused = async (telegramId, key) => (await pausedFor(telegramId)).has(key);

async function pause(adminId, telegramId, key, reason = null, hours = null) {
  await pool.query(
    `INSERT INTO user_feature_pauses (telegram_id, feature_key, paused_by, reason, expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int || ' hours')::interval END)
     ON CONFLICT (telegram_id, feature_key) DO UPDATE SET paused_by = $3, reason = $4, created_at = now(), expires_at = CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int || ' hours')::interval END`,
    [telegramId, key, adminId, reason, hours]
  );
  pauseCache.delete(String(telegramId));
  await require('./adminActions').auditLog(adminId, telegramId, 'feature_pause', `${key}${hours ? ` for ${hours}h` : ''}`);
}

async function unpause(adminId, telegramId, key) {
  await pool.query('DELETE FROM user_feature_pauses WHERE telegram_id = $1 AND feature_key = $2', [telegramId, key]);
  pauseCache.delete(String(telegramId));
  await require('./adminActions').auditLog(adminId, telegramId, 'feature_unpause', key);
}

async function listPauses(telegramId) {
  const { rows } = await pool.query(`SELECT feature_key, paused_by, created_at, expires_at FROM user_feature_pauses WHERE telegram_id = $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC`, [telegramId]);
  return rows;
}

// ── Read side (tiers decide who may call what — see handlers/monitoring.js) ─────

/** Counts only — safe for the lowest tier. */
async function counts() {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM sensitive_actions WHERE created_at > now() - interval '24 hours')::int AS actions_24h,
            (SELECT COUNT(*) FROM sensitive_actions WHERE flagged AND reviewed_at IS NULL)::int AS flagged_open,
            (SELECT COUNT(*) FROM sensitive_approvals WHERE status = 'pending')::int AS approvals_pending,
            (SELECT COUNT(*) FROM user_feature_pauses WHERE expires_at IS NULL OR expires_at > now())::int AS pauses,
            (SELECT COUNT(*) FROM manage_audit WHERE created_at > now() - interval '24 hours')::int AS manage_24h,
            (SELECT COUNT(*) FROM github_accounts WHERE health_status = 'revoked')::int AS dead_accounts`
  );
  return rows[0];
}

async function listFlagged({ limit = 6, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT s.id, s.telegram_id, s.account_login, s.action, s.repo_name, s.score, s.created_at, s.reviewed_at, u.telegram_username, u.telegram_first_name
       FROM sensitive_actions s LEFT JOIN users u ON u.telegram_id = s.telegram_id
      WHERE s.flagged AND s.reviewed_at IS NULL ORDER BY s.created_at DESC LIMIT $1 OFFSET $2`, [limit + 1, offset]);
  return { items: rows.slice(0, limit), hasNext: rows.length > limit };
}

async function markReviewed(adminId, id) {
  await pool.query('UPDATE sensitive_actions SET reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND reviewed_at IS NULL', [id, adminId]);
}

/** One person's recent sensitive actions and Manage taps across ALL their accounts. */
async function userActivity(telegramId, { limit = 10 } = {}) {
  const [sens, taps, accts] = await Promise.all([
    pool.query('SELECT action, repo_name, account_login, score, flagged, created_at FROM sensitive_actions WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT $2', [telegramId, limit]),
    pool.query('SELECT area, action, repo_name, account_login, is_change, created_at FROM manage_audit WHERE telegram_id = $1 AND is_change ORDER BY created_at DESC LIMIT $2', [telegramId, limit]),
    pool.query('SELECT github_login, health_status FROM github_accounts WHERE telegram_id = $1 ORDER BY id', [telegramId]),
  ]);
  return { sensitive: sens.rows, changes: taps.rows, accounts: accts.rows };
}

/** Owner/super-admin audit trail of Manage actions, newest first; `onlyChanges` hides browsing taps. */
async function auditTrail({ onlyChanges = true, limit = 8, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.telegram_id, a.account_login, a.area, a.action, a.repo_name, a.is_change, a.created_at, u.telegram_username, u.telegram_first_name
       FROM manage_audit a LEFT JOIN users u ON u.telegram_id = a.telegram_id
      WHERE ($1::boolean = FALSE OR a.is_change) ORDER BY a.created_at DESC, a.id DESC LIMIT $2 OFFSET $3`, [onlyChanges, limit + 1, offset]);
  return { items: rows.slice(0, limit), hasNext: rows.length > limit };
}

/** A person's own view of their sensitive actions (transparency — "My safety log"). */
async function mine(telegramId, limit = 10) {
  const { rows } = await pool.query('SELECT action, repo_name, account_login, created_at FROM sensitive_actions WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT $2', [telegramId, limit]);
  return rows;
}

/** Keeps the monitoring tables small. Called from the retention job. */
async function prune() {
  await pool.query(`DELETE FROM manage_audit WHERE created_at < now() - interval '30 days'`);
  await pool.query(`DELETE FROM sensitive_actions WHERE created_at < now() - interval '180 days'`);
  await pool.query(`DELETE FROM sensitive_approvals WHERE created_at < now() - interval '30 days'`);
  await pool.query(`DELETE FROM user_feature_pauses WHERE expires_at IS NOT NULL AND expires_at < now()`);
}

module.exports = {
  WEIGHTS, LABELS, HOLDABLE, FLAG_SCORE, score, shouldFlag, note, gate, decide, audit, isPaused, pause, unpause, listPauses,
  counts, listFlagged, markReviewed, userActivity, auditTrail, mine, prune, adminRecipients, tellAdmins, isOn,
};
