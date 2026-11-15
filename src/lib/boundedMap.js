/**
 * BoundedMap (v1.2.1-multi) — a Map with a hard entry cap and LRU eviction, plus an optional TTL sweep.
 * Drop-in for `new Map()`: every existing `.get/.set/.has/.delete/.keys/.size` call keeps working.
 *
 *   • set() past `max` evicts the least-recently-used entry (get() counts as a use);
 *   • `sweep(isExpired)` removes expired entries — `startSweeper()` runs it on an unref'd timer so a
 *     cache whose entries are only useful for N seconds doesn't keep idle users' data in memory;
 *   • `weight(value)` + `maxWeight` bound memory by SIZE (e.g. total tree entries), not just count.
 */
class BoundedMap extends Map {
  constructor({ max = 1000, maxWeight = Infinity, weight = () => 1, name = 'cache' } = {}) {
    super();
    this.max = max; this.maxWeight = maxWeight; this.weightFn = weight; this.name = name;
    this.totalWeight = 0; this.evictions = 0;
    this._w = new Map();
  }

  get(key) {
    if (!super.has(key)) return undefined;
    const v = super.get(key);
    super.delete(key); super.set(key, v); // refresh recency
    return v;
  }

  set(key, value) {
    if (super.has(key)) { this.totalWeight -= this._w.get(key) || 0; super.delete(key); }
    const w = Number(this.weightFn(value)) || 1;
    super.set(key, value); this._w.set(key, w); this.totalWeight += w;
    while ((this.size > this.max || this.totalWeight > this.maxWeight) && this.size > 1) {
      const oldest = super.keys().next().value;
      if (oldest === key) break;
      this.delete(oldest); this.evictions++;
    }
    return this;
  }

  delete(key) {
    if (super.has(key)) { this.totalWeight -= this._w.get(key) || 0; this._w.delete(key); }
    return super.delete(key);
  }

  clear() { super.clear(); this._w.clear(); this.totalWeight = 0; }

  sweep(isExpired) {
    let n = 0;
    for (const [k, v] of [...super.entries()]) if (isExpired(v, k)) { this.delete(k); n++; }
    return n;
  }

  startSweeper(isExpired, everyMs = 60000) {
    const t = setInterval(() => this.sweep(isExpired), everyMs);
    if (t.unref) t.unref();
    return t;
  }
}

module.exports = { BoundedMap };
