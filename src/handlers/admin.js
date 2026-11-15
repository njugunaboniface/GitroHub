const users = require('../lib/users');
const config = require('../config');
const adminActions = require('../lib/adminActions');
const adminStats = require('../lib/adminStats');
const format = require('../lib/format');
const bbtb = require('../keyboards/bbtb');
const inline = require('../keyboards/inline');
const { safeEditMessageText } = require('../lib/safeEdit');
const actionLock = require('../lib/actionLock');
const logger = require('../lib/logger');
const chatAction = require('../lib/chatAction');

const USERS_PER_PAGE = 6;
const ERRORS_PER_PAGE = 8;

/**
 * 🛡️ Admin Dashboard — a genuinely separate side of the bot, reachable
 * only by config.ADMIN_ID (see middleware/accessControl.js for where
 * is_admin gets set — nowhere else). Every screen here deals in counts
 * and metadata ONLY: no repo contents, no file paths, no commit messages,
 * per the privacy line drawn when this was designed. Every handler below
 * re-checks isAdmin itself rather than trusting that the button was
 * hidden from non-admins — a BBTB label is just text; someone could
 * always type it by hand.
 */
async function requireAdmin(ctx) {
  if (ctx.state && ctx.state.isAdmin) {
    // v1.1.8 — 🔒 Lockdown Mode gate. Sits right at this single choke
    // point every admin screen already passes through, so nothing else
    // needs its own check. The Owner is exempt inside isLocked() itself
    // — can never lock themselves out, even by accident.
    const lockdown = require('../lib/lockdown');
    if (await lockdown.isLocked(ctx.from.id)) {
      // Deliberately vague — no explanation of why, no mention of
      // Warden or the word "lockdown". In a real compromise scenario,
      // telling a possibly-hostile session anything more is intel you
      // don't want to hand over.
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('🔒 Dashboard access is currently restricted.', { show_alert: true }).catch(() => {});
      } else {
        await ctx.reply('🔒 Dashboard access is currently restricted.').catch(() => {});
      }
      // Tripwire — an attempted access WHILE locked out is itself a
      // strong compromise signal, not just routine denied access. The
      // Owner gets an immediate alert, not a buried log line.
      const config = require('../config');
      if (config.OWNER_ID && config.OWNER_ID !== ctx.from.id) {
        const who = ctx.from.username ? `@${ctx.from.username}` : `#${ctx.from.id}`;
        ctx.telegram.sendMessage(
          config.OWNER_ID,
          `🚨 Locked-out admin ${who} just attempted to open the Dashboard while their access was restricted.`
        ).catch(() => {});
      }
      return false;
    }
    // v1.3.3-multi — single choke point every admin screen/action passes
    // through before rendering, so it's also the single place to mark
    // "currently on the admin side". bot.js reads this to keep ❌ Cancel /
    // /cancel from bouncing an admin out to the regular main menu mid-flow
    // — see sendCancelledMenu(). Cleared only by '⬆️ Menu' and /start.
    if (ctx.session) ctx.session.adminZone = true;
    return true;
  }
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  return false;
}

/** Second, stricter gate for fleet-wide/destructive-at-scale actions —
 * see config.js's SUPER_ADMIN_IDS comment for exactly which screens use
 * this instead of the plain requireAdmin above. Always call requireAdmin
 * (or rely on it having already passed) first; this only narrows further,
 * it never substitutes for the base admin check. */
/** 👑 Role gate — supersedes the old binary requireAdmin/requireSuperAdmin
 * split now that there are four tiers. requireAdmin still means "is on
 * the ADMIN_IDS allowlist at all" (the guest floor — always true for
 * anyone requireRole would check further, so this ALWAYS calls it
 * first). requireSuperAdmin below is kept as a thin alias so the many
 * existing `requireSuperAdmin(ctx)` call sites (Broadcast, Bulk hub,
 * Global Config, Maintenance) didn't all need renaming — it's exactly
 * `requireRole(ctx, 'super_admin')`. */
async function requireRole(ctx, minRole) {
  if (!(await requireAdmin(ctx))) return false;
  const roles = require('../lib/roles');
  const role = await roles.getRole(ctx.from.id);
  if (roles.atLeast(role, minRole)) return true;
  const msg = `🔒 This needs ${minRole.replace('_', ' ')} access or higher — you're currently ${role.replace('_', ' ')}.`;
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(msg, { show_alert: true }).catch(() => {});
  } else {
    await ctx.reply(msg);
  }
  return false;
}

async function requireSuperAdmin(ctx) {
  return requireRole(ctx, 'super_admin');
}

/** v1.1.8 — strict Owner-only gate, for Lockdown Mode and (later) Warden:
 * both are deliberately NOT super_admin-accessible at all, unlike every
 * other Dashboard screen's two-tier admin/super_admin split. */
async function requireOwner(ctx) {
  if (!(await requireAdmin(ctx))) return false;
  const roles = require('../lib/roles');
  if (roles.isOwner(ctx.from.id)) return true;
  const msg = '🔒 This is Owner-only.';
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(msg, { show_alert: true }).catch(() => {});
  } else {
    await ctx.reply(msg);
  }
  return false;
}

/**
 * Result of an admin action: the text (which also puts the normal bottom menu back after a typing step) followed by
 * a small "next" message with inline buttons, so the person never has to scroll up to carry on.
 */
async function adminDone(ctx, text) {
  await ctx.reply(text);
  await ctx.reply('➡️ Next', inline.adminNextRow());
}

function userLabel(u) {
  const name = u.telegram_username ? `@${u.telegram_username}` : (u.telegram_first_name || `#${u.telegram_id}`);
  return format.escapeMd(name);
}

// ─── Dashboard ──────────────────────────────────────────────────────
async function showDashboard(ctx) {
  return require('./adminHub').showDashboard(ctx);
}

