/**
 * Per-user update serialization (v1.2.1-multi) — extracted from bot.js so it can be tested at 1,000
 * simultaneous users without Telegram. Same semantics as before:
 *
 *   • updates from ONE user run strictly one at a time, in arrival order;
 *   • updates from DIFFERENT users never wait for each other (there is no global queue);
 *   • a user's entry is removed as soon as their backlog drains (no map growth).
 *
 * New: a per-user backlog cap. A client replaying thousands of buffered taps (or a script) used to
 * park every one of them in memory behind the first; now anything beyond `maxPending` queued updates
 * from the same user is refused immediately (`{ dropped: true }`) so the caller can answer
 * "slow down" instead of holding the work.
 */
class UserSerializer {
  constructor({ maxPending = 25, maxRunMs = 0 } = {}) {
    this.maxPending = maxPending;
    // v2.1.1: a watchdog. One update that never finishes (a hung network call) must not freeze every later tap from that
    // person; after maxRunMs the queue moves on (the slow update keeps running in the background). 0 = off.
    this.maxRunMs = maxRunMs;
    this.timedOut = 0;
    this.tails = new Map(); // key -> promise of the last queued update
    this.depth = new Map(); // key -> queued + running count
    this.dropped = 0;
  }

  /** @returns {Promise<{dropped:true}|{dropped:false, value:any}>} rejects only if `fn` throws */
  async run(key, fn) {
    const k = String(key);
    const depth = this.depth.get(k) || 0;
    if (depth >= this.maxPending) { this.dropped++; return { dropped: true }; }
    this.depth.set(k, depth + 1);
    const previous = this.tails.get(k) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    this.tails.set(k, mine);
    await previous;
    try {
      if (!this.maxRunMs) return { dropped: false, value: await fn() };
      let timer;
      const work = Promise.resolve().then(fn);
      const watchdog = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timedOut: true }), this.maxRunMs); });
      const outcome = await Promise.race([work, watchdog]);
      clearTimeout(timer);
      if (outcome && outcome.__timedOut) { this.timedOut++; work.catch(() => {}); return { dropped: false, value: undefined, timedOut: true }; }
      return { dropped: false, value: outcome };
    } finally {
      release();
      const d = (this.depth.get(k) || 1) - 1;
      if (d <= 0) this.depth.delete(k); else this.depth.set(k, d);
      if (this.tails.get(k) === mine) this.tails.delete(k);
    }
  }

  stats() { return { users: this.depth.size, dropped: this.dropped, timedOut: this.timedOut }; }
}

module.exports = { UserSerializer };
