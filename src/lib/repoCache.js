const github = require('./github');
const crypto = require('crypto');
const { mapWithConcurrency } = require('./concurrency');
const { BoundedMap } = require('./boundedMap');

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

const inFlight = {
  repos: new Map(),
  languages: new Map(),
  treeStats: new Map(),
  user: new Map(),
};

/**
 * Short-lived in-process caches, all per-Telegram-user. GitroHub re-fetches
 * the full repo list (and a separate language call per visible repo) on
 * nearly every screen — My Repos, Pinned, Bulk Select, Search all hit this
 * independently, often within seconds of each other for information that
 * hasn't changed. These caches cut that down without needing a "did
 * anything change" check — a 60s TTL is short enough that staleness is
 * never noticeable, and every write path explicitly invalidates anyway.
 */

const REPO_LIST_TTL_MS = 60 * 1000;
const LANGUAGE_TTL_MS = 60 * 1000;
const TREE_STATS_TTL_MS = 60 * 1000;
const USERNAME_TTL_MS = 10 * 60 * 1000; // username essentially never changes mid-session

// v1.2.1-multi: these four had no size bound — with many users the repo-list cache alone (a full repo
// list per user, only useful for 60s) could hold hundreds of MB. Now LRU-capped, and swept for expiry.
const repoListCache = new BoundedMap({ max: Number(process.env.REPO_CACHE_MAX_USERS) || 400, name: 'repoList' }); // telegramId -> { repos, timestamp, tokenFingerprint }
const languageCache = new BoundedMap({ max: 3000, name: 'languages' }); // `${telegramId}:${repoName}` -> { languages, timestamp, tokenFingerprint }
const treeStatsCache = new BoundedMap({ max: 3000, name: 'treeStats' }); // `${telegramId}:${repoName}` -> { stats, timestamp, tokenFingerprint }
const usernameCache = new BoundedMap({ max: 5000, name: 'username' }); // telegramId -> { user, timestamp, tokenFingerprint }

for (const [m, ttl] of [[repoListCache, REPO_LIST_TTL_MS], [languageCache, LANGUAGE_TTL_MS], [treeStatsCache, TREE_STATS_TTL_MS], [usernameCache, USERNAME_TTL_MS]]) {
  m.startSweeper((v) => Date.now() - v.timestamp > ttl * 2);
}

async function getRepos(telegramId, token) {
  // v1.2.4-multi: the list belongs to the ACTIVE owner (personal account or an organisation), so the owner is part
  // of the cache identity — switching organisation can never serve the previous owner's repos.
  const org = await require('./accounts').getActiveOwner(telegramId).catch(() => null);
  const fp = `${tokenFingerprint(token)}:${org || ''}`;
  const cached = repoListCache.get(telegramId);
  if (cached && cached.tokenFingerprint === fp && Date.now() - cached.timestamp < REPO_LIST_TTL_MS) return cached.repos;
  const key = `${telegramId}:${fp}`;
  if (inFlight.repos.has(key)) return inFlight.repos.get(key);
  const work = (async () => {
    const fresh = repoListCache.get(telegramId);
    if (fresh && fresh.tokenFingerprint === fp && Date.now() - fresh.timestamp < REPO_LIST_TTL_MS) return fresh.repos;
    const repos = await github.listRepos(token, { org });
    repoListCache.set(telegramId, { repos, timestamp: Date.now(), tokenFingerprint: fp });
    return repos;
  })();
  inFlight.repos.set(key, work);
  try { return await work; } finally {
    if (inFlight.repos.get(key) === work) inFlight.repos.delete(key);
  }
}

async function getLanguages(telegramId, owner, repoName, token) {
  const fp = tokenFingerprint(token);
  const key = `${telegramId}:${owner}:${repoName}`;
  const cached = languageCache.get(key);
  if (cached && cached.tokenFingerprint === fp && Date.now() - cached.timestamp < LANGUAGE_TTL_MS) return cached.languages;
  const flightKey = `${key}:${fp}`;
  if (inFlight.languages.has(flightKey)) return inFlight.languages.get(flightKey);
  const work = (async () => {
    const fresh = languageCache.get(key);
    if (fresh && fresh.tokenFingerprint === fp && Date.now() - fresh.timestamp < LANGUAGE_TTL_MS) return fresh.languages;
    const languages = await github.getLanguages(token, owner, repoName);
    languageCache.set(key, { languages, timestamp: Date.now(), tokenFingerprint: fp });
    return languages;
  })();
  inFlight.languages.set(flightKey, work);
  try { return await work; } finally {
    if (inFlight.languages.get(flightKey) === work) inFlight.languages.delete(flightKey);
  }
}