// ─── v1.1.8 hub landing screens ─────────────────────────────────────
async function showPeopleHub(ctx, { skipBbtb = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const reports = require('../lib/reports');
  const openReportCount = await reports.openCount();
  const text = `👥 *People*\n\nEverything about individual accounts — the full user list, open reports, and who else has admin access\\.`;
  await require('./manage/ui').show(ctx, text, { parse_mode: 'MarkdownV2', ...inline.adminPeopleHubMenu(openReportCount) });
}

async function showOversightHub(ctx, { skipBbtb = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const text = `📊 *Oversight*\n\nLook\\-don't\\-act screens: fleet\\-wide numbers, and the full history of what every admin has done\\.`;
  void text;
  return require('./adminHub').showWatch(ctx);
}

async function showOpsHub(ctx, { skipBbtb = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const text = `🛠️ *Ops*\n\nFleet\\-wide levers — none of these are about one specific person\\.`;
  void text;
  return require('./adminHub').showSystem(ctx);
}

/** 📢 Broadcast's own small hub — it never had a persistent screen of
 * its own before (askBroadcast just fired a compose flow directly);
 * now that it lives under 🛠️ Ops it gets one, same shape as 🗂️ Bulk's. */
async function showBroadcastHub(ctx, { skipBbtb = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const text = `📢 *Broadcast*\n\nSend a message to every non\\-banned user, or review/cancel/repost what's already gone out\\.`;
  await require('./manage/ui').show(ctx, text, { parse_mode: 'MarkdownV2', ...inline.adminBroadcastHubMenu() });
}

// ─── Users list ─────────────────────────────────────────────────────
async function showUsers(ctx, { filter = 'all', page = 1, edit = false, skipBbtb = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const offset = (page - 1) * USERS_PER_PAGE;
  const { rows, total } = await users.listUsers({ filter, limit: USERS_PER_PAGE, offset });
  const totalPages = Math.max(1, Math.ceil(total / USERS_PER_PAGE));

  const filterLabel = { all: 'All', blocked: 'Banned', suspended: 'Suspended', connected: 'Connected', never_connected: 'Never Connected', suspicious: 'Suspicious' }[filter];
  let text = `👥 *Users — ${filterLabel}* \\(${total}\\)\n\n`;
  if (rows.length === 0) {
    text += 'No users match this filter\\.';
  } else {
    text += rows.map((u) => {
      const suspicious = users.isSuspicious(u);
      const badges = [
        u.is_blocked ? '🚫' : null,
        u.suspended_until && new Date(u.suspended_until) > new Date() ? '⏸️' : null,
        suspicious ? '🚩' : null,
        u.is_trusted ? '⭐' : null,
        u.github_token_enc ? '🔗' : null,
      ].filter(Boolean).join(' ');
      const lastSeen = u.last_active_at ? format.escapeMd(format.relativeTime(u.last_active_at)) : 'never active';
      return `${userLabel(u)} ${badges} — _${lastSeen}_`;
    }).join('\n');
  }
  text += `\n\nTap a name below, or use 🔍 Search / \\#️⃣ Jump to look someone up directly\\.`;

  const keyboard = inline.adminUsersList(rows, filter, page, totalPages);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

// ─── User detail ────────────────────────────────────────────────────
async function showUserDetail(ctx, targetId, { edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const { user, commitCount, errorCount, lastActivity } = await adminStats.userDetail(targetId);
  if (!user) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('User not found.').catch(() => {});
    return ctx.reply('User not found.');
  }
  // Lets 🎚️ Limits / 📜 History BBTB shortcuts act on whichever user is
  // currently open — same "current X" pattern as ctx.session.currentRepo.
  ctx.session.currentAdminTarget = targetId;

  const roles = require('../lib/roles');
  const [viewerRole, targetRole] = await Promise.all([roles.getRole(ctx.from.id), roles.getRole(targetId)]);
  const viewerCanPromote = roles.atLeast(viewerRole, 'super_admin');
  const targetIsOwner = roles.isOwner(targetId);

  const rl = user.github_token_enc ? require('../lib/github').getLastKnownRateLimit(
    await users.getDecryptedToken(targetId)
  ) : null;

  const limits = require('../lib/limits').getEffectiveLimits(user);
  const hasOverride = user.max_zip_bytes_override || user.max_file_bytes_override || user.hourly_action_cap_override;
  const suspicious = users.isSuspicious(user);
  const suspiciousReasons = users.suspiciousReasons(user);

  const suspended = user.suspended_until && new Date(user.suspended_until) > new Date();
  // v1.2.5-multi: every GitHub account the person has connected (never a token), with its last health check.
  const acctView = await require('../lib/accounts').listForAdmin(targetId).catch(() => []);
  const ROLE_ICON = { super_admin: '👑', admin: '🛡️', moderator: '🔧', guest: '👁️' };
  const lines = [
    `👤 *${userLabel(user)}*`,
    targetIsOwner ? `🏆 *OWNER* — protected, role can\u2019t be changed` : (targetRole !== 'guest' ? `${ROLE_ICON[targetRole] || ''} Dashboard role: ${format.escapeMd(targetRole.replace('_', ' '))}` : ''),
    suspicious ? '🚩 *Flagged as suspicious:*' : '',
    ...suspiciousReasons.map((r) => `   ${format.escapeMd(r)}`),
    '',
    '*Profile*',
    `Telegram ID: \`${user.telegram_id}\``,
    `📅 Member since: ${format.escapeMd(format.relativeTime(user.created_at))}`,
    '',
    '*Accounts*',
    user.github_username ? `GitHub: @${format.escapeMd(user.github_username)}${acctView.length > 1 ? ` \\(${acctView.length} accounts\\)` : ''}` : '_Not connected to GitHub_',
    ...acctView.filter((a) => !a.active).map((a) => `   ↳ also @${format.escapeMd(a.login)} ${a.health === 'revoked' ? '⚠️ revoked' : (a.health === 'ok' ? '✅' : '·')}${viewerCanPromote && a.scope ? ` — ${format.escapeMd(String(a.scope).split(',').join(', '))}` : ''}`),
    '',
    '*Activity & pauses*',
    `📦 Commits: ${commitCount}`,
    `⚠️ Errors logged: ${errorCount}`,
    `🖱️ Total actions: ${user.total_actions}`,
    `⏳ Rate\\-limit hits: ${user.rate_limit_hits || 0}`,
    `🕐 Last active: ${user.last_active_at ? format.escapeMd(format.relativeTime(user.last_active_at)) : 'never'}`,
    rl ? `📶 API remaining: ${rl.remaining}/${rl.limit}` : (user.github_token_enc ? '📶 API remaining: _no data yet this session_' : ''),
    lastActivity ? `🕗 Last event: ${lastActivity.icon} ${format.escapeMd(lastActivity.summary)}` : '',
    '',
    '*Limits*',
    `Status: ${user.is_blocked ? '🚫 Banned' : suspended ? `⏸️ Suspended until ${format.escapeMd(format.relativeTime(user.suspended_until))}` : '✅ Active'}${user.is_trusted ? '  ⭐ Trusted' : ''}`,
    user.is_blocked && user.blocked_reason ? `Ban reason: _${format.escapeMd(user.blocked_reason)}_` : '',
    `🎚️ Limits: ${hasOverride ? 'custom override set' : 'using defaults'} \\(${format.escapeMd(format.formatBytes(limits.maxZipBytes))} zip, ${format.escapeMd(format.formatBytes(limits.maxFileBytes))} file, ${limits.hourlyActionCap ? limits.hourlyActionCap + '/hr' : 'unlimited'}\\)`,
    user.admin_notes ? `\n*Notes*\n📝 ${format.escapeMd(user.admin_notes)}` : '',
    '\n*Actions* ↓',
  ].filter(Boolean);

  const hideOwnerPrivate = targetIsOwner && !roles.isOwner(ctx.from.id);
  const viewerIsOwner = roles.isOwner(ctx.from.id);
  const keyboard = inline.adminUserDetail(user, suspended, viewerCanPromote && !targetIsOwner, await adminActions.isProtectedAdmin(targetId), hideOwnerPrivate,
    { viewerIsOwner, reposShielded: !!user.repos_protected && !viewerIsOwner, canDelete: viewerCanPromote });
  const text = lines.join('\n');
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await require('./manage/ui').show(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard });
}

// ─── Per-user limit overrides ───────────────────────────────────────
async function showLimits(ctx, targetId, { edit = false } = {}) {
  if (!(await requireRole(ctx, 'admin'))) return;
  const { user } = await adminStats.userDetail(targetId);
  const limits = require('../lib/limits').getEffectiveLimits(user);
  const text =
    `🎚️ *Limits — ${userLabel(user)}*\n\n` +
    `📦 Zip upload: ${format.escapeMd(format.formatBytes(limits.maxZipBytes))}${user.max_zip_bytes_override ? ' \\(override\\)' : ' \\(default\\)'}\n` +
    `📄 File upload: ${format.escapeMd(format.formatBytes(limits.maxFileBytes))}${user.max_file_bytes_override ? ' \\(override\\)' : ' \\(default\\)'}\n` +
    `⏱️ Hourly actions: ${limits.hourlyActionCap || 'unlimited'}${user.hourly_action_cap_override ? ' \\(override\\)' : ' \\(default\\)'}\n\n` +
    `Tap a preset below to set an override, or Clear to go back to the global default\\.`;
  const keyboard = inline.adminLimitsMenu(targetId);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

const ZIP_PRESETS = { '1mb': 1024 * 1024, '5mb': 5 * 1024 * 1024, '20mb': 20 * 1024 * 1024 };
const FILE_PRESETS = { '1mb': 1024 * 1024, '5mb': 5 * 1024 * 1024, '20mb': 20 * 1024 * 1024 };
const CAP_PRESETS = { '50': 50, '200': 200, 'unlimited': 0 };

async function setLimit(ctx, targetId, field, presetKey) {
  if (!(await requireRole(ctx, 'admin'))) return;
  if (await blockIfOwnerTarget(ctx, targetId)) return;
  const overrides = {};
  if (field === 'zip') overrides.maxZipBytes = presetKey === 'clear' ? null : ZIP_PRESETS[presetKey];
  if (field === 'file') overrides.maxFileBytes = presetKey === 'clear' ? null : FILE_PRESETS[presetKey];
  if (field === 'cap') overrides.hourlyActionCap = presetKey === 'clear' ? null : CAP_PRESETS[presetKey];
  if (presetKey === 'clear') {
    // A single field-level clear still needs the OTHER two overrides left
    // untouched — clearLimitOverrides() wipes all three, so only call it
    // when nothing else is currently overridden; otherwise write NULL for
    // just this one field via setLimitOverrides' COALESCE semantics
    // (NULL there means "leave as-is", so we go around it deliberately).
    const { pool } = require('../db/postgres');
    const column = { zip: 'max_zip_bytes_override', file: 'max_file_bytes_override', cap: 'hourly_action_cap_override' }[field];
    await pool.query(`UPDATE users SET ${column} = NULL WHERE telegram_id = $1`, [targetId]);
    await require('../lib/adminActions').auditLog(ctx.from.id, targetId, 'limit_override', `cleared ${field}`);
  } else {
    await adminActions.setLimitOverrides(ctx.from.id, targetId, overrides);
  }
  return showLimits(ctx, targetId, { edit: true });
}

// ─── Audit log (fleet-wide + per-user history) ─────────────────────
const AUDIT_PER_PAGE = 8;
async function showAuditLog(ctx, { page = 1, targetTelegramId = null, edit = false, skipBbtb = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const offset = (page - 1) * AUDIT_PER_PAGE;
  // Filters only ever apply to the fleet-wide screen — see
  // inline.adminAuditPagination's comment for why the per-user History
  // card doesn't expose 🔍 Filter at all.
  const filter = !targetTelegramId ? (ctx.session.adminAuditFilter || {}) : {};
  const { rows, total } = await adminStats.auditLog({
    limit: AUDIT_PER_PAGE, offset, targetTelegramId, actionType: filter.actionType, adminId: filter.adminId,
  });
  const totalPages = Math.max(1, Math.ceil(total / AUDIT_PER_PAGE));
  const title = targetTelegramId ? `📜 *History — \\#${targetTelegramId}*` : `📜 *Audit Log*`;
  const filterActive = !!(filter.actionType || filter.adminId);
  const filterBits = [];
  if (filter.actionType) filterBits.push(`action\\=${format.escapeMd(filter.actionType)}`);
  if (filter.adminId) filterBits.push(`admin\\=\\#${filter.adminId}`);
  const filterLine = filterBits.length ? `_Filtered: ${filterBits.join(', ')}_\n\n` : '';
  let text = `${title} \\(${total}\\)\n\n${filterLine}`;
  text += rows.length
    ? rows.map((r) => `🕐 ${format.escapeMd(format.relativeTime(r.created_at))} — *${format.escapeMd(r.action)}*${r.target_telegram_id ? ` → \\#${r.target_telegram_id}` : ''}${r.detail ? `\n${format.escapeMd(r.detail)}` : ''}`).join('\n\n')
    : (filterActive ? 'No admin actions match this filter\\.' : 'No admin actions recorded yet\\.');
  const keyboard = targetTelegramId
    ? inline.adminAuditPagination(page, totalPages, `admin:user:${targetTelegramId}`, targetTelegramId)
    : inline.adminAuditPagination(page, totalPages, 'admin:watch', null, filterActive);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function askAuditFilter(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const [actions, admins] = await Promise.all([adminStats.distinctAuditActions(), adminStats.distinctAuditAdmins()]);
  const current = ctx.session.adminAuditFilter || {};
  await ctx.reply('🔍 Filter the Audit Log — tap again to clear just that filter:', inline.adminAuditFilterMenu(actions, admins, current));
}

/** Toggle semantics: tapping an already-active filter clears just that
 * one (so ✅ acts as both "this is active" and "tap to turn off"), tapping
 * a different value of the same kind switches to it. Action-type and
 * admin filters stack (AND, not OR) — see adminStats.auditLog's `WHERE`
 * building. */
async function setAuditFilter(ctx, kind, value) {
  if (!(await requireAdmin(ctx))) return;
  ctx.session.adminAuditFilter = ctx.session.adminAuditFilter || {};
  if (kind === 'clear') {
    ctx.session.adminAuditFilter = {};
  } else if (kind === 'action') {
    ctx.session.adminAuditFilter.actionType = ctx.session.adminAuditFilter.actionType === value ? null : value;
  } else if (kind === 'admin') {
    const num = Number(value);
    ctx.session.adminAuditFilter.adminId = ctx.session.adminAuditFilter.adminId === num ? null : num;
  }
  return showAuditLog(ctx, { edit: true });
}

/** 📤 CSV export — the current session filter (if any) applies here too,
 * so "export what I'm looking at" is literally true rather than always
 * dumping the unfiltered log. Capped at 5000 rows as a sane ceiling for
 * a single Telegram document, not a hard product limit. */
async function exportAuditLogCsv(ctx) {
  if (!(await requireRole(ctx, 'admin'))) return;
  const filter = ctx.session.adminAuditFilter || {};
  const { rows } = await adminStats.auditLog({ limit: 5000, offset: 0, actionType: filter.actionType, adminId: filter.adminId });
  const csv = require('../lib/csv');
  const content = csv.toCsv(rows, [
    { label: 'Timestamp', value: (r) => new Date(r.created_at).toISOString() },
    { label: 'Admin ID', value: (r) => r.admin_id },
    { label: 'Action', value: (r) => r.action },
    { label: 'Target ID', value: (r) => r.target_telegram_id || '' },
    { label: 'Detail', value: (r) => r.detail || '' },
  ]);
  const stopChatAction = chatAction.startChatAction(ctx, 'upload_document');
  try {
    await ctx.replyWithDocument({ source: Buffer.from(content, 'utf8'), filename: `audit-log-${Date.now()}.csv` });
  } finally {
    stopChatAction();
  }
}

// ─── Ban / Unban / Suspend / Unsuspend / Trust ─────────────────────
// v1.2.0-multi: the reason you type is sent to the person EXACTLY as written
// (the old ban prompt claimed it was "shown to no one but you", which was
// wrong), so it must be specific. No more reason-less bans or suspensions.
const MIN_REASON_LENGTH = 15;
const REASON_PROMPT = (verb) =>
  `${verb === 'ban' ? '🚫' : '⏸️'} Type the reason for ${verb === 'ban' ? 'banning' : 'suspending'} this user.\n\n` +
  `It is sent to them exactly as you write it, so be specific: what happened and which rule it breaks ` +
  `(at least ${MIN_REASON_LENGTH} characters). A vague reason isn\u2019t fair to them and can\u2019t be appealed properly.`;
const REASON_TOO_SHORT = `\u26a0\ufe0f That\u2019s too short. Please give a specific reason (at least ${MIN_REASON_LENGTH} characters) \u2014 it is sent to the user exactly as written.`;

async function askBan(ctx, targetId) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  if (await adminActions.isProtectedAdmin(targetId)) return ctx.reply('🛡️ This account is an admin and can\u2019t be banned through the Dashboard.');
  ctx.session.awaitingBanReason = true;
  ctx.session.pendingBanTarget = targetId;
  await ctx.reply(REASON_PROMPT('ban'), bbtb.adminBanReasonCompose);
}

async function handleBanReasonText(ctx) {
  ctx.session.awaitingBanReason = false;
  if (!(await requireRole(ctx, 'moderator'))) return;
  if (ctx.message.text.trim().length < MIN_REASON_LENGTH) {
    ctx.session.awaitingBanReason = true; // stay on the prompt so the corrected reason is read
    return ctx.reply(REASON_TOO_SHORT);
  }
  return askBanDuration(ctx, ctx.session.pendingBanTarget, ctx.message.text.trim().slice(0, 300));
}

async function skipBanReason(ctx) {
  if (!ctx.session.awaitingBanReason) return; // stray tap outside this flow — no-op
  if (!(await requireRole(ctx, 'moderator'))) return;
  return ctx.reply(REASON_TOO_SHORT); // a reason is mandatory now; the prompt stays active
}

/** ⏳ Timed bans — same 7d/30d/Permanent choice Suspend's own 24h/7d
 * picker already establishes the pattern for, one extra step ahead of
 * the existing reason-then-confirm flow rather than folding duration
 * into the reason prompt itself. */
async function askBanDuration(ctx, targetId, reason) {
  ctx.session.pendingBanReason = reason;
  await ctx.reply('⏳ How long should this ban last?', inline.adminBanDurationMenu(targetId));
}

async function setBanDuration(ctx, targetId, days) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  return askBanConfirm(ctx, targetId, ctx.session.pendingBanReason, days);
}

async function askBanConfirm(ctx, targetId, reason, days) {
  ctx.session.pendingBanDays = days;
  const { user } = await adminStats.userDetail(targetId);
  const durationLine = days ? `Duration: ${days} day${days === 1 ? '' : 's'}\n\n` : `Duration: permanent\n\n`;
  await ctx.reply(
    `⚠️ Ban ${userLabel(user)}\\?\n\n` +
    durationLine +
    (reason ? `Reason: _${format.escapeMd(reason)}_\n\n` : '') +
    `This will:\n` +
    `• Revoke and delete their stored GitHub token\n` +
    `• Remove any webhooks GitroHub created on their repos\n` +
    `• Block every future message from this person, silently`,
    { parse_mode: 'MarkdownV2', ...inline.adminConfirm(`admin:user:${targetId}:ban`, 'Ban User') }
  );
}

async function executeBan(ctx, targetId) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  if (await adminActions.isProtectedAdmin(targetId)) return ctx.reply('🛡️ This account is an admin and can\u2019t be banned through the Dashboard.');
  const reason = ctx.session.pendingBanReason || null;
  const days = ctx.session.pendingBanDays || null;
  ctx.session.pendingBanReason = null;
  ctx.session.pendingBanTarget = null;
  ctx.session.pendingBanDays = null;
  let undoId = null;
  const { skipped } = await actionLock.withLock(ctx.from.id, `admin:ban:${targetId}`, async () => {
    ({ undoId } = await adminActions.banUser(ctx.from.id, targetId, reason, { telegram: ctx.telegram }, days));
  });
  if (skipped) return ctx.reply('⏳ Already processing — please wait a moment.');
  await adminDone(ctx, `🚫 User banned${days ? ` for ${days} day${days === 1 ? '' : 's'}` : ' permanently'} and GitHub connection revoked.`);
  if (undoId) await ctx.reply('Made a mistake?', inline.adminUndoButton(undoId));
}

async function executeUnban(ctx, targetId) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  await adminActions.unbanUser(ctx.from.id, targetId, { telegram: ctx.telegram });
  return showUserDetail(ctx, targetId, { edit: true });
}

async function executeSuspend(ctx, targetId, hours, reason = null) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  if (await adminActions.isProtectedAdmin(targetId)) return ctx.reply('🛡️ This account is an admin and can\u2019t be suspended through the Dashboard.');
  const { undoId } = await adminActions.suspendUser(ctx.from.id, targetId, hours, { telegram: ctx.telegram }, reason);
  await showUserDetail(ctx, targetId, { edit: true });
  if (undoId) await ctx.reply('Made a mistake?', inline.adminUndoButton(undoId));
}

/** v1.1.8: suspend previously executed the instant an hour-picker button
 * was tapped, with zero reason step — unlike Ban, which already had one.
 * Same reason-or-Skip pattern as askBan/handleBanReasonText/skipBanReason
 * above, just reordered since Suspend's duration is already chosen via
 * the inline tap that got us here. */
async function askSuspendReason(ctx, targetId, hours) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  if (await adminActions.isProtectedAdmin(targetId)) return ctx.reply('🛡️ This account is an admin and can\u2019t be suspended through the Dashboard.');
  ctx.session.awaitingSuspendReason = true;
  ctx.session.pendingSuspendTarget = targetId;
  ctx.session.pendingSuspendHours = hours;
  await ctx.reply(REASON_PROMPT('suspend'), bbtb.adminBanReasonCompose);
}

async function handleSuspendReasonText(ctx) {
  ctx.session.awaitingSuspendReason = false;
  if (!(await requireRole(ctx, 'moderator'))) return;
  if (ctx.message.text.trim().length < MIN_REASON_LENGTH) {
    ctx.session.awaitingSuspendReason = true; // stay on the prompt so the corrected reason is read
    return ctx.reply(REASON_TOO_SHORT);
  }
  const targetId = ctx.session.pendingSuspendTarget;
  const hours = ctx.session.pendingSuspendHours;
  ctx.session.pendingSuspendTarget = null;
  ctx.session.pendingSuspendHours = null;
  return executeSuspend(ctx, targetId, hours, ctx.message.text.trim().slice(0, 300));
}

async function skipSuspendReason(ctx) {
  if (!ctx.session.awaitingSuspendReason) return; // stray tap outside this flow — no-op
  if (!(await requireRole(ctx, 'moderator'))) return;
  return ctx.reply(REASON_TOO_SHORT); // a reason is mandatory now; the prompt stays active
}

async function executeUnsuspend(ctx, targetId) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  await adminActions.unsuspendUser(ctx.from.id, targetId);
  return showUserDetail(ctx, targetId, { edit: true });
}

async function toggleTrust(ctx, targetId) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  const { user } = await adminStats.userDetail(targetId);
  await adminActions.setTrusted(ctx.from.id, targetId, !user.is_trusted);
  return showUserDetail(ctx, targetId, { edit: true });
}

// ─── ↩️ Undo ────────────────────────────────────────────────────────
async function executeUndo(ctx, undoId) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  const result = await adminActions.undoAction(ctx.from.id, undoId, { telegram: ctx.telegram });
  if (!result.ok) {
    const MSG = { 'not_found': 'Nothing to undo — this link is invalid.', 'already-undone': 'Already undone.', 'expired': 'Too late — this undo window has closed.' };
    return ctx.reply(`↩️ ${MSG[result.reason] || 'Could not undo that.'}`);
  }
  const LABEL = { ban: 'Ban', suspend: 'Suspension', bulk_suspend: 'Bulk suspend', bulk_mute: 'Bulk mute' };
  await adminDone(ctx, `↩️ ${LABEL[result.actionType] || 'Action'} reversed for ${result.targetIds.length} account(s).`);
}

