/**
 * Resource gate (v1.2.1-multi) — bounded concurrency + bounded queue for the
 * EXPENSIVE operations that a per-file size limit alone can't protect
 * (archive extraction, repository downloads, uploads in flight, …).
 *
 * "A 15 MB archive is safe" does not mean "100 users each extracting a 15 MB
 * archive at once is safe". A gate makes the total bounded:
 *
 *   • at most `maxConcurrent` jobs run at once (global),
 *   • at most `perUser` of them belong to one user,
 *   • at most `maxQueue` wait (bounded memory); beyond that new work is
 *     refused with a truthful, typed error — never silently dropped,
 *   • a waiter gives up after `queueTimeoutMs`,
 *   • waiting is FAIR: the next job started is the oldest waiter whose user is
 *     below their cap, so one user's pile of jobs can't starve others,
 *   • the slot is ALWAYS released (finally), whatever the job does,
 *   • waiting/running jobs can be cancelled with an AbortSignal.
 *
 * It reports NORMAL / BUSY / OVERLOADED so callers and monitoring can see
 * pressure. Process-local on purpose (see docs/SCALING.md for the Redis-backed
 * variant a multi-replica deployment would need).
 */
const metrics = require('./metrics');

const M = {
  active: metrics.gauge('gate_active', 'Jobs currently running inside a resource gate'),
  queued: metrics.gauge('gate_queued', 'Jobs waiting for a resource gate'),
  wait: metrics.histogram('gate_wait_ms', 'Time jobs waited for a resource gate'),
  duration: metrics.histogram('gate_duration_ms', 'Time jobs ran inside a resource gate', [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000]),
  rejected: metrics.counter('gate_rejected', 'Jobs refused by a resource gate, by reason'),
  completed: metrics.counter('gate_completed', 'Jobs finished inside a resource gate, by outcome'),
};

class GateError extends Error {
  constructor(code, message, gate) {
    super(message);
    this.name = 'GateError';
    this.code = code; // GATE_FULL | GATE_USER_LIMIT | GATE_TIMEOUT | GATE_ABORTED
    this.gate = gate;
  }
}

class Gate {
  /**
   * @param {{name:string, maxConcurrent:number, perUser?:number, maxQueue?:number, queueTimeoutMs?:number}} o
   */
  constructor({ name, maxConcurrent, perUser = 1, maxQueue = 20, queueTimeoutMs = 60000, now = Date.now }) {
    this.name = name;
    this.maxConcurrent = Math.max(1, maxConcurrent | 0);
    this.perUser = Math.max(1, perUser | 0);
    this.maxQueue = Math.max(0, maxQueue | 0);
    this.queueTimeoutMs = queueTimeoutMs;
    this.now = now;
    this.active = 0;
    this.activeByUser = new Map();
    this.queue = []; // FIFO of waiters
    this.stats = { started: 0, rejected: 0, timedOut: 0, completed: 0, failed: 0 };
  }

  _userActive(u) { return this.activeByUser.get(u) || 0; }
  _queuedFor(u) { let n = 0; for (const w of this.queue) if (w.user === u) n++; return n; }

  state() {
    const q = this.queue.length;
    if (q >= this.maxQueue * 0.9 && this.maxQueue > 0) return 'OVERLOADED';
    if (q > 0 || this.active >= this.maxConcurrent) return 'BUSY';
    return 'NORMAL';
  }

  snapshot() {
    return { name: this.name, state: this.state(), active: this.active, maxConcurrent: this.maxConcurrent, queued: this.queue.length, maxQueue: this.maxQueue, perUser: this.perUser, ...this.stats };
  }

  /** Where this user would wait: 0 = starts now. For "queued — N ahead" messages. */
  position(user) {
    if (this.active < this.maxConcurrent && this._userActive(user) < this.perUser) return 0;
    return this.queue.length + 1;
  }

  /**
   * Runs `fn()` once a slot is free. Rejects with GateError if the queue is
   * full, the user already has too much waiting, the wait times out, or the
   * signal aborts while waiting.
   * `onQueued(position)` is called (once) if the job has to wait, so the UI can say "queued".
   */
  run(user, fn, { signal, onQueued } = {}) {
    const key = user == null ? 'anon' : String(user);
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new GateError('GATE_ABORTED', 'cancelled', this.name));
      const canStart = this.active < this.maxConcurrent && this._userActive(key) < this.perUser && this.queue.length === 0;
      if (canStart) return this._start({ user: key, fn, resolve, reject, enqueuedAt: this.now(), signal });

