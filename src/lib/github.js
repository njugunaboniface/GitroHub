const { Octokit } = require('@octokit/rest');
const { mapLimit } = require('./pool');
const crypto = require('crypto');
const { getTraffic } = require('./githubTraffic');
const requestContext = require('./requestContext');
const { downloadGate } = require('./gate');
const { gitBlobSha } = require('./gitHash');

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/**
 * Thin wrapper around Octokit implementing every GitHub operation GitroHub's
 * menus map to. One function per bot action, so handlers stay declarative
 * and error-shaping (per our "specific errors always" rule) happens in
 * exactly one place per operation.
 *
 * Clients are cached per token instead of constructed fresh on every call —
 * building a new Octokit instance isn't free (route methods, request
 * wrappers, hooks all get rebuilt), and doing it on every single API call
 * was adding real allocation churn under load. Capped at CLIENT_CACHE_MAX
 * entries as a defensive bound against unbounded growth. Raised from the
 * original 3 (sized for "a single-owner bot only ever really has one
 * token") to 50 in v1.1.0-multi, now that open access means many distinct
 * users' tokens can genuinely be active in the same process at once — 3
 * would otherwise mean constant cache eviction/rebuild the moment more
 * than three people use the bot around the same time.
 */
const CLIENT_CACHE_MAX = 50;
const clientCache = new Map();
function client(token) {
  const key = tokenFingerprint(token);
  if (clientCache.has(key)) return clientCache.get(key);
  const octo = new Octokit({ auth: token });
  // v1.2.1-multi: every request this client makes — including each page of
  // octo.paginate() — now flows through the GitHub traffic manager (queue,
  // per-user fairness, per-identity rate-limit state, backoff, retry safety,
  // timeouts, metrics). It also captures the X-RateLimit-* headers that the
  // old passive hooks used to; getLastKnownRateLimit() below reads them from
  // the manager. Nothing about this file's public API changed.
  getTraffic().installHook(octo, token);
  clientCache.set(key, octo);
  if (clientCache.size > CLIENT_CACHE_MAX) {
    clientCache.delete(clientCache.keys().next().value);
  }
  return octo;
}

/**
 * True if the error looks like a genuine PRIMARY rate-limit rejection
 * (403, out of the 5000/hour core quota) — as opposed to a permissions
 * 403, or GitHub's separate SECONDARY/abuse-detection limit (see
 * isSecondaryRateLimitError below). Checked more narrowly than a bare
 * "contains the word rate limit" match specifically so it does NOT also
 * match secondary-limit messages — those need a completely different
 * response (see errorHelpers.js's replyGithubError), and used to get
 * shown the PRIMARY limit's hourly reset time even when the actual cause
 * was a short burst-detection cooldown with nothing to do with that
 * number — a real bug: an upload of 107 files failing on secondary abuse
 * detection reported "resets in 53 minutes" (the primary quota's ACTUAL
 * reset, 4816/5000 still remaining) when the real wait was under a
 * minute.
 */
function isRateLimitError(err) {
  return !!(err && err.status === 403 && /rate limit/i.test(err.message || '') && !isSecondaryRateLimitError(err));
}

/**
 * GitHub's ABUSE-DETECTION ("secondary") rate limit — a burst/concurrency
 * guard, completely separate from the primary 5000/hour quota. Triggers
 * from making too many requests too quickly (uploading many files in one
 * commit, for instance), regardless of how much primary quota remains,
 * and clears in seconds to low minutes via the `retry-after` header —
 * not the primary limit's up-to-an-hour `x-ratelimit-reset`. GitHub's own
 * docs identify it by this exact phrase in the error message.
 */
function isSecondaryRateLimitError(err) {
  return !!(err && err.status === 403 && /secondary rate limit/i.test(err.message || ''));
}

/** True when a WRITE ended without GitHub confirming either way (see reconcileUnknown). */
function isUnknownOutcome(err) {
  return !!(err && err.outcome === 'unknown');
}

/**
 * Best-effort passive read of ONE user's last-known core rate limit, so
 * Settings/Stats/Admin can show a live budget without spending a request.
 * The numbers come from the traffic manager, which tracks them per GitHub
 * identity (each connected user has an independent 5000/hr budget) from the
 * X-RateLimit-* headers of every response. May be null if no call has been
 * made for this token yet this process. Callers wanting a guaranteed-fresh
 * number should still use getRateLimit(token).
 */
function getLastKnownRateLimit(token) {
  return getTraffic().manager.getRateLimit(tokenFingerprint(token), 'core');
}

/**
 * Operation deadline + cancellation.
 *
 * v1.2.1-multi: retries, backoff, Retry-After handling and per-request
 * timeouts now live in ONE place (githubTraffic/manager.js). A second retry
 * layer here would multiply attempts (N×M) and amplify an outage, so this
 * wrapper no longer retries — it only bounds the WHOLE operation (queue wait
 * + attempts) and propagates cancellation: its AbortSignal is passed into
 * every Octokit call via `request: { signal }`, which the manager honours both
 * while a request is queued (it is removed) and in flight (it is aborted and
 * its concurrency slot released).
 *
 * `mutation: true` marks operations that change GitHub state. If such an
 * operation is cut off after its request was sent, the outcome is UNKNOWN —
 * it may or may not have been applied — and the error says so truthfully
 * (see reconcileUnknown) instead of pretending it simply failed.
 */
const MAX_OPERATION_MS = 88000; // stay under Telegraf's 90s handler timeout

function requestTimeoutMs() { return getTraffic().config.requestTimeoutMs; }

const UNKNOWN_OUTCOME_MESSAGE = 'GitHub did not confirm the final result of this operation. I won\u2019t claim it succeeded \u2014 please check the repository before trying again.';

