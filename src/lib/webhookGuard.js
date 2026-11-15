/**
 * Webhook burst protection (v1.2.1-multi) — pure, dependency-free helpers the
 * /webhook/github route composes. Nothing here trusts payload content.
 *
 *  • precheck(headers)  cheap shape test BEFORE any JSON parsing or DB work, so
 *    junk traffic is rejected for the price of reading two headers.
 *  • Deduper            GitHub redelivers (manual redelivery, retries after a
 *    slow ack). The X-GitHub-Delivery id is unique per delivery, so a repeat is
 *    acknowledged and dropped. Redis SET NX EX when available (works across
 *    replicas / restarts), bounded in-memory LRU otherwise (fail-open: a
 *    duplicate notification is better than a lost one).
 *  • RateWindow         per-registration cap (one noisy repo — a bot pushing 500
 *    commits — can't turn into 500 Telegram messages or 500 Redis writes).
 *    Excess events are COUNTED, not silently lost, and surfaced as "+N more".
 *  • Limiter            bounded concurrent post-processing + bounded backlog, so
 *    a 100+ event burst can't open 100 DB queries at once or grow memory.
 */
const SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/i;
const EVENT_RE = /^[a-z_]{1,40}$/;
const DELIVERY_RE = /^[0-9a-zA-Z-]{8,64}$/;

/** @returns {{ok:true, event:string, delivery:string|null, signature:string} | {ok:false, status:number}} */
function precheck(headers) {
  const signature = String(headers['x-hub-signature-256'] || '');
  const event = String(headers['x-github-event'] || '');
  if (!SIGNATURE_RE.test(signature)) return { ok: false, status: 401 };
  if (!EVENT_RE.test(event)) return { ok: false, status: 400 };
  const d = String(headers['x-github-delivery'] || '');
  return { ok: true, event, signature, delivery: DELIVERY_RE.test(d) ? d : null };
}

class Deduper {
  constructor({ redis = null, ttlSeconds = 3600, maxLocal = 2000, now = Date.now } = {}) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
    this.maxLocal = maxLocal;
    this.now = now;
    this.local = new Map(); // delivery -> expiresAt (insertion-ordered → oldest first)
  }

  _localSeen(id) {
    const t = this.now();
    const exp = this.local.get(id);
    if (exp && exp > t) return true;
    this.local.delete(id);
    this.local.set(id, t + this.ttlSeconds * 1000);
    while (this.local.size > this.maxLocal) this.local.delete(this.local.keys().next().value);
    return false;
  }

  /** Un-marks a delivery that was acknowledged but not actually processed (rate-limited or shed), so GitHub's manual Redeliver of the same delivery id isn't dropped as a duplicate. Never throws. */
  async forget(deliveryId) {
    if (!deliveryId) return;
    this.local.delete(deliveryId);
    const r = typeof this.redis === 'function' ? this.redis() : this.redis;
    if (!r || r.isReady === false) return;
    try { await r.del(`webhook-delivery:${deliveryId}`); } catch (_) { /* best effort */ }
  }

  /** true = already processed (drop it). Never throws. */
  async seen(deliveryId) {
    if (!deliveryId) return false;
    if (this._localSeen(deliveryId)) return true;
    const r = typeof this.redis === 'function' ? this.redis() : this.redis;
    if (!r || r.isReady === false) return false;
    try {
      const ok = await r.set(`webhook-delivery:${deliveryId}`, '1', { NX: true, EX: this.ttlSeconds });
      return ok !== 'OK';
    } catch (_) { return false; }
  }
}

class RateWindow {
  constructor({ max = 60, windowMs = 60000, maxKeys = 5000, now = Date.now } = {}) {
    Object.assign(this, { max, windowMs, maxKeys, now });
    this.keys = new Map(); // key -> { start, n, over }
  }

  /** @returns {{allowed:boolean, over:number}} over = events dropped in this window so far */
  hit(key) {
    const t = this.now();
    let e = this.keys.get(key);
    if (!e || t - e.start >= this.windowMs) {
      e = { start: t, n: 0, over: 0 };
      this.keys.delete(key);
      this.keys.set(key, e);
      while (this.keys.size > this.maxKeys) this.keys.delete(this.keys.keys().next().value);
    }
    e.n++;
    if (e.n > this.max) { e.over++; return { allowed: false, over: e.over }; }
    return { allowed: true, over: 0 };
  }
}

class Limiter {
  constructor({ concurrency = 8, maxBacklog = 500 } = {}) {
    Object.assign(this, { concurrency, maxBacklog });
    this.active = 0;
    this.q = [];
    this.dropped = 0;
  }

  /** @returns {boolean} false when the backlog is full (caller counts it as shed) */
  submit(task) {
    if (this.active < this.concurrency) { this._run(task); return true; }
    if (this.q.length >= this.maxBacklog) { this.dropped++; return false; }
    this.q.push(task);
    return true;
  }

  _run(task) {
    this.active++;
    Promise.resolve().then(task).catch(() => {}).finally(() => {
      this.active--;
      const next = this.q.shift();
      if (next) this._run(next);
    });
  }

  stats() { return { active: this.active, backlog: this.q.length, dropped: this.dropped }; }
}

module.exports = { precheck, Deduper, RateWindow, Limiter };