// ─── 💬 Direct Message ──────────────────────────────────────────────
async function askMessageUser(ctx, targetId) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  ctx.session.awaitingAdminMessageText = true;
  ctx.session.pendingMessageTarget = targetId;
  await ctx.reply(
    '💬 Type the message to send to this user directly, or send a photo/document (with an optional caption) to deliver that instead. Send ❌ Cancel to back out.',
    bbtb.adminMessageCompose
  );
}

async function handleAdminMessageText(ctx) {
  ctx.session.awaitingAdminMessageText = false;
  if (!(await requireRole(ctx, 'moderator'))) return;
  const targetId = ctx.session.pendingMessageTarget;
  ctx.session.pendingMessageTarget = null;
  if (!targetId) return; // stray text with nothing pending — no-op
  try {
    await adminActions.messageUser(ctx.from.id, targetId, { text: ctx.message.text.trim().slice(0, 3000) }, { telegram: ctx.telegram });
    await adminDone(ctx, '✅ Message sent.');
  } catch (err) {
    await adminDone(ctx, `⚠️ Couldn\u2019t deliver that — they may have blocked the bot. (${err.message})`);
  }
  return showUserDetail(ctx, targetId);
}

/** 📎 Photo/document variants of the same flow — same target/session
 * plumbing as handleAdminMessageText, just sourcing the payload from
 * ctx.message.photo (largest size) or ctx.message.document instead of
 * ctx.message.text. Routed in from bot.js's existing top-level 'photo'/
 * 'document' listeners (see bot.js's Free-document input router), not a
 * new listener of their own. */
async function handleAdminMessagePhoto(ctx) {
  ctx.session.awaitingAdminMessageText = false;
  if (!(await requireRole(ctx, 'moderator'))) return;
  const targetId = ctx.session.pendingMessageTarget;
  ctx.session.pendingMessageTarget = null;
  if (!targetId) return;
  const largest = ctx.message.photo[ctx.message.photo.length - 1];
  try {
    await adminActions.messageUser(ctx.from.id, targetId, { photoFileId: largest.file_id, caption: ctx.message.caption || '' }, { telegram: ctx.telegram });
    await adminDone(ctx, '✅ Message sent.');
  } catch (err) {
    await adminDone(ctx, `⚠️ Couldn\u2019t deliver that — they may have blocked the bot. (${err.message})`);
  }
  return showUserDetail(ctx, targetId);
}

async function handleAdminMessageDocument(ctx) {
  ctx.session.awaitingAdminMessageText = false;
  if (!(await requireRole(ctx, 'moderator'))) return;
  const targetId = ctx.session.pendingMessageTarget;
  ctx.session.pendingMessageTarget = null;
  if (!targetId) return;
  try {
    await adminActions.messageUser(ctx.from.id, targetId, { documentFileId: ctx.message.document.file_id, caption: ctx.message.caption || '' }, { telegram: ctx.telegram });
    await adminDone(ctx, '✅ Message sent.');
  } catch (err) {
    await adminDone(ctx, `⚠️ Couldn\u2019t deliver that — they may have blocked the bot. (${err.message})`);
  }
  return showUserDetail(ctx, targetId);
}

// ─── 📝 Admin Notes ─────────────────────────────────────────────────
async function askNotes(ctx, targetId) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  const { user } = await adminStats.userDetail(targetId);
  ctx.session.awaitingAdminNotesText = true;
  ctx.session.pendingNotesTarget = targetId;
  const current = user.admin_notes
    ? `Current note:\n_${format.escapeMd(user.admin_notes)}_\n\n`
    : '_No note set yet\\._\n\n';
  await ctx.reply(
    `📝 *Notes — ${userLabel(user)}*\n\n${current}Type a new note to replace it, tap 🗑️ Clear Notes to wipe it, or ❌ Cancel to leave it as\\-is\\.`,
    { parse_mode: 'MarkdownV2' }
  );
  await ctx.reply('Waiting for your note…', bbtb.adminNotesCompose);
}

async function handleAdminNotesText(ctx) {
  ctx.session.awaitingAdminNotesText = false;
  if (!(await requireRole(ctx, 'moderator'))) return;
  const targetId = ctx.session.pendingNotesTarget;
  ctx.session.pendingNotesTarget = null;
  if (!targetId) return;
  await adminActions.setNotes(ctx.from.id, targetId, ctx.message.text.trim());
  await adminDone(ctx, '✅ Note saved.');
  return showUserDetail(ctx, targetId);
}

async function clearNotes(ctx) {
  if (!ctx.session.awaitingAdminNotesText) return; // stray tap outside this flow — no-op
  ctx.session.awaitingAdminNotesText = false;
  if (!(await requireRole(ctx, 'moderator'))) return;
  const targetId = ctx.session.pendingNotesTarget;
  ctx.session.pendingNotesTarget = null;
  if (!targetId) return;
  await adminActions.setNotes(ctx.from.id, targetId, null);
  await adminDone(ctx, '🗑️ Note cleared.');
  return showUserDetail(ctx, targetId);
}

/** 🏆 v1.1.24-multi — the owner's repositories and data are private from every
 * other admin. Friendly front door for the hard check in
 * adminActions.assertNotOwnerTarget (which is what actually enforces it). */
async function blockIfOwnerTarget(ctx, targetId) {
  const roles = require('../lib/roles');
  if (roles.isOwner(targetId) && Number(ctx.from.id) !== Number(targetId)) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Owner accounts are private', { show_alert: false }).catch(() => {});
    await ctx.reply('🏆 The owner\u2019s repositories and data are private \u2014 they can\u2019t be viewed or changed from the Dashboard.').catch(() => {});
    return true;
  }
  return false;
}

// ─── 📂 Repo moderation ─────────────────────────────────────────────
/** 🛡 Repo Shield front door for the repo-moderation screens (the hard check
 * is adminActions.assertRepoModerationAllowed). */
async function blockIfRepoPrivate(ctx, targetId) {
  if (await blockIfOwnerTarget(ctx, targetId)) return true;
  const roles = require('../lib/roles');
  if (roles.isOwner(ctx.from.id)) return false;
  const u = await require('../lib/users').getUser(targetId);
  if (u && u.repos_protected) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Repos are protected', { show_alert: false }).catch(() => {});
    await ctx.reply('🛡 This user\u2019s repositories are protected by the owner \u2014 they can\u2019t be viewed or changed from the Dashboard.').catch(() => {});
    return true;
  }
  return false;
}

async function toggleShield(ctx, targetId) {
  if (!(await requireRole(ctx, 'moderator'))) return;
  const roles = require('../lib/roles');
  if (!roles.isOwner(ctx.from.id)) return ctx.reply('🛡 Only the owner can change Repo Shield.');
  const u = await require('../lib/users').getUser(targetId);
  await require('../lib/repoShield').setOne(ctx.from.id, targetId, !(u && u.repos_protected));
  return showUserDetail(ctx, targetId, { edit: true });
}

async function showUserRepos(ctx, targetId, { edit = false, accountLogin = null, forcePick = false } = {}) {
  if (!(await requireRole(ctx, 'admin'))) return;
  if (await blockIfRepoPrivate(ctx, targetId)) return;
  const { user } = await adminStats.userDetail(targetId);

  // v1.2.5-multi: a person can have several GitHub accounts. With more than one, the admin first picks which
  // account to look at (and the choice sticks while they work through that account's repos). Fewer than two:
  // straight to the list, exactly as before.
  const accountsView = await require('../lib/accounts').listForAdmin(targetId).catch(() => []);
  const cached = ctx.session.adminRepoList;
  if (!accountLogin && !forcePick && cached && cached.targetId === targetId) accountLogin = cached.accountLogin || null;
  if (accountsView.length > 1 && (forcePick || !accountLogin)) {
    ctx.session.adminAcctPick = { targetId, logins: accountsView.map((a) => a.login) };
    const text = `📂 *Repos — ${userLabel(user)}*\n\nThis person has ${accountsView.length} GitHub accounts connected\\. Which one do you want to look at\\?`;
    const keyboard = inline.adminAccountPicker(targetId, accountsView);
    if (edit && (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard }))) return;
    return ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
  }

  // v1.1.2 fix: this used to have no try/catch at all — if the target's
  // stored token is present but no longer valid on GitHub's side (they
  // revoked it, GitHub expired it, etc.), the raw error bubbled all the
  // way to bot.js's generic bot.catch() and the admin saw GitHub's raw
  // error text instead of a clear explanation. Delete/visibility/license
  // already had their own specific catches; this brings the read path
  // up to the same standard.
  let connected, login, repos, usedAccount;
  try {
    ({ connected, login, repos, accountLogin: usedAccount } = await adminActions.listUserRepos(targetId, ctx.from.id, { accountLogin }));
  } catch (err) {
    const text = `📂 *Repos — ${userLabel(user)}*\n\n⚠️ Couldn\u2019t reach GitHub for this account: ${format.escapeMd(err.message)}\n\nTheir stored connection may be invalid or revoked — this doesn\u2019t affect their own use of the bot, only this admin view\\.`;
    const keyboard = inline.adminBackTo(`admin:user:${targetId}`);
    if (edit && (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard }))) return;
    return ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
  }
  if (!connected) {
    const text = `📂 *Repos — ${userLabel(user)}*\n\n_Not connected to GitHub — nothing to show\\._`;
    const keyboard = inline.adminBackTo(`admin:user:${targetId}`);
    if (edit && (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard }))) return;
    return ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
  }
  // Cached by position (not just names, the full objects) so 🗑️/⬇️/🔒/⚖️
  // taps can reference a short index instead of putting a repo name into
  // callback_data (Telegram's 64-byte ceiling) — see inline.adminUserRepos
  // — and so every downstream confirmation can show the real "owner/repo"
  // rather than just a bare repo name, per your ask that every action
  // show exactly what it's about to touch before it touches it.
  // v1.2.5-multi: the cache also pins WHICH account the list belongs to — every action below acts as that
  // account, never as whichever one the person has active by the time the admin taps.
  ctx.session.adminRepoList = { targetId, login, accountLogin: usedAccount || login, repos };
  const text = repos.length
    ? `📂 *Repos — @${format.escapeMd(login)}* \\(${repos.length}\\)\n\nTap a repo to view, download, or moderate it\\.`
    : `📂 *Repos — @${format.escapeMd(login)}*\n\n_No repos\\._`;
  const keyboard = inline.adminUserRepos(targetId, repos, { multi: accountsView.length > 1 });
  if (edit && (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard }))) return;
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

/** v1.2.5-multi: the admin tapped an account in the picker. */
async function chooseRepoAccount(ctx, targetId, index) {
  if (!(await requireRole(ctx, 'admin'))) return;
  const pick = ctx.session.adminAcctPick;
  const login = pick && pick.targetId === targetId ? pick.logins[index] : null;
  if (!login) return ctx.reply('⚠️ That account list is stale — reopen 📂 Repos and try again.');
  return showUserRepos(ctx, targetId, { edit: true, accountLogin: login });
}

/** The account an open repo list belongs to (so every action acts as it), or null for single-account people. */
function listedAccount(ctx, targetId) {
  const cache = ctx.session.adminRepoList;
  return cache && cache.targetId === targetId ? (cache.accountLogin || null) : null;
}

function repoAtIndex(ctx, targetId, index) {
  const cache = ctx.session.adminRepoList;
  if (!cache || cache.targetId !== targetId) return null;
  return cache.repos[index] || null;
}

function fullName(ctx, targetId, repo) {
  const cache = ctx.session.adminRepoList;
  const login = cache && cache.targetId === targetId ? cache.login : '?';
  return `${login}/${repo.name}`;
}

const LICENSE_LABELS = { mit: 'MIT', 'apache-2.0': 'Apache 2.0', 'gpl-3.0': 'GPL v3', 'bsd-3-clause': 'BSD' };