async function withAbortTimeout(fn, label, timeoutMs = requestTimeoutMs(), { mutation = false } = {}) {
  const controller = new AbortController();
  const deadline = Math.min(timeoutMs + getTraffic().config.queueTimeoutMs, MAX_OPERATION_MS);
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      const e = new Error(`${label} timed out after ${deadline}ms`);
      e.code = 'GITHUB_TIMEOUT';
      e.originalMessage = e.message;
      e.reason = 'GITHUB_TIMEOUT';
      // Never sent (still queued) → certainly not applied. Sent → we cannot know.
      e.outcome = mutation && !(err && err.outcome === 'failed') ? 'unknown' : 'failed';
      if (e.outcome === 'unknown') { e.code = 'GITHUB_OUTCOME_UNKNOWN'; e.message = UNKNOWN_OUTCOME_MESSAGE; }
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * When a WRITE ends with an unknown outcome (timeout / dropped connection /
 * 5xx), ask GitHub what actually happened before telling the user anything.
 * `verify()` resolves { applied: true, value } (it did happen — return the
 * real result as if nothing went wrong), { applied: false } (confirmed it did
 * not happen), or throws / returns { applied: null } (still can't tell — the
 * error stays "unknown" and the user is told exactly that).
 */
async function reconcileUnknown(err, verify) {
  if (!err || err.outcome !== 'unknown') throw err;
  let verdict = null;
  let value;
  try {
    const r = await verify();
    verdict = r ? r.applied : null;
    value = r && r.value;
  } catch (_) { verdict = null; }
  if (verdict === true) return value;
  if (verdict === false) {
    err.outcome = 'failed';
    err.reconciled = true;
    if (err.code === 'GITHUB_OUTCOME_UNKNOWN') err.code = err.reason || 'GITHUB_REQUEST_FAILED';
    if (err.originalMessage) err.message = err.originalMessage;
  }
  throw err;
}

/** Read helpers for reconciliation: a 404 is an answer, not an error. */
async function readRepoRaw(token, owner, repo) {
  try {
    return await withAbortTimeout(async (signal) => (await client(token).repos.get({ owner, repo, request: { signal } })).data, 'Verify repo');
  } catch (err) {
    if (err && err.status === 404) return null;
    throw err;
  }
}

async function readFileRaw(token, owner, repo, path, branch = null) {
  try {
    return await withAbortTimeout(async (signal) => (await client(token).repos.getContent({ owner, repo, path, ...(branch ? { ref: branch } : {}), request: { signal } })).data, 'Verify file');
  } catch (err) {
    if (err && err.status === 404) return null;
    throw err;
  }
}

/** Kept under its old name so every read call site below is unchanged. Retrying is the manager's job now. */
async function withRetry(fn, label = 'GitHub API request') {
  return withAbortTimeout(fn, label);
}

/**
 * Request coalescing for READ-ONLY calls only. If two handlers
 * (e.g. Browse Files and Search Files) ask for the same repo's tree within
 * milliseconds of each other, the second attaches to the first's in-flight
 * promise instead of firing a duplicate GitHub request. Deliberately never
 * applied to writes (putFile/deleteRepo/etc.) — deduping an intentional
 * double action on a mutation would silently drop it, which is a
 * correctness bug, not an optimization.
 */
const inFlight = new Map(); // key -> Promise

function coalesce(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = Promise.resolve().then(fn);
  inFlight.set(key, p);
  // `.finally()` returns its OWN new promise, separate from `p` — if `p`
  // rejects (any transient GitHub API failure), that derived promise
  // rejects too, and since nothing else was ever attached to it, it was
  // an unhandled rejection every single time a coalesced call failed.
  // Node terminates the whole process on an unhandled rejection by
  // default, so any getRepo/tree-fetch failure — a 500, a network blip,
  // an expired token — could take the entire bot down for every user.
  // `p` itself (returned below, to the real caller) is untouched by this
  // and still rejects/resolves normally either way.
  p.finally(() => inFlight.delete(key)).catch(() => {});
  return p;
}

async function getAuthenticatedUser(token) {
  return withRetry((signal) => (async () => {
    const octo = client(token);
    const { data } = await octo.users.getAuthenticated({ request: { signal } });
    return data; // { login, avatar_url, ... }
  })(), 'Get authenticated user');
}

async function getRateLimit(token) {
  return withRetry((signal) => (async () => {
    const octo = client(token);
    const { data } = await octo.rateLimit.get({ request: { signal } });
    return data.resources.core; // { limit, remaining, reset }
  })(), 'Get rate limit');
}

/**
 * Revoke GitroHub's access on GitHub's side (v1.2.3-multi). Disconnect, Ban
 * and Delete used to only forget the token locally, which left it valid on
 * GitHub until the person revoked it by hand. Uses the OAuth app's own
 * credentials (DELETE /applications/{client_id}/token, or .../grant to drop
 * the whole authorization). Best-effort by design — never throws; a 404 means
 * the token/grant is already gone, which is the outcome we wanted.
 */
async function revokeOAuthAccess(token, { grant = false } = {}) {
  // Read at call time (same variables config.js validates at boot) so this
  // module stays loadable by tools that don't set the full environment.
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!token || !clientId || !clientSecret) return { ok: false, reason: 'not-configured' };
  try {
    const res = await fetch(`https://api.github.com/applications/${encodeURIComponent(clientId)}/${grant ? 'grant' : 'token'}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(Number(process.env.OAUTH_EXCHANGE_TIMEOUT_MS) || 10000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'GitroHub',
      },
      body: JSON.stringify({ access_token: token }),
    });
    if (res.status === 204 || res.status === 404) return { ok: true, status: res.status };
    return { ok: false, status: res.status, reason: 'unexpected-status' };
  } catch (err) {
    return { ok: false, reason: err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

async function listRepos(token, { sort = 'updated', direction = 'desc', org = null } = {}) {
  return withRetry((signal) => (async () => {
    const octo = client(token);
    // v1.2.4-multi: an organisation shown through the 💼 Workspace switcher lists the org's repos
    // the person can access (every repo the org has that this token can see).
    if (org) {
      return octo.paginate(octo.repos.listForOrg, { org, type: 'all', per_page: 100, sort, direction, request: { signal } });
    }
    // affiliation: 'owner' — GitHub's default also returns repos the user is
    // merely a collaborator on or can reach through an organization. Every
    // action in the bot addresses repos as `<user.login>/<name>`, so those
    // entries 404 on open and, on a name clash, would act on the user's own
    // same-named repo instead (v1.2.3 fix).
    return octo.paginate(octo.repos.listForAuthenticatedUser, {
      per_page: 100,
      affiliation: 'owner',
      sort,
      direction,
      request: { signal },
    });
  })(), 'List repos');
}

async function getRepo(token, owner, repo) {
  return coalesce(`getRepo:${tokenFingerprint(token)}:${owner}/${repo}`, () => withRetry((signal) => (async () => {
    const octo = client(token);
    const { data } = await octo.repos.get({ owner, repo, request: { signal } });
    return data;
  })(), 'Get repo'));
}

async function createRepo(token, { name, isPrivate, description, licenseTemplate, gitignoreTemplate, org = null }) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      // v1.2.4-multi: `org` set → create inside that organisation instead of the personal account.
      const create = org ? (params) => octo.repos.createInOrg({ org, ...params }) : (params) => octo.repos.createForAuthenticatedUser(params);
      const { data } = await create({
        name,
        private: isPrivate,
        description: description ? sanitizeDescription(description) : undefined,
        license_template: licenseTemplate || undefined,
        gitignore_template: gitignoreTemplate || undefined,
        auto_init: true, // ensures a default branch + initial commit exist immediately
        request: { signal },
      });
      return data;
    })(), 'Create repo', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => {
      const me = await getAuthenticatedUser(token);
      const found = await readRepoRaw(token, org || me.login, name);
      if (!found) return { applied: false };
      // Only claim it if it was created just now — a pre-existing repo of that name is not our success.
      const fresh = found.created_at && Date.now() - Date.parse(found.created_at) < 5 * 60 * 1000;
      return fresh ? { applied: true, value: found } : { applied: false };
    });
  }
}

async function deleteRepo(token, owner, repo) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      await octo.repos.delete({ owner, repo, request: { signal } });
    })(), 'Delete repo', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => ({ applied: (await readRepoRaw(token, owner, repo)) === null }));
  }
}

/** Registers a webhook on a repo pointed at our /webhook/github endpoint.
 * `secret` is generated by the caller and stored alongside the webhook id
 * so incoming payloads can be verified against it later. */
/** Every event type GitroHub can turn into an alert (v1.2.4-multi). Which ones a person SEES is their own
 * choice (💼 Workspace → Alert types); subscribing to all of them keeps that choice instant. */
const WEBHOOK_EVENTS = ['push', 'issues', 'pull_request', 'release', 'workflow_run', 'deployment_status',
  'star', 'fork', 'create', 'delete', 'issue_comment', 'pull_request_review'];

async function createWebhook(token, owner, repo, callbackUrl, secret, webhookEvents = null) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      const { data } = await octo.repos.createWebhook({
        owner,
        repo,
        config: { url: callbackUrl, content_type: 'json', secret },
        events: webhookEvents || WEBHOOK_EVENTS,
        request: { signal },
      });
      return data;
    })(), 'Create webhook', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => {
      const hooks = await withAbortTimeout(async (signal) => (await client(token).repos.listWebhooks({ owner, repo, request: { signal } })).data, 'Verify webhook');
      const mine = hooks.find((h) => h.config && h.config.url === callbackUrl);
      return mine ? { applied: true, value: mine } : { applied: false };
    });
  }
}

/** Re-points an existing hook at the current event list (older hooks only knew the original six). */
async function updateWebhookEvents(token, owner, repo, webhookId, events = WEBHOOK_EVENTS) {
  return withAbortTimeout((signal) => (async () => {
    const octo = client(token);
    const { data } = await octo.repos.updateWebhook({ owner, repo, hook_id: webhookId, events, request: { signal } });
    return data;
  })(), 'Update webhook', undefined, { mutation: true });
}

async function deleteWebhook(token, owner, repo, webhookId) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      await octo.repos.deleteWebhook({ owner, repo, hook_id: webhookId, request: { signal } });
    })(), 'Delete webhook', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => {
      const hooks = await withAbortTimeout(async (signal) => (await client(token).repos.listWebhooks({ owner, repo, request: { signal } })).data, 'Verify webhook');
      return { applied: !hooks.some((h) => h.id === webhookId) };
    });
  }
}

async function renameRepo(token, owner, repo, newName) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      const { data } = await octo.repos.update({ owner, repo, name: newName, request: { signal } });
      return data;
    })(), 'Rename repo', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => {
      const renamed = await readRepoRaw(token, owner, newName);
      if (renamed) return { applied: true, value: renamed };
      return { applied: (await readRepoRaw(token, owner, repo)) ? false : null }; // neither visible → still unknown
    });
  }
}

async function setVisibility(token, owner, repo, isPrivate) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      const { data } = await octo.repos.update({ owner, repo, private: isPrivate, request: { signal } });
      return data;
    })(), 'Change visibility', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => {
      const now = await readRepoRaw(token, owner, repo);
      if (!now) return { applied: null };
      return now.private === !!isPrivate ? { applied: true, value: now } : { applied: false };
    });
  }
}

/** GitHub rejects repo descriptions containing control characters (e.g.
 * stray \n, \t, or other C0/C1 codes that sneak in via copy-paste from
 * Telegram). Strip them and collapse any resulting whitespace so the
 * request never 422s on this. */
function sanitizeDescription(description) {
  if (!description) return '';
  // eslint-disable-next-line no-control-regex
  return description.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function updateDescription(token, owner, repo, description) {
  const wanted = sanitizeDescription(description);
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      const { data } = await octo.repos.update({ owner, repo, description: wanted, request: { signal } });
      return data;
    })(), 'Update description', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => {
      const now = await readRepoRaw(token, owner, repo);
      if (!now) return { applied: null };
      return (now.description || '') === wanted ? { applied: true, value: now } : { applied: false };
    });
  }
}

/** GitHub's Repos API has no "set license" field — a repo's detected
 * license comes from actually scanning a LICENSE file in the tree
 * (licensee). To change it, we fetch the real license body text from
 * GitHub's own /licenses/{key} endpoint and write/replace a LICENSE file —
 * same mechanism a person clicking "Add license" on github.com uses. */
async function getLicenseText(token, licenseKey) {
  return withAbortTimeout((signal) => (async () => {
    const octo = client(token);
    const { data } = await octo.licenses.get({ license: licenseKey, request: { signal } });
    return data.body;
  })(), 'Fetch license text');
}

async function forkRepo(token, owner, repo, { org = null } = {}) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      const { data } = await octo.repos.createFork({ owner, repo, ...(org ? { organization: org } : {}), request: { signal } });
      return data;
    })(), 'Fork repo', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => {
      const me = await getAuthenticatedUser(token);
      const mine = await readRepoRaw(token, org || me.login, repo);
      const fresh = mine && mine.fork && mine.created_at && Date.now() - Date.parse(mine.created_at) < 10 * 60 * 1000;
      return fresh ? { applied: true, value: mine } : { applied: false };
    });
  }
}

/** Last N commits — used for Repo View's commit preview (#5). */
async function getRecentCommits(token, owner, repo, count = 3) {
  return withRetry((signal) => (async () => {
    const octo = client(token);
    const { data } = await octo.repos.listCommits({ owner, repo, per_page: count, request: { signal } });
    return data.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0], // first line only — commit bodies can be long
      author: c.commit.author.name,
      date: c.commit.author.date,
    }));
  })(), 'Get recent commits');
}

/** Star/unstar a repo (#6 — quick toggle on public/external repos). GitHub's
 * star endpoints return 204 No Content on success, nothing to parse. */
async function starRepo(token, owner, repo) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      await octo.activity.starRepoForAuthenticatedUser({ owner, repo, request: { signal } });
    })(), 'Star repo', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => ({ applied: await isStarred(token, owner, repo) === true }));
  }
}

async function unstarRepo(token, owner, repo) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      await octo.activity.unstarRepoForAuthenticatedUser({ owner, repo, request: { signal } });
    })(), 'Unstar repo', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => ({ applied: await isStarred(token, owner, repo) === false }));
  }
}

/** GitHub returns 204 if starred, 404 if not — neither is really an "error"
 * for our purposes, so this normalizes both into a plain boolean instead of
 * making every caller handle a 404 specially. */
async function isStarred(token, owner, repo) {
  return withRetry((signal) => (async () => {
    const octo = client(token);
    try {
      await octo.activity.checkRepoIsStarredByAuthenticatedUser({ owner, repo, request: { signal } });
      return true;
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  })(), 'Check starred');
}

// ETag cache for the tree fetch (the most expensive, most-repeated
// read: Browse Files, file search, and the upload wizard's diff/classify
// step all hit it). A conditional request that comes back 304 doesn't count
// against rate-limit quota at all, unlike a normal request. Keyed on the
// resolved ref sha, not just owner/repo, so a stale entry can never be
// served across an actual branch update — the ref lookup itself always
// happens fresh; only the (large) recursive tree body is conditional.
// v1.2.1-multi: bounded by TOTAL tree entries (a 20,000-entry tree is ~2 MB; 300 of them was ~600 MB), not just count.
const treeEtagCache = new (require('./boundedMap').BoundedMap)({ max: 300, maxWeight: Number(process.env.TREE_CACHE_MAX_ENTRIES) || 60000, weight: (v) => (v && v.tree && v.tree.length) || 1, name: 'treeEtag' }); // `${owner}/${repo}:${sha}` -> { etag, tree }

/** Fetches the full recursive git tree, unfiltered (files + folders). Shared
 * by getTree() (files-only, for Browse Files/upload change-detection) and
 * getTreeStats() (size/file/folder counts, for Repo View). */
// Defensive hard cap on how many tree entries we'll ever hold onto for one
// repo, independent of whatever GitHub itself reports as truncated —
// protects against pathologically large monorepos blowing up memory or
// downstream Telegram message sizes even in the (rare) case GitHub
// doesn't flag its own response as truncated for some reason.
const MAX_TREE_ENTRIES = 20000;

/** An empty repo (no commit yet) has no branch and no tree — GitHub answers 404/409. That is "no files", not an error. */
async function emptyTreeIfRepoEmpty(err, token, owner, repo) {
  if (!err || (err.status !== 404 && err.status !== 409)) return null;
  if (err.status === 404) {
    try { await getRepo(token, owner, repo); } catch (_) { return null; } // the repo itself is missing: a real error
  }
  const tree = [];
  tree.truncated = false;
  return tree;
}

async function getRawTree(token, owner, repo, branch = null) {
  try {
    return await getRawTreeUnchecked(token, owner, repo, branch);
  } catch (err) {
    const empty = await emptyTreeIfRepoEmpty(err, token, owner, repo);
    if (empty) return empty;
    throw err;
  }
}

async function getRawTreeUnchecked(token, owner, repo, branch = null) {
  return coalesce(`getRawTree:${tokenFingerprint(token)}:${owner}/${repo}:${branch || ''}`, () => withRetry((signal) => (async () => {
    const octo = client(token);
    const repoData = branch ? { default_branch: branch } : await getRepo(token, owner, repo);
    const { data: refData } = await octo.git.getRef({
      owner,
      repo,
      ref: `heads/${repoData.default_branch}`,
      request: { signal },
    });
    const sha = refData.object.sha;
    const cacheKey = `${owner}/${repo}:${sha}`;
    const cached = treeEtagCache.get(cacheKey);

    try {
      const headers = cached ? { 'If-None-Match': cached.etag } : undefined;
      const response = await octo.git.getTree({
        owner,
        repo,
        tree_sha: sha,
        recursive: 'true',
        headers,
        request: { signal },
      });
      const etag = response.headers && response.headers.etag;
      // GitHub itself sets `truncated: true` on the response once a repo's
      // tree exceeds their own recursive-fetch limit (~100k entries / 7MB) —
      // previously silently ignored, meaning a huge repo's tree looked
      // complete when it quietly wasn't. Our own MAX_TREE_ENTRIES cap below
      // catches the (much more common) case of repos too large for a
      // Telegram-friendly experience well before GitHub's own limit.
      let tree = response.data.tree;
      let truncated = !!response.data.truncated;
      if (tree.length > MAX_TREE_ENTRIES) {
        tree = tree.slice(0, MAX_TREE_ENTRIES);
        truncated = true;
      }
      if (etag) treeEtagCache.set(cacheKey, { etag, tree, truncated });
      // v1.2.0-multi: raised from 50 ("a single-owner bot only has so many
      // repos open at once") now that many different users' repos can
      // legitimately be cached in the same process at once.
      tree.truncated = truncated; // carried on the array itself — see getTree()/getTreeStats()
      return tree;
    } catch (err) {
      if (err.status === 304 && cached) {
        const tree = cached.tree;
        tree.truncated = cached.truncated;
        return tree; // unchanged — served from cache, zero quota cost
      }
      throw err;
    }
  })(), 'Get file tree'));
}

/** Full recursive file tree — used for both Browse Files and file search.
 * The returned array carries a `.truncated` boolean property (not a
 * normal element, just an extra property on the array itself) — set when
 * either GitHub's own response was truncated or our MAX_TREE_ENTRIES cap
 * kicked in. Kept as an array (not `{items, truncated}`) deliberately, so
 * every existing caller that just iterates/filters the array keeps
 * working unchanged; only callers that specifically want to show a
 * "partial tree" notice need to check `.truncated`. */
async function getTree(token, owner, repo, branch = null) {
  const tree = await getRawTree(token, owner, repo, branch);
  const files = tree.filter((entry) => entry.type === 'blob'); // files only
  files.truncated = tree.truncated;
  return files;
}

/**
 * Repo size/file/folder counts computed from the tree we already fetch —
 * GitHub's own `repo.size` field (KB) is a periodically-recomputed cache on
 * their end and visibly lags real changes (e.g. right after an upload), so
 * we derive the real numbers from the same tree data instead of trusting it.
 * Falls back to `null` sizeBytes for entries GitHub returns without a size
 * (only happens for very large blobs it declines to size inline) — those are
 * summed as 0 and callers should treat the total as a lower bound in that case.
 */
async function getTreeStats(token, owner, repo, branch = null) {
  const tree = await getRawTree(token, owner, repo, branch);
  let sizeBytes = 0;
  let fileCount = 0;
  let folderCount = 0;
  let sizeIncomplete = false;
  for (const entry of tree) {
    if (entry.type === 'blob') {
      fileCount++;
      if (typeof entry.size === 'number') sizeBytes += entry.size;
      else sizeIncomplete = true;
    } else if (entry.type === 'tree') {
      folderCount++;
    }
  }
  // If the tree itself was truncated (see getRawTree), the counts/size
  // above are only a lower bound too — same honesty as sizeIncomplete,
  // just a different reason for it.
  if (tree.truncated) sizeIncomplete = true;
  return { sizeBytes, fileCount, folderCount, sizeIncomplete, treeTruncated: !!tree.truncated };
}

/** Encodes file content to base64 for GitHub's Contents/Git Data APIs without
 * ever routing through a UTF-8 string round-trip — that round-trip is lossy
 * for arbitrary bytes (images, PDFs, zips, executables, ...), silently
 * corrupting anything that isn't valid UTF-8 text. Buffers are encoded as-is;
 * plain strings (e.g. hand-typed commit content, license text) still go
 * through Buffer.from(..., 'utf8') since those are always genuine text. */
function toBase64(content) {
  return (Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')).toString('base64');
}

/**
 * Fetches a file's raw bytes as a Buffer — NOT decoded to a string — since
 * this is used for binary files (images, etc.) as well as text. Callers that
 * know they have text (Browse Files' text preview, Edit File, README/LICENSE
 * handling) should call `.toString('utf8')` on `content` themselves.
 *
 * GitHub's Contents API only returns inline `content` for files under 1MB —
 * for anything larger it comes back with an empty/missing content field even
 * though `size` is correctly reported. Silently treating that as "empty
 * file" would be actively dangerous for callers like Edit File (could
 * overwrite a real file with near-nothing), so this throws a clear,
 * recognizable error instead of returning a corrupted result.
 */
/**
 * Fetch one file. GitHub's contents endpoint only returns the body of files under 1MB, so by
 * default a bigger file is an error — which is right for editing and previews. v1.2.3-multi
 * options for the callers that really do need more:
 *   - allowLarge: fall back to the git BLOB endpoint (up to 100MB) for files over 1MB, refusing
 *     anything above `maxBytes` (default 50MB) with err.code = 'FILE_TOO_LARGE' and err.size set;
 *   - shaOnly: for callers that just need the blob sha (e.g. to delete the file) — never
 *     downloads or fails on size.
 */
async function getFileContent(token, owner, repo, path, { allowLarge = false, shaOnly = false, maxBytes = 50 * 1024 * 1024, branch = null } = {}) {
  return withRetry((signal) => (async () => {
    const octo = client(token);
    const { data } = await octo.repos.getContent({ owner, repo, path, ...(branch ? { ref: branch } : {}), request: { signal } });
    if (Array.isArray(data)) throw new Error('Path is a directory, not a file');
    if (!data.content && data.size > 0) {
      if (shaOnly) return { content: null, sha: data.sha, size: data.size };
      if (!allowLarge) {
        throw new Error(`File is too large to fetch inline (${data.size} bytes) — GitHub's API only returns content for files under 1MB.`);
      }
      if (data.size > maxBytes) {
        throw Object.assign(new Error(`File is ${data.size} bytes — over the ${maxBytes}-byte limit for this action.`), { code: 'FILE_TOO_LARGE', size: data.size });
      }
      const blob = await octo.git.getBlob({ owner, repo, file_sha: data.sha, request: { signal } });
      return { content: Buffer.from(blob.data.content || '', blob.data.encoding || 'base64'), sha: data.sha, size: data.size };
    }
    if (allowLarge && data.size > maxBytes) {
      throw Object.assign(new Error(`File is ${data.size} bytes — over the ${maxBytes}-byte limit for this action.`), { code: 'FILE_TOO_LARGE', size: data.size });
    }
    const content = Buffer.from(data.content || '', data.encoding || 'base64');
    return { content, sha: data.sha, size: data.size };
  })(), 'Get file content');
}

