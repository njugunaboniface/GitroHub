/** Owner panel — admin team (v2.3.0-multi): roster, roles, dashboard locks, add an admin. Same libraries as the bot. */
const { pool } = require('../../db/postgres');
const { ok, fail, idOf, text } = require('./util');

async function handle(method, parts, ctx) {
  if (parts[0] !== 'team') return undefined;
  const { owner, bot, body, need } = ctx;
  const roles = require('../../lib/roles');
  const lockdown = require('../../lib/lockdown');
  const sync = (id, isAdmin) => { if (bot) require('../../lib/adminCommands').syncFor(bot.telegram, id, isAdmin).catch(() => {}); };

  if (method === 'GET' && parts.length === 1) {
    const [admins, locked] = await Promise.all([roles.listAdmins(), lockdown.getLockedAdmins().catch(() => [])]);
    const lockedAt = new Map(locked.map((l) => [Number(l.telegram_id), l.dashboard_locked_at]));
    const ownerId = Number(require('../../config').OWNER_ID);
    const rows = admins.filter((a) => a.telegram_id !== ownerId).map((a) => ({
      id: a.telegram_id, name: a.telegram_first_name || null, username: a.telegram_username || null, role: a.role,
      grantedBy: a.granted_by == null ? null : a.granted_by, grantedAt: a.granted_at || null, locked: lockedAt.has(a.telegram_id), lockedAt: lockedAt.get(a.telegram_id) || null,
    }));
    const { rows: [me] } = await pool.query('SELECT telegram_username, telegram_first_name FROM users WHERE telegram_id = $1', [ownerId]).catch(() => ({ rows: [{}] }));
    return ok({
      owner: { id: ownerId, name: (me && me.telegram_first_name) || null, username: (me && me.telegram_username) || null },
      admins: rows, roles: roles.ROLES.filter((r) => r !== 'guest'), lockdownActive: !!lockdown.isFullLockdownActive(),
    });
  }
  if (method !== 'POST') return fail(405, 'Method not allowed');

  if (parts.length === 2 && parts[1] === 'add') {
    const blocked = need('team'); if (blocked) return blocked;
    const id = idOf(body.id); const role = text(body.role, 20);
    if (!id) return fail(400, 'Enter a numeric Telegram ID.');
    if (roles.isOwner(id)) return fail(409, 'That is you \u2014 the owner already has every right.');
    if (!roles.ROLES.includes(role) || role === 'guest') return fail(400, 'Pick moderator, admin or super_admin.');
    const before = await roles.getRole(id);
    await roles.setRole(owner, id, role);
    await ctx.audit(id, 'role_change', `${before} \u2192 ${role}`);
    sync(id, true);
    return ok({ ok: true });
  }
  if (parts.length === 3) {
    const id = idOf(parts[1]); const what = parts[2];
    if (!id) return fail(400, 'Bad user id');
    if (roles.isOwner(id)) return fail(409, 'That is you \u2014 the owner can\u2019t be changed from here.');
    if (what === 'lock') { await lockdown.lockAdmin(owner, id); await ctx.audit(id, 'dashboard_lock', ''); return ok(); }
    if (what === 'unlock') {
      const blocked = need('team'); if (blocked) return blocked;
      await lockdown.unlockAdmin(id); await ctx.audit(id, 'dashboard_unlock', ''); return ok();
    }
    if (what === 'role') {
      const blocked = need('team'); if (blocked) return blocked;
      const role = text(body.role, 20);
      if (!roles.ROLES.includes(role) || role === 'guest') return fail(400, 'Pick moderator, admin or super_admin.');
      const before = await roles.getRole(id);
      await roles.setRole(owner, id, role); await ctx.audit(id, 'role_change', `${before} \u2192 ${role}`); sync(id, true);
      return ok({ ok: true, role });
    }
    if (what === 'revoke') {
      const blocked = need('team'); if (blocked) return blocked;
      const before = await roles.getRole(id);
      await roles.revokeRole(id); await ctx.audit(id, 'role_change', `${before} \u2192 revoked (normal user)`); sync(id, false);
      return ok({ ok: true });
    }
  }
  return fail(404, 'Not found');
}

module.exports = { handle };
