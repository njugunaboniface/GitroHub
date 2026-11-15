/**
 * Redis lease for the timer-based background pollers (scheduled repos,
 * scheduled uploads, scheduled broadcasts).
 *
 * Why (v1.1.7-multi): those pollers do getDue() → act → mark done, with no
 * claim step. During a zero-downtime deploy (old and new instance briefly
 * running together) or an accidental second replica, both instances would
 * pick up the same due row and commit / create / broadcast it twice. A
 * short-lived `SET NX EX` lease per poller makes each tick owned by exactly
 * one instance; the owner releases it as soon as its tick finishes, and the
 * TTL only matters if the owner crashes mid-tick.
 *
 * Fail-open: if Redis can't be reached, the tick just runs (returning a
 * no-op lease) — missing a scheduled repo is worse than the (rare)
 * duplicate this guards against, and the pollers need Redis-adjacent
 * services healthy for most of their work anyway.
 *
 * NOTE: this only protects the background pollers. Per-user update
 * serialization, action caps and caches are still per-process by design, so
 * run a single bot replica (see README → Known limitations).
 */
const crypto = require('crypto');
const logger = require('./logger');

const INSTANCE_ID = crypto.randomBytes(8).toString('hex');

// Compare-and-delete: only the holder may release its own lease.
const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";

const NOOP_LEASE = { release: async () => {} };

/**
 * @param {string} name        poller name, e.g. 'scheduled-uploads'
 * @param {number} ttlSeconds  crash-safety expiry (normal runs release earlier)
 * @param {object} [redis]     injectable client (tests); defaults to db/redis
 * @returns {Promise<{release: () => Promise<void>} | null>} null → another instance owns this tick
 */
async function acquire(name, ttlSeconds, redis) {
  const client = redis || require('../db/redis').client;
  const key = `poller-lease:${name}`;
  try {
    const ok = await client.set(key, INSTANCE_ID, { NX: true, EX: ttlSeconds });
    if (ok !== 'OK') return null;
    let released = false;
    const renewEveryMs = Math.max(1000, Math.floor((ttlSeconds * 1000) / 3));
    const renew = async () => {
      if (released) return;
      try {
        const renewed = await client.eval(RENEW_SCRIPT, {
          keys: [key],
          arguments: [INSTANCE_ID, String(ttlSeconds)],
        });
        if (renewed !== 1) logger.warn('Poller lease was lost before renewal', { poller: name });
      } catch (err) {
        logger.warn('Poller lease renewal failed', { poller: name, message: err.message });
      }
    };
    const timer = setInterval(() => { renew().catch(() => {}); }, renewEveryMs);
    timer.unref?.();
    return {
      release: async () => {
        released = true;
        clearInterval(timer);
        try {
          await client.eval(RELEASE_SCRIPT, { keys: [key], arguments: [INSTANCE_ID] });
        } catch (_) { /* TTL will clear it */ }
      },
    };
  } catch (err) {
    logger.warn('Poller lease check failed — running the tick anyway', { poller: name, message: err.message });
    return NOOP_LEASE;
  }
}

module.exports = { acquire, INSTANCE_ID };
