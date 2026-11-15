const { pool } = require('../db/postgres');
const logger = require('./logger');

/**
 * Records one line into the Activity Log (Settings -> 📜 Activity), or the
 * Automation Log (Settings -> 🤖 Automation -> 📜 Automation Log) when
 * isAutomated is set — same table, same row shape, just a different filter
 * at read time so "things I did" and "things GitroHub did on its own"
 * (auto-tag rules, applied suggestions) stay visually separate.
 * icon        e.g. '⬆️', '➕', '🗑', '⚠️', '🔒', '🍴', '🤖'
 * summary     e.g. "Uploaded 4 files → weather-app"
 * detail      optional longer text (full error message, stack, etc.)
 * isError     marks it so it also shows under "⚠️ Errors Only" filter
 * isAutomated marks it so it also shows under the Automation Log
 */
async function log(telegramId, icon, summary, { detail = null, isError = false, isAutomated = false, isCommit = false } = {}) {
  // This is an audit trail, not the action itself — by the time anything
  // calls log(), whatever it's recording (disconnect, commit, connect…)
  // has already happened. A failure writing the *record* of that success
  // must never look like the action itself failed, so this never throws:
  // it's caught and reported to our own logs instead of the caller's
  // bot.catch(), which otherwise replaces the real success reply with a
  // scary "Something went wrong" for something that fully worked.
  if (isError) require('./wardenBrain/collector').recordError(telegramId);
  try {
    await pool.query(
      `INSERT INTO activity_log (telegram_id, icon, summary, detail, is_error, is_automated, is_commit)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [telegramId, icon, summary, detail, isError, isAutomated, isCommit]
    );
  } catch (e) {
    logger.error({ err: e, telegramId, icon, summary }, 'activity.log: failed to write activity_log row (swallowed)');
  }
}

/** Standardized commit count for one user — feeds the Admin Dashboard's
 * per-user detail card (and could feed a future self-serve Stats screen).
 * See schema.sql's is_commit column comment for why this exists instead
 * of guessing from icons. */
async function commitCount(telegramId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS c FROM activity_log WHERE telegram_id = $1 AND is_commit = TRUE',
    [telegramId]
  );
  return rows[0].c;
}

async function recent(telegramId, { limit = 6, offset = 0, errorsOnly = false, automatedOnly = false } = {}) {
  const conditions = [];
  if (errorsOnly) conditions.push('is_error = TRUE');
  if (automatedOnly) conditions.push('is_automated = TRUE');
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM activity_log
     WHERE telegram_id = $1 ${where}
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [telegramId, limit, offset]
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM activity_log WHERE telegram_id = $1 ${where}`,
    [telegramId]
  );
  return { rows, total: countRows[0].total };
}

/** #7 — looks for a rename event landing on this exact repo name within
 * the last N days, to show "renamed from X" so a forgotten rename doesn't
 * look like the repo went missing. Matches the exact log format written
 * in scenes/renameRepo.js ('Renamed → oldName → newName'). */
async function recentRename(telegramId, repoName, withinDays = 14) {
  // Escape LIKE wildcards in the repo name itself — GitHub repo names can
  // contain underscores, which is also SQL's LIKE "any single character"
  // wildcard, so an unescaped repo name here could match the wrong repo.
  const escaped = repoName.replace(/[%_\\]/g, '\\$&');
  const { rows } = await pool.query(
    `SELECT summary, created_at FROM activity_log
     WHERE telegram_id = $1 AND icon = '✏️' AND summary LIKE 'Renamed → %'
       AND summary LIKE $2 ESCAPE '\\' AND created_at > now() - ($3 || ' days')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [telegramId, `%→ ${escaped}`, withinDays]
  );
  if (!rows[0]) return null;
  const match = rows[0].summary.match(/Renamed → (.+) → .+$/);
  return match ? { previousName: match[1], renamedAt: rows[0].created_at } : null;
}

/** Deletes activity_log rows older than N days — called daily by the
 * scheduler in index.js. Without this the table grows forever; nothing
 * else in the app ever removes a row from it. */
async function pruneOlderThan(days) {
  const { rowCount } = await pool.query(
    `DELETE FROM activity_log WHERE created_at < now() - ($1 || ' days')::interval`,
    [days]
  );
  return rowCount;
}

module.exports = { log, recent, recentRename, pruneOlderThan, commitCount };
