/**
 * GitHub Traffic Manager (v1.2.1-multi) — the single control point between
 * GitroHub features and the GitHub API.
 *
 *   feature → github.js → Octokit request hook → schedule() ─┐
 *                                                            ▼
 *        admission (bounded queue, load shedding, per-user caps)
 *                                                            ▼
 *        scheduler (interactive ▸ background, fair round-robin across users)
 *                                                            ▼
 *        limiter   (global AIMD ceiling · per-identity lane · mutation order/pacing)
 *                                                            ▼
 *        run(signal) with a hard timeout → classify → retry / pause / settle
 *
 * Design choices that go beyond a plain semaphore + sleep:
 *
 *  • Rate-limit state is scoped to the GitHub IDENTITY (token), because each
 *    user has their own hourly budget and their own secondary-limit state.
 *    One user's 403 pauses THEIR lane only — never anyone else's.
 *  • A global AIMD ceiling (halve on fleet-wide secondary-limit pressure,
 *    creep back up on success) adapts to what GitHub actually tolerates.
 *  • After a pause ends, a lane "probes" (1 request, then 2, 4, …) instead of
 *    releasing its whole backlog at once — that is what prevents a retry storm.
 *  • Retries are decided by SAFETY, not just by error class: rate-limit
 *    rejections are always safe to retry (GitHub did not process them);
 *    timeouts / 5xx / dropped connections are retried for reads only. A
 *    mutation that may have been applied is reported as outcome "unknown".
 *  • Per-(identity, repo) write serialization + per-identity write pacing.
 *  • Everything is bounded: queue size, per-user queue, retries, retry time.
 *
 * Process-local on purpose (single bot replica today), but all shared state is
 * reached through this one class so a Redis-backed implementation can replace
 * it later without touching callers (see docs/SCALING.md).
 */
const crypto = require('crypto');
const { classifyError, KIND, isRateLimit } = require('./classify');
const { computeBackoffMs, spreadWake } = require('./backoff');
const { CircuitBreaker } = require('./breaker');
const metrics = require('../metrics');

const M = {
  total: metrics.counter('github_requests_total', 'GitHub requests dispatched (first attempts + retries are counted in github_requests_retry)'),
  success: metrics.counter('github_requests_success', 'GitHub requests that completed successfully'),
  failed: metrics.counter('github_requests_failed', 'GitHub requests that ended in failure, by normalized class'),
  retry: metrics.counter('github_requests_retry', 'GitHub request retries scheduled'),
  timeout: metrics.counter('github_requests_timeout', 'GitHub requests that hit the per-request timeout'),
  secondary: metrics.counter('github_secondary_limit_events', 'Secondary (abuse/burst) rate-limit responses seen'),
  primary: metrics.counter('github_primary_limit_events', 'Primary (hourly quota) rate-limit responses/guards'),
  shed: metrics.counter('github_requests_shed', 'Requests rejected locally before reaching GitHub, by reason'),
  active: metrics.gauge('github_active_requests', 'In-flight GitHub requests'),
  queue: metrics.gauge('github_queue_depth', 'Queued GitHub requests by priority'),
  limit: metrics.gauge('github_concurrency_limit', 'Current (AIMD-adjusted) global concurrency ceiling'),
  state: metrics.gauge('github_traffic_state', '0=NORMAL 1=BUSY 2=DEGRADED 3=OVERLOADED 4=RECOVERING'),
  circuit: metrics.gauge('github_circuit_state', '0=CLOSED 1=HALF_OPEN 2=OPEN'),
  remaining: metrics.gauge('github_rate_limit_remaining', 'LOWEST X-RateLimit-Remaining across active identities, by resource'),
  reset: metrics.gauge('github_rate_limit_reset', 'Earliest X-RateLimit-Reset (epoch s) among identities near exhaustion'),
  queueWait: metrics.histogram('github_queue_wait_ms', 'Time requests spent queued before dispatch'),
  duration: metrics.histogram('github_request_duration_ms', 'HTTP request duration from dispatch to settle'),
  retryDelay: metrics.histogram('github_retry_delay_ms', 'Delay chosen before a retry or resume'),
};

const UNKNOWN_OUTCOME_MESSAGE = 'GitHub did not confirm the final result of this operation. I won\u2019t claim it succeeded \u2014 please check the repository before trying again.';
const STATES = ['NORMAL', 'BUSY', 'DEGRADED', 'OVERLOADED', 'RECOVERING'];
const MAX_LANES = 5000;
const MAX_USAGE = 2000;
const SLOT_MS = 5 * 60 * 1000;
const WINDOW_SLOTS = 12; // one hour of 5-minute slots

/** Error produced by the traffic layer itself (as opposed to one GitHub sent). */
class GithubTrafficError extends Error {
  constructor(message, props = {}) {
    super(message);
    this.name = 'GithubTrafficError';
    Object.assign(this, { outcome: 'failed', retryAfterMs: null }, props);
  }
}

function fingerprintShort(identity) {
  return String(identity || '').slice(0, 8);
}

