/**
 * Scriptable fake GitHub + fake Octokit (v1.2.1-multi test support).
 *
 * `@octokit/rest` isn't needed to prove the traffic layer's behaviour — what
 * matters is the contract it relies on: `octo.hook.wrap('request', …)`, the
 * `octo.<ns>.<fn>(params)` route methods, `octo.paginate`, RequestError-shaped
 * failures, and Octokit's quirk of reporting network failures as status 500
 * WITHOUT a `response`. This reproduces exactly that, so github.js can be
 * exercised end to end (hook → manager → fake transport) with no network.
 */
const ROUTES = {
  users: { getAuthenticated: ['GET', '/user'] },
  rateLimit: { get: ['GET', '/rate_limit'] },
  licenses: { get: ['GET', '/licenses/{license}'] },
  activity: {
    starRepoForAuthenticatedUser: ['PUT', '/user/starred/{owner}/{repo}'],
    unstarRepoForAuthenticatedUser: ['DELETE', '/user/starred/{owner}/{repo}'],
    checkRepoIsStarredByAuthenticatedUser: ['GET', '/user/starred/{owner}/{repo}'],
  },
  repos: {
    listForAuthenticatedUser: ['GET', '/user/repos'],
    get: ['GET', '/repos/{owner}/{repo}'],
    createForAuthenticatedUser: ['POST', '/user/repos'],
    delete: ['DELETE', '/repos/{owner}/{repo}'],
    update: ['PATCH', '/repos/{owner}/{repo}'],
    createWebhook: ['POST', '/repos/{owner}/{repo}/hooks'],
    deleteWebhook: ['DELETE', '/repos/{owner}/{repo}/hooks/{hook_id}'],
    createFork: ['POST', '/repos/{owner}/{repo}/forks'],
    listCommits: ['GET', '/repos/{owner}/{repo}/commits'],
    listLanguages: ['GET', '/repos/{owner}/{repo}/languages'],
    getContent: ['GET', '/repos/{owner}/{repo}/contents/{path}'],
    createOrUpdateFileContents: ['PUT', '/repos/{owner}/{repo}/contents/{path}'],
    deleteFile: ['DELETE', '/repos/{owner}/{repo}/contents/{path}'],
    downloadZipballArchive: ['GET', '/repos/{owner}/{repo}/zipball/{ref}'],
  },
  git: {
    getRef: ['GET', '/repos/{owner}/{repo}/git/ref/{ref}'],
    getTree: ['GET', '/repos/{owner}/{repo}/git/trees/{tree_sha}'],
    getCommit: ['GET', '/repos/{owner}/{repo}/git/commits/{commit_sha}'],
    createBlob: ['POST', '/repos/{owner}/{repo}/git/blobs'],
    createTree: ['POST', '/repos/{owner}/{repo}/git/trees'],
    createCommit: ['POST', '/repos/{owner}/{repo}/git/commits'],
    updateRef: ['PATCH', '/repos/{owner}/{repo}/git/refs/{ref}'],
  },
};

function requestError(status, message, headers = {}, data = {}) {
  const e = new Error(message);
  e.name = 'HttpError';
  e.status = status;
  e.response = { status, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])), data };
  return e;
}
/** What Octokit throws when fetch itself fails: status 500, NO response. */
function networkError(message = 'fetch failed', code) {
  const e = new Error(message);
  e.name = 'HttpError';
  e.status = 500;
  if (code) e.cause = Object.assign(new Error(code), { code });
  return e;
}
const secondaryLimit = (retryAfterSecs) => requestError(403, 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.', retryAfterSecs != null ? { 'retry-after': retryAfterSecs } : {}, { documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits' });
const primaryLimit = (resetEpochSecs) => requestError(403, 'API rate limit exceeded for user ID 1.', { 'x-ratelimit-remaining': 0, 'x-ratelimit-limit': 5000, 'x-ratelimit-reset': resetEpochSecs });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(networkError('This operation was aborted'), { name: 'AbortError' }));
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(Object.assign(networkError('This operation was aborted'), { name: 'AbortError' })); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