/** v1.2.5-multi: remember a commit GitroHub just made so it can be undone from ⏪ Undo & Restore. Fire-and-forget. */
function journalCommit(owner, repo, branch, sha, message) {
  if (!sha) return;
  try {
    require('./changeJournal').record({ owner, repo, kind: 'commit', ref: branch || null, sha, label: message }).catch(() => {});
  } catch (_) { /* the journal must never be able to fail a commit */ }
}

/**
 * Create or update a single file — one commit per call.
 * For multi-file zip uploads, use commitMultipleFiles() instead (one commit total).
 * `content` may be a Buffer (preserves binary fidelity) or a plain text string.
 */
async function putFile(token, owner, repo, path, content, message, existingSha = null, { branch = null } = {}) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      const { data } = await octo.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: toBase64(content),
        sha: existingSha || undefined,
        ...(branch ? { branch } : {}),
        request: { signal },
      });
      journalCommit(owner, repo, branch, data && data.commit && data.commit.sha, message);
      return data;
    })(), 'Update file', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => {
      const now = await readFileRaw(token, owner, repo, path, branch);
      // The file now holds exactly the bytes we sent ⇒ the write landed (blob sha is a content hash).
      if (now && !Array.isArray(now) && now.sha === gitBlobSha(content)) return { applied: true, value: { content: { sha: now.sha, path }, commit: null, reconciled: true } };
      if (now && !Array.isArray(now) && existingSha && now.sha === existingSha) return { applied: false };
      return { applied: now === null && !existingSha ? false : null };
    });
  }
}