class GithubTrafficManager {
  constructor(config, deps = {}) {
    this.cfg = { ...config };
    this.now = deps.now || Date.now;
    this.random = deps.random || Math.random;
    this.logger = deps.logger || { info() {}, warn() {}, error() {} };

    this.limit = this.cfg.maxConcurrency; // AIMD-adjusted global ceiling
    this.activeCount = 0;
    this.bgActive = 0;
    this.queuedCount = 0;
    this.lanes = new Map(); // identity -> lane
    this.users = new Map(); // userKey -> { key, q:{interactive:[],background:[]}, active }
    this.rings = { interactive: [], background: [] };
    this.inRing = { interactive: new Set(), background: new Set() };
    this.cursor = { interactive: 0, background: 0 };
    this.repoLocks = new Map(); // `${identity}|${repo}` -> job holding the write lock
    this.repoEpoch = new Map(); // `${identity}|${repo}` -> mutation counter (cache/coalesce invalidation)
    this.breaker = new CircuitBreaker({ minFailures: this.cfg.breakerMinFailures, windowMs: this.cfg.breakerWindowMs, cooldownMs: this.cfg.breakerCooldownMs, now: this.now });
    this.secondaryEvents = []; // { t, identity } fleet-wide pressure detector
    this.lastGlobalCut = 0;
    this.globalSuccesses = 0;
    this.backgroundPaused = false; // owner switch (Admin → GitHub Traffic)
    this.pumping = false;
    this.wakeTimer = null;
    this.wakeAt = Infinity;
    this.stateMemo = { name: 'NORMAL', since: this.now(), lastBadAt: 0 };
    this.win = []; // per-minute buckets
    this.usage = new Map(); // userKey -> { hist:[{t0,req,mut,sec,shed}], lastAt }
    this.totals = { requests: 0, success: 0, failed: 0, retries: 0, timeouts: 0, secondary: 0, primary: 0, shed: 0, coalesced: 0, cacheHits: 0, unknownOutcomes: 0 };
    this.seq = 0;
    M.limit.set({}, this.limit);
    // Housekeeping: idle identity lanes (and their rate-limit readouts) are dropped after a while,
    // so memory tracks the number of RECENTLY active GitHub accounts, not every account ever seen.
    this.sweepTimer = setInterval(() => this.sweep(), 60000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /** Removes idle lanes not seen for `idleMs`, then enforces the hard lane cap (oldest idle first). */
  sweep({ idleMs = 10 * 60 * 1000 } = {}) {
    const t = this.now();
    let removed = 0;
    for (const l of [...this.lanes.values()]) {
      if (l.active === 0 && l.queued.size === 0 && t - l.lastSeen >= idleMs && this._pauseRemaining(l, 'core', t) === 0 && l.pausedUntil.all <= t) { this.lanes.delete(l.identity); removed++; }
    }
    if (this.lanes.size > MAX_LANES) { const before = this.lanes.size; this._gcLanes(); removed += before - this.lanes.size; }
    for (const [k, u] of this.users) if (u.active === 0 && !u.q.interactive.length && !u.q.background.length) this.users.delete(k);
    return removed;
  }

  // ───────────────────────── public API ─────────────────────────

  /**
   * Schedules one GitHub request.
   * @param meta  { identity, userId, priority, operation, category, endpoint, method,
   *                mutation, parallelSafe, repoKey, resource, timeoutMs, signal, parentId }
   * @param run   async (signal) => response   — performs the real HTTP request
   * @returns Promise resolving to run()'s result, or rejecting with the (annotated)
   *          GitHub error / GithubTrafficError. Rejections carry `.outcome`:
   *          'failed' (nothing applied) or 'unknown' (a write may have been applied).
   */
  schedule(meta, run) {
    return new Promise((resolve, reject) => {
      const t = this.now();
      const priority = meta.priority === 'background' ? 'background' : 'interactive';
      const identity = String(meta.identity || 'anonymous');
      const userKey = meta.userId != null ? String(meta.userId) : `id:${fingerprintShort(identity)}`;
      const job = {
        id: `ghreq_${crypto.randomBytes(6).toString('hex')}`,
        parentId: meta.parentId || null,
        meta, run, resolve, reject, priority, identity, userKey,
        mutation: !!meta.mutation,
        parallelSafe: !!meta.parallelSafe,
        repoKey: meta.repoKey ? `${identity}|${meta.repoKey}` : null,
        resource: meta.resource || 'core',
        operation: meta.operation || meta.category || 'unknown',
        category: meta.category || 'other',
        kind: meta.mutation ? 'write' : 'read',
        attempt: 1,
        createdAt: t,
        enqueuedAt: t,
        firstDispatchAt: 0,
        notBefore: 0,
        state: 'queued',
        queueTimer: null,
        blockedBy: null,
      };

      const lane = this._lane(identity, userKey);
      const rejectLocal = (reason, err) => { this._count('shed', userKey); M.shed.inc({ reason }); reject(err); };

      // Admission 1 — a pause we know will outlast what we're willing to wait fails FAST and TRUTHFULLY.
      const waitMs = this._pauseRemaining(lane, job.resource, t);
      if (waitMs > this._maxAutoWait(priority)) return rejectLocal('rate_limit_wait', this._rateLimitError(lane, job, waitMs));

      // Admission 2 — overload protection.
      const state = this.getState();
      if (priority === 'background' && (state === 'OVERLOADED' || this.backgroundPaused)) {
        return rejectLocal(this.backgroundPaused ? 'background_paused' : 'overloaded',
          new GithubTrafficError(this.backgroundPaused ? 'Background GitHub work is paused by the owner.' : 'GitHub traffic is overloaded; background work was deferred.', { code: 'GITHUB_OVERLOADED', retryAfterMs: 30000, requestId: job.id }));
      }
      const user = this._user(userKey);
      const userQueued = user.q.interactive.length + user.q.background.length;
      if (userQueued >= this.cfg.perUserMaxQueue) {
        return rejectLocal('user_queue_full', new GithubTrafficError('You already have a lot of GitHub operations waiting. Let them finish, then try again.', { code: 'GITHUB_USER_QUEUE_FULL', requestId: job.id }));
      }
      if (this.queuedCount >= this.cfg.maxQueueSize) {
        if (priority === 'interactive' && this._shedOneBackground()) { /* made room */ } else {
          return rejectLocal('queue_full', new GithubTrafficError('GitHub traffic is very busy right now and the queue is full. Nothing was changed — please try again shortly.', { code: 'GITHUB_QUEUE_FULL', retryAfterMs: 10000, requestId: job.id }));
        }
      }

      // Caller cancellation.
      const sig = meta.signal;
      if (sig) {
        if (sig.aborted) return reject(this._abortError());
        job.onCallerAbort = () => this._callerAbort(job);
        sig.addEventListener('abort', job.onCallerAbort, { once: true });
      }

      this._enqueue(job, false);
      this._count('requests', userKey);
      this._pump();
    });
  }

  /** Lowest-friction accessor for the passive "last known rate limit" readout. */
  getRateLimit(identity, resource = 'core') {
    const lane = this.lanes.get(identity);
    const r = lane && lane.rate[resource];
    return r ? { ...r } : null;
  }

  /** Bumps the per-repo mutation epoch; cache/coalesce keys include it. */
  epoch(identity, repoKey) {
    return this.repoEpoch.get(`${identity}|${repoKey}`) || 0;
  }

  noteCoalesced() { this.totals.coalesced++; }
  noteCacheHit() { this.totals.cacheHits++; }

  getState() {
    const t = this.now();
    const depth = this.queuedCount;
    const ratio = depth / this.cfg.maxQueueSize;
    const cb = this.breaker.current();
    const recentSecondary = this.secondaryEvents.some((e) => t - e.t < 30000);
    let raw = 'NORMAL';
    if (ratio >= 0.9) raw = 'OVERLOADED';
    else if (ratio >= 0.5 || cb !== 'CLOSED' || recentSecondary) raw = 'DEGRADED';
    else if (ratio >= 0.1 || this.activeCount >= this.limit) raw = 'BUSY';
    const memo = this.stateMemo;
    if (raw === 'DEGRADED' || raw === 'OVERLOADED') memo.lastBadAt = t;
    let out = raw;
    if ((raw === 'NORMAL' || raw === 'BUSY') && memo.lastBadAt && t - memo.lastBadAt < 10000) out = 'RECOVERING';
    if (out !== memo.name) { memo.name = out; memo.since = t; }
    M.state.set({}, STATES.indexOf(out));
    M.circuit.set({}, ['CLOSED', 'HALF_OPEN', 'OPEN'].indexOf(cb));
    return out;
  }

  /** Runtime tuning (spec §4 "future dynamic tuning"). Values are re-clamped. */
  tune(partial = {}) {
    if (partial.maxConcurrency) this.cfg.maxConcurrency = Math.max(1, Math.min(80, partial.maxConcurrency | 0));
    if (partial.backgroundConcurrency) this.cfg.backgroundConcurrency = Math.max(1, Math.min(this.cfg.maxConcurrency, partial.backgroundConcurrency | 0));
    if (partial.perIdentityConcurrency) this.cfg.perIdentityConcurrency = Math.max(1, Math.min(this.cfg.maxConcurrency, partial.perIdentityConcurrency | 0));
    this.limit = Math.min(this.limit, this.cfg.maxConcurrency);
    M.limit.set({}, this.limit);
    this._pump();
  }

  setBackgroundPaused(paused) {
    this.backgroundPaused = !!paused;
    if (!paused) this._pump();
  }

  resetBreaker() {
    this.breaker = new CircuitBreaker({ minFailures: this.cfg.breakerMinFailures, windowMs: this.cfg.breakerWindowMs, cooldownMs: this.cfg.breakerCooldownMs, now: this.now });
    this._pump();
  }

  /** Clears one identity's pause/strikes (owner tool). */
  resetLane(identity) {
    const lane = this.lanes.get(identity);
    if (!lane) return false;
    lane.pausedUntil = { all: 0, core: 0, search: 0, graphql: 0 };
    lane.strikes = 0; lane.limit = this.cfg.perIdentityConcurrency; lane.ramp = Infinity;
    this._pump();
    return true;
  }

  getSnapshot() {
    const t = this.now();
    const state = this.getState();
    const lanes = [...this.lanes.values()];
    const paused = lanes.filter((l) => this._pauseRemaining(l, 'core', t) > 0 || l.pausedUntil.all > t);
    const lowest = {};
    for (const l of lanes) {
      for (const [res, r] of Object.entries(l.rate)) {
        if (r && Number.isFinite(r.remaining) && (lowest[res] == null || r.remaining < lowest[res].remaining)) lowest[res] = { remaining: r.remaining, limit: r.limit, resetAt: r.resetAt };
      }
    }
    return {
      state, since: this.stateMemo.since,
      active: this.activeCount, limit: this.limit, maxConcurrency: this.cfg.maxConcurrency,
      backgroundActive: this.bgActive, backgroundConcurrency: this.cfg.backgroundConcurrency,
      queued: this.queuedCount, maxQueue: this.cfg.maxQueueSize,
      queuedInteractive: this._queuedBy('interactive'), queuedBackground: this._queuedBy('background'),
      backgroundPaused: this.backgroundPaused,
      breaker: { state: this.breaker.current(), retryInMs: this.breaker.retryInMs(), opens: this.breaker.opens },
      lanes: lanes.length, pausedLanes: paused.length,
      pausedList: paused.slice(0, 10).map((l) => ({ user: l.userKey, resumeInMs: Math.max(l.pausedUntil.all, l.pausedUntil.core) - t, strikes: l.strikes })),
      lowestRemaining: lowest,
      totals: { ...this.totals },
      lastHour: this._windowTotals(60),
      lastFiveMinutes: this._windowTotals(5),
      topConsumers: this._topConsumers(8),
    };
  }

  // ───────────────────────── internals: bookkeeping ─────────────────────────

  _queuedBy(p) { let n = 0; for (const u of this.users.values()) n += u.q[p].length; return n; }

  _lane(identity, userKey) {
    let lane = this.lanes.get(identity);
    if (!lane) {
      if (this.lanes.size >= MAX_LANES) this._gcLanes();
      lane = {
        identity, userKey, active: 0, queued: new Set(),
        limit: this.cfg.perIdentityConcurrency, ramp: Infinity,
        pausedUntil: { all: 0, core: 0, search: 0, graphql: 0 },
        strikes: 0, successStreak: 0, nextMutationAt: 0, rate: {}, lastSeen: this.now(),
      };
      this.lanes.set(identity, lane);
    }
    lane.lastSeen = this.now();
    return lane;
  }

  _gcLanes() {
    const t = this.now();
    const idle = [...this.lanes.values()].filter((l) => l.active === 0 && l.queued.size === 0 && this._pauseRemaining(l, 'core', t) === 0)
      .sort((a, b) => a.lastSeen - b.lastSeen);
    const excess = Math.max(0, this.lanes.size - MAX_LANES);
    for (const l of idle.slice(0, Math.max(1, excess, Math.floor(MAX_LANES * 0.1)))) this.lanes.delete(l.identity);
  }

  _user(key) {
    let u = this.users.get(key);
    if (!u) { u = { key, q: { interactive: [], background: [] }, active: 0 }; this.users.set(key, u); }
    return u;
  }

  _maxAutoWait(priority) { return priority === 'background' ? this.cfg.backgroundMaxAutoWaitMs : this.cfg.maxAutoWaitMs; }

  _pauseRemaining(lane, resource, t) {
    return Math.max(0, Math.max(lane.pausedUntil.all, lane.pausedUntil[resource] || 0) - t);
  }

  _bucket() {
    const t = this.now();
    const t0 = Math.floor(t / 60000) * 60000;
    let b = this.win[this.win.length - 1];
    if (!b || b.t0 !== t0) {
      b = { t0, req: 0, ok: 0, fail: 0, retry: 0, timeout: 0, sec: 0, pri: 0, shed: 0, unknown: 0, waitSum: 0, waitN: 0, durSum: 0, durN: 0 };
      this.win.push(b);
      while (this.win.length > 65) this.win.shift();
    }
    return b;
  }

  _windowTotals(minutes) {
    const cutoff = this.now() - minutes * 60000;
    const agg = { req: 0, ok: 0, fail: 0, retry: 0, timeout: 0, sec: 0, pri: 0, shed: 0, unknown: 0, waitSum: 0, waitN: 0, durSum: 0, durN: 0 };
    for (const b of this.win) if (b.t0 >= cutoff - 60000) for (const k of Object.keys(agg)) agg[k] += b[k];
    return { ...agg, avgQueueWaitMs: agg.waitN ? Math.round(agg.waitSum / agg.waitN) : 0, avgDurationMs: agg.durN ? Math.round(agg.durSum / agg.durN) : 0 };
  }

  _count(what, userKey, extra) {
    const b = this._bucket();
    if (what === 'requests') { this.totals.requests++; b.req++; }
    if (what === 'shed') { this.totals.shed++; b.shed++; }
    const t = this.now();
    let u = this.usage.get(userKey);
    if (!u) {
      if (this.usage.size >= MAX_USAGE) {
        const oldest = [...this.usage.entries()].sort((a, c) => a[1].lastAt - c[1].lastAt)[0];
        if (oldest) this.usage.delete(oldest[0]);
      }
      u = { hist: [], lastAt: t };
      this.usage.set(userKey, u);
    }
    u.lastAt = t;
    const t0 = Math.floor(t / SLOT_MS) * SLOT_MS;
    let s = u.hist[u.hist.length - 1];
    if (!s || s.t0 !== t0) { s = { t0, req: 0, mut: 0, sec: 0, shed: 0 }; u.hist.push(s); while (u.hist.length > WINDOW_SLOTS) u.hist.shift(); }
    if (what === 'requests') { s.req++; if (extra && extra.mutation) s.mut++; }
    if (what === 'secondary') s.sec++;
    if (what === 'shed') s.shed++;
  }

  _topConsumers(n) {
    const cutoff = this.now() - WINDOW_SLOTS * SLOT_MS;
    const rows = [];
    for (const [user, u] of this.usage) {
      let req = 0, mut = 0, sec = 0, shed = 0;
      for (const s of u.hist) if (s.t0 >= cutoff) { req += s.req; mut += s.mut; sec += s.sec; shed += s.shed; }
      if (req || shed) rows.push({ user, requests: req, writes: mut, secondaryLimits: sec, shed });
    }
    return rows.sort((a, b) => b.requests - a.requests).slice(0, n);
  }

  // ───────────────────────── internals: queueing ─────────────────────────

  _enqueue(job, front) {
    const user = this._user(job.userKey);
    const q = user.q[job.priority];
    if (front) q.unshift(job); else q.push(job);
    this.queuedCount++;
    job.state = 'queued';
    job.enqueuedAt = this.now();
    this._lane(job.identity, job.userKey).queued.add(job);
    if (!this.inRing[job.priority].has(job.userKey)) { this.inRing[job.priority].add(job.userKey); this.rings[job.priority].push(job.userKey); }
    const base = job.priority === 'background' ? this.cfg.backgroundQueueTimeoutMs : this.cfg.queueTimeoutMs;
    const extra = Math.max(0, job.notBefore - this.now());
    clearTimeout(job.queueTimer);
    job.queueTimer = setTimeout(() => this._expire(job), base + extra);
    if (job.queueTimer.unref) job.queueTimer.unref();
    M.queue.set({ priority: job.priority }, this._queuedBy(job.priority));
  }

  _dequeue(job) {
    const user = this.users.get(job.userKey);
    if (user) {
      const q = user.q[job.priority];
      const i = q.indexOf(job);
      if (i >= 0) { q.splice(i, 1); this.queuedCount--; }
    }
    const lane = this.lanes.get(job.identity);
    if (lane) lane.queued.delete(job);
    clearTimeout(job.queueTimer);
    M.queue.set({ priority: job.priority }, this._queuedBy(job.priority));
  }

  _expire(job) {
    if (job.state !== 'queued') return;
    this._dequeue(job);
    this._count('shed', job.userKey);
    M.shed.inc({ reason: 'queue_timeout' });
    this._finish(job, null, new GithubTrafficError(
      job.blockedBy === 'pause'
        ? 'GitHub is temporarily rate-limiting requests and the wait is longer than I can hold this open. Nothing was changed — try again shortly.'
        : 'Your request waited too long because GitHub traffic is busy. Nothing was changed — please try again.',
      { code: 'GITHUB_QUEUE_TIMEOUT', retryAfterMs: 5000, requestId: job.id, attempts: job.attempt - 1 }));
  }

  _shedOneBackground() {
    let victim = null; let most = 0;
    for (const u of this.users.values()) if (u.q.background.length > most) { most = u.q.background.length; victim = u; }
    if (!victim) return false;
    const job = victim.q.background[victim.q.background.length - 1];
    this._dequeue(job);
    this._count('shed', job.userKey);
    M.shed.inc({ reason: 'shed_background' });
    this._finish(job, null, new GithubTrafficError('Background GitHub work was deferred to keep interactive requests responsive.', { code: 'GITHUB_OVERLOADED', retryAfterMs: 30000, requestId: job.id }));
    return true;
  }

  _callerAbort(job) {
    if (job.state === 'queued') {
      this._dequeue(job);
      this._finish(job, null, this._abortError());
      this._pump();
    } else if (job.state === 'active') {
      job.callerAborted = true;
      if (job.controller) job.controller.abort();
      if (job.abortHook) job.abortHook(this._abortError());
    }
  }

  _abortError() { const e = new Error('The operation was cancelled'); e.name = 'AbortError'; e.code = 'ABORT_ERR'; return e; }

  _finish(job, value, err) {
    if (job.done) return;
    job.done = true;
    job.state = 'done';
    clearTimeout(job.queueTimer);
    if (job.meta.signal && job.onCallerAbort) job.meta.signal.removeEventListener('abort', job.onCallerAbort);
    if (job.lockKey && this.repoLocks.get(job.lockKey) === job) {
      this.repoLocks.delete(job.lockKey);
      this.repoEpoch.set(job.lockKey, (this.repoEpoch.get(job.lockKey) || 0) + 1);
    }
    if (err) job.reject(err); else job.resolve(value);
  }

  // ───────────────────────── internals: scheduling ─────────────────────────

  _pump() {
    if (this.pumping) return;
    this.pumping = true;
    let wake = Infinity;
    try {
      for (;;) {
        if (this.activeCount >= this.limit) break;
        const picked = this._pickNext();
        wake = Math.min(wake, picked.wake);
        if (!picked.job) break;
        this._dispatch(picked.job);
      }
    } finally {
      this.pumping = false;
    }
    if (wake < Infinity) this._armWake(wake);
  }

  _armWake(at) {
    const t = this.now();
    const target = Math.max(at, t + 5);
    if (this.wakeTimer && this.wakeAt <= target) return;
    clearTimeout(this.wakeTimer);
    this.wakeAt = target;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.wakeAt = Infinity; this._pump(); }, target - t);
    if (this.wakeTimer.unref) this.wakeTimer.unref();
  }

