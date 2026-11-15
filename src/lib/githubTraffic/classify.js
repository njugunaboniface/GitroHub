/**
 * Error classification (v1.2.1-multi) — turns "whatever Octokit threw" into
 * ONE normalized shape so no feature has to understand raw GitHub behaviour.
 *
 *   RATE_LIMIT_PRIMARY       out of the hourly quota (X-RateLimit-Remaining: 0)
 *   RATE_LIMIT_SECONDARY     abuse/burst protection (message, Retry-After, docs URL)
 *   RETRYABLE_GITHUB_ERROR   500/502/503/504/408 — transient, server-side
 *   NON_RETRYABLE_GITHUB_ERROR  4xx that retrying cannot fix (404, 422, 401, plain 403…)
 *   NETWORK_ERROR            no HTTP response at all (DNS, reset, refused…)
 *   TIMEOUT                  OUR request timer fired
 *   ABORTED                  the caller cancelled
 *
 * Detection never relies on the status code alone (spec §9): it combines
 * status + Retry-After + X-RateLimit-* + message + the documentation URL.
 *
 * IMPORTANT Octokit quirk handled here: when fetch itself fails (network
 * down, aborted) Octokit still throws a RequestError with status 500 but NO
 * `response`. A real HTTP 500 always has `response`. That's the discriminator
 * between NETWORK_ERROR and RETRYABLE_GITHUB_ERROR.
 */
const KIND = Object.freeze({
  RATE_LIMIT_PRIMARY: 'RATE_LIMIT_PRIMARY',
  RATE_LIMIT_SECONDARY: 'RATE_LIMIT_SECONDARY',
  RETRYABLE_GITHUB_ERROR: 'RETRYABLE_GITHUB_ERROR',
  NON_RETRYABLE_GITHUB_ERROR: 'NON_RETRYABLE_GITHUB_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
});

// Failures where the request provably never reached GitHub — safe to retry even
// for mutations, because nothing can have been applied.
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE']);

function header(err, name) {
  const h = err && err.response && err.response.headers;
  return h ? h[name] : undefined;
}

/** Retry-After is either delta-seconds or an HTTP date. Returns ms or null. */
function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs >= 0 ? Math.round(secs * 1000) : null;
  const when = Date.parse(String(value));
  return Number.isFinite(when) ? Math.max(0, when - now) : null;
}

function causeCode(err) {
  let e = err;
  for (let i = 0; e && i < 4; i++, e = e.cause) if (e.code) return String(e.code);
  return null;
}

function classifyError(err, { timedOut = false, callerAborted = false, now = Date.now() } = {}) {
  const out = { kind: KIND.NON_RETRYABLE_GITHUB_ERROR, status: err && err.status, retryAfterMs: null, resetAtMs: null, notSent: false };
  if (callerAborted) return { ...out, kind: KIND.ABORTED };
  if (timedOut) return { ...out, kind: KIND.TIMEOUT };

  const status = err && err.status;
  const hasResponse = !!(err && err.response);
  const message = String((err && err.message) || '');
  const docUrl = String((err && err.response && err.response.data && err.response.data.documentation_url) || '');

  if (!hasResponse && (!status || status === 500)) {
    const code = causeCode(err);
    return { ...out, kind: KIND.NETWORK_ERROR, status: undefined, notSent: !!(code && NOT_SENT_CODES.has(code)) };
  }

  out.retryAfterMs = parseRetryAfterMs(header(err, 'retry-after'), now);
  const reset = Number(header(err, 'x-ratelimit-reset'));
  out.resetAtMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
  const remaining = header(err, 'x-ratelimit-remaining');

  if (status === 403 || status === 429) {
    if (/secondary rate limit|abuse detection|abuse rate limit/i.test(message) || /secondary-rate-limits|abuse-rate-limits/i.test(docUrl)) {
      return { ...out, kind: KIND.RATE_LIMIT_SECONDARY };
    }
    if (String(remaining) === '0' || /api rate limit exceeded|rate limit exceeded/i.test(message)) {
      return { ...out, kind: KIND.RATE_LIMIT_PRIMARY };
    }
    // A bare Retry-After on a 403/429 is GitHub's burst-protection signature.
    if (out.retryAfterMs != null) return { ...out, kind: KIND.RATE_LIMIT_SECONDARY };
    if (status === 429) return { ...out, kind: KIND.RATE_LIMIT_SECONDARY };
    return out; // plain permissions 403 → non-retryable
  }
  if (status >= 500 && status < 600 && status !== 501) return { ...out, kind: KIND.RETRYABLE_GITHUB_ERROR };
  if (status === 408) return { ...out, kind: KIND.RETRYABLE_GITHUB_ERROR };
  return out;
}

const isRateLimit = (kind) => kind === KIND.RATE_LIMIT_PRIMARY || kind === KIND.RATE_LIMIT_SECONDARY;

module.exports = { KIND, classifyError, parseRetryAfterMs, isRateLimit };
