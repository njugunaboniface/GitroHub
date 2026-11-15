const { pool } = require('../db/postgres');
const filterClauses = require('./filterClauses');

/** The saved clause list, or null when the stored JSON is unreadable. */
function parseClauses(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

async function list(telegramId) {
  const { rows } = await pool.query(
    'SELECT id, name, filter_json, position FROM saved_views WHERE telegram_id = $1 ORDER BY position ASC, id ASC',
    [telegramId]
  );
  // A row whose JSON is damaged is skipped rather than breaking the whole list (v1.2.3-multi).
  return rows.map((r) => ({ ...r, clauses: parseClauses(r.filter_json) })).filter((r) => r.clauses !== null);
}

async function get(telegramId, viewId) {
  const { rows } = await pool.query(
    'SELECT id, name, filter_json FROM saved_views WHERE telegram_id = $1 AND id = $2',
    [telegramId, viewId]
  );
  if (!rows[0]) return null;
  const clauses = parseClauses(rows[0].filter_json);
  return clauses === null ? null : { ...rows[0], clauses };
}

async function create(telegramId, name, clauses) {
  const { rows: posRows } = await pool.query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM saved_views WHERE telegram_id = $1',
    [telegramId]
  );
  const { rows } = await pool.query(
    `INSERT INTO saved_views (telegram_id, name, filter_json, position) VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id, name) DO UPDATE SET filter_json = $3
     RETURNING id, name, filter_json, position`,
    [telegramId, name.trim(), JSON.stringify(clauses), posRows[0].next]
  );
  return rows[0];
}

async function remove(telegramId, viewId) {
  // v1.3.0-multi: keep a 30-day copy for 🧯 Restore center (best-effort, never blocks the delete).
  const sd = require('./softDelete');
  const had = await sd.safe(async () => (await pool.query('SELECT name, filter_json, position FROM saved_views WHERE telegram_id = $1 AND id = $2', [telegramId, viewId])).rows[0]);
  await pool.query('DELETE FROM saved_views WHERE telegram_id = $1 AND id = $2', [telegramId, viewId]);
  if (had) sd.stash(telegramId, 'view', `Saved view: ${had.name}`, { type: 'view', ...had });
}

/** Runs a saved view's stored clauses against an already-fetched repo list
 * (same repoCache.getRepos data every other list screen uses — no separate
 * fetch path). */
async function apply(telegramId, view, repos) {
  const ctx = await filterClauses.buildTagContext(telegramId, view.clauses);
  return filterClauses.applyClauses(repos, view.clauses, ctx);
}

module.exports = { list, get, create, remove, apply };
