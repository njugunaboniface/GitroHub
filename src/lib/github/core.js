/**
 * Generic GitHub REST helpers for the v1.2.4-multi feature modules (src/lib/github/*).
 *
 * Everything goes through the SAME Octokit client as lib/github.js, so every call is queued, rate-limited,
 * retried and measured by the GitHub traffic manager, bounded by the same operation deadline, and writes
 * report an honest "unknown outcome" instead of pretending nothing happened.
 *
 * Routes are written the way GitHub documents them ("GET /repos/{owner}/{repo}/pulls"), so each feature
 * function is a one-liner that can be checked against the REST docs.
 */
const github = require('../github');
const { client, withAbortTimeout, withRetry, reconcileUnknown } = github.internals;

const hasNextLink = (headers) => /rel="next"/.test(String((headers && headers.link) || ''));

/** One read → response.data. */
async function get(token, route, params = {}, label = 'GitHub request') {
  const res = await withRetry((signal) => client(token).request(route, { ...params, request: { signal } }), label);
  return res.data;
}

/** One read → { data, headers } (for conditional logic on headers/status). */
async function getFull(token, route, params = {}, label = 'GitHub request') {
  const res = await withRetry((signal) => client(token).request(route, { ...params, request: { signal } }), label);
  return { data: res.data, headers: res.headers || {}, status: res.status };
}

/** A page of a list endpoint → { items, hasNext, total }. `items` is unwrapped from `{ items | <key> }` when needed. */
/** The `after` cursor of the next page from a Link header (cursor-paginated endpoints such as Dependabot alerts), or null. */
function nextCursor(headers) {
  const link = headers && (headers.link || headers.Link);
  if (!link) return null;
  for (const part of String(link).split(',')) {
    if (!/rel="next"/.test(part)) continue;
    const m = /<([^>]+)>/.exec(part);
    if (!m) continue;
    try { return new URL(m[1]).searchParams.get('after') || null; } catch (_) { return null; }
  }
  return null;
}

const PAGE_PARAM_UNSUPPORTED = /pagination using the .?page.? parameter is not supported/i;

/**
 * One page of a list. `cursor: true` never sends `page` (for endpoints that only do cursor paging — Dependabot alerts —
 * pass `after` in params and read `nextCursor` from the result). As a safety net, if GitHub still answers that the `page`
 * parameter is not supported, the same request is repeated once without it.
 */
async function page(token, route, params = {}, label = 'GitHub request', { key = null, cursor = false } = {}) {
  const query = { per_page: 8, page: 1, ...params };
  if (cursor) delete query.page;
  let res;
  try {
    res = await withRetry((signal) => client(token).request(route, { ...query, request: { signal } }), label);
  } catch (err) {
    if (!('page' in query) || !PAGE_PARAM_UNSUPPORTED.test(String((err && err.message) || ''))) throw err;
    delete query.page;
    res = await withRetry((signal) => client(token).request(route, { ...query, request: { signal } }), label);
  }
  let data = res.data;
  if (!Array.isArray(data)) data = (data && (key ? data[key] : (data.items || data.workflow_runs || data.workflows || data.jobs || data.secrets || data.variables || data.releases))) || [];
  return { items: data, hasNext: hasNextLink(res.headers), nextCursor: nextCursor(res.headers), total: res.data && res.data.total_count != null ? res.data.total_count : null };
}

/**
 * A write. `verify` (optional) is asked what really happened when the outcome is unknown:
 * resolve { applied: true, value } / { applied: false } / { applied: null }. Without it, an unknown
 * outcome surfaces as the standard "GitHub did not confirm" error.
 */
async function mutate(token, route, params = {}, label = 'GitHub change', verify = null, timeoutMs = undefined) {
  try {
    const res = await withAbortTimeout((signal) => client(token).request(route, { ...params, request: { signal } }), label, timeoutMs, { mutation: true });
    return res.data;
  } catch (err) {
    if (verify) return reconcileUnknown(err, verify);
    throw err;
  }
}

/** Reads that treat a 404 as "nothing there" instead of an error. */
async function getOrNull(token, route, params, label) {
  try { return await get(token, route, params, label); } catch (err) {
    if (err && err.status === 404) return null;
    throw err;
  }
}

/** Light input guards shared by the modules. */
const clamp = (text, max) => String(text == null ? '' : text).slice(0, max);
const assertNumber = (n, what) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) throw new Error(`Invalid ${what}`);
  return v;
};
const REF_SAFE = /^[A-Za-z0-9._\-/]+$/;
function assertBranchName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 200 || !REF_SAFE.test(n) || n.startsWith('/') || n.endsWith('/') || n.endsWith('.lock') || n.includes('..') || n.includes('//') || n.startsWith('-') || n.endsWith('.')) {
    throw Object.assign(new Error('That isn’t a valid branch name. Use letters, numbers, dots, dashes, underscores and slashes.'), { code: 'BAD_REF' });
  }
  return n;
}

module.exports = { get, getFull, page, mutate, getOrNull, hasNextLink, nextCursor, clamp, assertNumber, assertBranchName };
