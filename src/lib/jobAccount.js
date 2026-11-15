/**
 * Which GitHub account a BACKGROUND job runs as (v1.2.5-multi).
 *
 * Scheduled repos and uploads remember the account (and owner) they were set up under. When they fire —
 * minutes or days later — they must act as that account, not as whichever account the person happens to
 * have switched to since. Rows written before 1.2.5 carry no account and keep the old behaviour (the
 * person's active account), so nothing already scheduled changes.
 *
 *   resolve(item) → { legacy: true,  token }                         old row: use the active account
 *                 → { legacy: false, token, accountLogin, owner }    the account the job was made under
 *                 → { gone: true, accountLogin }                     that account has since been removed
 */
const accounts = require('./accounts');
const users = require('./users');

async function resolve(item) {
  if (!item || !item.account_login) {
    return { legacy: true, token: await users.getDecryptedToken(item && item.telegram_id) };
  }
  const acc = await accounts.tokenFor(item.telegram_id, item.account_login);
  if (!acc) return { gone: true, accountLogin: item.account_login };
  return {
    legacy: false,
    token: acc.token,
    accountLogin: acc.login,
    owner: item.owner_login || acc.login,
  };
}

/** One friendly sentence for the "its account is gone" case, shared by every job type. */
function goneMessage(what, accountLogin) {
  return `⚠️ ${what} couldn't run — it was scheduled under the GitHub account @${accountLogin}, which is no longer connected. ` +
    `Reconnect that account (💼 Workspace → Accounts) and schedule it again.`;
}

module.exports = { resolve, goneMessage };