  _pickNext() {
    const t = this.now();
    let wake = Infinity;
    const bgAllowed = this.bgActive < this.cfg.backgroundConcurrency && !this.backgroundPaused && this.breaker.current() === 'CLOSED';
    // Anti-starvation: an old-enough background request gets one slot ahead of interactive work.
    let order = ['interactive', 'background'];
    if (bgAllowed && this._oldestWait('background', t) >= this.cfg.backgroundAgingMs) order = ['background', 'interactive'];
    for (const cls of order) {
      if (cls === 'background' && !bgAllowed) continue;
      const found = this._scanRing(cls, t);
      wake = Math.min(wake, found.wake);
      if (found.job) return { job: found.job, wake };
    }
    return { job: null, wake };
  }

  _oldestWait(cls, t) {
    let oldest = 0;
    for (const key of this.rings[cls]) {
      const u = this.users.get(key);
      const j = u && u.q[cls][0];
      if (j && t - j.enqueuedAt > oldest) oldest = t - j.enqueuedAt;
    }
    return oldest;
  }

  /** Fair round-robin: resume after the user served last, so one user's backlog can't starve others. */
  _scanRing(cls, t) {
    const ring = this.rings[cls];
    let wake = Infinity;
    let n = ring.length;
    if (!n) return { job: null, wake };
    let idx = this.cursor[cls] % n;
    for (let seen = 0; seen < n; seen++) {
      const key = ring[idx];
      const user = this.users.get(key);
      const q = user ? user.q[cls] : [];
      if (!q.length) { // lazy cleanup of drained users
        ring.splice(idx, 1); this.inRing[cls].delete(key); n--;
        if (user && !user.q.interactive.length && !user.q.background.length && user.active === 0) this.users.delete(key);
        if (!n) break;
        if (idx >= n) idx = 0;
        seen--; // we removed one: don't count it as visited
        continue;
      }
      const lim = Math.min(q.length, 8);
      for (let i = 0; i < lim; i++) {
        const job = q[i];
        const res = this._eligible(job, t);
        if (res === true) { this.cursor[cls] = (idx + 1) % Math.max(1, ring.length); this._dequeue(job); return { job, wake }; }
        if (typeof res === 'number') wake = Math.min(wake, res);
        if (job.mutation && !job.parallelSafe) break; // keep write order within a user's stream
      }
      idx = (idx + 1) % n;
    }
    return { job: null, wake };
  }