async function deleteFile(token, owner, repo, path, sha, message, { branch = null } = {}) {
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      const { data } = await octo.repos.deleteFile({ owner, repo, path, message, sha, ...(branch ? { branch } : {}), request: { signal } });
      journalCommit(owner, repo, branch, data && data.commit && data.commit.sha, message);
      return data;
    })(), 'Delete file', undefined, { mutation: true });
  } catch (err) {
    return reconcileUnknown(err, async () => {
      const now = await readFileRaw(token, owner, repo, path, branch);
      if (now === null) return { applied: true, value: { content: null, commit: null, reconciled: true } };
      return !Array.isArray(now) && now.sha === sha ? { applied: false } : { applied: null };
    });
  }
}

/**
 * Commit multiple files (and optionally delete some) in ONE commit using the
 * Git Data API (blobs -> tree -> commit -> update ref). Deletions are done by
 * setting `sha: null` on that path's tree entry, which GitHub's Git Trees API
 * treats as "remove this path" when building on top of an existing base_tree.
 *
 * Given a large batch/zip can genuinely need several sequential API calls,
 * this gets a longer timeout window than the single-call operations above —
 * still bounded, just sized for what a real multi-file commit can take.
 * All calls (including the parallel blob creations) share ONE AbortController,
 * so if the 45s ceiling is hit, every still-in-flight request — not just the
 * one we happened to be awaiting — actually gets torn down together.
 */
