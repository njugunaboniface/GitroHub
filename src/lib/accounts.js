/**
 * Several GitHub accounts per Telegram user + the active organisation (v1.2.4-multi).
 *
 * Design: `users.github_token_enc / github_username / github_scope` always mirror the ACTIVE
 * account, so every existing code path (which reads the user's one token) keeps working
 * unchanged. `github_accounts` holds all of a person's accounts; switching copies the chosen
 * account's token/login/scope into the users row. `users.active_owner` is NULL for the personal
 * account or an organisation login — repoCache.getUser() reports that owner as `login`, which is
 * what every existing "<owner>/<repo>" call already uses.
 *
 * Deliberately has no dependency on lib/users.js (users.js requires this file).
 */
const { pool } = require('../db/postgres');
const { encrypt, tryDecrypt } = require('./crypto');
const { BoundedMap } = require('./boundedMap');

const MAX_ACCOUNTS = 5;

const ownerCache = new BoundedMap({ max: 5000, name: 'activeOwner' }); // telegramId -> { owner }

function toView(row, activeLogin) {
  return {
    id: Number(row.id),
    login: row.github_login,
    scope: row.scope || '',
    addedAt: row.added_at,
    lastUsedAt: row.last_used_at,
    active: !!activeLogin && String(row.github_login).toLowerCase() === String(activeLogin).toLowerCase(),
  };
}

async function activeLoginOf(telegramId) {
  const { rows } = await pool.query(
    'SELECT github_username FROM users WHERE telegram_id = $1 AND github_token_enc IS NOT NULL AND disconnected_at IS NULL',
    [telegramId]
  );
  return rows[0] ? rows[0].github_username : null;
}

/** All of this person's accounts, active one flagged, most recently used first. */
async function list(telegramId) {
  const [{ rows }, active] = await Promise.all([
    pool.query('SELECT id, github_login, scope, added_at, last_used_at FROM github_accounts WHERE telegram_id = $1 ORDER BY last_used_at DESC, id DESC', [telegramId]),
    activeLoginOf(telegramId),
  ]);
  return rows.map((r) => toView(r, active));
}

/** Same, with decrypted tokens (undecryptable rows are skipped). Internal use only — never render. */
async function listWithTokens(telegramId) {
  const { rows } = await pool.query('SELECT id, github_login, token_enc, scope FROM github_accounts WHERE telegram_id = $1 ORDER BY last_used_at DESC, id DESC', [telegramId]);
  const out = [];
  for (const r of rows) {
    const token = tryDecrypt(r.token_enc);
    if (token) out.push({ id: Number(r.id), login: r.github_login, token, scope: r.scope || '' });
  }
  return out;
}

/**
 * Stores (or refreshes) an account. A NEW login counts against MAX_ACCOUNTS and throws
 * { code: 'ACCOUNT_LIMIT' } before anything is written; the same login again just refreshes its token.
 */
async function upsert(telegramId, { login, token, scope }) {
  if (!login || !token) throw new Error('upsert needs a login and a token');
  const { rows: existing } = await pool.query(
    'SELECT id FROM github_accounts WHERE telegram_id = $1 AND LOWER(github_login) = LOWER($2)',
    [telegramId, login]
  );
  if (!existing[0]) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM github_accounts WHERE telegram_id = $1', [telegramId]);
    if (rows[0].n >= MAX_ACCOUNTS) {
      const err = new Error(`You can connect up to ${MAX_ACCOUNTS} GitHub accounts. Remove one first.`);
      err.code = 'ACCOUNT_LIMIT';
      throw err;
    }
  }
  await pool.query(
    `INSERT INTO github_accounts (telegram_id, github_login, token_enc, scope, added_at, last_used_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (telegram_id, github_login) DO UPDATE SET token_enc = $3, scope = $4, last_used_at = now()`,
    [telegramId, login, encrypt(token), scope || null]
  );
  return { added: !existing[0] };
}

function invalidateCaches(telegramId) {
  ownerCache.delete(telegramId);
  try { require('./ownerScope').forget(telegramId); } catch (_) { /* cache only */ }
  try { require('./repoCache').invalidateUser(telegramId); } catch (_) { /* caches only */ }
}