async function showRepoDetail(ctx, targetId, index, { edit = false } = {}) {
  if (!(await requireRole(ctx, 'admin'))) return;
  const repo = repoAtIndex(ctx, targetId, index);
  if (!repo) return ctx.reply('⚠️ That repo list is stale — reopen 📂 Repos and try again.');
  const full = fullName(ctx, targetId, repo);
  const sizeKb = repo.size || 0;
  const size = sizeKb > 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`;
  const license = repo.license ? (repo.license.spdx_id || repo.license.name) : 'None';
  const text =
    `📁 *${format.escapeMd(full)}*\n\n` +
    `${repo.private ? '🔒 Private' : '🌐 Public'}  •  📏 ${format.escapeMd(size)}\n` +
    `🌿 Default branch: ${format.escapeMd(repo.default_branch || '—')}\n` +
    `⚖️ License: ${format.escapeMd(license)}\n` +
    `🕐 Last push: ${format.escapeMd(format.relativeTime(repo.pushed_at))}\n` +
    `${repo.description ? `\n${format.escapeMd(repo.description)}\n` : ''}\n` +
    `🔗 ${format.escapeMd(repo.html_url || `https://github.com/${full}`)}`;
  const keyboard = inline.adminRepoDetail(targetId, index, repo);
  if (edit && (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard }))) return;
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function downloadUserRepo(ctx, targetId, index) {
  if (!(await requireRole(ctx, 'admin'))) return;
  if (await blockIfRepoPrivate(ctx, targetId)) return;
  const repo = repoAtIndex(ctx, targetId, index);
  if (!repo) return ctx.reply('⚠️ That repo list is stale — reopen 📂 Repos and try again.');
  const full = fullName(ctx, targetId, repo);
  await ctx.reply(`⬇️ Downloading ${full}…`);
  const stopChatAction = chatAction.startChatAction(ctx, 'upload_document');
  try {
    const { buffer } = await adminActions.downloadUserRepoZip(ctx.from.id, targetId, repo.name, repo.default_branch, { accountLogin: listedAccount(ctx, targetId) });
    await ctx.replyWithDocument({ source: buffer, filename: `${repo.name}.zip` }, { caption: `📁 ${full}` });
  } catch (err) {
    await adminDone(ctx, `⚠️ Couldn\u2019t download ${full}: ${require('../lib/friendlyErrors').oneLine(err)}`);
  } finally {
    stopChatAction();
  }
}

async function askDeleteUserRepo(ctx, targetId, index) {
  if (!(await requireRole(ctx, 'admin'))) return;
  if (await blockIfRepoPrivate(ctx, targetId)) return;
  const repo = repoAtIndex(ctx, targetId, index);
  if (!repo) return ctx.reply('⚠️ That repo list is stale — reopen 📂 Repos and try again.');
  const full = fullName(ctx, targetId, repo);
  await ctx.reply(
    `⚠️ Delete *${format.escapeMd(full)}* from GitHub\\? This removes the repo itself, not just the connection\\. This cannot be undone\\.`,
    { parse_mode: 'MarkdownV2', ...inline.adminConfirm(`admin:repos:${targetId}:del:${index}:execute`, 'Delete Repo') }
  );
}


/**
 * v1.2.1-multi: an admin write that ended with an UNKNOWN outcome (timeout / dropped connection
 * after the request was sent) must not be reported as "nothing was removed / it's unchanged" —
 * that would be a guess. `unchangedClaim` is only said when GitHub (or our own verification)
 * confirmed the operation did not happen.
 */
function failureLine(err, failedWhat, unchangedClaim) {
  if (err && err.outcome === 'unknown') {
    return `⚠️ ${failedWhat} — GitHub did not confirm the final result, so I can\u2019t say whether it happened. Check the repository before trying again.`;
  }
  return `⚠️ ${failedWhat} — ${unchangedClaim}: ${require('../lib/friendlyErrors').oneLine(err)}`;
}

async function executeDeleteUserRepo(ctx, targetId, index) {
  if (!(await requireRole(ctx, 'admin'))) return;
  if (await blockIfRepoPrivate(ctx, targetId)) return;
  const repo = repoAtIndex(ctx, targetId, index);
  if (!repo) return ctx.reply('⚠️ That repo list is stale — reopen 📂 Repos and try again.');
  const full = fullName(ctx, targetId, repo);
  try {
    // adminActions.deleteUserRepo awaits GitHub's own response before
    // doing anything else — a throw here means GitHub said no, so this
    // catch is the only place a "deleted" message can come from, and it
    // never runs on a failure.
    await adminActions.deleteUserRepo(ctx.from.id, targetId, repo.name, { telegram: ctx.telegram }, { accountLogin: listedAccount(ctx, targetId) });
    await adminDone(ctx, `🗑️ ${full} deleted.`);
  } catch (err) {
    await adminDone(ctx, failureLine(err, `Delete failed for ${full}`, 'nothing was removed'));
  }
  return showUserRepos(ctx, targetId);
}

async function askRepoVisibility(ctx, targetId, index) {
  if (!(await requireRole(ctx, 'admin'))) return;
  if (await blockIfRepoPrivate(ctx, targetId)) return;
  const repo = repoAtIndex(ctx, targetId, index);
  if (!repo) return ctx.reply('⚠️ That repo list is stale — reopen 📂 Repos and try again.');
  const full = fullName(ctx, targetId, repo);
  const toPrivate = !repo.private;
  await ctx.reply(
    `⚠️ Make *${format.escapeMd(full)}* ${toPrivate ? 'private' : 'public'}\\?`,
    { parse_mode: 'MarkdownV2', ...inline.adminConfirm(`admin:repos:${targetId}:vis:${index}:execute`, toPrivate ? 'Make Private' : 'Make Public') }
  );
}

async function executeRepoVisibility(ctx, targetId, index) {
  if (!(await requireRole(ctx, 'admin'))) return;
  if (await blockIfRepoPrivate(ctx, targetId)) return;
  const repo = repoAtIndex(ctx, targetId, index);
  if (!repo) return ctx.reply('⚠️ That repo list is stale — reopen 📂 Repos and try again.');
  const full = fullName(ctx, targetId, repo);
  const toPrivate = !repo.private;
  try {
    await adminActions.setUserRepoVisibility(ctx.from.id, targetId, repo.name, toPrivate, { telegram: ctx.telegram }, { accountLogin: listedAccount(ctx, targetId) });
    await ctx.reply(`✅ ${full} is now ${toPrivate ? 'private' : 'public'}.`);
  } catch (err) {
    await ctx.reply(failureLine(err, `Couldn\u2019t change visibility on ${full}`, 'it\u2019s unchanged'));
  }
  return showUserRepos(ctx, targetId, { edit: false });
}

async function askRepoLicense(ctx, targetId, index) {
  if (!(await requireRole(ctx, 'admin'))) return;
  if (await blockIfRepoPrivate(ctx, targetId)) return;
  const repo = repoAtIndex(ctx, targetId, index);
  if (!repo) return ctx.reply('⚠️ That repo list is stale — reopen 📂 Repos and try again.');
  const full = fullName(ctx, targetId, repo);
  await ctx.reply(`⚖️ Pick a license to write to *${format.escapeMd(full)}*:`, { parse_mode: 'MarkdownV2', ...inline.adminRepoLicenseMenu(targetId, index) });
}

async function executeRepoLicense(ctx, targetId, index, licenseKey) {
  if (!(await requireRole(ctx, 'admin'))) return;
  if (await blockIfRepoPrivate(ctx, targetId)) return;
  const repo = repoAtIndex(ctx, targetId, index);
  if (!repo) return ctx.reply('⚠️ That repo list is stale — reopen 📂 Repos and try again.');
  const full = fullName(ctx, targetId, repo);
  const label = LICENSE_LABELS[licenseKey] || licenseKey;
  try {
    await adminActions.setUserRepoLicense(ctx.from.id, targetId, repo.name, licenseKey, label, { telegram: ctx.telegram }, { accountLogin: listedAccount(ctx, targetId) });
    await ctx.reply(`✅ ${label} license written to ${full}.`);
  } catch (err) {
    await ctx.reply(failureLine(err, `Couldn\u2019t write a license to ${full}`, 'it\u2019s unchanged'));
  }
  return showUserRepos(ctx, targetId, { edit: false });
}

// ─── Delete user ────────────────────────────────────────────────────
async function askDelete(ctx, targetId) {
  // v1.2.3-multi: permanent account deletion is a super_admin action (the README always
  // said so; the code had been checking for plain admin).
  if (!(await requireRole(ctx, 'super_admin'))) return;
  if (await adminActions.isProtectedAdmin(targetId)) return ctx.reply('🛡️ This account is an admin and can\u2019t be deleted through the Dashboard.');
  const { user } = await adminStats.userDetail(targetId);
  await ctx.reply(
    `🗑️ Permanently delete ${userLabel(user)}\\?\n\n` +
    `This wipes their entire account: GitHub connection, tags, pins, ` +
    `activity history, scheduled jobs — everything\\. This cannot be undone\\.`,
    { parse_mode: 'MarkdownV2', ...inline.adminConfirm(`admin:user:${targetId}:delete`, 'Delete User') }
  );
}

async function executeDelete(ctx, targetId) {
  if (!(await requireRole(ctx, 'super_admin'))) return;
  if (await adminActions.isProtectedAdmin(targetId)) return ctx.reply('🛡️ This account is an admin and can\u2019t be deleted through the Dashboard.');
  await adminActions.deleteUser(ctx.from.id, targetId);
  await adminDone(ctx, '🗑️ User deleted permanently.');
}

// ─── Export ─────────────────────────────────────────────────────────
async function exportUser(ctx, targetId) {
  if (!(await requireRole(ctx, 'admin'))) return;
  if (await blockIfOwnerTarget(ctx, targetId)) return;
  const result = await adminActions.exportUserData(ctx.from.id, targetId);
  await ctx.replyWithDocument({ source: Buffer.from(result.content, 'utf8'), filename: result.filename });
}

// ─── Fleet stats ────────────────────────────────────────────────────
async function showFleetStats(ctx, { edit = false, skipBbtb = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const overview = await adminStats.fleetOverview();
  const text =
    `📊 *Fleet Stats*\n\n` +
    `👥 Total users: ${overview.totalUsers}\n` +
    `🟢 Active today: ${overview.activeToday}\n` +
    `🔗 Connected to GitHub: ${overview.connected}\n` +
    (overview.githubAccounts > overview.connected
      ? `👤 GitHub accounts: ${overview.githubAccounts} \\(${overview.multiAccountUsers} people use more than one${overview.revokedAccounts ? `, ${overview.revokedAccounts} revoked` : ''}\\)\n`
      : '') +
    `🚫 Banned: ${overview.blocked}\n` +
    `⏸️ Suspended: ${overview.suspended}\n` +
    `🆕 New today: ${overview.newToday}  📅 New this week: ${overview.newThisWeek}\n` +
    `📦 Total commits \\(all users\\): ${overview.totalCommits}\n` +
    `📈 Avg commits per active user: ${format.escapeMd(String(overview.avgCommitsPerActiveUser))}\n` +
    `⚠️ Errors in last 24h: ${overview.errorsToday}`;
  const keyboard = inline.adminFleetActions();
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

/** 📈 Chart — split out from showFleetStats on purpose: the chart used to
 * send automatically every time Fleet Stats opened, which meant an
 * external round-trip (and a photo message) on every single visit whether
 * or not anyone wanted it. Now it's opt-in per visit via its own BBTB
 * button, and (v1.2.3-multi) it is drawn locally by lib/chartRender.js —
 * no external service involved. */
async function sendFleetChart(ctx) {
  if (!(await requireAdmin(ctx))) return;
  try {
    const chartRender = require('../lib/chartRender');
    const growth = await adminStats.growthByDay(30);
    const buffer = await chartRender.renderLineChart({
      title: 'New users — last 30 days',
      labels: growth.map((g) => g.label),
      data: growth.map((g) => g.count),
    });
    await ctx.replyWithPhoto({ source: buffer }, { caption: '📈 30-day signup trend' });
  } catch (err) {
    logger.warn('Fleet Stats chart render failed', { err: err.message });
    await ctx.reply('⚠️ Couldn\u2019t render the chart right now. The text stats above are unaffected.');
  }
}

/** 📤 CSV export for Fleet Stats — the 30-day growth series, same data
 * the chart button renders visually. Overview counters (total users,
 * banned, etc.) are single point-in-time numbers, not a series, so
 * they're not a good fit for a CSV row per se — growth-by-day is the one
 * part of Fleet Stats that's actually tabular. */
async function exportFleetStatsCsv(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const growth = await adminStats.growthByDay(30);
  const csv = require('../lib/csv');
  const content = csv.toCsv(growth, [
    { label: 'Date', value: (g) => g.label },
    { label: 'New Users', value: (g) => g.count },
  ]);
  const stopChatAction = chatAction.startChatAction(ctx, 'upload_document');
  try {
    await ctx.replyWithDocument({ source: Buffer.from(content, 'utf8'), filename: `fleet-stats-${Date.now()}.csv` });
  } finally {
    stopChatAction();
  }
}

async function showLeaderboards(ctx, { edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const [byClicks, byCommits, stale, newest] = await Promise.all([
    adminStats.mostActiveByClicks(5),
    adminStats.mostActiveByCommits(5),
    adminStats.staleAccounts(30, 5),
    adminStats.newestMembers(5),
  ]);
  const fmt = (u, val) => `${userLabel(u)} — ${val}`;
  const text =
    `🏆 *Leaderboards*\n\n` +
    `*Most Active \\(clicks\\)*\n` +
    (byClicks.length ? byClicks.map((u) => fmt(u, u.total_actions)).join('\n') : '_No data yet_') +
    `\n\n*Most Commits*\n` +
    (byCommits.length ? byCommits.map((u) => fmt(u, u.commit_count)).join('\n') : '_No data yet_') +
    `\n\n*Going Stale \\(connected, quiet 30\\+ days\\)*\n` +
    (stale.length ? stale.map((u) => fmt(u, u.last_active_at ? format.escapeMd(format.relativeTime(u.last_active_at)) : 'never active')).join('\n') : '_Nothing stale right now_') +
    `\n\n*Newest Members*\n` +
    (newest.length ? newest.map((u) => fmt(u, format.escapeMd(format.relativeTime(u.created_at)))).join('\n') : '_No data yet_');
  const keyboard = inline.adminBackTo('admin:fleet');
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function showSystemHealth(ctx, { edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const { getHealthStatus } = require('../lib/healthCheck');
  const { pgStatus, redisStatus } = await getHealthStatus();
  const mem = process.memoryUsage();
  const uptimeMs = process.uptime() * 1000;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const upD = Math.floor(uptimeSec / 86400);
  const upH = Math.floor((uptimeSec % 86400) / 3600);
  const upM = Math.floor((uptimeSec % 3600) / 60);
  const text =
    `🖥️ *System Health*\n\n` +
    `${pgStatus.ok ? '🟢' : '🔴'} Postgres: ${pgStatus.ok ? `ok, ${pgStatus.ms}ms` : format.escapeMd(pgStatus.error || 'unreachable')}\n` +
    `${redisStatus.ok ? '🟢' : '🔴'} Redis: ${redisStatus.ok ? `ok, ${redisStatus.ms}ms` : format.escapeMd(redisStatus.error || 'unreachable')}\n` +
    `🧠 Memory: ${Math.round(mem.rss / 1024 / 1024)}MB RSS \\(${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB heap\\)\n` +
    `⏱️ Uptime: ${upD}d ${upH}h ${upM}m\n` +
    `🧩 Node: ${format.escapeMd(process.version)}\n` +
    `☁️ Host: ${format.escapeMd(process.env.RAILWAY_ENVIRONMENT_NAME ? 'Railway' : (process.env.NODE_ENV === 'production' ? 'production' : 'local'))}\n` +
    `🔧 Bot version: v${format.escapeMd(config.BOT_VERSION)}`;
  const keyboard = inline.adminBackTo('admin:fleet');
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function showGrowth(ctx, { edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const days = await adminStats.growthByDay(14);
  const maxCount = Math.max(1, ...days.map((d) => d.count));
  const text =
    `📈 *Growth — last 14 days*\n\n` +
    days.map((d) => {
      const barLen = Math.round((d.count / maxCount) * 10);
      const bar = '█'.repeat(barLen) || '·';
      return `${format.escapeMd(d.label)}  ${bar}  ${d.count}`;
    }).join('\n');
  const keyboard = inline.adminBackTo('admin:fleet');
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

// ─── Anomaly Feed — the real foundation behind abuse detection ─────
async function showAnomalyFeed(ctx, { page = 1, edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const offset = (page - 1) * 8;
  const { rows, total } = await adminStats.anomalyFeed({ limit: 8, offset });
  const totalPages = Math.max(1, Math.ceil(total / 8));
  let text = `🕵️ *Anomaly Feed* \\(${total}\\)\n\n` +
    `Flagged GitHub connection events — reconnect right after a disconnect, or a scope change between sessions\\. Not proof of anything wrong, just worth a second look\\.\n\n`;
  text += rows.length
    ? rows.map((r) => `⚠️ ${format.escapeMd(format.relativeTime(r.created_at))} — ${r.telegram_username ? '@' + format.escapeMd(r.telegram_username) : `\\#${r.telegram_id}`}\n${format.escapeMd(r.anomaly_reason || r.event)}`).join('\n\n')
    : 'No anomalies flagged\\.';
  const nav = [];
  if (page > 1) nav.push(['⬅️ Prev', `admin:anomalies:${page - 1}`]);
  if (page < totalPages) nav.push(['Next ➡️', `admin:anomalies:${page + 1}`]);
  const keyboard = inline.adminAnomalyFeedNav(nav);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

// ─── Scheduled Jobs Overview ────────────────────────────────────────
async function showScheduledJobs(ctx, { edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const jobs = await adminStats.scheduledJobsOverview();
  let text = `🗓️ *Scheduled Jobs* \\(${jobs.length}\\)\n\n`;
  text += jobs.length
    ? jobs.slice(0, 15).map((j) => {
        const icon = j.status === 'failed' ? '⚠️' : '⏳';
        const who = `\\#${j.telegram_id}`;
        const kindLabel = j.kind === 'repo' ? 'repo create' : 'upload';
        return `${icon} ${who} — ${format.escapeMd(kindLabel)}: ${format.escapeMd(j.label)}\n${format.escapeMd(format.relativeTime(j.scheduled_for))}${j.error_message ? `\n${format.escapeMd(j.error_message)}` : ''}`;
      }).join('\n\n')
    : 'Nothing pending, and no failures in the last 7 days\\.';
  if (jobs.length > 15) text += `\n\n_\\.\\.\\. and ${jobs.length - 15} more_`;
  const keyboard = inline.adminBackTo('admin:fleet');
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

