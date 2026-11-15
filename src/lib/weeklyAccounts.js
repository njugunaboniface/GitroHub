/**
 * Every GitHub account a person has, as sources for the weekly automation run (v1.2.5-multi).
 *
 * The weekly auto-backup and stale-repo nudge used to look only at the ACTIVE account, so repos on a
 * person's other connected accounts were never backed up or nudged about. Now each account is a source;
 * the active one keeps its existing path (cached list, active organisation), every other one lists its
 * own repos with its own token. One broken account (revoked token…) never stops the others.
 *
 *   { accountLogin, active, token, ownerOf(repo), loadRepos() }
 */
const users = require('./users');
const accounts = require('./accounts');
const repoCache = require('./repoCache');
const github = require('./github');

async function sourcesFor(telegramId) {
  const out = [];
  const activeToken = await users.getDecryptedToken(telegramId);
  const activeLogin = await accounts.activeLoginOf(telegramId).catch(() => null);
  if (activeToken) {
    const user = await repoCache.getUser(telegramId, activeToken).catch(() => null);
    if (user) {
      out.push({
        accountLogin: activeLogin || user.personalLogin || user.login,
        active: true,
        token: activeToken,
        ownerOf: () => user.login,
        loadRepos: () => repoCache.getRepos(telegramId, activeToken),
      });
    }
  }
  const all = await accounts.listWithTokens(telegramId).catch(() => []);
  for (const a of all) {
    if (activeLogin && a.login.toLowerCase() === String(activeLogin).toLowerCase()) continue;
    out.push({
      accountLogin: a.login,
      active: false,
      token: a.token,
      ownerOf: (repo) => (repo && repo.owner && repo.owner.login) || a.login,
      loadRepos: () => github.listRepos(a.token),
    });
  }
  return out;
}

module.exports = { sourcesFor };
