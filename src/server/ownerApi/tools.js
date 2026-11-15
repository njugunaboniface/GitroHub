/**
 * Owner panel — undo, bulk tools and exports (v2.3.0-multi). Same libraries as the bot's Admin Dashboard.
 * Destructive bulk actions also need the word DELETE typed by the owner (the page asks; the server checks).
 */
const { pool } = require('../../db/postgres');
const { ok, fail, file, int, idOf, text, truthy, namesFor, label } = require('./util');

const UNDO_REASON = { not_found: [404, 'That undo entry no longer exists.'], 'already-undone': [409, 'That was already undone.'], expired: [410, 'The undo window (1 hour) has passed.'] };

async function previewCounts() {
  const q = (sql, p = []) => pool.query(sql, p).then((r) => Number(r.rows[0].n)).catch(() => 0);
  const [neverAll, never30, banned, active, stale, hooks] = await Promise.all([
    q('SELECT COUNT(*)::int AS n FROM users WHERE connected_at IS NULL AND is_admin = FALSE'),
    q("SELECT COUNT(*)::int AS n FROM users WHERE connected_at IS NULL AND is_admin = FALSE AND created_at < now() - interval '30 days'"),
    q('SELECT COUNT(*)::int AS n FROM users WHERE is_blocked = TRUE AND is_admin = FALSE'),
    q('SELECT COUNT(*)::int AS n FROM users WHERE is_blocked = FALSE AND is_admin = FALSE'),
    q("SELECT COUNT(*)::int AS n FROM users WHERE is_blocked = FALSE AND is_admin = FALSE AND (last_active_at IS NULL OR last_active_at < now() - interval '30 days')"),
    q('SELECT COUNT(DISTINCT (telegram_id, repo_name))::int AS n FROM repo_webhooks'),
  ]);
  return { neverConnected: neverAll, neverConnected30d: never30, banned, activeNonAdmins: active, stale30d: stale, webhookPairs: hooks };
}

async function handle(method, parts, ctx) {
  const { owner, bot, body, query, need } = ctx;

  // ── undo ──
  if (parts[0] === 'undo') {
    if (method === 'GET' && parts.length === 1) {
      const { rows } = await pool.query('SELECT id, admin_id, action_type, target_ids, created_at, expires_at FROM admin_undo_log WHERE undone_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 20');
      const parsed = rows.map((r) => { let ids = []; try { ids = JSON.parse(r.target_ids); } catch (_) { ids = []; } return { r, ids }; });
      const names = await namesFor(pool, parsed.flatMap((p) => p.ids.slice(0, 3)).concat(parsed.map((p) => p.r.admin_id)));
      return ok({ entries: parsed.map(({ r, ids }) => ({ id: Number(r.id), action: r.action_type, count: ids.length, targets: ids.slice(0, 3).map((i) => ({ id: Number(i), name: label(names, i) })), by: label(names, r.admin_id), at: r.created_at, expiresAt: r.expires_at })) });
    }
    if (method === 'POST' && parts.length === 2) {
      const id = idOf(parts[1]); if (!id) return fail(400, 'Bad id');
      const r = await require('../../lib/adminActions').undoAction(owner, id, bot);
      if (!r.ok) { const [s, m] = UNDO_REASON[r.reason] || [409, 'Could not undo that.']; return fail(s, m); }
      return ok({ ok: true, action: r.actionType });
    }
    return undefined;
  }

  // ── bulk tools ──
  if (parts[0] === 'bulk') {
    if (method === 'GET' && parts[1] === 'preview') return ok(await previewCounts());
    if (method !== 'POST' || parts.length !== 2) return undefined;
    const blocked = need('bulk'); if (blocked) return blocked;
    const actions = require('../../lib/adminActions');
    const what = parts[1];
    const typed = text(body.confirm, 10);
    if (['purge', 'delete_banned'].includes(what) && typed !== 'DELETE') return fail(400, 'Type DELETE to confirm this.');
    if (what === 'suspend') {
      const scope = body.scope === 'stale' ? 'stale' : 'all';
      const hours = int(body.hours, 24, 1, 24 * 90);
      const r = await actions.bulkSuspend(owner, scope, hours, bot);
      await ctx.audit(null, 'bulk_suspend_web', `${scope}, ${hours}h`);
      return ok({ ok: true, result: r, undoId: (r && r.undoId) || null });
    }
    if (what === 'mute') { const r = await actions.bulkMuteAll(owner, truthy(body.mute)); return ok({ ok: true, result: r, undoId: (r && typeof r === 'object' && r.undoId) || null }); }
    if (what === 'nudge') {
      if (!bot) return fail(503, 'The bot connection isn\u2019t available.');
      return ok({ ok: true, result: await actions.nudgeNeverConnected(owner, bot) });
    }
    if (what === 'purge') {
      const days = body.days === null || body.days === '' || body.days === undefined ? null : int(body.days, 30, 1, 3650);
      return ok({ ok: true, removed: await actions.bulkPurgeNeverConnected(owner, days) });
    }
    if (what === 'delete_banned') return ok({ ok: true, removed: await actions.bulkDeleteBanned(owner) });
    return fail(404, 'Not found');
  }

  // ── exports ──
  if (parts[0] === 'export' && parts[1] === 'users' && method === 'GET') {
    const blocked = need('export'); if (blocked) return blocked;
    const out = await require('../../lib/adminActions').exportAllUsers(owner);
    return file(out.content, 'application/json; charset=utf-8', out.filename);
  }
  void query;
  return undefined;
}

module.exports = { handle, previewCounts };