// ─── Per-user Access Log (admin view of the existing self-serve feature) ─
async function showUserAccessLog(ctx, targetId, { edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const accessLog = require('../lib/accessLog');
  const [events, user] = await Promise.all([accessLog.recent(targetId, 10), users.getUser(targetId)]);
  const EVENT_LABEL = { connected: 'Connected', reconnected: 'Reconnected \\(scope updated\\)', disconnected: 'Disconnected', token_rejected: 'Token rejected mid\\-action' };
  let text = `🔓 *Access Log — ${userLabel(user)}*\n\n`;
  text += events.length
    ? events.map((e) => {
        const icon = e.is_anomalous ? '⚠️' : '⚪';
        const line = `${icon} ${format.escapeMd(format.relativeTime(e.created_at))} — ${EVENT_LABEL[e.event] || format.escapeMd(e.event)}`;
        return e.is_anomalous ? `${line}\n   ⤷ ${format.escapeMd(e.anomaly_reason)}` : line;
      }).join('\n')
    : 'No connection events recorded yet\\.';
  const keyboard = inline.adminBackTo(`admin:user:${targetId}`);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

// ─── Global Config ──────────────────────────────────────────────────
async function showGlobalConfig(ctx, { edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const globalConfig = require('../lib/globalConfig');
  const overrides = globalConfig.getAllOverrides();
  const rawConfig = require('../config');
  const currentZip = overrides.default_max_zip_bytes != null ? Number(overrides.default_max_zip_bytes) : rawConfig.MAX_ZIP_SIZE_BYTES;
  const currentFile = overrides.default_max_file_bytes != null ? Number(overrides.default_max_file_bytes) : rawConfig.MAX_SINGLE_FILE_BYTES;
  const currentCap = overrides.default_hourly_action_cap != null ? Number(overrides.default_hourly_action_cap) : (rawConfig.DEFAULT_HOURLY_ACTION_CAP || 0);
  const notifyEnabled = globalConfig.get('notify_users_on_repo_mod') === '1';
  // v1.1.8 additions — same "override, else env default" display pattern
  // as the three original rows above.
  const trashDefault = globalConfig.getTrashRetentionDaysDefault();
  const sessionTtl = globalConfig.getSessionTtlSeconds();
  const logRetention = globalConfig.getLogRetentionDays();
  const maxZipUncompressed = globalConfig.getMaxZipUncompressedBytes();
  const maxArchiveFiles = globalConfig.getMaxArchiveFiles();
  const digestWindow = globalConfig.getWebhookDigestWindowMs();
  const signupsPaused = globalConfig.isSignupsPaused();
  const text =
    `⚙️ *Global Config*\n\n` +
    `Live defaults — changing these takes effect immediately, no redeploy, and only affects people without their own per\\-user override already set\\.\n\n` +
    `📦 Zip upload: ${format.escapeMd(format.formatBytes(currentZip))}${overrides.default_max_zip_bytes != null ? ' \\(override\\)' : ' \\(env default\\)'}\n` +
    `📄 File upload: ${format.escapeMd(format.formatBytes(currentFile))}${overrides.default_max_file_bytes != null ? ' \\(override\\)' : ' \\(env default\\)'}\n` +
    `⏱️ Hourly actions: ${currentCap || 'unlimited'}${overrides.default_hourly_action_cap != null ? ' \\(override\\)' : ' \\(env default\\)'}\n` +
    `🔔 Notify users on repo moderation: ${notifyEnabled ? 'ON' : 'OFF \\(default\\)'}\n\n` +
    `*New in v1\\.1\\.8:*\n` +
    `🗑️ New\\-user trash retention: ${trashDefault}d${overrides.default_trash_retention_days != null ? ' \\(override\\)' : ' \\(default\\)'}\n` +
    `🔑 Session TTL: ${Math.round(sessionTtl / 60)}min${overrides.session_ttl_seconds != null ? ' \\(override\\)' : ' \\(default\\)'}\n` +
    `📜 Log retention: ${logRetention}d${overrides.log_retention_days != null ? ' \\(override\\)' : ' \\(default\\)'}\n` +
    `🗜️ Archive decompressed limit: ${format.escapeMd(format.formatBytes(maxZipUncompressed))}${overrides.max_zip_uncompressed_bytes != null ? ' \\(override\\)' : ' \\(default\\)'}\n` +
    `🗂️ Archive file\\-count limit: ${maxArchiveFiles}${overrides.max_archive_files != null ? ' \\(override\\)' : ' \\(default\\)'}\n` +
    `📨 Webhook digest window: ${Math.round(digestWindow / 1000)}s${overrides.webhook_digest_window_ms != null ? ' \\(override\\)' : ' \\(default\\)'}\n` +
    `🚦 New signups: ${signupsPaused ? '⏸️ PAUSED — existing users unaffected' : '✅ Open'}`;
  const keyboard = inline.adminGlobalConfigMenu(notifyEnabled, signupsPaused);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

const GLOBAL_ZIP_PRESETS = { '1mb': 1024 * 1024, '5mb': 5 * 1024 * 1024, '20mb': 20 * 1024 * 1024 };
const GLOBAL_FILE_PRESETS = { '1mb': 1024 * 1024, '5mb': 5 * 1024 * 1024, '20mb': 20 * 1024 * 1024 };
const GLOBAL_CAP_PRESETS = { '50': 50, '200': 200, 'unlimited': 0 };
// v1.1.8 preset tables for the new Global Config rows — same shape/style
// as the three above, so setGlobalConfig's existing preset+clear pattern
// covers all of them with one shared function rather than seven bespoke
// ones.
const GLOBAL_TRASH_PRESETS = { '7': 7, '30': 30, '90': 90 };
const GLOBAL_SESSION_TTL_PRESETS = { '1h': 3600, '6h': 21600, '24h': 86400 };
const GLOBAL_LOG_RETENTION_PRESETS = { '30': 30, '90': 90, '180': 180 };
const GLOBAL_ARCHIVE_ZIP_PRESETS = { '5mb': 5 * 1024 * 1024, '15mb': 15 * 1024 * 1024, '50mb': 50 * 1024 * 1024 };
const GLOBAL_ARCHIVE_FILES_PRESETS = { '50': 50, '200': 200, '1000': 1000 };
const GLOBAL_DIGEST_WINDOW_PRESETS = { '30s': 30 * 1000, '2min': 2 * 60 * 1000, '5min': 5 * 60 * 1000 };

async function setGlobalConfig(ctx, field, presetKey) {
  if (!(await requireAdmin(ctx))) return;
  if (!(await requireSuperAdmin(ctx))) return;
  const globalConfig = require('../lib/globalConfig');
  const key = {
    zip: 'default_max_zip_bytes', file: 'default_max_file_bytes', cap: 'default_hourly_action_cap',
    trash: 'default_trash_retention_days', sessionttl: 'session_ttl_seconds', logretention: 'log_retention_days',
    archivezip: 'max_zip_uncompressed_bytes', archivefiles: 'max_archive_files', digest: 'webhook_digest_window_ms',
  }[field];
  if (presetKey === 'clear') {
    await globalConfig.clear(ctx.from.id, key);
  } else {
    const presetTable = {
      zip: GLOBAL_ZIP_PRESETS, file: GLOBAL_FILE_PRESETS, cap: GLOBAL_CAP_PRESETS,
      trash: GLOBAL_TRASH_PRESETS, sessionttl: GLOBAL_SESSION_TTL_PRESETS, logretention: GLOBAL_LOG_RETENTION_PRESETS,
      archivezip: GLOBAL_ARCHIVE_ZIP_PRESETS, archivefiles: GLOBAL_ARCHIVE_FILES_PRESETS, digest: GLOBAL_DIGEST_WINDOW_PRESETS,
    }[field];
    const value = presetTable[presetKey];
    await globalConfig.set(ctx.from.id, key, value);
  }
  return showGlobalConfig(ctx, { edit: true });
}

/** 🚦 Pause new signups — distinct from full Maintenance Mode; see
 * handlers/start.js's handleStart for what this actually gates
 * (blocks only genuinely-new people, never a reconnecting existing user,
 * never anyone already connected). */
async function toggleSignupsPaused(ctx) {
  if (!(await requireSuperAdmin(ctx))) return;
  const globalConfig = require('../lib/globalConfig');
  const currentlyPaused = globalConfig.isSignupsPaused();
  await globalConfig.set(ctx.from.id, 'signups_paused', currentlyPaused ? 'false' : 'true');
  await adminActions.auditLog(ctx.from.id, null, 'signups_paused', currentlyPaused ? 'resumed' : 'paused');
  return showGlobalConfig(ctx, { edit: true });
}

/** 🔔 Silent-by-default toggle — see lib/adminActions.js's
 * notifyUserIfEnabled for what this actually gates (repo moderation
 * notifications only; ban/suspend/message notices are unaffected —
 * those are inherent to what those actions ARE, not incidental). */
async function toggleNotifyUsers(ctx) {
  if (!(await requireSuperAdmin(ctx))) return;
  const globalConfig = require('../lib/globalConfig');
  const currentlyOn = globalConfig.get('notify_users_on_repo_mod') === '1';
  await globalConfig.set(ctx.from.id, 'notify_users_on_repo_mod', currentlyOn ? '0' : '1');
  return showGlobalConfig(ctx, { edit: true });
}


// ─── Feature switches (v1.2.4-multi) ────────────────────────────────
// One on/off switch per ⚡ Manage / 💼 Workspace area. OFF hides the area from the hubs and makes its buttons
// answer "switched off" — no redeploy needed. Stored as `feature_<key>` in admin_config (lib/features.js).
async function showFeatureSwitches(ctx, { edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const features = require('../lib/features');
  const registry = require('./manage/registry');
  const style = require('../keyboards/buttonStyle');
  const { Markup } = require('telegraf');
  const areas = registry.list();
  const rows = areas.map((a) => [style.callback(`${features.isEnabled(a.key) ? '✅' : '⏸️'} ${a.emoji} ${a.label} · ${a.level === 'repo' ? 'Manage' : 'Workspace'}`, `admin:features:toggle:${a.key}`, features.isEnabled(a.key) ? style.BLUE : style.RED)]);
  rows.push([style.callback('⬅️ Back to Global Config', 'admin:config', style.BLUE)]);
  const text = '🧩 *Feature Switches*\n\nTap an area to switch it on or off for *everyone*\\. Switched\\-off areas disappear from ⚡ Manage and 💼 Workspace; anything already in progress is told it is off\\. Takes effect immediately\\.';
  const kb = Markup.inlineKeyboard(rows);
  if (edit && (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...kb }))) return;
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...kb });
}

async function toggleFeatureSwitch(ctx, key) {
  if (!(await requireSuperAdmin(ctx))) return;
  const features = require('../lib/features');
  const registry = require('./manage/registry');
  const area = registry.get(key);
  if (!area) return ctx.reply('That feature no longer exists.');
  const globalConfig = require('../lib/globalConfig');
  const on = features.isEnabled(key);
  if (on) await globalConfig.set(ctx.from.id, features.configKey(key), 'off');
  else await globalConfig.clear(ctx.from.id, features.configKey(key));
  await adminActions.auditLog(ctx.from.id, null, 'feature_switch', `${key} ${on ? 'OFF' : 'ON'}`);
  return showFeatureSwitches(ctx, { edit: true });
}

// ─── Nudge Never-Connected ──────────────────────────────────────────
async function askNudge(ctx) {
  if (!(await requireRole(ctx, 'admin'))) return;
  const { pool } = require('../db/postgres');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE connected_at IS NULL AND is_blocked = FALSE');
  await ctx.reply(
    `📣 Send a re\\-connect reminder to ${rows[0].c} account\\(s\\) that signed up but never finished connecting GitHub\\?`,
    { parse_mode: 'MarkdownV2', ...inline.adminConfirm('admin:nudge:execute', 'Send Nudge') }
  );
}

async function executeNudge(ctx) {
  if (!(await requireRole(ctx, 'admin'))) return;
  const { sent, total } = await adminActions.nudgeNeverConnected(ctx.from.id, { telegram: ctx.telegram });
  await adminDone(ctx, `✅ Nudge delivered to ${sent}/${total} accounts.`);
}

// ─── Bulk Export All ────────────────────────────────────────────────
async function exportAll(ctx) {
  if (!(await requireRole(ctx, 'super_admin'))) return;
  const result = await adminActions.exportAllUsers(ctx.from.id);
  await ctx.replyWithDocument({ source: Buffer.from(result.content, 'utf8'), filename: result.filename });
}

async function showErrorFeed(ctx, { page = 1, edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const offset = (page - 1) * ERRORS_PER_PAGE;
  const { rows, total } = await adminStats.globalErrorFeed({ limit: ERRORS_PER_PAGE, offset });
  const totalPages = Math.max(1, Math.ceil(total / ERRORS_PER_PAGE));
  let text = `⚠️ *Global Error Feed* \\(${total}\\)\n\n`;
  text += rows.length
    ? rows.map((r) => `🕐 ${format.escapeMd(format.relativeTime(r.created_at))} — ${r.telegram_username ? '@' + format.escapeMd(r.telegram_username) : `\\#${r.telegram_id}`}\n${r.icon} ${format.escapeMd(r.summary)}`).join('\n\n')
    : 'No errors recorded across any user\\.';
  const keyboard = inline.adminErrorFeedPagination(page, totalPages);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

// ─── 🩺 Maintenance Mode ────────────────────────────────────────────
// v1.3.0-multi — manual toggle + an optional UTC-based auto-on/auto-off
// schedule, both backed by lib/maintenance.js (itself layered on the
// same admin_config cache Global Config already uses). Admins always
// pass through the gate itself (middleware/accessControl.js) — this
// screen is reachable and fully usable even while maintenance is ON.
async function showMaintenance(ctx, { edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const maintenance = require('../lib/maintenance');
  const timezone = require('../lib/timezone');
  const admin = await users.getUser(ctx.from.id);
  const tz = (admin && admin.timezone) || 'UTC';
  const enabled = maintenance.isEnabled();
  const message = maintenance.getMessage();
  const autoOnUtc = maintenance.getAutoOn();
  const autoOffUtc = maintenance.getAutoOff();
  // v1.1.8: shown in the admin's OWN timezone now, not raw UTC — storage
  // and the poller (lib/maintenance.js's checkSchedule) are unchanged,
  // this is purely a display/input convenience layer, same shortcut the
  // user side already had for its own schedules.
  const autoOnLocal = autoOnUtc ? timezone.hhmmUtcToLocal(autoOnUtc, tz) : null;
  const autoOffLocal = autoOffUtc ? timezone.hhmmUtcToLocal(autoOffUtc, tz) : null;
  const text =
    `🩺 *Maintenance Mode*\n\n` +
    `Status: ${enabled ? '🔴 ON — non\\-admins are blocked right now' : '🟢 Off — bot is open to everyone'}\n\n` +
    `*Message shown to users while ON:*\n_${format.escapeMd(message)}_\n\n` +
    `*Schedule \\(${format.escapeMd(tz)}\\)*\n` +
    `├ Auto\\-ON: ${autoOnLocal ? format.escapeMd(autoOnLocal) : 'not set'}\n` +
    `└ Auto\\-OFF: ${autoOffLocal ? format.escapeMd(autoOffLocal) : 'not set'}\n\n` +
    `Admins always get full access, even while this is ON\\.`;
  const keyboard = inline.adminMaintenanceMenu(enabled, autoOnUtc, autoOffUtc);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function toggleMaintenance(ctx, turnOn) {
  if (!(await requireRole(ctx, 'super_admin'))) return;
  const maintenance = require('../lib/maintenance');
  await maintenance.setEnabled(ctx.from.id, turnOn);
  return showMaintenance(ctx, { edit: true });
}

async function askMaintenanceMessage(ctx) {
  if (!(await requireRole(ctx, 'super_admin'))) return;
  ctx.session.awaitingMaintenanceMessage = true;
  await ctx.reply(
    'Type the message users should see while Maintenance Mode is ON, or send ⏭️ Skip to reset it to the default.',
    bbtb.adminBanReasonCompose
  );
}

async function handleMaintenanceMessageText(ctx) {
  ctx.session.awaitingMaintenanceMessage = false;
  if (!(await requireRole(ctx, 'super_admin'))) return;
  const maintenance = require('../lib/maintenance');
  await maintenance.setMessage(ctx.from.id, ctx.message.text.trim().slice(0, 500));
  return showMaintenance(ctx);
}

async function skipMaintenanceMessage(ctx) {
  if (!ctx.session.awaitingMaintenanceMessage) return; // stray tap outside this flow — no-op
  ctx.session.awaitingMaintenanceMessage = false;
  if (!(await requireRole(ctx, 'super_admin'))) return;
  const maintenance = require('../lib/maintenance');
  await maintenance.clearMessage(ctx.from.id);
  return showMaintenance(ctx);
}

async function askMaintenanceSchedule(ctx, which) {
  if (!(await requireRole(ctx, 'super_admin'))) return;
  if (which === 'on') ctx.session.awaitingMaintenanceAutoOn = true;
  else ctx.session.awaitingMaintenanceAutoOff = true;
  const admin = await users.getUser(ctx.from.id);
  const tz = (admin && admin.timezone) || 'UTC';
  await ctx.reply(
    `⏰ Send the auto\\-${which === 'on' ? 'ON' : 'OFF'} time as \`HH:MM\` in your own timezone \\(${format.escapeMd(tz)}\\), or \`off\` to clear it\\.`,
    { parse_mode: 'MarkdownV2' }
  );
}

async function handleMaintenanceScheduleInput(ctx, which) {
  if (!(await requireRole(ctx, 'super_admin'))) return;
  const maintenance = require('../lib/maintenance');
  const timezone = require('../lib/timezone');
  if (which === 'on') ctx.session.awaitingMaintenanceAutoOn = false;
  else ctx.session.awaitingMaintenanceAutoOff = false;
  const trimmed = ctx.message.text.trim().toLowerCase();
  if (trimmed === 'off') {
    if (which === 'on') await maintenance.clearAutoOn(ctx.from.id);
    else await maintenance.clearAutoOff(ctx.from.id);
    return showMaintenance(ctx);
  }
  if (!maintenance.isValidTime(trimmed)) {
    // keep listening for the corrected time (the flag was cleared above)
    if (which === 'on') ctx.session.awaitingMaintenanceAutoOn = true;
    else ctx.session.awaitingMaintenanceAutoOff = true;
    return ctx.reply('Didn\u2019t understand that — use 24h `HH:MM` \\(e\\.g\\. `02:00`\\), or `off` to clear\\.', { parse_mode: 'MarkdownV2' });
  }
  // v1.1.8: the admin typed this in THEIR OWN timezone (per the prompt
  // above) — convert to UTC before storing, since lib/maintenance.js's
  // checkSchedule poller compares against UTC and that storage format
  // is unchanged; only the admin-facing edges got timezone-aware.
  const admin = await users.getUser(ctx.from.id);
  const tz = (admin && admin.timezone) || 'UTC';
  const utcHHMM = timezone.hhmmLocalToUtc(trimmed, tz);
  if (which === 'on') await maintenance.setAutoOn(ctx.from.id, utcHHMM);
  else await maintenance.setAutoOff(ctx.from.id, utcHHMM);
  return showMaintenance(ctx);
}


async function askBroadcast(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!(await requireSuperAdmin(ctx))) return;
  ctx.session.awaitingBroadcastText = true;
  await ctx.reply(
    'Type the message to send to every non\u2011banned user.\n\n' +
    'Formatting is preserved exactly as you type it in Telegram — *bold*, _italic_, links, etc. all go out to everyone looking the same as they do right here. No emoji or wrapper text gets added on top, so this is safe to use for a real announcement or a promo.\n\n' +
    'Send ❌ Cancel to back out.',
    bbtb.adminBroadcastCompose
  );
}

async function handleBroadcastText(ctx) {
  ctx.session.awaitingBroadcastText = false;
  if (!(await requireAdmin(ctx))) return;
  // Keep the admin's own formatting `entities` alongside the raw text —
  // this is what lets Send Broadcast go out with real bold/italic/links
  // exactly as typed, instead of forcing everything through MarkdownV2
  // escaping (which the admin never asked for and would mangle anything
  // they'd actually typed as Markdown-looking text).
  ctx.session.pendingBroadcast = { text: ctx.message.text, entities: ctx.message.entities || [] };
  // The preview IS the real send — same text, same entities — so what
  // the admin approves here is provably identical to what goes out,
  // not a re-escaped MarkdownV2 approximation of it.
  await ctx.reply(ctx.message.text, ctx.message.entities ? { entities: ctx.message.entities } : undefined);
  await ctx.reply('☝️ Send this to every non-banned user now, or queue it for later?', inline.adminBroadcastWhen());
}

async function executeBroadcast(ctx) {
  if (!(await requireSuperAdmin(ctx))) return;
  const pending = ctx.session.pendingBroadcast;
  ctx.session.pendingBroadcast = null;
  if (!pending || !pending.text) return;
  const scheduledBroadcasts = require('../lib/scheduledBroadcasts');
  // Every send — immediate or scheduled — gets exactly one row here, so
  // 📜 Cast History always reflects what actually went out rather than a
  // reconstruction from the audit log's truncated detail string. An
  // immediate send just closes its own row (pending → sent) within the
  // same request instead of waiting on index.js's poller.
  const row = await scheduledBroadcasts.create(ctx.from.id, pending.text, pending.entities, new Date(), { claimed: true });
  const { sent, total } = await adminActions.broadcast(ctx.from.id, { telegram: ctx.telegram }, pending.text, pending.entities);
  await scheduledBroadcasts.markSent(row.id, sent, total);
  await adminDone(ctx, `✅ Delivered to ${sent}/${total} users.`);
}

async function askBroadcastSchedule(ctx) {
  if (!(await requireSuperAdmin(ctx))) return;
  if (!ctx.session.pendingBroadcast) return ctx.reply('⚠️ Nothing to schedule — compose a broadcast first.');
  await ctx.reply('⏰ When should this go out?', inline.adminBroadcastTimePresets());
}

/** Mirrors handlers/scheduledUploads.js's setQuickTime/handleCustomTimeInput
 * exactly (presets, timezone source, custom-input parsing) — a second,
 * differently-behaved "pick a future time" control would be a worse
 * outcome than importing the same one two features already share. */
async function setBroadcastQuickTime(ctx, pick) {
  if (!(await requireSuperAdmin(ctx))) return;
  const pending = ctx.session.pendingBroadcast;
  if (!pending) return ctx.reply('⚠️ Nothing to schedule — compose a broadcast first.');
  const timezone = require('../lib/timezone');
  const admin = await users.getUser(ctx.from.id);
  const tz = admin.timezone || 'UTC';

  if (pick === 'custom') {
    ctx.session.awaitingBroadcastScheduleTime = true;
    await ctx.reply(
      `⌨️ Send a time in your timezone \\(${format.escapeMd(tz)}\\) — just "14:00" works \\(today, or tomorrow if that's already passed\\), or add a date: "12\\-25 09:00", or the full "2026\\-09\\-15 14:00" if you want to be exact\\. 12\\-hour like "2:30pm" also works\\.`,
      { parse_mode: 'MarkdownV2', ...bbtb.adminBroadcastCompose }
    );
    return;
  }

  const now = new Date();
  let sendAt;
  if (pick === '1h') {
    sendAt = new Date(now.getTime() + 60 * 60 * 1000);
  } else if (pick === 'tomorrow9am') {
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const [ty, tm, td] = todayLocal.split('-').map(Number);
    const tomorrowLocal = new Date(Date.UTC(ty, tm - 1, td + 1));
    const y = tomorrowLocal.getUTCFullYear();
    const mo = String(tomorrowLocal.getUTCMonth() + 1).padStart(2, '0');
    const d = String(tomorrowLocal.getUTCDate()).padStart(2, '0');
    sendAt = timezone.zonedTimeToUtc(`${y}-${mo}-${d}`, '09:00', tz);
    if (sendAt.getTime() <= now.getTime()) sendAt = new Date(sendAt.getTime() + 24 * 60 * 60 * 1000);
  }
  return askBroadcastRecurrence(ctx, sendAt);
}

async function handleBroadcastScheduleCustomTime(ctx) {
  ctx.session.awaitingBroadcastScheduleTime = false;
  if (!(await requireSuperAdmin(ctx))) return;
  const pending = ctx.session.pendingBroadcast;
  if (!pending) return ctx.reply('⚠️ Nothing to schedule — compose a broadcast first.');
  const timezone = require('../lib/timezone');
  const admin = await users.getUser(ctx.from.id);
  const tz = admin.timezone || 'UTC';
  const sendAt = timezone.parseFlexibleDateTime(ctx.message.text.trim(), tz);
  if (!sendAt) {
    await ctx.reply(format.errorMessage('Couldn\u2019t read that', 'try "14:00", "12-25 09:00", or "2026-09-15 14:00"', '12-hour like "2:30pm" also works, or ❌ Cancel.'));
    ctx.session.awaitingBroadcastScheduleTime = true;
    return;
  }
  if (sendAt.getTime() <= Date.now()) {
    await ctx.reply(format.errorMessage('That time has already passed', `that resolves to the past in ${tz}`, 'Send a future date/time, or ❌ Cancel.'));
    ctx.session.awaitingBroadcastScheduleTime = true;
    return;
  }
  return askBroadcastRecurrence(ctx, sendAt);
}

/** v1.1.8: recurrence picker — sits between picking a send time and
 * actually committing the row, so a one-time broadcast (still the
 * default/first option, unchanged behavior) is exactly as fast as
 * before, and recurring is one extra tap rather than a separate flow. */
async function askBroadcastRecurrence(ctx, sendAt) {
  if (!(await requireSuperAdmin(ctx))) return;
  ctx.session.pendingBroadcastSendAt = sendAt.toISOString();
  await ctx.reply('🔁 Send once, or make this repeat automatically?', inline.adminBroadcastRecurrenceMenu());
}

async function chooseBroadcastRecurrence(ctx, choice) {
  if (!(await requireSuperAdmin(ctx))) return;
  const sendAtIso = ctx.session.pendingBroadcastSendAt;
  ctx.session.pendingBroadcastSendAt = null;
  if (!sendAtIso) return ctx.reply('⚠️ That schedule step expired — compose the broadcast again.');
  const sendAt = new Date(sendAtIso);
  if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
    ctx.session.pendingBroadcast = null;
    return ctx.reply('⚠️ That schedule time is no longer valid — compose the broadcast again.');
  }
  const recurrenceType = choice === 'once' ? null : choice; // 'daily' | 'weekly'
  if (recurrenceType && !['daily', 'weekly'].includes(recurrenceType)) {
    return ctx.reply('⚠️ That repeat option is no longer valid — compose the broadcast again.');
  }
  return finalizeScheduledBroadcast(ctx, sendAt, recurrenceType);
}

async function finalizeScheduledBroadcast(ctx, sendAt, recurrenceType = null) {
  const pending = ctx.session.pendingBroadcast;
  if (!pending || !pending.text) {
    ctx.session.pendingBroadcastSendAt = null;
    return ctx.reply('⚠️ That broadcast draft expired — compose it again before scheduling.');
  }
  ctx.session.pendingBroadcast = null;
  ctx.session.pendingBroadcastSendAt = null;
  const scheduledBroadcasts = require('../lib/scheduledBroadcasts');
  await scheduledBroadcasts.create(ctx.from.id, pending.text, pending.entities, sendAt, { recurrenceType });
  const recurLine = recurrenceType ? ` It'll then repeat ${recurrenceType} until you cancel it.` : '';
  await adminDone(ctx, `⏰ Scheduled for ${sendAt.toUTCString()}.${recurLine} It'll go out automatically and show up in 📜 Cast History once it does.`);
}

const BROADCAST_HISTORY_PER_PAGE = 6;
async function showBroadcastHistory(ctx, { page = 1, edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const scheduledBroadcasts = require('../lib/scheduledBroadcasts');
  const [{ rows, total }, pending] = await Promise.all([
    scheduledBroadcasts.history(BROADCAST_HISTORY_PER_PAGE, (page - 1) * BROADCAST_HISTORY_PER_PAGE),
    scheduledBroadcasts.listPending(),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / BROADCAST_HISTORY_PER_PAGE));
  const STATUS_ICON = { sent: '✅', failed: '⚠️', cancelled: '🚫' };
  let text = `📜 *Cast History* \\(${total}\\)\n\n`;
  if (pending.length) {
    text += `*⏰ Pending \\(${pending.length}\\)*\n`;
    text += pending.map((p) => {
      const repeat = p.recurrence_type
        ? ` • 🔁 ${p.recurrence_type}${p.recurrence_fired_count ? ` • ${p.recurrence_fired_count} sent` : ''}`
        : '';
      return `${format.escapeMd(format.relativeTime(p.send_at))}${repeat} — ${format.escapeMd(p.text.slice(0, 60))}`;
    }).join('\n');
    text += '\n\n';
  }
  text += rows.length
    ? rows.map((r) => {
        const icon = STATUS_ICON[r.status] || '•';
        const stats = r.status === 'sent' ? ` \\(${r.sent_count}/${r.total_count}\\)` : '';
        return `${icon} ${format.escapeMd(format.relativeTime(r.sent_at || r.created_at))}${stats}\n${format.escapeMd(r.text.slice(0, 80))}`;
      }).join('\n\n')
    : '_No broadcasts sent yet\\._';
  const keyboard = inline.adminBroadcastHistoryPagination(page, totalPages, pending, rows);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

/** v1.1.8: Cast History was previously view-only — cancel/repost were both
 * missing even though scheduledBroadcasts.cancel() already existed
 * server-side, just never wired to a button. */
async function cancelBroadcast(ctx, id) {
  if (!(await requireSuperAdmin(ctx))) return; // matches askBroadcast/executeBroadcast's own gate
  const scheduledBroadcasts = require('../lib/scheduledBroadcasts');
  const cancelled = await scheduledBroadcasts.cancel(id);
  await adminActions.auditLog(ctx.from.id, null, 'broadcast_cancel', cancelled ? `#${id}` : `#${id} (already sent/cancelled)`);
  await ctx.answerCbQuery(cancelled ? '🚫 Cancelled.' : 'Already sent or cancelled — nothing to do.');
  return showBroadcastHistory(ctx, { edit: true });
}

async function repostBroadcast(ctx, id) {
  if (!(await requireSuperAdmin(ctx))) return; // sending is equivalent to executeBroadcast, same gate
  const scheduledBroadcasts = require('../lib/scheduledBroadcasts');
  const source = await scheduledBroadcasts.get(id);
  if (!source) return ctx.answerCbQuery('That broadcast no longer exists.');
  // Reposts immediately rather than reopening the compose flow — the
  // text is already known-good (it sent successfully once already);
  // if the admin wants to edit it first, Repost isn't the right button,
  // Cast is.
  const entities = source.entities ? JSON.parse(source.entities) : [];
  const row = await scheduledBroadcasts.repost(id, ctx.from.id, new Date());
  const { sent, total } = await adminActions.broadcast(ctx.from.id, { telegram: ctx.telegram }, source.text, entities);
  await scheduledBroadcasts.markSent(row.id, sent, total);
  await adminActions.auditLog(ctx.from.id, null, 'broadcast_repost', `from #${id} → #${row.id} (${sent}/${total})`);
  await ctx.answerCbQuery(`🔁 Reposted to ${sent}/${total}.`);
  return showBroadcastHistory(ctx, { edit: true });
}

// ─── 🚩 Reports (admin side — see handlers/reports.js for the user-facing /report) ─
const REPORTS_PER_PAGE = 8;
async function showReports(ctx, { edit = false } = {}) {
  if (!(await requireRole(ctx, 'admin'))) return;
  const reports = require('../lib/reports');
  const { rows, total } = await reports.list({ status: 'open', limit: REPORTS_PER_PAGE, offset: 0 });
  const text = total
    ? `🚩 *Open Reports* \\(${total}\\)\n\nTap one to view it and take action\\.`
    : `🚩 *Open Reports*\n\n_Nothing open right now\\._`;
  const keyboard = inline.adminReportsList(rows);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function showReportDetail(ctx, reportId, { edit = false } = {}) {
  if (!(await requireRole(ctx, 'admin'))) return;
  const reports = require('../lib/reports');
  const report = await reports.get(reportId);
  if (!report) return ctx.reply('⚠️ That report no longer exists.');
  const who = report.telegram_username ? `@${format.escapeMd(report.telegram_username)}` : format.escapeMd(report.telegram_first_name || `#${report.telegram_id}`);
  const CAT_LABEL = { bug: '🐛 Bug', abuse: '🚨 Abuse', other: '❓ Other' };
  const text =
    `🚩 *Report from ${who}*\n` +
    `${CAT_LABEL[report.category] || '❓ Other'}  •  _${format.escapeMd(format.relativeTime(report.created_at))}_\n\n` +
    `${format.escapeMd(report.message)}`;
  const keyboard = inline.adminReportDetail(report);
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function resolveReport(ctx, reportId, status) {
  if (!(await requireRole(ctx, 'admin'))) return;
  const reports = require('../lib/reports');
  await reports.resolve(reportId, ctx.from.id, status);
  await ctx.reply(status === 'resolved' ? '✅ Marked resolved.' : '🗑️ Dismissed.');
  return showReports(ctx, { edit: false });
}

// ─── 👑 Admins & Roles ──────────────────────────────────────────────
/** Viewing the roster is open to any tier (mirrors Guest being able to
 * see 👥 Users) — only the ability to CHANGE a role is gated further,
 * decided per-viewer right here rather than as a separate screen, so
 * there's exactly one 👑 Admins entry point for everyone instead of a
 * view-only one and a manage one that could drift out of sync. */
// ─── 🔒 Lockdown Mode (Owner-only) — see lib/lockdown.js for the full design note ───
async function showLockdown(ctx, { edit = false } = {}) {
  if (!(await requireOwner(ctx))) return;
  const lockdown = require('../lib/lockdown');
  const locked = await lockdown.getLockedAdmins();
  const fullActive = lockdown.isFullLockdownActive();
  const keepWarden = lockdown.keepWardenActive();
  const lockedLines = locked.length
    ? locked.map((u) => `└ ${userLabel(u)}`).join('\n')
    : '_nobody is currently locked out_';
  const text =
    `🔒 *Lockdown Mode*\n\n` +
    `Revokes DASHBOARD access only — a locked\\-out admin can still use the bot as a normal user\\. Use this if you suspect an admin session has been compromised\\.\n\n` +
    `Status: ${fullActive ? '🔴 Full Lockdown ON' : (locked.length ? '🟡 Partial — some admins locked' : '🟢 Nobody locked')}\n` +
    `Warden while locked down: ${keepWarden ? '✅ Keeps running' : '⏸️ Also paused'}\n\n` +
    `*Currently locked:*\n${lockedLines}`;
  const keyboard = inline.adminLockdownMenu(fullActive, keepWarden, locked);
  if (edit && (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard }))) return;
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function lockdownAll(ctx) {
  if (!(await requireOwner(ctx))) return;
  const lockdown = require('../lib/lockdown');
  const lockedIds = await lockdown.lockAll(ctx.from.id);
  await adminActions.auditLog(ctx.from.id, null, 'lockdown_all', `${lockedIds.length} admin(s)`);
  await ctx.answerCbQuery(`🔒 Locked ${lockedIds.length} admin(s) out of the Dashboard.`, { show_alert: true });
  return showLockdown(ctx, { edit: true });
}

async function releaseLockdownAll(ctx) {
  if (!(await requireOwner(ctx))) return;
  const lockdown = require('../lib/lockdown');
  const releasedIds = await lockdown.unlockAll(ctx.from.id);
  await adminActions.auditLog(ctx.from.id, null, 'lockdown_release_all', `${releasedIds.length} admin(s)`);
  await ctx.answerCbQuery(`🔓 Released ${releasedIds.length} admin(s).`);
  return showLockdown(ctx, { edit: true });
}

async function askTargetedLockdown(ctx) {
  if (!(await requireOwner(ctx))) return;
  const roles = require('../lib/roles');
  const lockdown = require('../lib/lockdown');
  const [admins, locked] = await Promise.all([roles.listAdmins(), lockdown.getLockedAdmins()]);
  const lockedIds = new Set(locked.map((u) => String(u.telegram_id)));
  const nonOwnerAdmins = admins.filter((a) => !roles.isOwner(a.telegram_id));
  const text = '🎯 *Targeted Lockdown*\n\nTap an admin to lock or unlock just their Dashboard access\\.';
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...inline.adminTargetedLockdownList(nonOwnerAdmins, lockedIds) });
}

async function toggleLockAdmin(ctx, targetId) {
  if (!(await requireOwner(ctx))) return;
  const lockdown = require('../lib/lockdown');
  const currentlyLocked = await lockdown.isLocked(targetId);
  if (currentlyLocked) {
    await lockdown.unlockAdmin(targetId);
    await adminActions.auditLog(ctx.from.id, targetId, 'lockdown_release', '');
    await ctx.answerCbQuery('🔓 Released.');
  } else {
    await lockdown.lockAdmin(ctx.from.id, targetId);
    await adminActions.auditLog(ctx.from.id, targetId, 'lockdown_lock', '');
    await ctx.answerCbQuery('🔒 Locked out of the Dashboard.');
  }
  return askTargetedLockdown(ctx);
}

async function toggleKeepWardenDuringLockdown(ctx) {
  if (!(await requireOwner(ctx))) return;
  const lockdown = require('../lib/lockdown');
  await lockdown.setKeepWardenActive(ctx.from.id, !lockdown.keepWardenActive());
  return showLockdown(ctx, { edit: true });
}

async function showAdmins(ctx, { edit = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const roles = require('../lib/roles');
  const [admins, viewerRole] = await Promise.all([roles.listAdmins(), roles.getRole(ctx.from.id)]);
  const canManage = roles.atLeast(viewerRole, 'super_admin');
  const text = `👑 *Admins* \\(${admins.length}\\)\n\n${canManage ? 'Tap an admin to change their role\\.' : '_Only super admins can change roles\\._'}`;
  const keyboard = inline.adminAdminsList(admins, canManage);
  if (edit && (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard }))) return;
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function askChangeRole(ctx, targetId) {
  if (!(await requireRole(ctx, 'super_admin'))) return;
  const roles = require('../lib/roles');
  if (roles.isOwner(targetId)) {
    return ctx.reply('👑 This account is the Owner (set via OWNER_ID) — its role can\u2019t be changed by anyone, including other super admins.');
  }
  const currentRole = await roles.getRole(targetId);
  await ctx.reply(`👑 Change role for \\#${targetId} \\(currently *${format.escapeMd(currentRole.replace('_', ' '))}*\\):`, { parse_mode: 'MarkdownV2', ...inline.adminRoleMenu(targetId, currentRole) });
}

/** Three guardrails a super_admin can't override by mistake:
 *   1. Can't change the OWNER's role — not even another super_admin can
 *      do this, ever, regardless of who's asking. See config.js's
 *      resolvedOwnerId and lib/roles.js's isOwner.
 *   2. Can't change your OWN role — a self-demote-to-guest with no other
 *      super_admin around would be a self-lockout with no recovery path
 *      short of editing SUPER_ADMIN_IDS/OWNER_ID and redeploying.
 *   3. Can't demote the LAST remaining super_admin (even a different
 *      super_admin doing it to someone else) — same lockout, just via a
 *      different admin's mistake instead of your own.
 * Unlike the old version of this system, targetId no longer has to
 * already be in config.ADMIN_IDS — roles.setRole() will happily create a
 * fresh admin_roles row for any user, which is what makes "promote a
 * user directly to a role" from their User Detail card possible. */
async function executeSetRole(ctx, targetId, newRole) {
  if (!(await requireRole(ctx, 'super_admin'))) return;
  const roles = require('../lib/roles');
  if (roles.isOwner(targetId)) {
    return ctx.reply('👑 This account is the Owner — its role can\u2019t be changed by anyone, including other super admins.');
  }
  if (targetId === ctx.from.id) {
    return ctx.reply('🔒 You can\u2019t change your own role — ask another super admin to do it.');
  }
  const currentRole = await roles.getRole(targetId);
  if (currentRole === 'super_admin' && newRole !== 'super_admin') {
    const count = await roles.countSuperAdmins();
    if (count <= 1) return ctx.reply('🔒 Can\u2019t demote the last remaining super admin — promote someone else first.');
  }
  await roles.setRole(ctx.from.id, targetId, newRole);
  require('../lib/adminCommands').syncFor(ctx.telegram, targetId, true).catch(() => {}); // /admin appears in their "/" menu
  await adminActions.auditLog(ctx.from.id, targetId, 'role_change', `${currentRole} → ${newRole}`);
  // v1.1.8: promotion/demotion previously had ZERO notification — a
  // role change is a real capability change, worth being explicit about
  // rather than the person only discovering it because buttons that
  // used to 403 suddenly work (or vice versa).
  const rank = { guest: 0, moderator: 1, admin: 2, super_admin: 3 };
  const isPromotion = (rank[newRole] || 0) > (rank[currentRole] || 0);
  await ctx.telegram.sendMessage(
    targetId,
    isPromotion
      ? `⬆️ You've been promoted to *${format.escapeMd(newRole.replace('_', ' '))}*\\. New admin abilities are now available to you \\— check the Dashboard\\.`
      : `⬇️ Your role has changed to *${format.escapeMd(newRole.replace('_', ' '))}*\\. Some admin abilities you had before are no longer available\\.`,
    { parse_mode: 'MarkdownV2' }
  ).catch(() => {});
  await ctx.reply(`✅ Role updated: \\#${targetId} is now *${format.escapeMd(newRole.replace('_', ' '))}*\\.`, { parse_mode: 'MarkdownV2' });
  return showAdmins(ctx, { edit: false });
}

/** 🗑️ Revoke Completely — the actual "back to normal user" bug fix:
 * "⬇️ Demote to Guest" leaves a role row behind (still Dashboard view
 * access, still ban/suspend-protected — see lib/roles.js's revokeRole
 * comment for the full distinction); this deletes the row outright.
 * Guardrails mirror executeSetRole's (Owner, self, last-super_admin)
 * plus one more that's specific to revoke: a config.ADMIN_IDS member
 * can't be revoked from here at all — their row would just get silently
 * re-seeded back on the next boot (lib/roles.js's seedFromConfig), which
 * would make the revoke look like it worked and then quietly reverse
 * itself, worse than refusing outright. Removing a config-seeded admin
 * requires editing ADMIN_IDS itself. */
async function executeRevokeRole(ctx, targetId) {
  if (!(await requireRole(ctx, 'super_admin'))) return;
  const roles = require('../lib/roles');
  if (roles.isOwner(targetId)) {
    return ctx.reply('👑 This account is the Owner — its access can\u2019t be revoked by anyone, including other super admins.');
  }
  if (targetId === ctx.from.id) {
    return ctx.reply('🔒 You can\u2019t revoke your own access — ask another super admin to do it.');
  }
  if (config.ADMIN_IDS.includes(Number(targetId))) {
    return ctx.reply('🔒 This account is in ADMIN_IDS — revoking here would just get re-seeded back on the next restart. Remove them from ADMIN_IDS in your environment variables instead.');
  }
  const currentRole = await roles.getRole(targetId);
  if (currentRole === 'super_admin') {
    const count = await roles.countSuperAdmins();
    if (count <= 1) return ctx.reply('🔒 Can\u2019t revoke the last remaining super admin — promote someone else first.');
  }
  await roles.revokeRole(targetId);
  require('../lib/adminCommands').syncFor(ctx.telegram, targetId, false).catch(() => {}); // /admin leaves their "/" menu
  await adminActions.auditLog(ctx.from.id, targetId, 'role_change', `${currentRole} → revoked (normal user)`);
  await ctx.telegram.sendMessage(
    targetId,
    `⬇️ Your admin access has been revoked — you're back to a normal account\\. Admin abilities you had before are no longer available\\.`,
    { parse_mode: 'MarkdownV2' }
  ).catch(() => {});
  await adminDone(ctx, `✅ #${targetId} is back to a normal user — no Dashboard access at all.`);
  return showAdmins(ctx, { edit: false });
}

// ─── Bulk Actions hub ───────────────────────────────────────────────
async function showBulkHub(ctx, { skipBbtb = false } = {}) {
  if (!(await requireAdmin(ctx))) return;
  const text =
    `🗂️ *Bulk Actions*\n\n` +
    `Operations that act on many accounts at once\\. Each one confirms before doing anything, and every run is written to the 📜 Audit Log\\.\n\n` +
    `🧹 *Purge* — delete never\\-connected accounts by age\n` +
    `⏸️ *Suspend* — pause a whole group at once \\(maintenance\\)\n` +
    `🔇 *Mute* — pause notification delivery fleet\\-wide\n` +
    `🗑️ *Delete Banned* — permanently clean out already\\-banned accounts`;
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...inline.adminBulkHubMenu() });
}

/** v1.1.8: one consistent "type a custom number" mechanism reused across
 * every bulk-action day/hour preset picker (Purge's days, bulk-Suspend's
 * hours, and any future one) instead of a bespoke text-input flow per
 * screen. `kind` decides where the number lands once typed. */
async function askCustomNumber(ctx, { kind, scope = null }) {
  if (!(await requireSuperAdmin(ctx))) return;
  ctx.session.awaitingCustomNumber = { kind, scope };
  const unit = kind === 'bulksuspend_hours' ? 'hours' : 'days';
  await ctx.reply(`⌨️ Type a custom number of ${unit} \\(whole number, e\\.g\\. \`45\`\\)\\.`, { parse_mode: 'MarkdownV2' });
}

async function handleCustomNumberText(ctx) {
  const pending = ctx.session.awaitingCustomNumber;
  ctx.session.awaitingCustomNumber = null;
  if (!pending) return;
  if (!(await requireSuperAdmin(ctx))) return;
  const n = Number(ctx.message.text.trim());
  if (!Number.isInteger(n) || n <= 0) {
    ctx.session.awaitingCustomNumber = pending; // keep listening for the corrected number
    return ctx.reply('That doesn\u2019t look like a whole positive number — try again, or use one of the preset buttons instead.');
  }
  if (pending.kind === 'purge_days') return askBulkPurgeConfirm(ctx, n);
  if (pending.kind === 'bulksuspend_hours') return askBulkSuspendConfirm(ctx, pending.scope, n);
}

async function askBulkPurge(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!(await requireSuperAdmin(ctx))) return;
  await ctx.reply(
    `🧹 *Purge Never\\-Connected*\n\nDeletes accounts that *never connected GitHub*\\. Accounts that connected even once are never touched by this — delete those individually if needed\\. Choose how old the account must be, or *Never* to purge all of them regardless of age\\.`,
    { parse_mode: 'MarkdownV2', ...inline.adminPurgeDaysMenu() }
  );
}

async function askBulkPurgeConfirm(ctx, days) {
  if (!(await requireSuperAdmin(ctx))) return;
  const scopeLabel = days === null ? 'EVERY never-connected account, regardless of age' : `every never-connected account older than ${days} days`;
  await ctx.reply(
    `⚠️ Delete ${format.escapeMd(scopeLabel)}\\? This cannot be undone\\.`,
    { parse_mode: 'MarkdownV2', ...inline.adminConfirm(`admin:purge:${days === null ? 'never' : days}:execute`, 'Purge') }
  );
}

async function executeBulkPurge(ctx, days) {
  if (!(await requireSuperAdmin(ctx))) return;
  const count = await adminActions.bulkPurgeNeverConnected(ctx.from.id, days);
  await adminDone(ctx, `✅ Purged ${count} never-connected account(s)${days === null ? ' (all ages)' : ` older than ${days} days`}.`);
}

async function askBulkSuspend(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!(await requireSuperAdmin(ctx))) return;
  await ctx.reply(
    `⏸️ *Bulk Suspend*\n\nPauses every account in the chosen group at once \\(their GitHub connection is untouched — same as an individual Suspend\\)\\. Choose who:`,
    { parse_mode: 'MarkdownV2', ...inline.adminBulkSuspendScopeMenu() }
  );
}

async function askBulkSuspendHours(ctx, scope) {
  if (!(await requireSuperAdmin(ctx))) return;
  await ctx.reply(
    `⏸️ For how long?`,
    { ...inline.adminBulkSuspendHoursMenu(scope) }
  );
}

async function askBulkSuspendConfirm(ctx, scope, hours) {
  if (!(await requireSuperAdmin(ctx))) return;
  const scopeLabel = scope === 'stale' ? 'everyone inactive 30+ days' : 'EVERY non-banned user';
  await ctx.reply(
    `⚠️ Suspend ${format.escapeMd(scopeLabel)} for ${hours}h\\?`,
    { parse_mode: 'MarkdownV2', ...inline.adminConfirm(`admin:bulksuspend:${scope}:${hours}:execute`, 'Suspend') }
  );
}

async function executeBulkSuspend(ctx, scope, hours) {
  if (!(await requireSuperAdmin(ctx))) return;
  const { count, undoId } = await adminActions.bulkSuspend(ctx.from.id, scope, hours, { telegram: ctx.telegram });
  await adminDone(ctx, `✅ Suspended ${count} account(s) for ${hours}h.`);
  if (undoId) await ctx.reply('Made a mistake?', inline.adminUndoButton(undoId));
}

async function askBulkMute(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!(await requireSuperAdmin(ctx))) return;
  await ctx.reply(
    `🔇 *Bulk Mute*\n\nPauses \\(or resumes\\) notification delivery across every registered repo for every user — a fleet\\-wide "maintenance mode" switch\\. Doesn't touch anyone's GitHub connection or webhooks themselves\\.`,
    { parse_mode: 'MarkdownV2', ...inline.adminBulkMuteMenu() }
  );
}

