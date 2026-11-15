/**
 * Owner web panel — JSON API (v2.2.0-multi).
 *
 * Everything here calls the SAME library functions the bot's Admin Dashboard calls (roles, adminActions, sensitiveActions,
 * globalConfig, reports, adminStats), so a rule that holds in the chat holds here — nothing is re-implemented.
 * Callers (ownerPanel.js) have already checked: valid owner session, same-origin, CSRF token, rate limit.
 *
 * route({ method, path, query, body, session, bot }) → { status, json }
 *   `path` is what follows /owner/api, e.g. '/users/123/ban'.
 */
const { pool } = require('../db/postgres');
const ownerWeb = require('../lib/ownerWeb');
const { ok, fail, int, idOf, text, truthy, likeEscape, failure, namesFor, label } = require('./ownerApi/util');
const MODULES = ['warden', 'team', 'schedule', 'tools', 'insights', 'sessions'].map((m) => require(`./ownerApi/${m}`));
const schedule = require('./ownerApi/schedule');

/** Actions that need a FRESH session (started from a link in the last 10 minutes). */
const DANGEROUS = new Set(['role', 'role_revoke', 'ban', 'broadcast', 'control_danger', 'lockdown', 'bulk', 'team', 'approval', 'export']);

// Switches the Controls page offers. `danger` ones affect everyone, so they need a fresh session.
const CONTROLS = [
  { key: 'maintenance_enabled', label: 'Maintenance mode', hint: 'Pauses the bot for everyone except admins', type: 'bool', danger: true },
  { key: 'signups_paused', label: 'Pause new sign-ups', hint: 'New people can\u2019t start the bot', type: 'bool', danger: true },
  { key: 'notify_users_on_repo_mod', label: 'Tell users about repo moderation', hint: 'Message people when an admin changes their repo', type: 'bool' },
  { key: 'sens_notify_admins', label: 'Warden alerts to admins', hint: 'Notify admins about sensitive activity', type: 'bool' },
  { key: 'sens_hold', label: 'Hold sensitive actions', hint: 'Pause risky actions for review', type: 'bool' },
  { key: 'warden_briefing', label: 'Warden daily briefing', hint: 'Send the daily summary', type: 'bool' },
  { key: 'maintenance_message', label: 'Maintenance message', hint: 'What people see during maintenance', type: 'text' },
  { key: 'default_max_zip_bytes', label: 'Max zip size (bytes)', type: 'number' },
  { key: 'default_max_file_bytes', label: 'Max file size (bytes)', type: 'number' },
  { key: 'default_hourly_action_cap', label: 'Actions per hour, per person', type: 'number' },
  { key: 'default_trash_retention_days', label: 'Trash retention (days)', type: 'number' },
  { key: 'session_ttl_seconds', label: 'Bot session length (seconds)', type: 'number' },
  { key: 'log_retention_days', label: 'Log retention (days)', type: 'number' },
];

/** The user row, reduced to what an admin screen needs — never a token, secret or encrypted column. */
function publicUser(u) {
  if (!u) return null;
  return {
    id: Number(u.telegram_id),
    username: u.telegram_username || null,
    name: u.telegram_first_name || null,
    github: u.github_username || null,
    connected: !!u.github_token_enc || !!u.github_username,
    neverConnected: !u.connected_at,
    blocked: !!u.is_blocked,
    blockedReason: u.blocked_reason || null,
    blockedUntil: u.blocked_until || null,
    suspendedUntil: u.suspended_until || null,
    trusted: !!u.is_trusted,
    isAdmin: !!u.is_admin,
    notes: u.admin_notes || null,
    timezone: u.timezone || null,
    createdAt: u.created_at || null,
    lastActiveAt: u.last_active_at || null,
  };
}