  /** true when dispatchable now; a number = earliest time worth retrying; false = wait for a completion event. */
  _eligible(job, t) {
    const lane = this._lane(job.identity, job.userKey);
    if (job.notBefore > t) { job.blockedBy = 'retry'; return job.notBefore; }
    const pauseMs = this._pauseRemaining(lane, job.resource, t);
    if (pauseMs > 0) { job.blockedBy = 'pause'; return t + pauseMs; }
    if (lane.active >= Math.min(lane.limit, lane.ramp, this.cfg.perIdentityConcurrency)) { job.blockedBy = 'capacity'; return false; }
    if (job.priority === 'interactive') {
      const probe = this.breaker.probeLimit();
      if (probe != null && this.activeCount >= probe) { job.blockedBy = 'breaker'; return false; }
    }
    if (job.mutation) {
      if (job.repoKey && !job.parallelSafe) {
        const holder = this.repoLocks.get(job.repoKey);
        if (holder && holder !== job) { job.blockedBy = 'lock'; return false; }
      }
      if (lane.nextMutationAt > t) { job.blockedBy = 'pacing'; return lane.nextMutationAt; }
    }
    job.blockedBy = null;
    return true;
  }

  _dispatch(job) {
    const t = this.now();
    const lane = this._lane(job.identity, job.userKey);
    const user = this._user(job.userKey);
    job.state = 'active';
    job.startedAt = t;
    if (!job.firstDispatchAt) job.firstDispatchAt = t;
    lane.active++; user.active++; this.activeCount++;
    if (job.priority === 'background') this.bgActive++;
    if (job.mutation) {
      lane.nextMutationAt = t + this.cfg.mutationMinIntervalMs;
      if (job.repoKey && !job.parallelSafe) {
        job.lockKey = job.repoKey;
        this.repoLocks.set(job.repoKey, job);
        this.repoEpoch.set(job.repoKey, (this.repoEpoch.get(job.repoKey) || 0) + 1);
      }
    }
    const waited = t - job.enqueuedAt;
    M.queueWait.observe({ priority: job.priority }, waited);
    const b = this._bucket(); b.waitSum += waited; b.waitN++;
    M.total.inc({ category: job.category, priority: job.priority, kind: job.kind });
    M.active.set({}, this.activeCount);

    const controller = new AbortController();
    job.controller = controller;
    const timeoutMs = Math.max(50, Math.min(120000, job.meta.timeoutMs || this.cfg.requestTimeoutMs));
    const guard = new Promise((_, rej) => { job.abortHook = rej; });
    guard.catch(() => {});
    job.timeoutTimer = setTimeout(() => {
      job.timedOut = true;
      controller.abort();
      job.abortHook(new GithubTrafficError(`GitHub request timed out after ${timeoutMs}ms`, { code: 'GITHUB_TIMEOUT', requestId: job.id }));
    }, timeoutMs);
    if (job.timeoutTimer.unref) job.timeoutTimer.unref();

    let running;
    try { running = Promise.resolve(job.run(controller.signal)); } catch (e) { running = Promise.reject(e); }
    running.catch(() => {}); // an orphaned run() settling after a timeout must never become an unhandled rejection
    Promise.race([running, guard]).then(
      (res) => this._onSuccess(job, res),
      (err) => this._onFailure(job, err),
    );
  }

