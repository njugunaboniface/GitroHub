const { pool } = require('../db/postgres');
const ownerScope = require('./ownerScope');

/**
 * 📌 Pins — v1.2.5-multi: scoped to the OWNER the person is looking at (their active account, or the
 * organisation they switched to), so a same-named repo under another account no longer shares a pin.
 * A row written before 1.2.5 has no owner and stays visible under every owner, exactly as before; when
 * both a legacy and an owner-specific row exist for one name, the owner-specific one wins.
 * Every function keeps its old signature — the owner is resolved here, never by the caller.
 */
const VISIBLE = '(owner_login IS NULL OR $2::text IS NULL OR LOWER(owner_login) = $2::text)';

async function list(telegramId) {
  const owner = await ownerScope.current(telegramId);
  const { rows } = await pool.query(
    `SELECT repo_name, position, pin_section FROM (
       SELECT DISTINCT ON (repo_name) repo_name, position, pin_section
         FROM pinned_repos
        WHERE telegram_id = $1 AND ${VISIBLE}
        ORDER BY repo_name, (owner_login IS NULL) ASC
     ) p
     ORDER BY pin_section NULLS FIRST, position ASC`,
    [telegramId, owner]
  );
  return rows;
}

/** Pins grouped by section for the Pinned screen — NULL section renders as
 * the default "📌 Pinned" cluster, others as their own labeled group. */
async function listGrouped(telegramId) {
  const pins = await list(telegramId);
  const groups = new Map();
  for (const p of pins) {
    const key = p.pin_section || null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.entries()].map(([section, items]) => ({ section, items }));
}

async function isPinned(telegramId, repoName) {
  const owner = await ownerScope.current(telegramId);
  const { rows } = await pool.query(
    `SELECT 1 FROM pinned_repos WHERE telegram_id = $1 AND repo_name = $3 AND ${VISIBLE} LIMIT 1`,
    [telegramId, owner, repoName]
  );
  return rows.length > 0;
}

async function pin(telegramId, repoName, section = null) {
  const owner = await ownerScope.current(telegramId);
  const { rows } = await pool.query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM pinned_repos WHERE telegram_id = $1',
    [telegramId]
  );
  await pool.query(
    `INSERT INTO pinned_repos (telegram_id, repo_name, position, pin_section, owner_login)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telegram_id, repo_name, (COALESCE(LOWER(owner_login), ''))) DO NOTHING`,
    [telegramId, repoName, rows[0].next, section, owner]
  );
}

async function setSection(telegramId, repoName, section) {
  const owner = await ownerScope.current(telegramId);
  await pool.query(
    `UPDATE pinned_repos SET pin_section = $3 WHERE telegram_id = $1 AND repo_name = $4 AND ${VISIBLE}`,
    [telegramId, owner, section || null, repoName]
  );
}

async function listSections(telegramId) {
  const owner = await ownerScope.current(telegramId);
  const { rows } = await pool.query(
    `SELECT DISTINCT pin_section FROM pinned_repos
      WHERE telegram_id = $1 AND ${VISIBLE} AND pin_section IS NOT NULL ORDER BY pin_section`,
    [telegramId, owner]
  );
  return rows.map((r) => r.pin_section);
}

async function unpin(telegramId, repoName, { stash = true } = {}) {
  const owner = await ownerScope.current(telegramId);
  // v1.3.0-multi: a deliberate unpin keeps a 30-day copy for 🧯 Restore center (not when the repo itself is gone).
  const sd = require('./softDelete');
  const had = stash ? await sd.safe(async () => (await pool.query(
    `SELECT repo_name, position, pin_section, owner_login FROM pinned_repos WHERE telegram_id = $1 AND repo_name = $3 AND ${VISIBLE}`,
    [telegramId, owner, repoName])).rows) : null;
  await pool.query(
    `DELETE FROM pinned_repos WHERE telegram_id = $1 AND repo_name = $3 AND ${VISIBLE}`,
    [telegramId, owner, repoName]
  );
  if (had && had.length) sd.stash(telegramId, 'pin', `Pin: ${repoName}`, { type: 'pin', rows: had }, { ownerLogin: owner });
}

/** Swaps the position of a pin with its immediate neighbor WITHIN THE SAME
 * SECTION (up = -1, down = +1) — reordering shouldn't jump a pin across
 * section boundaries; use setSection for that. */
async function move(telegramId, repoName, direction) {
  const owner = await ownerScope.current(telegramId);
  const all = await list(telegramId);
  const idx = all.findIndex((p) => p.repo_name === repoName);
  if (idx === -1) return;
  const section = all[idx].pin_section;
  const sameSection = all.filter((p) => p.pin_section === section);
  const localIdx = sameSection.findIndex((p) => p.repo_name === repoName);
  const swapIdx = localIdx + direction;
  if (swapIdx < 0 || swapIdx >= sameSection.length) return; // no-op at either end

  const a = sameSection[localIdx];
  const b = sameSection[swapIdx];
  await pool.query(`UPDATE pinned_repos SET position = $1 WHERE telegram_id = $3 AND repo_name = $4 AND ${VISIBLE}`, [b.position, owner, telegramId, a.repo_name]);
  await pool.query(`UPDATE pinned_repos SET position = $1 WHERE telegram_id = $3 AND repo_name = $4 AND ${VISIBLE}`, [a.position, owner, telegramId, b.repo_name]);
}

async function clearAll(telegramId) {
  const owner = await ownerScope.current(telegramId);
  await pool.query(`DELETE FROM pinned_repos WHERE telegram_id = $1 AND ${VISIBLE}`, [telegramId, owner]);
}

async function removeByRepoName(telegramId, repoName) {
  await unpin(telegramId, repoName, { stash: false });
}

module.exports = {
  list, listGrouped, isPinned, pin, unpin, move, clearAll, removeByRepoName,
  setSection, listSections,
};