/** Repo size/file/folder counts, computed from the real file tree (see
 * github.getTreeStats) instead of GitHub's lagging cached `repo.size`.
 *
 * v1.1.21-multi: `defaultBranch` is optional but callers that already hold
 * the repo object should pass it — it lets the tree fetch skip its own
 * "get repo" round trip (one fewer sequential GitHub call per repo) and
 * keeps the in-flight coalescing key identical across screens, so My Repos,
 * Pinned and Repo View share one fetch instead of racing duplicates. */
// v2.1.4: a repo this big (GitHub's own `size`, in KB) has a file tree of tens of thousands of entries — reading it
// recursively is a multi-megabyte response that GitHub answers with a secondary rate limit, and the result is cut short
// anyway. Such repos are shown with GitHub's own size and no file/folder counts. (The Linux kernel is ~6,000,000 KB.)
const HUGE_REPO_KB = 250000;

/** `sizeKb` = repo.size from GitHub when the caller has it; null for a repo too big to scan, so callers fall back to repo.size. */
async function getTreeStats(telegramId, owner, repoName, token, defaultBranch = null, { sizeKb = null } = {}) {
  if (Number(sizeKb) > HUGE_REPO_KB) return null;
  const key = `${telegramId}:${owner}:${repoName}:${defaultBranch || ''}`;
  const fp = tokenFingerprint(token);
  const cached = treeStatsCache.get(key);
  if (cached && cached.tokenFingerprint === fp && Date.now() - cached.timestamp < TREE_STATS_TTL_MS) {
    return { ...cached.stats, fetchedAt: cached.timestamp }; // #11 — feeds "last synced" note
  }
  const flightKey = `${key}:${fp}`;
  if (inFlight.treeStats.has(flightKey)) return inFlight.treeStats.get(flightKey);
  const work = (async () => {
    const fresh = treeStatsCache.get(key);
    if (fresh && fresh.tokenFingerprint === fp && Date.now() - fresh.timestamp < TREE_STATS_TTL_MS) {
      return { ...fresh.stats, fetchedAt: fresh.timestamp };
    }
    const stats = await github.getTreeStats(token, owner, repoName, defaultBranch);
    const fetchedAt = Date.now();
    treeStatsCache.set(key, { stats, timestamp: fetchedAt, tokenFingerprint: fp });
    return { ...stats, fetchedAt };
  })();
  inFlight.treeStats.set(flightKey, work);
  try { return await work; } finally {
    if (inFlight.treeStats.get(flightKey) === work) inFlight.treeStats.delete(flightKey);
  }
}

// How long a LIST screen (My Repos, Pinned) will wait for real tree-derived
// sizes before rendering anyway. Past this, repos still loading fall back to
// GitHub's own cached `repo.size` (already on the list payload — zero extra
// calls) and keep fetching in the background so the next view is exact.
const TREE_STATS_LIST_BUDGET_MS = 2500;
const TREE_STATS_LIST_CONCURRENCY = 3;

/**
 * Tree stats for a whole page of repos, with a hard wait budget.
 *
 * Why this exists: list screens used to `await` a full recursive tree fetch
 * for EVERY visible repo before sending a single character. One large or slow
 * repo held the whole screen hostage — and because updates are processed one
 * at a time per user, every tap made meanwhile queued up behind it, which is
 * what made the bot feel frozen. Now: cache hits return instantly, misses are
 * fetched with bounded concurrency, and the screen is sent as soon as either
 * everything resolved or the budget ran out, whichever comes first. Fetches
 * still in flight are NOT cancelled — they finish in the background and fill
 * the 60s stats cache, so a refresh moments later is exact and instant.
 *
 * Returns an array aligned with `repos`: stats object, or null (not ready /
 * failed — callers fall back to repo.size, same as they always did on error).
 */