/** Blobs are created with bounded concurrency (default 4 in flight). The old
 * code created every blob at once via Promise.all — for a 100+ file upload
 * that burst is precisely what trips GitHub's secondary (abuse) rate limit.
 * Since v1.2.1-multi a secondary-limit response on ANY request (blobs
 * included — they are content-addressed, so retrying is always safe) is
 * paused and retried by the traffic manager, per the Retry-After header, so
 * the local backoff loop this used to carry is gone. */
const BLOB_CONCURRENCY = Math.max(1, Number(process.env.GITHUB_BLOB_CONCURRENCY) || 4);

// ── v2.3.3: how a big upload is sent ─────────────────────────────────────────────────────────────────────────────────────
// GitHub allows roughly 80 content-creating requests a minute. One blob per file blows through that for a whole-project
// zip, so text files travel INSIDE the tree request (GitHub makes the blob itself — zero extra requests); only binaries and
// empty files still get a blob of their own, and those are paced to stay under the cap. Trees are built in chunks on top of
// each other, so no single request is huge.
const INLINE_FILE_MAX = 400 * 1024;       // a text file above this still goes through the blob API
const TREE_CHUNK_FILES = 100;             // entries per tree request
const TREE_CHUNK_BYTES = 1.5 * 1024 * 1024; // inline text per tree request
const BLOB_PACE_MS = Math.max(0, Number(process.env.GITHUB_BLOB_PACE_MS) || 900); // ≈ 66 blobs a minute
const BLOB_PACE_FROM = 30;                // pacing only matters for bigger batches
const MAX_PAUSES = 4;                     // rate-limit pauses one commit will sit through
const MAX_PAUSE_MS = 5 * 60 * 1000;       // …and the longest single one

