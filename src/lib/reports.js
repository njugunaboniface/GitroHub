const { pool } = require('../db/postgres');

/**
 * 🚩 User Reports — see schema.sql's comment for why this exists: every
 * other admin↔user signal runs admin→user (ban/suspend/message) or is
 * automated (anomaly/suspicious flags); this is the only channel a user
 * can use to actually flag something TO an admin. `category` (bug/abuse/
 * other) lets the 🚩 Reports queue be scanned at a glance instead of
 * every row needing to be opened to know what kind of problem it is.
 */
async function create(telegramId, message, category = 'other') {
  const { rows } = await pool.query(
    'INSERT INTO user_reports (telegram_id, message, category) VALUES ($1, $2, $3) RETURNING *',
    [telegramId, message.trim().slice(0, 2000), category]
  );
  return rows[0];
}

/** How many reports this person still has open — used to cap how many they can have in the queue at once. */
async function countOpenByUser(telegramId) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM user_reports WHERE telegram_id = $1 AND status = 'open'`, [telegramId]);
  return rows[0].c;
}

/** Powers the 🚩 Reports badge on the Dashboard — open count only, so
 * checking it never means paying for the full list query. */
async function openCount() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM user_reports WHERE status = 'open'`);
  return rows[0].c;
}

async function list({ status = 'open', limit = 8, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT r.*, u.telegram_username, u.telegram_first_name FROM user_reports r
     LEFT JOIN users u ON u.telegram_id = r.telegram_id
     WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );
  const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS c FROM user_reports WHERE status = $1', [status]);
  return { rows, total: countRows[0].c };
}

async function get(id) {
  const { rows } = await pool.query(
    `SELECT r.*, u.telegram_username, u.telegram_first_name FROM user_reports r
     LEFT JOIN users u ON u.telegram_id = r.telegram_id WHERE r.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** `status` is 'resolved' or 'dismissed' — kept as two distinct end states
 * (not one generic "closed") so the Dashboard can tell "an admin actually
 * did something about this" apart from "this wasn't actionable," same
 * distinction Unban vs a bulk-purge skip already draws elsewhere. */
async function resolve(id, adminId, status) {
  await pool.query(
    `UPDATE user_reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1 AND status = 'open'`,
    [id, status, adminId]
  );
}

module.exports = { create, openCount, countOpenByUser, list, get, resolve };