async function askBulkMuteConfirm(ctx, mute) {
  if (!(await requireSuperAdmin(ctx))) return;
  await ctx.reply(
    mute ? `⚠️ Mute notifications for every user\\?` : `Resume notifications for every user\\?`,
    { parse_mode: 'MarkdownV2', ...inline.adminConfirm(`admin:bulkmute:${mute ? 'mute' : 'unmute'}:execute`, mute ? 'Mute All' : 'Unmute All') }
  );
}

async function executeBulkMute(ctx, mute) {
  if (!(await requireSuperAdmin(ctx))) return;
  const { count, undoId } = await adminActions.bulkMuteAll(ctx.from.id, mute);
  await adminDone(ctx, `✅ ${mute ? 'Muted' : 'Unmuted'} ${count} repo(s) across all users.`);
  if (undoId) await ctx.reply('Made a mistake?', inline.adminUndoButton(undoId));
}

async function askBulkDeleteBanned(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!(await requireSuperAdmin(ctx))) return;
  await ctx.reply(
    `🗑️ Permanently delete every currently\\-banned account\\? This only ever touches accounts already banned — cannot be undone\\.`,
    { parse_mode: 'MarkdownV2', ...inline.adminConfirm('admin:bulkdeleteban:execute', 'Delete Banned') }
  );
}

