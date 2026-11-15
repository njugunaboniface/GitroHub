/**
 * Backoff maths (v1.2.1-multi) — pure functions, no timers, so it is trivially
 * testable and the randomness is injectable.
 *
 *   delay(attempt) = min(MAX, BASE * 2^(attempt-1))
 *   result         = delay * (0.5 + 0.5*random())   // "equal jitter": never zero, never synchronized
 *                    + random() * JITTER            // extra spread
 *
 * Equal jitter (rather than a fixed delay + small noise) is what prevents a
 * herd of requests that failed together from retrying together.
 */
function computeBackoffMs({ attempt, baseMs, maxMs, jitterMs, random = Math.random }) {
  const n = Math.max(1, attempt | 0);
  const exp = Math.min(maxMs, baseMs * 2 ** (n - 1));
  return Math.round(exp * (0.5 + 0.5 * random()) + random() * jitterMs);
}

/** Spread a wake-up that GitHub dictated (Retry-After) so a queue doesn't all
 * wake at the same millisecond. Adds 0–spreadMs on top; never shortens it. */
function spreadWake(waitMs, { spreadMs = 1000, random = Math.random } = {}) {
  return Math.round(waitMs + random() * spreadMs);
}

module.exports = { computeBackoffMs, spreadWake };