  _release(job) {
    clearTimeout(job.timeoutTimer);
    const lane = this.lanes.get(job.identity);
    if (lane) lane.active = Math.max(0, lane.active - 1);
    const user = this.users.get(job.userKey);
    if (user) user.active = Math.max(0, user.active - 1);
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (job.priority === 'background') this.bgActive = Math.max(0, this.bgActive - 1);
    M.active.set({}, this.activeCount);
    const dur = this.now() - job.startedAt;
    M.duration.observe({ category: job.category, kind: job.kind }, dur);
    const b = this._bucket(); b.durSum += dur; b.durN++;
  }

  _captureRate(lane, headers, job) {
    if (!headers) return;
    const remaining = headers['x-ratelimit-remaining'];
    if (remaining == null) return;
    const resource = String(headers['x-ratelimit-resource'] || job.resource || 'core');
    const reset = Number(headers['x-ratelimit-reset']);
    const r = {
      remaining: Number(remaining), limit: Number(headers['x-ratelimit-limit']),
      used: headers['x-ratelimit-used'] != null ? Number(headers['x-ratelimit-used']) : null,
      resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null, seenAt: this.now(),
    };
    lane.rate[resource] = r;
    // Proactive primary guard: quota gone → stop sending (continuing to hit a limited API can get an integration banned).
    if (r.remaining === 0 && r.resetAt && r.resetAt > this.now()) {
      const until = r.resetAt + 1000;
      if (until > (lane.pausedUntil[resource] || 0)) { lane.pausedUntil[resource] = until; this._failBlocked(lane, resource); }
    }
    let low = null;
    for (const l of this.lanes.values()) { const x = l.rate[resource]; if (x && Number.isFinite(x.remaining) && (!low || x.remaining < low.remaining)) low = x; }
    if (low) { M.remaining.set({ resource }, low.remaining); if (low.resetAt) M.reset.set({ resource }, Math.round(low.resetAt / 1000)); }
  }

