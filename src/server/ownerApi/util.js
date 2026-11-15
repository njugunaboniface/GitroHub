/** Shared helpers for the owner panel's API modules (v2.3.0-multi). */
const ok = (json = { ok: true }) => ({ status: 200, json });
const fail = (status, error, extra = {}) => ({ status, json: { error, ...extra } });
/** A file download: { raw, contentType, filename }. */
const file = (raw, contentType, filename) => ({ status: 200, raw, contentType, filename: String(filename || 'download.txt').replace(/[^\w.\-]+/g, '_') });
const int = (v, d, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const idOf = (v) => (/^\d{1,15}$/.test(String(v)) ? Number(v) : null);
const text = (v, max) => String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);
const truthy = (v) => v === true || ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase());
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/** One calm answer for any thrown error (never a stack trace). */
function failure(err) {
  const m = String((err && err.message) || err);
  if (m === 'admin_protected') return fail(409, 'That person is an admin, so this isn\u2019t allowed.');
  if (m === 'not_owner') return fail(403, 'Only the owner can do this.');
  if (m === 'cannot_lock_owner') return fail(409, 'The owner can\u2019t be locked.');
  return fail(400, m.slice(0, 200));
}

/** id → { name, username } for a set of Telegram ids, so lists can show people instead of numbers. */
async function namesFor(pool, ids) {
  const clean = [...new Set(ids.filter((x) => x != null).map(Number).filter(Number.isFinite))];
  if (!clean.length) return new Map();
  try {
    const { rows } = await pool.query('SELECT telegram_id, telegram_username, telegram_first_name FROM users WHERE telegram_id = ANY($1::bigint[])', [clean]);
    return new Map(rows.map((r) => [Number(r.telegram_id), { name: r.telegram_first_name || null, username: r.telegram_username || null }]));
  } catch (_) { return new Map(); }
}
const label = (m, id) => { const n = m.get(Number(id)); return n ? (n.name || (n.username ? `@${n.username}` : String(id))) : (id == null ? null : String(id)); };

module.exports = { ok, fail, file, int, idOf, text, truthy, likeEscape, failure, namesFor, label };