async function executeBulkDeleteBanned(ctx) {
  if (!(await requireSuperAdmin(ctx))) return;
  const count = await adminActions.bulkDeleteBanned(ctx.from.id);
  await adminDone(ctx, `✅ Permanently deleted ${count} banned account(s).`);
}

// ─── Search ─────────────────────────────────────────────────────────
async function askSearch(ctx) {
  if (!(await requireAdmin(ctx))) return;
  ctx.session.awaitingUserSearch = true;
  await ctx.reply('🔍 Type a Telegram ID, @username, or GitHub username to search for.', bbtb.adminBroadcastCompose);
}

async function handleSearchText(ctx) {
  ctx.session.awaitingUserSearch = false;
  if (!(await requireAdmin(ctx))) return;
  const query = ctx.message.text.trim().replace(/^@/, '');
  const rows = await adminStats.searchUsers(query);
  if (rows.length === 0) ctx.session.awaitingUserSearch = true; // "try a different ID/username" — keep listening
  let text = `🔍 *Search results for* "${format.escapeMd(ctx.message.text.trim())}" \\(${rows.length}\\)\n\n`;
  text += rows.length
    ? rows.map((u) => userLabel(u)).join('\n')
    : 'No matches\\. Try a different Telegram ID, @username, or GitHub username\\.';
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...inline.adminSearchResults(rows) });
}