  /** After a pause lengthens, fail queued requests that would now wait longer than we're willing to hold them. */
  _failBlocked(lane, resource) {
    const t = this.now();
    for (const job of [...lane.queued]) {
      if (job.resource !== resource && resource !== 'all') continue;
      const wait = this._pauseRemaining(lane, job.resource, t);
      if (wait > this._maxAutoWait(job.priority)) {
        this._dequeue(job);
        this._count('shed', job.userKey);
        M.shed.inc({ reason: 'rate_limit_wait' });
        this._finish(job, null, this._rateLimitError(lane, job, wait));
      }
    }
  }

  _rateLimitError(lane, job, waitMs) {
    const t = this.now();
    const primary = lane.pausedUntil.all <= t && (lane.pausedUntil[job.resource] || 0) > t;
    const resetAt = t + waitMs;
    const secs = Math.max(1, Math.ceil(waitMs / 1000));
    const err = new GithubTrafficError(
      primary ? `API rate limit exceeded — GitHub quota used up; resets in about ${Math.ceil(secs / 60)} min (held locally to avoid hammering GitHub)`
        : `GitHub secondary rate limit — requests are paused for about ${secs}s (held locally)`,
      { code: 'GITHUB_RATE_LIMITED', status: 403, kind: primary ? KIND.RATE_LIMIT_PRIMARY : KIND.RATE_LIMIT_SECONDARY, retryAfterMs: waitMs, requestId: job.id, attempts: job.attempt - 1 });
    err.response = { headers: primary
      ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(resetAt / 1000)) }
      : { 'retry-after': String(secs) } };
    return err;
  }

  _onSuccess(job, res) {
    const lane = this.lanes.get(job.identity);
    this._release(job);
    if (lane) {
      this._captureRate(lane, res && res.headers, job);
      lane.successStreak++;
      if (Number.isFinite(lane.ramp)) lane.ramp = lane.ramp >= this.cfg.perIdentityConcurrency ? Infinity : lane.ramp * 2;
      if (lane.successStreak % 5 === 0 && lane.strikes > 0) lane.strikes--;
      if (lane.successStreak % this.cfg.aimdSuccessesPerStep === 0 && lane.limit < this.cfg.perIdentityConcurrency) lane.limit++;
    }
    this.breaker.record(true, job.identity);
    this.globalSuccesses++;
    if (this.limit < this.cfg.maxConcurrency && this.now() - this.lastGlobalCut > 10000 && this.globalSuccesses % this.cfg.aimdSuccessesPerStep === 0) {
      this.limit++; M.limit.set({}, this.limit);
    }
    this.totals.success++; this._bucket().ok++;
    M.success.inc({ category: job.category, priority: job.priority });
    this._finish(job, res, null);
    this._pump();
  }

  _onFailure(job, err) {
    const lane = this.lanes.get(job.identity) || this._lane(job.identity, job.userKey);
    this._release(job);
    const t = this.now();
    const info = classifyError(err, { timedOut: !!job.timedOut, callerAborted: !!job.callerAborted, now: t });
    if (err && err.response) this._captureRate(lane, err.response.headers, job);
    const annotate = (e, outcome) => {
      if (e && typeof e === 'object') {
        e.traffic = { class: info.kind, outcome, attempts: job.attempt, requestId: job.id, retryAfterMs: info.retryAfterMs };
        if (outcome === 'unknown') { e.outcome = 'unknown'; e.reason = e.code; e.originalMessage = e.originalMessage || e.message; e.message = UNKNOWN_OUTCOME_MESSAGE; e.code = 'GITHUB_OUTCOME_UNKNOWN'; this.totals.unknownOutcomes++; this._bucket().unknown++; }
        else if (!e.outcome) e.outcome = 'failed';
      }
      return e;
    };
    const fail = (outcome, errOverride) => {
      this.totals.failed++; this._bucket().fail++;
      M.failed.inc({ class: info.kind, category: job.category });
      if (info.kind !== KIND.ABORTED) {
        this.logger.warn('github request failed', { requestId: job.id, parentId: job.parentId, operation: job.operation, category: job.category, endpoint: job.meta.endpoint, method: job.meta.method, class: info.kind, status: info.status, attempts: job.attempt, outcome: outcome || 'failed', identity: fingerprintShort(job.identity) });
      }
      this._finish(job, null, annotate(errOverride || err, outcome || 'failed'));
      this._pump();
    };

    if (info.kind === KIND.ABORTED) { return fail('failed', this._abortError()); }

    if (isRateLimit(info.kind)) {
      this._applyRateLimit(lane, job, info);
      // GitHub rejected this BEFORE processing it → retrying is safe for every method, mutations included.
      const waitMs = this._pauseRemaining(lane, job.resource, t);
      if (job.attempt < this.cfg.retryMaxAttempts && waitMs <= this._maxAutoWait(job.priority) && t - job.firstDispatchAt + waitMs <= Math.max(this.cfg.maxRetryDurationMs, this._maxAutoWait(job.priority))) {
        return this._requeue(job, waitMs, info);
      }
      // Out of retries or the wait is too long to hold open: surface GitHub's OWN error when there is one
      // (existing user-facing messages key off it), otherwise a locally-shaped rate-limit error. Nothing was applied.
      return fail('failed', err && err.status ? err : this._rateLimitError(lane, job, waitMs || info.retryAfterMs || 1000));
    }

    const serverSide = info.kind === KIND.TIMEOUT || info.kind === KIND.NETWORK_ERROR || info.kind === KIND.RETRYABLE_GITHUB_ERROR;
    if (info.kind === KIND.TIMEOUT) { this.totals.timeouts++; this._bucket().timeout++; M.timeout.inc({ category: job.category }); }
    if (serverSide) this.breaker.record(false, job.identity);

    if (serverSide) {
      const retrySafe = !job.mutation || info.notSent;
      if (retrySafe && job.attempt < this.cfg.retryMaxAttempts) {
        const delay = computeBackoffMs({ attempt: job.attempt, baseMs: this.cfg.retryBaseDelayMs, maxMs: this.cfg.retryMaxDelayMs, jitterMs: this.cfg.retryJitterMs, random: this.random });
        if (t - job.firstDispatchAt + delay <= this.cfg.maxRetryDurationMs) return this._requeue(job, delay, info);
      }
      // Out of retries, or a write whose fate is genuinely unknown: say so, never guess.
      if (job.mutation && !info.notSent) return fail('unknown');
      return fail('failed');
    }
    return fail('failed'); // NON_RETRYABLE
  }

  _applyRateLimit(lane, job, info) {
    const t = this.now();
    if (info.kind === KIND.RATE_LIMIT_PRIMARY) {
      this.totals.primary++; this._bucket().pri++; M.primary.inc({ category: job.category });
      const until = info.resetAtMs ? info.resetAtMs + 1000 : t + (info.retryAfterMs != null ? info.retryAfterMs : 60000);
      lane.pausedUntil[job.resource] = Math.max(lane.pausedUntil[job.resource] || 0, until);
      this.logger.warn('github primary rate limit', { identity: fingerprintShort(job.identity), resumeInMs: until - t, requestId: job.id });
      this._failBlocked(lane, job.resource);
      return;
    }
    this.totals.secondary++; this._bucket().sec++; M.secondary.inc({ category: job.category });
    this._count('secondary', job.userKey);
    lane.strikes++;
    lane.successStreak = 0;
    const base = info.retryAfterMs != null ? info.retryAfterMs : Math.min(900000, this.cfg.secondaryDefaultWaitMs * 2 ** (lane.strikes - 1));
    const wait = spreadWake(base, { spreadMs: Math.min(2000, Math.max(200, base * 0.1)), random: this.random });
    const until = t + wait;
    if (until > lane.pausedUntil.all) lane.pausedUntil.all = until;
    lane.limit = Math.max(1, Math.floor(lane.limit / 2));
    lane.ramp = 1; // probe with ONE request when the pause ends, then 2, 4, … (no thundering herd)
    this.logger.warn('github secondary rate limit', { identity: fingerprintShort(job.identity), pauseMs: wait, strikes: lane.strikes, laneLimit: lane.limit, requestId: job.id });
    // Fleet-wide pressure (several DIFFERENT identities limited close together) → lower the global ceiling.
    this.secondaryEvents.push({ t, identity: job.identity });
    this.secondaryEvents = this.secondaryEvents.filter((e) => t - e.t < 60000);
    const ids = new Set(this.secondaryEvents.map((e) => e.identity));
    if (ids.size >= 3 && t - this.lastGlobalCut > 5000) {
      this.limit = Math.max(2, Math.floor(this.limit / 2));
      this.lastGlobalCut = t;
      M.limit.set({}, this.limit);
      this.logger.warn('github global concurrency lowered', { limit: this.limit, identities: ids.size });
    }
    this._failBlocked(lane, 'all');
  }

  _requeue(job, delayMs, info) {
    M.retry.inc({ class: info.kind, category: job.category });
    M.retryDelay.observe({ class: info.kind }, delayMs);
    this.totals.retries++; this._bucket().retry++;
    job.attempt += 1;
    job.notBefore = this.now() + delayMs;
    job.timedOut = false; job.callerAborted = false; job.controller = null;
    this._enqueue(job, true);
    this._armWake(job.notBefore);
    this._pump();
  }
}

module.exports = { GithubTrafficManager, GithubTrafficError, STATES, UNKNOWN_OUTCOME_MESSAGE };