/** The file as a UTF-8 string when it can travel inside a tree request unchanged, else null (binary, empty, or too big). */
function inlineTextOf(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content == null ? '' : content), 'utf8');
  if (buf.length === 0 || buf.length > INLINE_FILE_MAX) return null;
  if (buf.includes(0)) return null; // NUL byte: binary
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null; // only when decoding loses nothing
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds GitHub (or the local hold) wants us to wait when `err` is a "slow down", else null. */
function rateLimitPauseMs(err) {
  const slow = require('./rateLimitFriendly').describe(err);
  if (!slow) return null;
  const secs = slow.secs || 60;
  return Math.max(2000, secs * 1000 + 500);
}

/**
 * Commit multiple files (and optionally delete some) in ONE commit using the Git Data API. Deletions are `sha: null` tree
 * entries on top of the base tree.
 *
 * Options (all optional):
 *   onProgress({ stage, done, total, pauseSecs })  stage: 'preparing' | 'committing' | 'paused' | 'resumed' | 'finalizing'
 *   shouldCancel()  → true stops the upload BEFORE the branch moves (nothing visible has changed; the unreferenced objects
 *                    GitHub already holds are harmless). After the branch update starts it is too late and cancel is ignored.
 *
 * Every step before the branch update only creates content-addressed objects nothing points at, so it can be repeated
 * freely. That is what makes the pause safe: on a rate limit the step waits and tries again, and files already sent are
 * never sent twice. Only the final branch update can leave the outcome genuinely unknown (see reconcileUnknown).
 */
