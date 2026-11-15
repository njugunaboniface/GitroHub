const { pool } = require('../db/postgres');

/**
 * 🗑️ Trash — see db/schema.sql's trashed_repos table for the storage
 * approach (the zip snapshot lives as a Telegram document in the person's
 * own chat; this table just tracks its file_id plus enough metadata to
 * restore or display it).
 *
 * retentionDays === 0 means "Never" (My Defaults' 🗑️ Trash Retention) —
 * stored as a NULL expires_at rather than some fake far-future date, so
 * list()/pruneExpired() just treat NULL as "not expired, ever".
 */
async function add(telegramId, { originalName, description, visibility, backupFileId, retentionDays, restorable = true }) {
  // v1.2.5-multi: remember WHICH account and owner the repo was deleted from, so restoring it can never
  // quietly re-create it under a different account just because that one is active later.
  const { owner, account } = await currentScope(telegramId);
  const { rows } = await pool.query(
    `INSERT INTO trashed_repos (telegram_id, original_name, description, visibility, backup_file_id, expires_at, restorable, owner_login, account_login)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int = 0 THEN NULL ELSE now() + ($6::int * interval '1 day') END, $7, $8, $9)
     RETURNING *`,
    [telegramId, originalName, description || null, visibility, backupFileId, retentionDays, restorable, owner, account]
  );
  return rows[0];
}

/** { owner, account } the person is working in right now (logins, or null when unknown). */
async function currentScope(telegramId) {
  return require('./ownerScope').scope(telegramId);
}

/**
 * Can this entry be restored under the account that is active right now? An entry made before 1.2.5 has no
 * account and is always restorable (as before). Otherwise it must be the SAME account — returns
 * { ok: true } or { ok: false, account } naming the account to switch to first.
 */
async function restoreTarget(telegramId, entry) {
  if (!entry || !entry.account_login) return { ok: true };
  const active = await require('./accounts').activeLoginOf(telegramId).catch(() => null);
  if (!active || String(active).toLowerCase() === String(entry.account_login).toLowerCase()) return { ok: true };
  return { ok: false, account: entry.account_login };
}

/**
 * Whether a trash entry can still be acted on. A NULL expires_at means "kept
 * indefinitely" (retention "Never") — it must NOT be read as an expired date:
 * `new Date(null)` is the 1970 epoch, which made every "Never" entry
 * unrestorable (v1.2.3-multi fix).
 */
function isAvailable(entry, now = Date.now()) {
  if (!entry || entry.restored_at) return false;
  if (entry.expires_at == null) return true;
  return new Date(entry.expires_at).getTime() > now;
}

/** Everything still recoverable — not yet restored, not yet expired
 * (NULL expires_at = never expires). */
async function list(telegramId) {
  const { rows } = await pool.query(
    `SELECT * FROM trashed_repos
     WHERE telegram_id = $1 AND restored_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     ORDER BY deleted_at DESC`,
    [telegramId]
  );
  return rows;
}

/** One entry by id — null when it doesn't exist or has already expired, so an
 * old button can't act on something the daily sweep simply hasn't removed yet. */
async function get(telegramId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM trashed_repos
     WHERE telegram_id = $1 AND id = $2 AND (expires_at IS NULL OR expires_at > now())`,
    [telegramId, id]
  );
  return rows[0] || null;
}

async function markRestored(telegramId, id) {
  await pool.query(
    `UPDATE trashed_repos SET restored_at = now() WHERE telegram_id = $1 AND id = $2`,
    [telegramId, id]
  );
}

/** Edits a trash entry's own record before it's restored — used by
 * "✏️ Edit & Restore" so the collision check and eventual GitHub creation
 * both see the updated values (see handlers/trash.js's requestRestore,
 * which re-fetches the entry fresh every time). */
const EDITABLE_FIELDS = { originalName: 'original_name', description: 'description', visibility: 'visibility' };
async function update(telegramId, id, field, value) {
  const col = EDITABLE_FIELDS[field];
  if (!col) throw new Error(`Unknown trashed_repos field: ${field}`);
  await pool.query(
    `UPDATE trashed_repos SET ${col} = $1 WHERE telegram_id = $2 AND id = $3 AND restored_at IS NULL`,
    [value, telegramId, id]
  );
}

/** Permanently removes a trash entry — "🗑️ Delete Forever", for when
 * someone wants it gone right now instead of waiting for expiry. The
 * backup document itself isn't (and can't be) deleted from the person's
 * own Telegram chat history from here — this just removes the bot's
 * record of it, matching what expiry already does under the hood. */
async function remove(telegramId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM trashed_repos WHERE telegram_id = $1 AND id = $2 AND restored_at IS NULL`,
    [telegramId, id]
  );
  return rowCount > 0;
}

/** Called daily by the automation scheduler — expired rows just get
 * dropped from the table. NULL expires_at ("Never" retention) is excluded
 * so those never get swept up here. There's no separate cleanup needed on
 * the Telegram side; an unreferenced file_id simply stops being useful
 * once nothing in the bot points at it anymore. */
async function pruneExpired() {
  const { rowCount } = await pool.query(
    `DELETE FROM trashed_repos WHERE expires_at IS NOT NULL AND expires_at <= now() AND restored_at IS NULL`
  );
  return rowCount;
}

/** Restores a trash entry as-is, from a Settings Export/Import file —
 * preserves the original deleted_at/expires_at (skipping anything that's
 * already expired by import time) rather than starting a fresh retention
 * clock, since this is "bring back what was there," not "re-delete it
 * today." Only meaningful when imported back into the SAME bot/account —
 * backup_file_id is a Telegram file reference, not portable elsewhere. */
async function importEntry(telegramId, { originalName, description, visibility, backupFileId, deletedAt, expiresAt, restorable = true, ownerLogin = null, accountLogin = null }) {
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return null; // already expired — nothing to restore
  // v1.2.3-multi: importing the same file twice must not duplicate entries.
  const existing = await pool.query(
    'SELECT 1 FROM trashed_repos WHERE telegram_id = $1 AND original_name = $2 AND backup_file_id = $3 AND restored_at IS NULL LIMIT 1',
    [telegramId, originalName, backupFileId]
  );
  if (existing.rows.length > 0) return null;
  const { rows } = await pool.query(
    `INSERT INTO trashed_repos (telegram_id, original_name, description, visibility, backup_file_id, deleted_at, expires_at, restorable, owner_login, account_login)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7, $8, $9, $10)
     RETURNING *`,
    [telegramId, originalName, description || null, visibility, backupFileId, deletedAt || null, expiresAt || null, restorable !== false, ownerLogin || null, accountLogin || null]
  );
  return rows[0];
}

module.exports = { add, list, get, markRestored, update, remove, pruneExpired, importEntry, isAvailable, currentScope, restoreTarget };
