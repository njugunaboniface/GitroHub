/**
 * Change journal (v1.2.5-multi) — remembers what GitroHub itself changed in a repo, so the ⏪ Undo & Restore
 * screens can offer exactly those changes (undo this commit, recover this branch) without making the person
 * dig out a sha. Best-effort by design: a journal failure must never fail the real action.
 *
 * Rows hold ids and names only — never a token, never file content.
 */
const { pool } = require('../db/postgres');
const logger = require('./logger');

const KINDS = new Set(['commit', 'revert', 'restore', 'rollback', 'branch_delete', 'tag_delete']);
const KEEP_DAYS = 90;
const KEEP_ROWS = 300;

/** Who the work is for: explicit `telegramId`, else the current request's user. */
function actor(telegramId) {
  if (telegramId) return telegramId;
  try { return require('./requestContext').current().userId || null; } catch (_) { return null; }
}

/**
 * Records one change. `owner` is the repo owner (an account login or organisation). Never throws.
 * @returns {Promise<number|null>} the journal id
 */
async function record({ telegramId = null, owner = null, accountLogin = null, repo, kind, ref = null, sha = null, prevSha = null, label = '' }) {
  try {
    const id = actor(telegramId);
    if (!id || !repo || !KINDS.has(kind)) return null;
    const { rows } = await pool.query(
      `INSERT INTO change_journal (telegram_id, account_login, owner_login, repo_name, kind, ref_name, sha, prev_sha, label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [id, accountLogin ? String(accountLogin).toLowerCase() : null, owner ? String(owner).toLowerCase() : null, repo, kind, ref, sha, prevSha, String(label || '').split('\n')[0].slice(0, 160)]
    );
    if (Math.random() < 0.05) prune(id).catch(() => {});
    return rows && rows[0] ? Number(rows[0].id) : null;
  } catch (err) {
    logger.debug('change journal: could not record', { error: err && err.message });
    return null;
  }
}

/** Keeps the journal small: nothing older than KEEP_DAYS, and at most KEEP_ROWS per person. */
async function prune(telegramId) {
  await pool.query(`DELETE FROM change_journal WHERE telegram_id = $1 AND created_at < now() - ($2 || ' days')::interval`, [telegramId, String(KEEP_DAYS)]);
  await pool.query(
    `DELETE FROM change_journal WHERE telegram_id = $1 AND id NOT IN (SELECT id FROM change_journal WHERE telegram_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`,
    [telegramId, KEEP_ROWS]
  );
}

/** Newest-first entries for one repo under one owner (owner compared case-insensitively). Not-yet-undone only by default. */
async function list(telegramId, owner, repo, { kinds = null, includeUndone = false, limit = 8, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, kind, ref_name, sha, prev_sha, label, undone_at, created_at, account_login
       FROM change_journal
      WHERE telegram_id = $1 AND repo_name = $2 AND ($3::text IS NULL OR LOWER(owner_login) = $3::text OR owner_login IS NULL)
        AND ($4::text[] IS NULL OR kind = ANY($4::text[])) AND ($5::boolean OR undone_at IS NULL)
      ORDER BY created_at DESC, id DESC LIMIT $6 OFFSET $7`,
    [telegramId, repo, owner ? String(owner).toLowerCase() : null, kinds, includeUndone, limit + 1, offset]
  );
  return { items: rows.slice(0, limit), hasNext: rows.length > limit };
}

/** Newest-first, not-yet-undone changes across ALL of one person's repos under one owner (the Restore center's timeline). */
async function listAll(telegramId, owner, { limit = 30, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, kind, repo_name, ref_name, label, created_at
       FROM change_journal
      WHERE telegram_id = $1 AND ($2::text IS NULL OR LOWER(owner_login) = $2::text OR owner_login IS NULL) AND undone_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
    [telegramId, owner ? String(owner).toLowerCase() : null, limit, offset]
  );
  return rows;
}

async function get(telegramId, id) {
  const { rows } = await pool.query(`SELECT * FROM change_journal WHERE telegram_id = $1 AND id = $2`, [telegramId, id]);
  return rows[0] || null;
}

async function markUndone(telegramId, id) {
  await pool.query(`UPDATE change_journal SET undone_at = now() WHERE telegram_id = $1 AND id = $2`, [telegramId, id]);
}

module.exports = { record, list, listAll, get, markUndone, prune, KINDS };
