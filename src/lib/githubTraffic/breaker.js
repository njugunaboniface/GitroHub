/**
 * Service-level circuit breaker (v1.2.1-multi).
 *
 * Scope decision (spec §13): RATE LIMITS are per GitHub identity (each user's
 * own token/budget) and are handled by per-identity pauses in the manager —
 * they must never stop unrelated users. This breaker only watches failures
 * that indicate GitHub ITSELF (or the network path to it) is unhealthy:
 * timeouts, connection failures and 5xx. Those affect everyone alike, so one
 * shared breaker is the correct scope.
 *
 *   CLOSED ──(failures ≥ min within window, ratio ≥ 50%, from ≥2 identities
 *            when ≥2 identities were active)──▶ OPEN
 *   OPEN   ──(cooldown elapsed)──▶ HALF_OPEN
 *   HALF_OPEN ──(3 consecutive successes)──▶ CLOSED
 *   HALF_OPEN ──(any failure)──▶ OPEN  (cooldown doubles, capped at 12x)
 *
 * While not CLOSED the manager stops starting BACKGROUND work and allows only
 * a trickle of interactive probes (see `probeLimit`).
 */
class CircuitBreaker {
  constructor({ minFailures, windowMs, cooldownMs, now = Date.now }) {
    this.minFailures = minFailures;
    this.windowMs = windowMs;
    this.baseCooldownMs = cooldownMs;
    this.now = now;
    this.state = 'CLOSED';
    this.events = []; // { t, ok, id }
    this.openedAt = 0;
    this.cooldownMs = cooldownMs;
    this.halfOpenSuccesses = 0;
    this.opens = 0;
  }

  _trim(t) {
    const cutoff = t - this.windowMs;
    while (this.events.length && this.events[0].t < cutoff) this.events.shift();
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  /** Current state, advancing OPEN→HALF_OPEN when the cooldown has elapsed. */
  current() {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'HALF_OPEN';
      this.halfOpenSuccesses = 0;
    }
    return this.state;
  }

  record(ok, identity) {
    const t = this.now();
    const state = this.current();
    if (state === 'HALF_OPEN') {
      if (!ok) { this._open(true); return; }
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= 3) { this.state = 'CLOSED'; this.cooldownMs = this.baseCooldownMs; this.events = []; }
      return;
    }
    if (state === 'OPEN') return; // stragglers finishing while open don't re-trigger
    this.events.push({ t, ok, id: identity });
    this._trim(t);
    const fails = this.events.filter((e) => !e.ok);
    if (fails.length < this.minFailures || fails.length / this.events.length < 0.5) return;
    const activeIds = new Set(this.events.map((e) => e.id));
    const failIds = new Set(fails.map((e) => e.id));
    if (activeIds.size >= 2 && failIds.size < 2) return; // one identity's trouble ≠ a GitHub problem
    this._open(false);
  }

  _open(escalate) {
    this.state = 'OPEN';
    this.openedAt = this.now();
    this.opens += 1;
    this.cooldownMs = escalate ? Math.min(this.baseCooldownMs * 12, this.cooldownMs * 2) : this.baseCooldownMs;
    this.events = [];
  }

  /** Concurrency allowed for INTERACTIVE work while unhealthy (null = no extra limit). */
  probeLimit() {
    const s = this.current();
    return s === 'CLOSED' ? null : s === 'HALF_OPEN' ? 1 : 2;
  }

  retryInMs() {
    return this.current() === 'OPEN' ? Math.max(0, this.cooldownMs - (this.now() - this.openedAt)) : 0;
  }
}

module.exports = { CircuitBreaker };
