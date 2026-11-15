/**
 * Central configuration for the GitHub traffic layer (v1.2.1-multi).
 *
 * Every limit lives HERE, with its purpose, so no magic number is scattered
 * through the scheduler. Values come from environment variables; anything
 * unset/invalid falls back to the conservative default, and every number is
 * clamped to a sane [min, max] so a typo (e.g. 0 or 99999) can't disable a
 * protection or create a footgun.
 *
 * Defaults are deliberately CONSERVATIVE starting points — GitHub's
 * documented ceiling is 100 concurrent requests per account, and this app
 * does not aim anywhere near it. Treat each as a tunable engineering
 * parameter; /admin → 🌐 GitHub Traffic shows live utilisation to tune against.
 */
const SPEC = [
  // key, env, default, min, max, purpose
  ['maxConcurrency', 'GITHUB_MAX_CONCURRENCY', 20, 1, 80, 'Global ceiling on simultaneous in-flight GitHub requests across ALL users (AIMD may lower it temporarily).'],
  ['backgroundConcurrency', 'GITHUB_BACKGROUND_CONCURRENCY', 4, 1, 40, 'Max in-flight requests for BACKGROUND work (pollers, scheduled jobs), so they can never starve interactive taps.'],
  ['perIdentityConcurrency', 'GITHUB_PER_IDENTITY_CONCURRENCY', 6, 1, 40, 'Max in-flight requests for ONE GitHub identity (token). One user cannot hold the whole pool, and no single GitHub account is burst-hammered.'],
  ['maxQueueSize', 'GITHUB_MAX_QUEUE_SIZE', 500, 10, 20000, 'Hard cap on queued requests process-wide (bounded memory). Past it, work is shed truthfully instead of growing the heap.'],
  ['perUserMaxQueue', 'GITHUB_PER_USER_MAX_QUEUE', 60, 1, 5000, 'Max queued requests for ONE user, so a runaway/bulk action cannot fill the whole queue.'],
  ['queueTimeoutMs', 'GITHUB_QUEUE_TIMEOUT_MS', 20000, 500, 600000, 'How long an INTERACTIVE request may wait in the queue before failing with a truthful "busy" error.'],
  ['backgroundQueueTimeoutMs', 'GITHUB_BACKGROUND_QUEUE_TIMEOUT_MS', 300000, 1000, 3600000, 'Queue wait limit for BACKGROUND requests.'],
  ['requestTimeoutMs', 'GITHUB_REQUEST_TIMEOUT_MS', 15000, 1000, 120000, 'Per-HTTP-request timeout, measured from dispatch (queue wait does not count). The slot is always released when it fires.'],
  ['retryMaxAttempts', 'GITHUB_RETRY_MAX_ATTEMPTS', 4, 1, 10, 'Total attempts per request (first try included) for retry-safe failures.'],
  ['retryBaseDelayMs', 'GITHUB_RETRY_BASE_DELAY_MS', 500, 50, 60000, 'Backoff base for transient errors.'],
  ['retryMaxDelayMs', 'GITHUB_RETRY_MAX_DELAY_MS', 20000, 100, 600000, 'Backoff cap for transient errors.'],
  ['retryJitterMs', 'GITHUB_RETRY_JITTER_MS', 400, 0, 60000, 'Extra random spread so delayed requests never wake at the same instant.'],
  ['maxRetryDurationMs', 'GITHUB_RETRY_MAX_DURATION_MS', 60000, 1000, 900000, 'Total time one request may spend retrying before it is failed for good.'],
  ['secondaryDefaultWaitMs', 'GITHUB_SECONDARY_DEFAULT_WAIT_MS', 60000, 1000, 600000, 'Pause when GitHub signals a secondary limit WITHOUT Retry-After (GitHub guidance: at least one minute).'],
  ['maxAutoWaitMs', 'GITHUB_MAX_AUTO_WAIT_MS', 30000, 1000, 600000, 'Longest pause an INTERACTIVE request will silently wait out; beyond it the user gets a truthful "try again in N" instead of a hung chat.'],
  ['backgroundMaxAutoWaitMs', 'GITHUB_BACKGROUND_MAX_AUTO_WAIT_MS', 900000, 1000, 3600000, 'Same, for BACKGROUND work (can afford to wait longer).'],
  ['mutationMinIntervalMs', 'GITHUB_MUTATION_MIN_INTERVAL_MS', 150, 0, 10000, 'Minimum spacing between write requests of ONE identity (GitHub asks for non-concurrent, spaced mutations).'],
  ['cacheTtlMs', 'GITHUB_CACHE_TTL_MS', 5000, 0, 300000, 'Freshness window for a few safe, read-heavy metadata endpoints (after it, conditional requests are used). 0 disables TTL serving.'],
  ['cacheMaxEntries', 'GITHUB_CACHE_MAX_ENTRIES', 400, 0, 10000, 'Max entries of the small conditional-request cache (bounded memory).'],
  ['breakerMinFailures', 'GITHUB_BREAKER_MIN_FAILURES', 6, 2, 100, 'Service-level circuit breaker: failures within the window needed to open.'],
  ['breakerWindowMs', 'GITHUB_BREAKER_WINDOW_MS', 30000, 1000, 600000, 'Service-level circuit breaker: sliding window.'],
  ['breakerCooldownMs', 'GITHUB_BREAKER_COOLDOWN_MS', 10000, 500, 600000, 'Initial OPEN cooldown (doubles on repeated failure, capped at 12x).'],
  ['aimdSuccessesPerStep', 'GITHUB_AIMD_SUCCESSES_PER_STEP', 20, 1, 1000, 'Successful requests needed to raise a lowered concurrency limit by one.'],
  ['backgroundAgingMs', 'GITHUB_BACKGROUND_AGING_MS', 30000, 1000, 600000, 'A background request waiting this long gets one guaranteed slot ahead of interactive work (anti-starvation).'],
];

function parse(raw, def, min, max) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function load(env = process.env) {
  const cfg = {};
  for (const [key, name, def, min, max] of SPEC) cfg[key] = parse(env[name], def, min, max);
  // Cross-field sanity: background/per-identity can never exceed the global ceiling.
  cfg.backgroundConcurrency = Math.min(cfg.backgroundConcurrency, cfg.maxConcurrency);
  cfg.perIdentityConcurrency = Math.min(cfg.perIdentityConcurrency, cfg.maxConcurrency);
  cfg.retryMaxDelayMs = Math.max(cfg.retryMaxDelayMs, cfg.retryBaseDelayMs);
  return Object.freeze(cfg);
}

/** Human-readable table of every knob (used by docs and the admin screen). */
function describe() {
  return SPEC.map(([key, env, def, min, max, purpose]) => ({ key, env, default: def, min, max, purpose }));
}

module.exports = { load, describe, SPEC };
