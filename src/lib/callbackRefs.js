/**
 * Callback-data packing: repo binding + short references.
 *
 * Two long-standing problems, one small mechanism (v1.1.7-multi):
 *
 * 1. Telegram hard-limits callback_data to 64 bytes. Buttons that embed a
 *    repo name (up to 100 chars on GitHub) or a file path routinely exceed
 *    it, and until now that was only logged ("this button will fail").
 *    `shorten()` replaces any oversized value with `~<id>` — a 17-byte
 *    reference derived from the value's SHA-256 — and remembers the full
 *    value (in-process for instant use, Redis for 30 days / restarts /
 *    other instances). The bot resolves it back to the original string in a
 *    single early middleware (see bot.js), so no handler ever sees a
 *    reference and nothing else in the codebase had to change.
 *
 * 2. Browse/file buttons acted on `ctx.session.currentRepo`, so a button on
 *    an OLDER message silently operated on whichever repo had become
 *    "current" since. `bindRepo()` prefixes such buttons with the repo they
 *    were rendered for (`@repo|browse:file:src/x.js`); on tap, the
 *    middleware makes that repo current again before routing, so every
 *    message's buttons stay bound to what THAT message was showing.
 *
 * The id is content-derived, so building the same keyboard twice yields the
 * same reference and there is no counter or per-message state to keep.
 */
const crypto = require('crypto');

const MAX_CALLBACK_DATA_BYTES = 64;
const REF_PREFIX = '~';
const BIND_PREFIX = '@';
const BIND_SEPARATOR = '|';
const REF_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — older buttons answer "expired"
const MEMORY_MAX = 5000;

const memory = new Map(); // id -> full data string (insertion-ordered → cheap FIFO eviction)

function idFor(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('base64url').slice(0, 16);
}

function redisClient() {
  try {
    const { client } = require('../db/redis');
    return client && client.isReady ? client : null;
  } catch (_) {
    return null;
  }
}

/** Prefix `data` with the repo it was rendered for. See file header. */
function bindRepo(repoName, data) {
  if (!repoName) return data;
  return `${BIND_PREFIX}${repoName}${BIND_SEPARATOR}${data}`;
}

/** Returns `data` unchanged when it fits in 64 bytes, else a `~id` reference
 * (registering the full value so resolve() can find it). Synchronous. */
function shorten(data) {
  if (Buffer.byteLength(data, 'utf8') <= MAX_CALLBACK_DATA_BYTES) return data;
  const id = idFor(data);
  if (!memory.has(id)) {
    memory.set(id, data);
    if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
  }
  const redis = redisClient();
  if (redis) {
    // Fire-and-forget: the message has to be sent before anyone can tap, and
    // the in-process copy covers the gap. Redis makes it survive restarts.
    redis.set(`cbref:${id}`, data, { EX: REF_TTL_SECONDS }).catch(() => {});
  }
  return `${REF_PREFIX}${id}`;
}

/**
 * Turns whatever callback_data Telegram sent back into `{ data, repo }`:
 * expands a `~id` reference and unwraps a `@repo|` binding. Returns null when
 * a reference can't be found (expired / evicted everywhere).
 */
async function resolve(raw) {
  let data = raw;
  if (typeof data === 'string' && data.startsWith(REF_PREFIX)) {
    const id = data.slice(REF_PREFIX.length);
    let full = memory.get(id);
    if (full === undefined) {
      const redis = redisClient();
      if (redis) {
        try { full = await redis.get(`cbref:${id}`); } catch (_) { full = null; }
      }
    }
    // Integrity: a reference must resolve to the value it was derived from.
    if (typeof full !== 'string' || idFor(full) !== id) return null;
    if (!memory.has(id)) memory.set(id, full);
    data = full;
  }

  let repo = null;
  if (typeof data === 'string' && data.startsWith(BIND_PREFIX)) {
    const sep = data.indexOf(BIND_SEPARATOR);
    if (sep > 1) {
      repo = data.slice(BIND_PREFIX.length, sep);
      data = data.slice(sep + 1);
    }
  }
  return { data, repo };
}

/** True when a raw callback_data value needs resolve() before routing. */
function needsResolve(raw) {
  return typeof raw === 'string' && (raw.startsWith(REF_PREFIX) || raw.startsWith(BIND_PREFIX));
}

module.exports = { bindRepo, shorten, resolve, needsResolve, MAX_CALLBACK_DATA_BYTES };