class FakeGitHub {
  constructor() {
    this.calls = [];
    this.handlers = []; // { test, fn, times }
    this.latencyMs = 0;
    this.active = 0;
    this.peak = 0;
    this.byToken = new Map(); // token -> { active, peak }
  }

  /** Register a handler for requests matching `test` ("GET /user" | fn | RegExp on "METHOD template"). */
  on(test, fn, { times = Infinity } = {}) { this.handlers.push({ test, fn, times }); return this; }
  clear() { this.handlers = []; this.calls = []; }

  _match(h, opts) {
    const label = `${opts.method} ${opts.url}`;
    if (typeof h.test === 'string') return label === h.test;
    if (h.test instanceof RegExp) return h.test.test(label);
    return !!h.test(opts, label);
  }

  async transport(opts, token) {
    const call = { method: opts.method, url: opts.url, params: opts.params, token, at: Date.now() };
    this.calls.push(call);
    this.active++; this.peak = Math.max(this.peak, this.active);
    const t = this.byToken.get(token) || { active: 0, peak: 0 };
    t.active++; t.peak = Math.max(t.peak, t.active); this.byToken.set(token, t);
    try {
      call.concurrentForToken = t.active;
      if (this.latencyMs) await abortableSleep(typeof this.latencyMs === 'function' ? this.latencyMs(opts) : this.latencyMs, opts.signal);
      for (const h of this.handlers) {
        if (h.times > 0 && this._match(h, opts)) {
          h.times--;
          const out = await h.fn(opts, call);
          return { status: 200, headers: {}, url: opts.url, ...out };
        }
      }
      return { status: 200, headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) }, data: {}, url: opts.url };
    } finally { this.active--; t.active--; }
  }
}

function makeOctokit(gh) {
  return class Octokit {
    constructor({ auth } = {}) {
      this.auth = auth;
      this._wraps = [];
      this.hook = {
        wrap: (name, fn) => { if (name === 'request') this._wraps.push(fn); },
        after() {}, error() {}, before() {},
      };
      const base = async (options) => {
        const signal = options.request && options.request.signal;
        const params = { ...options };
        for (const k of ['method', 'url', 'headers', 'request', 'mediaType', 'baseUrl']) delete params[k];
        return gh.transport({ method: options.method, url: options.url, params, headers: options.headers || {}, signal }, this.auth);
      };
      this.request = (arg, extra) => {
        // v1.2.4-multi: real Octokit also accepts request("GET /repos/{owner}/{repo}", params) — parse it the same way
        let options = arg;
        if (typeof arg === 'string') {
          const [method, url] = arg.split(' ');
          options = { method, url, ...(extra || {}) };
        }
        let fn = base;
        for (const w of this._wraps) { const inner = fn; fn = (opts) => w(inner, opts); }
        return fn({ ...options, request: { hook: true, ...(options.request || {}) } });
      };
      for (const [ns, fns] of Object.entries(ROUTES)) {
        this[ns] = {};
        for (const [name, [method, url]] of Object.entries(fns)) {
          this[ns][name] = (params = {}) => this.request({ method, url, ...params });
          this[ns][name].route = { method, url };
        }
      }
      this.rest = this;
      this.paginate = async (fn, params = {}) => {
        const out = []; const per = params.per_page || 30;
        for (let page = 1; page < 50; page++) {
          const res = await fn({ ...params, page });
          const items = Array.isArray(res.data) ? res.data : [];
          out.push(...items);
          if (items.length < per) break;
        }
        return out;
      };
    }
  };
}

module.exports = { FakeGitHub, makeOctokit, requestError, networkError, secondaryLimit, primaryLimit, sleep, abortableSleep, ROUTES };