async function overview() {
  const runtimeMetrics = require('../lib/runtimeMetrics');
  const [h, fleet, openReports] = await Promise.all([
    runtimeMetrics.getHealth(),
    require('../lib/adminStats').fleetOverview().catch(() => null),
    require('../lib/reports').openCount().catch(() => 0),
  ]);
  const t = h.traffic;
  const gc = require('../lib/globalConfig');
  return {
    version: require('../../package.json').version,
    uptimeSeconds: Math.round(process.uptime()),
    health: h.status,
    reasons: h.reasons || [],
    postgres: !!(h.pgStatus && h.pgStatus.ok),
    redis: !!(h.redisStatus && h.redisStatus.ok),
    github: t ? { state: t.state, circuit: t.breaker && t.breaker.state, active: t.active, queued: t.queued } : null,
    memoryMB: h.rssMB, lagP99Ms: h.lag && h.lag.p99, cpuPercent: h.cpuPercent, poolWaiting: h.poolWaiting,
    // adminStats.fleetOverview() speaks camelCase (totalUsers, newThisWeek …).
    fleet: fleet && {
      users: fleet.totalUsers, activeToday: fleet.activeToday, connected: fleet.connected, blocked: fleet.blocked,
      suspended: fleet.suspended, newToday: fleet.newToday, newWeek: fleet.newThisWeek, commits: fleet.totalCommits, errorsToday: fleet.errorsToday,
      accounts: fleet.githubAccounts, revokedAccounts: fleet.revokedAccounts, avgCommits: fleet.avgCommitsPerActiveUser,
    },
    openReports,
    maintenance: truthy(gc.get('maintenance_enabled')),
    signupsPaused: truthy(gc.get('signups_paused')),
  };
}

const USER_FILTERS = {
  admins: 'is_admin = TRUE', blocked: 'is_blocked = TRUE', suspended: 'suspended_until > now()',
  never: 'connected_at IS NULL', connected: 'connected_at IS NOT NULL', trusted: 'is_trusted = TRUE',
};