async function getTreeStatsBatch(telegramId, token, repos, { budgetMs = TREE_STATS_LIST_BUDGET_MS, concurrency = TREE_STATS_LIST_CONCURRENCY } = {}) {
  const results = new Array(repos.length).fill(null);
  if (repos.length === 0) return results;

  const work = mapWithConcurrency(repos, concurrency, async (repo, i) => {
    if (!repo) return;
    try {
      results[i] = await getTreeStats(telegramId, repo.owner.login, repo.name, token, repo.default_branch || null, { sizeKb: repo.size });
    } catch (_) { /* leave null — caller falls back to repo.size */ }
  });

  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); });
  await Promise.race([work, deadline]);
  clearTimeout(timer);
  return results.slice(); // snapshot — background completions don't mutate what was rendered
}

/**
 * The authenticated GitHub user, with `login` = the OWNER every "<owner>/<repo>" call should use
 * (v1.2.4-multi): the active organisation when one is selected, else the person's own login. Both are
 * always available as `personalLogin` / `isOrg`. Pass `{ personal: true }` where the real account
 * login is what's needed (the connect flow, identity checks).
 */
async function getUser(telegramId, token, { personal = false } = {}) {
  const user = await getRealUser(telegramId, token);
  if (personal) return { ...user, personalLogin: user.login, isOrg: false };
  const org = await require('./accounts').getActiveOwner(telegramId).catch(() => null);
  if (org && String(org).toLowerCase() !== String(user.login).toLowerCase()) {
    return { ...user, login: org, personalLogin: user.login, isOrg: true };
  }
  return { ...user, personalLogin: user.login, isOrg: false };
}

async function getRealUser(telegramId, token) {
  const fp = tokenFingerprint(token);
  const cached = usernameCache.get(telegramId);
  if (cached && cached.tokenFingerprint === fp && Date.now() - cached.timestamp < USERNAME_TTL_MS) return cached.user;
  const key = `${telegramId}:${fp}`;
  if (inFlight.user.has(key)) return inFlight.user.get(key);
  const work = (async () => {
    const fresh = usernameCache.get(telegramId);
    if (fresh && fresh.tokenFingerprint === fp && Date.now() - fresh.timestamp < USERNAME_TTL_MS) return fresh.user;
    const user = await github.getAuthenticatedUser(token);
    usernameCache.set(telegramId, { user, timestamp: Date.now(), tokenFingerprint: fp });
    // A renamed GitHub login must reach the database, or webhook lookups (which join on it) stop matching.
    require('./users').syncGithubUsername(telegramId, user.login).then((changed) => {
      if (changed) require('./logger').info('GitHub username changed — stored login updated', { telegramId, login: user.login });
    }).catch(() => {});
    return user;
  })();
  inFlight.user.set(key, work);
  try { return await work; } finally {
    if (inFlight.user.get(key) === work) inFlight.user.delete(key);
  }
}

/** Call after ANY write (create/delete/rename/upload/visibility/bulk actions)
 * so the next read reflects reality instead of serving stale cached data. */
function invalidateRepos(telegramId) {
  repoListCache.delete(telegramId);
}

function invalidateLanguages(telegramId, repoName) {
  const suffix = `:${repoName}`;
  for (const key of languageCache.keys()) {
    if (key.startsWith(`${telegramId}:`) && key.endsWith(suffix)) languageCache.delete(key);
  }
}

/** Call after anything that changes a repo's file tree (upload, replace,
 * commit, delete) so Repo View's size/file/folder counts aren't stale. */
function invalidateTreeStats(telegramId, repoName) {
  const marker = `:${repoName}:`;
  for (const key of treeStatsCache.keys()) {
    if (key.startsWith(`${telegramId}:`) && key.includes(marker)) treeStatsCache.delete(key);
  }
}

/** Called on disconnect — the cached username would otherwise be wrong for whoever connects next. */
function invalidateUser(telegramId) {
  usernameCache.delete(telegramId);
  repoListCache.delete(telegramId);
  for (const key of languageCache.keys()) {
    if (key.startsWith(`${telegramId}:`)) languageCache.delete(key);
  }
  for (const key of treeStatsCache.keys()) {
    if (key.startsWith(`${telegramId}:`)) treeStatsCache.delete(key);
  }
}

module.exports = {
  getRepos,
  getLanguages,
  getTreeStats,
  HUGE_REPO_KB,
  getTreeStatsBatch,
  getUser,
  invalidateRepos,
  invalidateLanguages,
  invalidateTreeStats,
  invalidateUser,
};
