const { pool } = require('../db/postgres');
const { encrypt, tryDecrypt } = require('./crypto');

/**
 * v1.2.1-multi: webhook signing secrets are encrypted at rest with the same AES-256-GCM key as GitHub
 * tokens (they were plaintext). Backward compatible: rows written before this version are plaintext
 * hex with no prefix and are still read correctly; each is upgraded the first time it is read.
 * Rotation = register the webhook again (a new random secret replaces the old one in one UPSERT).
 */
const ENC_PREFIX = 'enc1:';
const sealSecret = (plain) => `${ENC_PREFIX}${encrypt(String(plain))}`;
/** The plaintext secret, or null when it can't be opened. Never '' — an empty
 * key would let anyone compute a valid HMAC, so callers skip null secrets. */
function openSecret(stored) {
  const v = String(stored || '');
  if (!v) return null;
  return v.startsWith(ENC_PREFIX) ? tryDecrypt(v.slice(ENC_PREFIX.length)) : v;
}
const isLegacy = (stored) => !String(stored || '').startsWith(ENC_PREFIX);
async function upgradeLegacy(telegramId, repoName, plain) {
  try {
    await pool.query('UPDATE repo_webhooks SET secret = $3 WHERE telegram_id = $1 AND repo_name = $2 AND secret NOT LIKE \'enc1:%\'', [telegramId, repoName, sealSecret(plain)]);
  } catch (_) { /* best-effort; the plaintext row still works */ }
}

async function get(telegramId, repoName) {
  const { rows } = await pool.query(
    'SELECT webhook_id, secret, owner_login, account_login FROM repo_webhooks WHERE telegram_id = $1 AND repo_name = $2',
    [telegramId, repoName]
  );
  return rows[0] ? { ...rows[0], secret: openSecret(rows[0].secret) } : null;
}

/** Every webhook registration for a user — used on Disconnect, so every
 * live webhook can be torn down on GitHub's side before the token that
 * would let us do that is wiped. */
async function getAllForUser(telegramId) {
  const { rows } = await pool.query(
    'SELECT repo_name, webhook_id, owner_login, account_login FROM repo_webhooks WHERE telegram_id = $1',
    [telegramId]
  );
  return rows;
}

/**
 * v1.2.4-multi: the registrations created with ONE GitHub account's token — what must be torn down
 * (on GitHub, with that token) when that account is removed. Rows written before this version have no
 * account_login; they belong to the person's first/only account, so they are included only when the
 * caller says this is their last account (`includeLegacy`).
 */
async function getAllForAccount(telegramId, accountLogin, { includeLegacy = false } = {}) {
  const { rows } = await pool.query(
    `SELECT repo_name, webhook_id, owner_login, account_login FROM repo_webhooks
     WHERE telegram_id = $1 AND (LOWER(account_login) = LOWER($2) ${includeLegacy ? 'OR account_login IS NULL' : ''})`,
    [telegramId, accountLogin]
  );
  return rows;
}

/** Deletes just these registrations' DB rows (after each was torn down on GitHub's side). */
async function removeMany(telegramId, repoNames) {
  if (!repoNames.length) return;
  await pool.query('DELETE FROM repo_webhooks WHERE telegram_id = $1 AND repo_name = ANY($2::text[])', [telegramId, repoNames]);
}

/**
 * `ownerLogin` = who owns the repo (a person or an organisation); `accountLogin` = the connected GitHub
 * account whose token created the hook. Both are optional so older callers keep working.
 */
async function save(telegramId, repoName, webhookId, secret, { ownerLogin = null, accountLogin = null } = {}) {
  await pool.query(
    `INSERT INTO repo_webhooks (telegram_id, repo_name, webhook_id, secret, created_at, owner_login, account_login)
     VALUES ($1, $2, $3, $4, now(), $5, $6)
     ON CONFLICT (telegram_id, repo_name) DO UPDATE SET webhook_id = $3, secret = $4, created_at = now(), owner_login = $5, account_login = $6`,
    [telegramId, repoName, webhookId, sealSecret(secret), ownerLogin, accountLogin]
  );
}

async function remove(telegramId, repoName) {
  await pool.query('DELETE FROM repo_webhooks WHERE telegram_id = $1 AND repo_name = $2', [telegramId, repoName]);
}

/** Clears every webhook DB row for a user in one shot — used on Disconnect
 * after each webhook has already been torn down on GitHub's side. */
async function removeAllForUser(telegramId) {
  await pool.query('DELETE FROM repo_webhooks WHERE telegram_id = $1', [telegramId]);
}

/** Looks up the (telegram_id, secret) registered for a repo, so the caller
 * can verify an inbound payload's HMAC signature using the STORED secret —
 * never trust a secret the payload itself claims to have.
 *
 * v1.1.0-multi: now takes `ownerLogin` too and joins against users.github_username.
 * Under single-owner, repo_name alone was unambiguous (only one person's
 * repos existed at all). With open multi-user access, two different
 * GitHub accounts can each have a repo called the same short name — a
 * repo_name-only lookup would resolve to whichever row happened to match,
 * silently misrouting notifications (or worse, failing HMAC verification
 * against the wrong user's secret and dropping the event entirely).
 * ownerLogin disambiguates since GitHub owner/repo pairs are globally unique. */
/**
 * v1.2.1-multi: EVERY registration for this owner/repo. Two Telegram accounts can be connected to the
 * same GitHub login (GitHub OAuth has no "one device" concept), and each registers its own webhook
 * with its own secret. getByRepo() returned an arbitrary one, so the other account's deliveries failed
 * signature verification and its notifications silently stopped. The route now tries each candidate's
 * secret; only the registration whose secret signed the payload receives the event — so an event can
 * never be delivered to an account that didn't register it.
 */
async function getAllByRepo(repoName, ownerLogin) {
  const { rows } = await pool.query(
    // v1.2.4-multi: a registration made on 1.2.4+ stores the repo's real owner (person OR organisation) and
    // matches on it directly; older rows (owner_login NULL) still match through the person's GitHub login.
    `SELECT rw.telegram_id, rw.secret FROM repo_webhooks rw
     JOIN users u ON u.telegram_id = rw.telegram_id
     WHERE rw.repo_name = $1
       AND (LOWER(rw.owner_login) = LOWER($2) OR (rw.owner_login IS NULL AND u.github_username = $2))
     ORDER BY rw.telegram_id
     LIMIT 10`,
    [repoName, ownerLogin]
  );
  const out = [];
  for (const r of rows) {
    const secret = openSecret(r.secret);
    if (secret == null) continue; // unreadable secret: this registration can't verify anything
    if (isLegacy(r.secret)) upgradeLegacy(r.telegram_id, repoName, secret);
    out.push({ telegram_id: r.telegram_id, secret });
  }
  return out;
}

async function getByRepo(repoName, ownerLogin) {
  return (await getAllByRepo(repoName, ownerLogin))[0] || null;
}

module.exports = {
  getAllByRepo, get, getAllForUser, getAllForAccount, removeMany, save, remove, removeAllForUser, getByRepo };
