/**
 * One place that ends a person's GitHub connection (v1.2.3-multi, made multi-account in v1.2.4):
 * used by the 🚪 Disconnect button, admin Ban, Delete User, and revoked-token handling.
 *
 * Per account being removed, in this order (everything that needs the live token happens BEFORE
 * the token is wiped):
 *   1. remove every live webhook that account's token created (best-effort)
 *   2. revoke GitroHub's access on GitHub's side (best-effort; a ban/delete drops the whole
 *      authorization, a plain disconnect only the token)
 *   3. forget those webhook registrations locally and drop the account
 * Then:
 *   - default (a person's own Disconnect / a revoked token): ONLY the active account is removed. If
 *     they have another account, it becomes active (`switchedTo`); otherwise they are disconnected.
 *   - `all: true` (admin Ban / Delete User): every account is torn down and the person is disconnected.
 *
 * `tokenDead: true` (the active token was already rejected by GitHub — see lib/revokedToken.js)
 * skips the GitHub calls for it: they would only fail again.
 *
 * It never throws because of GitHub: whatever fails upstream, the local connection is always
 * ended. An undecryptable token simply skips steps 1-2.
 */
const users = require('./users');
const accounts = require('./accounts');
const github = require('./github');
const repoWebhooks = require('./repoWebhooks');
const notificationMutes = require('./notificationMutes');
const logger = require('./logger');

async function teardownAccount(telegramId, { login, token }, { revokeGrant, tokenDead, includeLegacy }, summary) {
  summary.hadToken = true;
  const regs = login
    ? await repoWebhooks.getAllForAccount(telegramId, login, { includeLegacy }).catch(() => [])
    : await repoWebhooks.getAllForUser(telegramId).catch(() => []);

  if (tokenDead) {
    summary.revokeReason = 'already-revoked';
  } else {
    for (const reg of regs) {
      const owner = reg.owner_login || login;
      if (!owner) { summary.webhooksFailed++; continue; }
      try {
        await github.deleteWebhook(token, owner, reg.repo_name, reg.webhook_id);
        summary.webhooksRemoved++;
      } catch (err) {
        summary.webhooksFailed++;
        logger.warn('Could not remove webhook during teardown', { repo: reg.repo_name, message: err.message });
      }
    }
    const revoke = await github.revokeOAuthAccess(token, { grant: revokeGrant });
    summary.revoked = summary.revoked !== false && !!revoke.ok;
    summary.revokeReason = revoke.ok ? summary.revokeReason : (revoke.reason || `status ${revoke.status}`);
    if (!revoke.ok) logger.warn('Could not revoke GitHub access during teardown', { telegramId, reason: summary.revokeReason });
  }

  await repoWebhooks.removeMany(telegramId, regs.map((r) => r.repo_name)).catch(() => {});
  if (login) await accounts.removeAccount(telegramId, login).catch(() => {});
}

async function teardownGithubConnection(telegramId, { revokeGrant = false, tokenDead = false, all = false } = {}) {
  const summary = { hadToken: false, webhooksRemoved: 0, webhooksFailed: 0, revoked: null, revokeReason: null, switchedTo: null, removedLogin: null };
  const activeToken = await users.getDecryptedToken(telegramId).catch(() => null);
  const activeLogin = await accounts.activeLoginOf(telegramId).catch(() => null);
  const known = await accounts.listWithTokens(telegramId).catch(() => []);
  const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  summary.removedLogin = activeLogin;

  const targets = all ? known.map((a) => ({ login: a.login, token: a.token, dead: false })) : [];
  if (activeToken) {
    const i = targets.findIndex((t) => same(t.login, activeLogin));
    if (i >= 0) targets[i].token = activeToken; // the users row is the freshest copy of the active token
    else targets.push({ login: activeLogin, token: activeToken, dead: false });
  }
  for (const t of targets) t.dead = tokenDead && (!all || same(t.login, activeLogin));

  const lastOne = all || known.length <= 1;
  for (const t of targets) {
    await teardownAccount(telegramId, t, { revokeGrant, tokenDead: t.dead, includeLegacy: lastOne }, summary);
  }
  if (summary.revoked === null) summary.revoked = false;

  if (!all && activeLogin) {
    const next = await accounts.activateNext(telegramId, activeLogin).catch(() => null);
    if (next) { summary.switchedTo = next.login; return summary; }
  }

  await repoWebhooks.removeAllForUser(telegramId).catch(() => {});
  await notificationMutes.unmuteAllForUser(telegramId).catch(() => {});
  if (all) await accounts.removeAll(telegramId).catch(() => {});
  await users.disconnect(telegramId);
  return summary;
}

/**
 * Removes ONE non-active account whose token GitHub rejected (v1.2.5-multi health sweep): its webhooks are
 * forgotten locally (the token is dead, GitHub calls would only fail) and the account row is dropped. The
 * person's active account and everything else stay untouched. Never throws.
 */
async function removeDeadAccount(telegramId, login, token) {
  const summary = { hadToken: false, webhooksRemoved: 0, webhooksFailed: 0, revoked: false, revokeReason: 'already-revoked' };
  try {
    await teardownAccount(telegramId, { login, token }, { revokeGrant: false, tokenDead: true, includeLegacy: false }, summary);
  } catch (err) {
    logger.warn('Could not fully remove a dead account', { telegramId, login, message: err && err.message });
    await accounts.removeAccount(telegramId, login).catch(() => {});
  }
  return summary;
}

module.exports = { teardownGithubConnection, removeDeadAccount };
