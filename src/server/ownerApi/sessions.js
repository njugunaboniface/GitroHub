/** Owner panel — your web sessions and sign-in history (v2.3.0-multi). */
const { ok, fail, int } = require('./util');

async function handle(method, parts, ctx) {
  if (parts[0] !== 'sessions') return undefined;
  const { session, query } = ctx;
  const ownerWeb = require('../../lib/ownerWeb');

  if (method === 'GET' && parts.length === 1) {
    const [list, hist] = await Promise.all([
      ownerWeb.listSessions(session.sid),
      require('../../lib/adminStats').auditLog({ limit: int(query.limit, 12, 1, 40), actionType: 'web_login' }).catch(() => ({ rows: [] })),
    ]);
    return ok({
      sessions: list.map((s) => ({ ref: s.ref, current: s.current, device: s.device, ip: s.ip, createdAt: s.createdAt })),
      history: hist.rows.map((h) => ({ detail: h.detail || '', at: h.created_at })),
      ttlHours: Math.round(ownerWeb.SESSION_TTL_S / 3600), freshMinutes: Math.round(ownerWeb.FRESH_MS / 60000),
    });
  }
  if (method !== 'POST') return fail(405, 'Method not allowed');
  if (parts[1] === 'revoke_others') {
    const n = await ownerWeb.revokeOthers(session.sid);
    await ctx.audit(null, 'web_revoke', `${n} other session(s)`);
    return ok({ ok: true, revoked: n });
  }
  if (parts[1] === 'revoke') {
    const ref = String((ctx.body && ctx.body.ref) || '');
    if (!/^[a-f0-9]{64}$/.test(ref)) return fail(400, 'Bad session.');
    await ownerWeb.revokeRef(ref);
    await ctx.audit(null, 'web_revoke', '1 session');
    return ok();
  }
  return fail(404, 'Not found');
}

module.exports = { handle };