async function commitMultipleFiles(token, owner, repo, files, message, deletions = [], { branch: targetBranch = null, onProgress = null, shouldCancel = null } = {}) {
  const report = (info) => { try { if (onProgress) onProgress(info); } catch (_) { /* progress is cosmetic */ } };
  const cancelled = () => { try { return !!(shouldCancel && shouldCancel()); } catch (_) { return false; } };
  const total = files.length;
  let done = 0;
  let pauses = 0;
  let pausedUntil = 0;
  let stage = 'prepare';
  let branch = null;
  let latestCommitSha = null;
  let newCommit = null;
  const octo = client(token);

  const throwIfCancelled = () => {
    if (!cancelled()) return;
    const e = new Error('Upload cancelled — nothing was changed.');
    e.code = 'UPLOAD_CANCELLED';
    e.outcome = 'failed';
    throw e;
  };

  /** Waits out a shared pause (so parallel workers pause together), reporting a countdown and honouring cancel. */
  const waitForPause = async () => {
    let lastReport = 0;
    while (Date.now() < pausedUntil) {
      throwIfCancelled();
      const left = Math.ceil((pausedUntil - Date.now()) / 1000);
      if (Date.now() - lastReport >= 10000) { report({ stage: 'paused', done, total, pauseSecs: left }); lastReport = Date.now(); }
      await sleepMs(Math.min(1000, Math.max(50, pausedUntil - Date.now())));
    }
  };

  /** One repeatable step: its own deadline, and a rate limit means "wait, then try this same step again". */
  const step = async (label, fn, { mutation = false } = {}) => {
    for (;;) {
      throwIfCancelled();
      if (Date.now() < pausedUntil) { await waitForPause(); report({ stage: 'resumed', done, total }); }
      try {
        return await withAbortTimeout((signal) => fn(signal), label, 30000, { mutation });
      } catch (err) {
        const wait = rateLimitPauseMs(err);
        if (wait == null || wait > MAX_PAUSE_MS) throw err;
        // Parallel workers that hit the SAME limit share one pause: only the first of them counts and reports it.
        if (Date.now() >= pausedUntil) {
          if (pauses >= MAX_PAUSES) throw err;
          pauses++;
          pausedUntil = Date.now() + wait;
          report({ stage: 'paused', done, total, pauseSecs: Math.ceil(wait / 1000) });
        }
      }
    }
  };

  try {
    report({ stage: 'preparing', done, total });
    const refData = await step('Read branch', async (signal) => {
      branch = targetBranch || (await getRepo(token, owner, repo)).default_branch;
      return (await octo.git.getRef({ owner, repo, ref: `heads/${branch}`, request: { signal } })).data;
    });
    latestCommitSha = refData.object.sha;
    const latestCommit = await step('Read commit', async (signal) => (await octo.git.getCommit({ owner, repo, commit_sha: latestCommitSha, request: { signal } })).data);
    const baseTreeSha = latestCommit.tree.sha;

    // Split: text rides inside the tree request; everything else needs a blob first.
    const inline = [];
    const needBlob = [];
    for (const f of files) {
      const text = inlineTextOf(f.content);
      const mode = f.mode === '100755' ? '100755' : '100644';
      if (text != null) inline.push({ path: f.path, mode, type: 'blob', content: text, bytes: Buffer.byteLength(text) });
      else needBlob.push(f);
    }

    // Binaries / empty files: blobs, bounded concurrency, paced when there are many.
    const paceMs = needBlob.length > BLOB_PACE_FROM ? BLOB_PACE_MS : 0;
    let nextSlot = 0;
    const blobEntries = await mapLimit(needBlob, BLOB_CONCURRENCY, async (f) => {
      if (paceMs) { const at = Math.max(Date.now(), nextSlot); nextSlot = at + paceMs; if (at > Date.now()) await sleepMs(at - Date.now()); }
      const blob = await step('Create blob', async (signal) => (await octo.git.createBlob({ owner, repo, content: toBase64(f.content), encoding: 'base64', request: { signal } })).data);
      done++;
      report({ stage: 'committing', done, total });
      return { path: f.path, mode: f.mode === '100755' ? '100755' : '100644', type: 'blob', sha: blob.sha };
    });

    // Tree, built up in chunks (each chunk sits on the tree before it).
    const chunks = [];
    let current = []; let currentBytes = 0;
    const flush = () => { if (current.length) { chunks.push(current); current = []; currentBytes = 0; } };
    for (const entry of [...blobEntries, ...inline]) {
      const bytes = entry.bytes || 0;
      if (current.length >= TREE_CHUNK_FILES || (current.length && currentBytes + bytes > TREE_CHUNK_BYTES)) flush();
      current.push(entry); currentBytes += bytes;
    }
    flush();
    const deletionEntries = deletions.map((path) => ({ path, mode: '100644', type: 'blob', sha: null }));
    if (deletionEntries.length) chunks.push(deletionEntries);
    if (chunks.length === 0) chunks.push([]);

    let treeSha = baseTreeSha;
    for (const chunk of chunks) {
      const entries = chunk.map(({ bytes, ...rest }) => rest);
      const base = treeSha;
      const inlineCount = chunk.filter((e) => e.content != null).length;
      const created = await step('Create tree', async (signal) => (await octo.git.createTree({ owner, repo, base_tree: base, tree: entries, request: { signal } })).data);
      treeSha = created.sha;
      done += inlineCount;
      report({ stage: 'committing', done, total });
    }

    report({ stage: 'finalizing', done, total });
    throwIfCancelled();
    newCommit = await step('Create commit', async (signal) => (await octo.git.createCommit({ owner, repo, message, tree: treeSha, parents: [latestCommitSha], request: { signal } })).data);

    // Point of no return: from here the branch may move, so cancel is no longer honoured.
    stage = 'ref';
    try {
      // Never force-update the branch here. Another GitroHub action (or a normal GitHub client) may have advanced the
      // branch after we read latestCommitSha. A forced update would silently discard that newer commit. GitHub rejects the
      // stale ref update instead, allowing the caller to retry from the new branch tip.
      await step('Update branch', async (signal) => octo.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha, force: false, request: { signal } }), { mutation: true });
    } catch (err) {
      // 409, or the specific 422 GitHub returns for a non-fast-forward ref update. Other 422s keep their own message.
      const notFastForward = err && err.status === 422 && /fast[- ]?forward/i.test(String(err.message));
      if (err && (err.status === 409 || notFastForward)) {
        err.code = 'GIT_REF_CONFLICT';
        err.message = 'The branch changed while this commit was being prepared. No changes were overwritten; please retry.';
      }
      throw err;
    }

    journalCommit(owner, repo, branch, newCommit.sha, message);
    return newCommit;
  } catch (err) {
    if (stage !== 'ref') {
      // Nothing references the new objects yet — certainly not applied.
      if (err && err.outcome === 'unknown') {
        err.outcome = 'failed';
        if (err.code === 'GITHUB_OUTCOME_UNKNOWN') err.code = err.reason || 'GITHUB_REQUEST_FAILED';
        err.message = err.originalMessage || err.message;
      }
      throw err;
    }
    return reconcileUnknown(err, async () => {
      const { data } = await withAbortTimeout((signal) => client(token).git.getRef({ owner, repo, ref: `heads/${branch}`, request: { signal } }), 'Verify branch');
      const tip = data.object.sha;
      if (newCommit && tip === newCommit.sha) return { applied: true, value: newCommit };
      if (tip === latestCommitSha) return { applied: false };
      return { applied: null }; // the branch moved on for another reason — can't attribute it
    });
  }
}