module.exports = {
  toggleShield,
  requireAdmin,
  requireOwner,
  showDashboard,
  showPeopleHub,
  showOversightHub,
  showOpsHub,
  showBroadcastHub,
  showUsers,
  showUserDetail,
  showLimits,
  setLimit,
  showAuditLog,
  askAuditFilter,
  setAuditFilter,
  exportAuditLogCsv,
  askBan,
  handleBanReasonText,
  skipBanReason,
  setBanDuration,
  executeBan,
  executeUnban,
  executeSuspend,
  askSuspendReason,
  handleSuspendReasonText,
  skipSuspendReason,
  executeUnsuspend,
  toggleTrust,
  executeUndo,
  askMessageUser,
  handleAdminMessageText,
  handleAdminMessagePhoto,
  handleAdminMessageDocument,
  askNotes,
  handleAdminNotesText,
  clearNotes,
  showUserRepos,
  chooseRepoAccount,
  showRepoDetail,
  downloadUserRepo,
  askRepoVisibility,
  executeRepoVisibility,
  askRepoLicense,
  executeRepoLicense,
  askDeleteUserRepo,
  executeDeleteUserRepo,
  showAdmins,
  showLockdown,
  lockdownAll,
  releaseLockdownAll,
  askTargetedLockdown,
  toggleLockAdmin,
  toggleKeepWardenDuringLockdown,
  askChangeRole,
  executeSetRole,
  executeRevokeRole,
  askDelete,
  executeDelete,
  exportUser,
  showFleetStats,
  sendFleetChart,
  exportFleetStatsCsv,
  showLeaderboards,
  showErrorFeed,
  showSystemHealth,
  showGrowth,
  showAnomalyFeed,
  showScheduledJobs,
  showUserAccessLog,
  showGlobalConfig,
  showFeatureSwitches,
  toggleFeatureSwitch,
  setGlobalConfig,
  toggleNotifyUsers,
  toggleSignupsPaused,
  showMaintenance,
  toggleMaintenance,
  askMaintenanceMessage,
  handleMaintenanceMessageText,
  skipMaintenanceMessage,
  askMaintenanceSchedule,
  handleMaintenanceScheduleInput,
  askNudge,
  executeNudge,
  exportAll,
  askBroadcast,
  handleBroadcastText,
  executeBroadcast,
  askBroadcastSchedule,
  setBroadcastQuickTime,
  handleBroadcastScheduleCustomTime,
  showBroadcastHistory,
  cancelBroadcast,
  repostBroadcast,
  askBroadcastRecurrence,
  chooseBroadcastRecurrence,
  showReports,
  showReportDetail,
  resolveReport,
  showBulkHub,
  askBulkPurge,
  askCustomNumber,
  handleCustomNumberText,
  askBulkPurgeConfirm,
  executeBulkPurge,
  askBulkSuspend,
  askBulkSuspendHours,
  askBulkSuspendConfirm,
  executeBulkSuspend,
  askBulkMute,
  askBulkMuteConfirm,
  executeBulkMute,
  askBulkDeleteBanned,
  executeBulkDeleteBanned,
  askSearch,
  handleSearchText,
};