      if (this.queue.length >= this.maxQueue) {
        this.stats.rejected++; M.rejected.inc({ gate: this.name, reason: 'full' });
        return reject(new GateError('GATE_FULL', `${this.name} is busy right now`, this.name));
      }
      if (this._queuedFor(key) >= Math.max(2, this.perUser * 2)) {
        this.stats.rejected++; M.rejected.inc({ gate: this.name, reason: 'user_limit' });
        return reject(new GateError('GATE_USER_LIMIT', `you already have ${this.name} work waiting`, this.name));
      }
      const waiter = { user: key, fn, resolve, reject, enqueuedAt: this.now(), signal, timer: null, onAbort: null };
      waiter.timer = setTimeout(() => {
        this._remove(waiter);
        this.stats.timedOut++; M.rejected.inc({ gate: this.name, reason: 'timeout' });
        reject(new GateError('GATE_TIMEOUT', `waited too long for ${this.name}`, this.name));
        this._updateGauges();
      }, this.queueTimeoutMs);
      if (waiter.timer.unref) waiter.timer.unref();
      if (signal) {
        waiter.onAbort = () => { this._remove(waiter); reject(new GateError('GATE_ABORTED', 'cancelled', this.name)); this._updateGauges(); };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this._updateGauges();
      if (onQueued) { try { onQueued(this.queue.length); } catch (_) { /* UI hint only */ } }
    });
  }

  _remove(w) {
    const i = this.queue.indexOf(w);
    if (i >= 0) this.queue.splice(i, 1);
    clearTimeout(w.timer);
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
  }

  _start(w) {
    this.active++;
    this.activeByUser.set(w.user, this._userActive(w.user) + 1);
    this.stats.started++;
    const t0 = this.now();
    M.wait.observe({ gate: this.name }, t0 - w.enqueuedAt);
    this._updateGauges();
    let p;
    try { p = Promise.resolve(w.fn()); } catch (e) { p = Promise.reject(e); }
    p.then(
      (v) => this._done(w, t0, 'ok', () => w.resolve(v)),
      (e) => this._done(w, t0, 'error', () => w.reject(e)),
    );
  }

  _done(w, t0, outcome, settle) {
    this.active = Math.max(0, this.active - 1);
    const n = this._userActive(w.user) - 1;
    if (n <= 0) this.activeByUser.delete(w.user); else this.activeByUser.set(w.user, n);
    if (outcome === 'ok') this.stats.completed++; else this.stats.failed++;
    M.duration.observe({ gate: this.name }, this.now() - t0);
    M.completed.inc({ gate: this.name, outcome });
    settle();
    this._drain();
    this._updateGauges();
  }

  /** Start the oldest waiter(s) whose user is under their cap. */
  _drain() {
    for (let i = 0; i < this.queue.length && this.active < this.maxConcurrent;) {
      const w = this.queue[i];
      if (this._userActive(w.user) >= this.perUser) { i++; continue; }
      this.queue.splice(i, 1);
      clearTimeout(w.timer);
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      this._start(w);
    }
  }

  _updateGauges() {
    M.active.set({ gate: this.name }, this.active);
    M.queued.set({ gate: this.name }, this.queue.length);
  }
}

// ── Named gates, configured once from the environment ───────────────────────
function envInt(name, def, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' && process.env[name] != null ? Math.min(max, Math.max(min, Math.round(n))) : def;
}

const registry = new Map();
function defineGate(name, opts) {
  if (!registry.has(name)) registry.set(name, new Gate({ name, ...opts }));
  return registry.get(name);
}

/** Archive (zip/tar) extraction — CPU + memory heavy. */
const archiveGate = () => defineGate('archive', {
  maxConcurrent: envInt('ARCHIVE_MAX_CONCURRENCY', 2, 1, 16),
  perUser: 1,
  maxQueue: envInt('ARCHIVE_MAX_QUEUE', 20, 0, 500),
  queueTimeoutMs: envInt('QUEUE_TIMEOUT_MS', 60000, 1000, 600000),
});

/** Repository / file downloads — whole archive is buffered in memory. */
const downloadGate = () => defineGate('download', {
  maxConcurrent: envInt('DOWNLOAD_MAX_CONCURRENCY', 3, 1, 32),
  perUser: 1,
  maxQueue: envInt('DOWNLOAD_MAX_QUEUE', 30, 0, 500),
  queueTimeoutMs: envInt('QUEUE_TIMEOUT_MS', 60000, 1000, 600000),
});

/** Uploads being processed/committed (classification + the multi-call commit). */
const uploadGate = () => defineGate('upload', {
  maxConcurrent: envInt('UPLOAD_MAX_CONCURRENCY', 4, 1, 32),
  perUser: envInt('UPLOAD_PER_USER_CONCURRENCY', 1, 1, 4),
  maxQueue: envInt('UPLOAD_MAX_QUEUE', 40, 0, 1000),
  queueTimeoutMs: envInt('QUEUE_TIMEOUT_MS', 60000, 1000, 600000),
});

/** Bulk operations (one tap → many GitHub calls). */
const bulkGate = () => defineGate('bulk', {
  maxConcurrent: envInt('BULK_MAX_CONCURRENCY', 3, 1, 32),
  perUser: 1,
  maxQueue: envInt('BULK_MAX_QUEUE', 30, 0, 500),
  queueTimeoutMs: envInt('QUEUE_TIMEOUT_MS', 60000, 1000, 600000),
});

/** Plain-language message for a GateError, for the reply layer. */
function describeGateError(err, what = 'This') {
  if (!err || err.name !== 'GateError') return null;
  if (err.code === 'GATE_USER_LIMIT') return `${what} is already in progress for you — let it finish first.`;
  if (err.code === 'GATE_TIMEOUT') return `${what} waited too long because the bot is busy. Nothing was changed — try again in a moment.`;
  if (err.code === 'GATE_ABORTED') return `${what} was cancelled.`;
  return `The bot is handling a lot of ${err.gate === 'download' ? 'downloads' : err.gate === 'archive' ? 'archive uploads' : 'work'} right now. Nothing was changed — try again in a minute.`;
}

module.exports = { Gate, GateError, archiveGate, downloadGate, uploadGate, bulkGate, describeGateError };