/** Codeload zip URL — kept for reference/fallback links in error messages only */
function zipDownloadUrl(owner, repo, branch = 'main') {
  return `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
}

/**
 * Downloads a repo archive as a Buffer using the authenticated Git Archive API.
 * Unlike a plain fetch() against github.com/.../archive/...zip (which returns a
 * 9-byte "Not Found" for any private repo since it isn't authenticated), this
 * goes through Octokit with the user's token and works for private AND public repos.
 */
async function downloadZip(token, owner, repo, ref) {
  // v1.2.1-multi: the whole archive is buffered in memory, so downloads are
  // (1) refused up front for repositories far too large to hold, and
  // (2) gated: a global + per-user concurrency limit with a bounded queue, so
  // many simultaneous downloads can't add up to an out-of-memory crash.
  const maxKb = Number(process.env.DOWNLOAD_MAX_REPO_KB) || 256000;
  const info = await getRepo(token, owner, repo).catch(() => null);
  if (info && Number(info.size) > maxKb) {
    const err = new Error(`This repository is about ${Math.round(Number(info.size) / 1024)} MB — too large to download through the bot. Nothing was changed.`);
    err.code = 'DOWNLOAD_TOO_LARGE';
    err.outcome = 'failed';
    throw err;
  }
  const ctx = requestContext.current();
  return downloadGate().run(ctx.userId != null ? ctx.userId : tokenFingerprint(token).slice(0, 12), () => withAbortTimeout((signal) => (async () => {
    const octo = client(token);
    const response = await octo.repos.downloadZipballArchive({ owner, repo, ref, request: { signal } });
    return Buffer.from(response.data);
  })(), 'Download zip', Math.max(requestTimeoutMs(), 60000)));
}

/** Fetches per-language byte counts (used to compute language % breakdown) */
async function getLanguages(token, owner, repo) {
  return withRetry((signal) => (async () => {
    const octo = client(token);
    const { data } = await octo.repos.listLanguages({ owner, repo, request: { signal } });
    return data; // { JavaScript: 12345, HTML: 6789, ... } bytes per language
  })(), 'Get languages');
}

// Low-level helpers shared with src/lib/github/* (v1.2.4-multi): same client, same traffic hook, same
// deadline + unknown-outcome handling as every function in this file.
const internals = { client, withAbortTimeout, withRetry, reconcileUnknown, coalesce, tokenFingerprint };

module.exports = {
  internals,
  _emptyTreeIfRepoEmpty: emptyTreeIfRepoEmpty,
  getAuthenticatedUser,
  getRateLimit,
  listRepos,
  revokeOAuthAccess,
  getRepo,
  createRepo,
  deleteRepo,
  createWebhook,
  updateWebhookEvents,
  WEBHOOK_EVENTS,
  deleteWebhook,
  renameRepo,
  setVisibility,
  updateDescription,
  getLicenseText,
  forkRepo,
  getRecentCommits,
  starRepo,
  unstarRepo,
  isStarred,
  getTree,
  getTreeStats,
  getFileContent,
  putFile,
  deleteFile,
  commitMultipleFiles,
  zipDownloadUrl,
  downloadZip,
  getLanguages,
  isRateLimitError,
  isSecondaryRateLimitError,
  isUnknownOutcome,
  getLastKnownRateLimit,
};