/** Makes `login` the active account: copies its token/login/scope into the users row, personal owner again. */
async function activate(telegramId, login) {
  const { rows } = await pool.query(
    'SELECT id, github_login, token_enc, scope FROM github_accounts WHERE telegram_id = $1 AND LOWER(github_login) = LOWER($2)',
    [telegramId, login]
  );
  const row = rows[0];
  if (!row) return null;
  if (!tryDecrypt(row.token_enc)) { // unreadable (e.g. key rotated): drop it rather than activating a dead account
    await pool.query('DELETE FROM github_accounts WHERE id = $1', [row.id]);
    return null;
  }
  await pool.query(
    `UPDATE users SET github_username = $2, github_token_enc = $3, github_scope = $4,
            disconnected_at = NULL, active_owner = NULL
     WHERE telegram_id = $1`,
    [telegramId, row.github_login, row.token_enc, row.scope]
  );
  await pool.query('UPDATE github_accounts SET last_used_at = now() WHERE id = $1', [row.id]);
  invalidateCaches(telegramId);
  return { login: row.github_login, scope: row.scope || '' };
}

/** Activates the most recently used account other than `exceptLogin`; null when none remain. */
async function activateNext(telegramId, exceptLogin) {
  const { rows } = await pool.query(
    'SELECT github_login FROM github_accounts WHERE telegram_id = $1 AND LOWER(github_login) <> LOWER($2) ORDER BY last_used_at DESC, id DESC',
    [telegramId, exceptLogin || '']
  );
  for (const r of rows) {
    const done = await activate(telegramId, r.github_login);
    if (done) return done;
  }
  return null;
}

async function removeAccount(telegramId, login) {
  await pool.query('DELETE FROM github_accounts WHERE telegram_id = $1 AND LOWER(github_login) = LOWER($2)', [telegramId, login]);
}

async function removeAll(telegramId) {
  await pool.query('DELETE FROM github_accounts WHERE telegram_id = $1', [telegramId]);
}

// ── Active organisation ──────────────────────────────────────────────

/** The organisation login My Repos is showing, or null for the personal account. */
async function getActiveOwner(telegramId) {
  const hit = ownerCache.get(telegramId);
  if (hit) return hit.owner;
  const { rows } = await pool.query('SELECT active_owner FROM users WHERE telegram_id = $1', [telegramId]);
  const owner = (rows[0] && rows[0].active_owner) || null;
  ownerCache.set(telegramId, { owner });
  return owner;
}

async function setActiveOwner(telegramId, owner) {
  await pool.query('UPDATE users SET active_owner = $2 WHERE telegram_id = $1', [telegramId, owner || null]);
  invalidateCaches(telegramId);
  ownerCache.set(telegramId, { owner: owner || null });
}

function forgetOwner(telegramId) {
  ownerCache.delete(telegramId);
  try { require('./ownerScope').forget(telegramId); } catch (_) { /* cache only */ }
}

/**
 * The decrypted token of ONE specific account (v1.2.5-multi) — for background jobs and admin tools that
 * must act as the account something belongs to, not whichever account happens to be active now.
 * Returns { login, token, scope } or null when the account is gone or its token is unreadable.
 */
async function tokenFor(telegramId, login) {
  if (!login) return null;
  const { rows } = await pool.query(
    'SELECT github_login, token_enc, scope FROM github_accounts WHERE telegram_id = $1 AND LOWER(github_login) = LOWER($2)',
    [telegramId, login]
  );
  const row = rows[0];
  if (!row) return null;
  const token = tryDecrypt(row.token_enc);
  return token ? { login: row.github_login, token, scope: row.scope || '' } : null;
}

/** Records what the all-accounts health sweep found for one account: 'ok' | 'revoked' | 'unknown'. */
async function setHealth(telegramId, login, status) {
  await pool.query(
    'UPDATE github_accounts SET health_status = $3, health_checked_at = now() WHERE telegram_id = $1 AND LOWER(github_login) = LOWER($2)',
    [telegramId, login, status]
  );
}

/** Account list with health info, for the admin view (never includes a token). */
async function listForAdmin(telegramId) {
  const [{ rows }, active] = await Promise.all([
    pool.query(
      `SELECT id, github_login, scope, added_at, last_used_at, health_status, health_checked_at
         FROM github_accounts WHERE telegram_id = $1 ORDER BY last_used_at DESC, id DESC`, [telegramId]),
    activeLoginOf(telegramId),
  ]);
  return rows.map((r) => ({ ...toView(r, active), health: r.health_status || null, healthCheckedAt: r.health_checked_at || null }));
}

module.exports = {
  MAX_ACCOUNTS, list, listWithTokens, upsert, activate, activateNext, removeAccount, removeAll,
  getActiveOwner, setActiveOwner, forgetOwner, activeLoginOf, tokenFor, setHealth, listForAdmin,
};