async function listUsers(query) {
  const limit = int(query.limit, 20, 1, 50);
  const offset = int(query.offset, 0, 0, 100000);
  const q = text(query.q, 64).replace(/^@/, '');
  const where = []; const params = [];
  if (q) {
    params.push(q, `%${likeEscape(q)}%`);
    where.push("(telegram_id::text = $1 OR telegram_username ILIKE $2 ESCAPE '\\' OR github_username ILIKE $2 ESCAPE '\\' OR telegram_first_name ILIKE $2 ESCAPE '\\')");
  }
  const f = USER_FILTERS[query.filter];
  if (f) where.push(f);
  params.push(limit + 1, offset);
  const { rows } = await pool.query(
    `SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(last_active_at, created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return ok({ users: rows.slice(0, limit).map(publicUser), hasMore: rows.length > limit, limit, offset, query: q, filter: f ? query.filter : '' });
}

async function userDetail(id) {
  const roles = require('../lib/roles');
  const stats = require('../lib/adminStats');
  const sens = require('../lib/sensitiveActions');
  const [detail, role, pauses, audit, profile, openCase, activity] = await Promise.all([
    stats.userDetail(id),
    roles.getRole(id),
    sens.listPauses(id).catch(() => []),
    stats.auditLog({ limit: 10, targetTelegramId: id }).catch(() => ({ rows: [] })),
    pool.query('SELECT stage, risk, confidence, snooze_until FROM warden_profiles WHERE telegram_id = $1', [id]).then((r) => r.rows[0] || null).catch(() => null),
    pool.query("SELECT id, stage, opened_at FROM warden_cases WHERE telegram_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1", [id]).then((r) => r.rows[0] || null).catch(() => null),
    sens.userActivity(id, { limit: 6 }).catch(() => ({ sensitive: [] })),
  ]);
  if (!detail || !detail.user) return fail(404, 'No such user');
  const accounts = await pool.query('SELECT github_login, health_status FROM github_accounts WHERE telegram_id = $1 ORDER BY 1', [id]).then((r) => r.rows).catch(() => []);
  const registry = require('../handlers/manage/registry');
  const names = await namesFor(pool, audit.rows.flatMap((a) => [a.admin_id, a.target_telegram_id]));
  return ok({
    user: publicUser(detail.user),
    role, isOwner: roles.isOwner(id),
    commits: detail.commitCount, errors: detail.errorCount, lastActivity: detail.lastActivity && { text: detail.lastActivity.summary || detail.lastActivity.text || null, at: detail.lastActivity.created_at },
    accounts: accounts.map((a) => ({ login: a.github_login, health: a.health_status || null })),
    pauses: pauses.map((p) => ({ key: p.feature_key, since: p.created_at, until: p.expires_at })),
    features: registry.list().map((a) => ({ key: a.key, label: a.label })),
    roles: roles.ROLES,
    warden: profile && { stage: profile.stage, risk: profile.risk == null ? null : Number(profile.risk), confidence: profile.confidence == null ? null : Number(profile.confidence), snoozeUntil: profile.snooze_until || null, caseId: openCase ? Number(openCase.id) : null, caseStage: openCase ? openCase.stage : null },
    sensitive: (activity.sensitive || []).map((s) => ({ action: s.action, repo: s.repo_name || null, account: s.account_login || null, score: s.score, flagged: !!s.flagged, at: s.created_at })),
    audit: audit.rows.map((a) => ({ ...a, adminName: label(names, a.admin_id), targetName: label(names, a.target_telegram_id) })),
  });
}

async function controls() {
  const gc = require('../lib/globalConfig');
  const overrides = gc.getAllOverrides();
  const items = CONTROLS.map((c) => ({ ...c, value: overrides[c.key] != null ? overrides[c.key] : null, overridden: overrides[c.key] != null }));
  const features = Object.keys(overrides).filter((k) => /^feature_[a-z][a-z_]{1,29}$/.test(k))
    .map((k) => ({ key: k, label: `Feature: ${k.slice(8).replace(/_/g, ' ')}`, hint: 'off = switched off for everyone', type: 'feature', value: overrides[k], overridden: true }));
  return ok({ items: [...items, ...features] });
}

async function webhooks() {
  const [counts, recent] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS hooks, COUNT(DISTINCT telegram_id)::int AS people FROM repo_webhooks').then((r) => r.rows[0]).catch(() => ({ hooks: 0, people: 0 })),
    pool.query('SELECT telegram_id, repo_name, created_at FROM repo_webhooks ORDER BY created_at DESC LIMIT 10').then((r) => r.rows).catch(() => []),
  ]);
  let live = {};
  try {
    const snap = require('../lib/metrics').snapshot ? require('../lib/metrics').snapshot() : {};
    for (const [k, v] of Object.entries(snap)) if (/^webhook/.test(k)) live[k] = v;
  } catch (_) { live = {}; }
  return ok({ hooks: counts.hooks, people: counts.people, recent: recent.map((r) => ({ id: Number(r.telegram_id), repo: r.repo_name, at: r.created_at })), live });
}

async function route({ method, path, query = {}, body = {}, session, bot = null }) {
  const parts = String(path || '/').split('/').filter(Boolean);
  const owner = session.uid;
  const audit = (target, action, detail) => require('../lib/adminActions').auditLog(owner, target, action, `${detail || ''} [web]`.trim());
  const need = (key) => (DANGEROUS.has(key) && !ownerWeb.isFresh(session)
    ? fail(403, 'This needs a fresh sign-in. Send /owner to the bot and open the new link.', { needFresh: true }) : null);

  try {
    // ── the feature modules (Warden, team, announcements, tools, insights, sessions) ──
    const ctx = { owner, bot, body, query, session, need, audit };
    for (const m of MODULES) {
      const r = await m.handle(method, parts, ctx);
      if (r) return r;
    }

    // ── reads ──
    if (method === 'GET') {
      if (parts[0] === 'overview') return ok(await overview());
      if (parts[0] === 'users' && parts.length === 1) return listUsers(query);
      if (parts[0] === 'users' && parts.length === 2) { const id = idOf(parts[1]); return id ? userDetail(id) : fail(400, 'Bad user id'); }
      if (parts[0] === 'reports') {
        const status = ['open', 'resolved', 'dismissed'].includes(query.status) ? query.status : 'open';
        const limit = int(query.limit, 10, 1, 50); const offset = int(query.offset, 0, 0, 100000);
        const r = await require('../lib/reports').list({ status, limit, offset });
        return ok({ status, total: r.total, limit, offset, reports: r.rows.map((x) => ({ id: x.id, userId: Number(x.telegram_id), username: x.telegram_username || null, name: x.telegram_first_name || null, category: x.category || null, message: x.message, status: x.status, at: x.created_at })) });
      }
      if (parts[0] === 'audit') {
        const stats = require('../lib/adminStats');
        const limit = int(query.limit, 20, 1, 50); const offset = int(query.offset, 0, 0, 100000);
        const [log, actions, admins] = await Promise.all([
          stats.auditLog({ limit, offset, actionType: text(query.action, 40) || null, adminId: idOf(query.admin) }),
          stats.distinctAuditActions().catch(() => []), stats.distinctAuditAdmins().catch(() => []),
        ]);
        const names = await namesFor(pool, log.rows.flatMap((a) => [a.admin_id, a.target_telegram_id]));
        return ok({
          rows: log.rows.map((a) => ({ id: a.id, action: a.action, detail: a.detail || '', created_at: a.created_at, admin_id: a.admin_id == null ? null : Number(a.admin_id), target_telegram_id: a.target_telegram_id == null ? null : Number(a.target_telegram_id), adminName: label(names, a.admin_id), targetName: label(names, a.target_telegram_id) })),
          total: log.total, limit, offset, actions,
          admins: admins.map((a) => ({ id: Number(a.admin_id), name: a.telegram_first_name || (a.telegram_username ? `@${a.telegram_username}` : String(a.admin_id)) })),
        });
      }
      if (parts[0] === 'controls') return controls();
      if (parts[0] === 'webhooks') return webhooks();
      if (parts[0] === 'broadcast' && parts[1] === 'preview') return ok({ recipients: await schedule.recipients(), running: schedule.isRunning() });
      return fail(404, 'Not found');
    }

    if (method !== 'POST') return fail(405, 'Method not allowed');
    const actions = require('../lib/adminActions');

    // ── users ──
    if (parts[0] === 'users' && parts.length === 3) {
      const id = idOf(parts[1]);
      const what = parts[2];
      if (!id) return fail(400, 'Bad user id');
      const roles = require('../lib/roles');
      if (roles.isOwner(id) && !['notes', 'message', 'pause', 'unpause'].includes(what)) return fail(409, 'That is you \u2014 the owner can\u2019t be changed from here.');
      if (roles.isOwner(id) && ['pause'].includes(what)) return fail(409, 'The owner can\u2019t be paused.');

      if (what === 'role') {
        const blocked = need('role'); if (blocked) return blocked;
        const role = text(body.role, 20);
        if (!roles.ROLES.includes(role) || role === 'guest') return fail(400, 'Pick moderator, admin or super_admin.');
        const before = await roles.getRole(id);
        await roles.setRole(owner, id, role);
        await actions.auditLog(owner, id, 'role_change', `${before} \u2192 ${role} [web]`);
        if (bot) require('../lib/adminCommands').syncFor(bot.telegram, id, true).catch(() => {});
        return ok({ ok: true, role });
      }
      if (what === 'role_revoke') {
        const blocked = need('role_revoke'); if (blocked) return blocked;
        const before = await roles.getRole(id);
        await roles.revokeRole(id);
        await actions.auditLog(owner, id, 'role_change', `${before} \u2192 revoked (normal user) [web]`);
        if (bot) require('../lib/adminCommands').syncFor(bot.telegram, id, false).catch(() => {});
        return ok({ ok: true, role: 'guest' });
      }
      if (what === 'ban') {
        const blocked = need('ban'); if (blocked) return blocked;
        const days = body.days ? int(body.days, null, 1, 3650) : null;
        const r = await actions.banUser(owner, id, text(body.reason, 300) || null, bot, days);
        return ok({ ok: true, undoId: (r && r.undoId) || null });
      }
      if (what === 'unban') { await actions.unbanUser(owner, id, bot); return ok(); }
      if (what === 'suspend') {
        const hours = int(body.hours, 24, 1, 24 * 365);
        const r = await actions.suspendUser(owner, id, hours, bot, text(body.reason, 300) || null);
        return ok({ ok: true, undoId: (r && r.undoId) || null });
      }
      if (what === 'unsuspend') { await actions.unsuspendUser(owner, id); return ok(); }
      if (what === 'pause' || what === 'unpause') {
        const key = text(body.key, 40);
        if (!require('../handlers/manage/registry').get(key)) return fail(400, 'Unknown feature');
        if (what === 'pause') await require('../lib/sensitiveActions').pause(owner, id, key, text(body.reason, 200) || null, body.hours ? int(body.hours, null, 1, 24 * 365) : null);
        else await require('../lib/sensitiveActions').unpause(owner, id, key);
        return ok();
      }
      if (what === 'notes') { const clean = await actions.setNotes(owner, id, text(body.notes, 1000)); return ok({ ok: true, notes: clean || null }); }
      if (what === 'message') {
        if (!bot) return fail(503, 'The bot connection isn\u2019t available.');
        const msg = text(body.text, 1500);
        if (!msg) return fail(400, 'Write a message first.');
        await actions.messageUser(owner, id, { text: msg }, bot);
        return ok();
      }
      return fail(404, 'Not found');
    }

    // ── reports ──
    if (parts[0] === 'reports' && parts.length === 3 && parts[2] === 'resolve') {
      const status = body.status === 'dismissed' ? 'dismissed' : 'resolved';
      const id = idOf(parts[1]);
      if (!id) return fail(400, 'Bad report id');
      await require('../lib/reports').resolve(id, owner, status);
      await audit(null, 'report_' + status, `#${id}`);
      return ok();
    }

    // ── controls ──
    if (parts[0] === 'controls' && parts.length === 1) {
      const key = text(body.key, 60);
      const def = CONTROLS.find((c) => c.key === key);
      const isFeature = /^feature_[a-z][a-z_]{1,29}$/.test(key);
      if (!def && !isFeature) return fail(400, 'Unknown setting');
      if (def && def.danger) { const blocked = need('control_danger'); if (blocked) return blocked; }
      const gc = require('../lib/globalConfig');
      if (body.clear) { await gc.clear(owner, key); return ok(); }
      let value = body.value;
      const type = def ? def.type : 'feature';
      if (type === 'bool') value = body.value === true || truthy(body.value) ? 'true' : 'false';
      else if (type === 'feature') value = body.value === 'off' || body.value === false ? 'off' : 'on';
      else if (type === 'number') { const n = Number(value); if (!Number.isFinite(n) || n < 0) return fail(400, 'Enter a number.'); value = String(Math.round(n)); }
      else value = text(value, 500);
      await gc.set(owner, key, value);
      return ok({ ok: true, value });
    }

    // ── broadcast (send now) ──
    if (parts[0] === 'broadcast' && parts.length === 1) {
      const blocked = need('broadcast'); if (blocked) return blocked;
      if (!bot) return fail(503, 'The bot connection isn\u2019t available.');
      const msg = text(body.text, 3500);
      if (!msg) return fail(400, 'Write the announcement first.');
      if (schedule.isRunning()) return fail(409, 'A broadcast is already being sent.');
      const n = await schedule.recipients();
      // Recorded in the shared history like every bot broadcast (born 'processing', so the poller can't send it twice).
      const row = await require('../lib/scheduledBroadcasts').create(owner, msg, null, new Date(), { claimed: true }).catch(() => null);
      schedule.runBroadcast({ owner, bot, msg, row });
      return ok({ ok: true, recipients: n });
    }

    return fail(404, 'Not found');
  } catch (err) {
    return failure(err);
  }
}

module.exports = { route, CONTROLS, DANGEROUS, publicUser, _setBroadcastRunning: (v) => schedule.setRunning(v) };
