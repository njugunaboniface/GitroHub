/**
 * GitHub traffic layer entry point (v1.2.1-multi).
 *
 * `installHook(octo, token)` wraps an Octokit instance's `request` so EVERY
 * call — including each page of octo.paginate() — flows through the manager.
 * github.js keeps its public API, so no feature call site changes.
 *
 * Safe-read optimisations live here (not in the manager) because they need
 * the request shape:
 *  • coalescing of identical in-flight GETs (same identity + same params +
 *    same repo "write epoch", so a read can never be served a result that
 *    pre-dates a write we made);
 *  • a tiny conditional-request cache (ETag/If-None-Match → a 304 costs no
 *    quota) with a short TTL for three cheap metadata endpoints.
 * Mutations are NEVER coalesced, cached or retried blindly.
 */
const crypto = require('crypto');
const configModule = require('./config');
const { GithubTrafficManager, GithubTrafficError } = require('./manager');
const { describeRequest } = require('./request');
const requestContext = require('../requestContext');

const TTL_ENDPOINTS = new Set(['/repos/:owner/:repo', '/repos/:owner/:repo/languages', '/user']);
const CONDITIONAL_ENDPOINTS = new Set([...TTL_ENDPOINTS, '/repos/:owner/:repo/commits']);
const MAX_CACHED_BYTES = 200 * 1024;

function stableKey(identity, options, d) {
  const skip = new Set(['request', 'headers', 'method', 'baseUrl', 'mediaType', 'url']);
  const params = Object.keys(options).filter((k) => !skip.has(k)).sort().map((k) => `${k}=${JSON.stringify(options[k])}`).join('&');
  return `${identity}|${d.method}|${d.template}|${params}`;
}

function isBinaryRead(options) {
  const accept = String((options.headers && (options.headers.accept || options.headers.Accept)) || '');
  return !!(options.mediaType && options.mediaType.format) || /raw|diff|patch|octet/i.test(accept);
}

function createTraffic(config = configModule.load(), deps = {}) {
  const manager = new GithubTrafficManager(config, deps);
  const inflight = new Map(); // key -> Promise<response>
  const cache = new Map(); // key -> { etag, res, storedAt, epoch }

  function cacheSet(key, entry) {
    if (!config.cacheMaxEntries) return;
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > config.cacheMaxEntries) cache.delete(cache.keys().next().value);
  }

  function execute(identity, request, options) {
    const d = describeRequest(options);
    const ctx = requestContext.current();
    const callerSignal = options.request && options.request.signal;
    const meta = {
      identity, userId: ctx.userId, priority: ctx.priority || 'interactive',
      operation: ctx.operation || d.category, category: d.category, endpoint: d.endpoint, method: d.method,
      mutation: d.mutation, parallelSafe: d.parallelSafe, repoKey: d.repoKey, resource: d.resource,
      signal: callerSignal, parentId: ctx.opId, timeoutMs: ctx.timeoutMs,
    };
    const send = (extraHeaders) => (signal) => request({
      ...options,
      headers: extraHeaders ? { ...(options.headers || {}), ...extraHeaders } : options.headers,
      request: { ...(options.request || {}), signal },
    });

    const safeRead = !d.mutation && d.method === 'GET' && !isBinaryRead(options) && d.category !== 'download';
    if (!safeRead) return manager.schedule(meta, send());

    const epoch = d.repoKey ? manager.epoch(identity, d.repoKey) : 0;
    const key = `${stableKey(identity, options, d)}|e${epoch}`;
    const cacheKey = stableKey(identity, options, d);
    const conditional = CONDITIONAL_ENDPOINTS.has(d.endpoint) && !(options.headers && (options.headers['if-none-match'] || options.headers['If-None-Match']));
    const cached = conditional ? cache.get(cacheKey) : null;

    // Fresh enough to serve with zero traffic (and no write to this repo since it was stored).
    if (cached && TTL_ENDPOINTS.has(d.endpoint) && config.cacheTtlMs > 0 && cached.epoch === epoch && manager.now() - cached.storedAt < config.cacheTtlMs) {
      manager.noteCacheHit();
      return Promise.resolve(structuredClone(cached.res));
    }

    const existing = inflight.get(key);
    if (existing) {
      manager.noteCoalesced();
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(manager._abortError());
        if (callerSignal) { if (callerSignal.aborted) return onAbort(); callerSignal.addEventListener('abort', onAbort, { once: true }); }
        existing.then(resolve, (err) => {
          // The leader's own cancel/timeout must not become the follower's failure: go again on our own.
          const leaderAborted = err && (err.name === 'AbortError' || err.code === 'GITHUB_TIMEOUT');
          if (leaderAborted && !(callerSignal && callerSignal.aborted)) return execute(identity, request, options).then(resolve, reject);
          reject(err);
        }).finally(() => { if (callerSignal) callerSignal.removeEventListener('abort', onAbort); });
      });
    }

    const run = async (signal) => {
      try {
        const res = await send(cached ? { 'if-none-match': cached.etag } : undefined)(signal);
        const etag = res && res.headers && res.headers.etag;
        const size = Number(res && res.headers && res.headers['content-length']);
        if (conditional && etag && Number.isFinite(size) && size <= MAX_CACHED_BYTES) {
          cacheSet(cacheKey, { etag, res: structuredClone(res), storedAt: manager.now(), epoch });
        }
        return res;
      } catch (err) {
        if (err && err.status === 304 && cached) {
          cached.storedAt = manager.now(); cached.epoch = epoch;
          manager.noteCacheHit();
          return structuredClone(cached.res); // unchanged — served from cache at zero quota cost
        }
        throw err;
      }
    };
    const p = manager.schedule(meta, run);
    inflight.set(key, p);
    p.then(() => inflight.delete(key), () => inflight.delete(key));
    return p;
  }

  function installHook(octo, token) {
    if (!octo || !octo.hook || typeof octo.hook.wrap !== 'function') return false;
    const identity = crypto.createHash('sha256').update(String(token || '')).digest('hex');
    octo.hook.wrap('request', (request, options) => execute(identity, request, options));
    return true;
  }

  return { manager, installHook, execute, config, _cache: cache, _inflight: inflight };
}

let singleton = null;
function getTraffic() {
  if (!singleton) singleton = createTraffic(configModule.load(), { logger: require('../logger') });
  return singleton;
}

module.exports = { createTraffic, getTraffic, GithubTrafficError, requestContext, describeRequest };
