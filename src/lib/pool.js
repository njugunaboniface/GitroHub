/**
 * Tiny bounded-concurrency helper.
 *
 * `mapLimit(items, limit, fn)` behaves like `Promise.all(items.map(fn))`
 * except that at most `limit` calls of `fn` are in flight at once. Results
 * keep the input order. The first rejection stops handing out new work and
 * is re-thrown (already-started calls are allowed to settle).
 *
 * Why (v1.1.7-multi): committing a 100+ file upload used to fire every
 * createBlob at once via Promise.all, which is exactly what trips GitHub's
 * secondary (abuse) rate limit. Same helper also bounds the Redis writes
 * made while extracting a big archive.
 */
async function mapLimit(items, limit, fn) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  let next = 0;
  let failed = false;

  async function worker() {
    while (!failed) {
      const i = next++;
      if (i >= list.length) return;
      try {
        results[i] = await fn(list[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  const workers = [];
  for (let w = 0; w < width; w++) workers.push(worker());
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((s) => s.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
}

module.exports = { mapLimit };
