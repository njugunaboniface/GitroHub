const crypto = require('crypto');
const config = require('../config');
const redisDb = require('../db/redis');
const logger = require('./logger');

/**
 * v1.2.0-multi — now Redis-backed (write-through + read-through), making
 * in-progress uploads survive a process restart. Previously this was
 * deliberately in-process-only (see the old comment this replaces): file
 * bytes never touched Redis at all, so a mid-upload restart silently lost
 * whatever the person had uploaded so far. That was an accepted trade-off
 * at the time, explicitly revisited and reversed here per direct request.
 *
 * Still keeps an in-process Map as a fast L1 cache — the common case
 * (process stays up, upload completes normally) never needs a Redis
 * round-trip at all. Redis is the fallback path, hit only when an entry
 * isn't in the local Map — which, after a restart, is every entry, since
 * the Map itself doesn't survive; that's exactly the case this exists to
 * handle.
 *
 * Stored as base64 in Redis (~33% size overhead vs. raw bytes) rather
 * than configuring the redis client for binary mode — simpler and more
 * portable, and still bounded: the largest a single entry can be is
 * config.MAX_ZIP_UNCOMPRESSED_BYTES (15MB), so worst case is ~20MB in
 * Redis per pending upload. Same TTL as before either way — this was
 * never meant to be permanent storage, just enough to survive a restart
 * during active use, not to become a second file store.
 */
const store = new Map(); // id -> { content, timer }
const REDIS_KEY_PREFIX = 'filebuf:';

/**
 * v1.2.1-multi — hard memory bounds. A per-file limit (15MB) says nothing
 * about how many such files can be pending at once across many users, so:
 *
 *  • L1 (this Map) has a total BYTE budget (FILEBUF_MAX_MEMORY_MB, default 96).
 *    Past it, the OLDEST entries are evicted from memory — they are NOT lost:
 *    the Redis copy still serves them (read-through below), exactly as after a restart.
 *  • Redis write-through has its own tracked budget (FILEBUF_REDIS_BUDGET_MB,
 *    default 256). Past it, new entries stay in memory only (and the log says
 *    so) instead of growing Redis without bound. Every key also has a TTL, so
 *    abandoned uploads can never live forever either way.
 *  • A single entry larger than the whole L1 budget is never held in memory.
 */
const MEMORY_BUDGET = (Number(process.env.FILEBUF_MAX_MEMORY_MB) || 96) * 1024 * 1024;
const REDIS_BUDGET = (Number(process.env.FILEBUF_REDIS_BUDGET_MB) || 256) * 1024 * 1024;
let memoryBytes = 0;
let redisBytes = 0;
const redisSizes = new Map(); // id -> bytes written to Redis (this process), for budget accounting

function dropFromMemory(id) {
  const e = store.get(id);
  if (!e) return;
  clearTimeout(e.timer);
  memoryBytes -= e.content.length;
  store.delete(id);
}

function holdInMemory(id, content) {
  if (content.length > MEMORY_BUDGET) return false;
  while (memoryBytes + content.length > MEMORY_BUDGET && store.size) dropFromMemory(store.keys().next().value); // Map keeps insertion order → oldest first
  const timer = setTimeout(() => { dropFromMemory(id); }, config.WIZARD_SESSION_TTL_SECONDS * 1000);
  timer.unref?.();
  store.set(id, { content, timer });
  memoryBytes += content.length;
  return true;
}

function stats() { return { entries: store.size, memoryBytes, memoryBudget: MEMORY_BUDGET, redisBytes, redisBudget: REDIS_BUDGET }; }

function redisKey(id) {
  return `${REDIS_KEY_PREFIX}${id}`;
}

async function put(content) {
  const id = crypto.randomBytes(8).toString('hex');
  const held = holdInMemory(id, content);

  const b64Len = Math.ceil(content.length / 3) * 4;
  if (redisBytes + b64Len > REDIS_BUDGET) {
    if (!held) throw new Error('The bot is holding too many pending uploads right now. Please try again in a few minutes.');
    logger.warn('fileBufferCache Redis budget reached — entry kept in memory only (will not survive a restart)', { redisBytes });
    return id;
  }
  try {
    await redisDb.client.set(redisKey(id), content.toString('base64'), { EX: config.WIZARD_SESSION_TTL_SECONDS });
    redisSizes.set(id, b64Len); redisBytes += b64Len;
    const t = setTimeout(() => { if (redisSizes.delete(id)) redisBytes -= b64Len; }, config.WIZARD_SESSION_TTL_SECONDS * 1000);
    t.unref?.();
  } catch (err) {
    // Redis write failing must NOT fail the upload itself — worst case,
    // this one entry just isn't resumable across a restart, exactly the
    // old behavior. The in-process copy above still works normally.
    logger.warn('fileBufferCache Redis write-through failed — entry will not survive a restart', { message: err.message });
    if (!held) throw err;
  }
  return id;
}

async function get(id) {
  const entry = store.get(id);
  if (entry) return entry.content;

  // Not in the local Map — either it never existed, or (the case this
  // whole rewrite exists for) the process restarted since it was put().
  // Fall back to Redis; if found, warm the local Map too so a SECOND
  // get() for the same id in this same process doesn't pay the Redis
  // round-trip again.
  try {
    const base64 = await redisDb.client.get(redisKey(id));
    if (base64 == null) return undefined;
    const content = Buffer.from(base64, 'base64');
    holdInMemory(id, content); // warm L1 (bounded; if it doesn't fit, Redis keeps serving it)
    return content;
  } catch (err) {
    logger.warn('fileBufferCache Redis read failed', { message: err.message });
    return undefined;
  }
}

async function release(id) {
  dropFromMemory(id);
  const sz = redisSizes.get(id);
  if (sz != null) { redisSizes.delete(id); redisBytes -= sz; }
  try {
    await redisDb.client.del(redisKey(id));
  } catch (err) {
    logger.warn('fileBufferCache Redis delete failed — entry will simply expire via its own TTL', { message: err.message });
  }
}

async function releaseAll(ids) {
  await Promise.all(ids.map(release));
}

module.exports = { put, get, release, releaseAll, stats };
