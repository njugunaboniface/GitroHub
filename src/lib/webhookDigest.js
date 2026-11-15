const crypto = require('crypto');
const redisDb = require('../db/redis');

const DEFAULT_DIGEST_WINDOW_MS = 2 * 60 * 1000; // 2 minutes — overridable live via Global Config, see lib/globalConfig.js's getWebhookDigestWindowMs()
const DUE_KEY_PREFIX = 'webhook-digest-due:';
const BUFFER_KEY_PREFIX = 'webhook-buffer:';
const LOCK_KEY_PREFIX = 'webhook-digest-lock:';
const DROPPED_KEY_PREFIX = 'webhook-dropped:';
const LOCK_TTL_MS = 60 * 1000;
const RENEW_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('pexpire', KEYS[1], ARGV[2])
  end
  return 0
`;
const RELEASE_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;
const ACK_SCRIPT = `
  if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
  local count = tonumber(ARGV[2]) or 0
  local len = redis.call('llen', KEYS[2])
  if count > 0 then
    if len <= count then
      redis.call('del', KEYS[2], KEYS[3])
    else
      -- push() RPUSHes, so the delivered (oldest) events are the first
      -- count. Remove exactly those and preserve anything appended
      -- while the digest was being delivered.
      redis.call('ltrim', KEYS[2], count, -1)
      redis.call('set', KEYS[3], '1', 'XX')
    end
  elseif len == 0 then
    redis.call('del', KEYS[3])
  end
  redis.call('del', KEYS[1])
  return 1
`;
function bufferKey(telegramId, repo) {
  return `${BUFFER_KEY_PREFIX}${telegramId}:${repo}`;
}
function dueKey(telegramId, repo) {
  return `${DUE_KEY_PREFIX}${telegramId}:${repo}`;
}
function lockKey(telegramId, repo) {
  return `${LOCK_KEY_PREFIX}${telegramId}:${repo}`;
}
function droppedKey(telegramId, repo) {
  return `${DROPPED_KEY_PREFIX}${telegramId}:${repo}`;
}

/**
 * Batches rapid-fire webhook events (e.g. 5 pushes in 2 minutes)
 * into one Telegram message instead of one message per event. Uses a
 * Redis LIST for the buffer (append-only, cheap) and a separate TTL "due"
 * marker key rather than a JS setTimeout — a setTimeout would be lost on
 * any restart (deploy, memory-watchdog cycle), silently dropping whatever
 * was mid-buffer. The due marker survives a restart because it's just
 * data; a lightweight poller (startWebhookDigestPoller in index.js, its own
 * 30-second timer) scans for markers whose due time has passed and
 * flushes them.
 *
 * Returns true if this is the FIRST event in a fresh window (caller uses
 * this to know whether a flush needs scheduling — it already does, since
 * the poller scans unconditionally, but kept for clarity/future use).
 */
// v1.2.1-multi: the buffer is a Redis LIST that used to grow without limit while a
// digest window (or quiet hours) was open — a repo firing thousands of events would
// grow Redis memory unbounded. Now capped: past MAX_BUFFERED the OLDEST entries are
// trimmed (the digest is a grouped count anyway) and the buffer carries a TTL so an
// abandoned one (user removed, flush never ran) cannot live forever.
const MAX_BUFFERED = Number(process.env.WEBHOOK_MAX_BUFFERED_EVENTS) || 200;
const BUFFER_TTL_SECONDS = Number(process.env.WEBHOOK_BUFFER_TTL_SECONDS) || 3 * 24 * 3600;

/**
 * Counts events that could not be shown (over the per-repo rate limit, shed under
 * load, or trimmed from a full buffer) so the digest can say so instead of silently
 * under-reporting (v1.2.3-multi). Also makes sure a flush is scheduled, because every
 * event of a burst might have been dropped before any reached the buffer.
 */
async function noteDropped(telegramId, repo, count = 1) {
  if (!(count > 0)) return;
  const key = droppedKey(telegramId, repo);
  await redisDb.client.multi().incrBy(key, count).expire(key, BUFFER_TTL_SECONDS).exec();
  await ensureDue(telegramId, repo);
}

async function ensureDue(telegramId, repo) {
  const due = dueKey(telegramId, repo);
  const exists = await redisDb.client.exists(due);
  if (exists) return false;
  await redisDb.client.set(due, String(Date.now() + require('./globalConfig').getWebhookDigestWindowMs()));
  return true;
}

/** Keeps only what a button needs, and only a real github.com address. */
function cleanLink(link) {
  if (!link || !['pr', 'issue', 'run'].includes(link.type)) return null;
  const out = { type: link.type };
  if (Number.isInteger(link.number) && link.number > 0) out.number = link.number;
  if (Number.isInteger(link.runId) && link.runId > 0) out.runId = link.runId;
  if (typeof link.owner === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(link.owner)) out.owner = link.owner;
  if (typeof link.url === 'string' && /^https:\/\/github\.com\/[^\s]{1,300}$/.test(link.url)) out.url = link.url;
  if (link.type === 'run' ? !out.runId : !out.number) return null;
  return out;
}

async function push(telegramId, repo, summary, link = null) {
  const key = bufferKey(telegramId, repo);
  const results = await redisDb.client.multi()
    .rPush(key, JSON.stringify({ summary, at: Date.now(), ...(cleanLink(link) ? { link: cleanLink(link) } : {}) }))
    .lTrim(key, -MAX_BUFFERED, -1)
    .expire(key, BUFFER_TTL_SECONDS)
    .exec();
  // rPush's reply is the list length BEFORE the trim: anything over the cap was just discarded.
  const lengthBeforeTrim = Number(Array.isArray(results) ? results[0] : 0) || 0;
  if (lengthBeforeTrim > MAX_BUFFERED) await noteDropped(telegramId, repo, lengthBeforeTrim - MAX_BUFFERED);

  const due = dueKey(telegramId, repo);
  const exists = await redisDb.client.exists(due);
  if (!exists) {
    // Marks when this window's flush becomes due. The key's VALUE is
    // unused (just a marker); its existence + no-TTL-yet is checked via a
    // separate scan pattern below, since Redis can't natively "list keys
    // about to expire" — instead we store the due timestamp as the value
    // and compare on scan, which also survives clock drift better than
    // relying on TTL expiry timing exactly.
    await redisDb.client.set(due, String(Date.now() + require('./globalConfig').getWebhookDigestWindowMs()));
    return true;
  }
  return false;
}

/** Scans for any due digest windows and returns their (telegramId, repo)
 * pairs along with the buffered events, THEN clears both keys. Called by
 * the poller — see bot.js's memory-watchdog-adjacent interval. */
async function flushDue() {
  // Never use Redis KEYS here: this poller runs in production and KEYS
  // blocks Redis for the entire keyspace. SCAN is incremental and keeps
  // unrelated bot traffic responsive as the number of sessions/cache keys
  // grows.
  const dueKeys = [];
  for await (const key of redisDb.client.scanIterator({
    MATCH: `${DUE_KEY_PREFIX}*`,
    COUNT: 100,
  })) {
    dueKeys.push(key);
  }

  const results = [];
  const now = Date.now();

  for (const key of dueKeys) {
    const dueAt = Number(await redisDb.client.get(key));
    if (!dueAt || dueAt > now) continue; // not due yet

    const rest = key.slice(DUE_KEY_PREFIX.length);
    const sepIdx = rest.indexOf(':');
    const telegramId = rest.slice(0, sepIdx);
    const repo = rest.slice(sepIdx + 1);

    const lockToken = crypto.randomBytes(18).toString('hex');
    const lock = await redisDb.client.set(lockKey(telegramId, repo), lockToken, { NX: true, PX: LOCK_TTL_MS });
    if (lock !== 'OK') continue;

    const bKey = bufferKey(telegramId, repo);
    const raw = await redisDb.client.lRange(bKey, 0, -1);
    const droppedCount = Number(await redisDb.client.get(droppedKey(telegramId, repo))) || 0;
    if (raw.length > 0 || droppedCount > 0) {
      results.push({
        telegramId: Number(telegramId),
        repo,
        events: raw.map((r) => JSON.parse(r)),
        eventCount: raw.length,
        droppedCount,
        lockToken,
      });
    } else {
      await ack(telegramId, repo, lockToken, 0);
    }
  }
  return results;
}

/** Permanently removes a successfully delivered digest. Keeping the buffer
 * until delivery succeeds prevents a Telegram/network failure from losing
 * webhook notifications. The lock is released last so another poller cannot
 * race the acknowledgement. */
async function renew(telegramId, repo, lockToken) {
  if (!lockToken) return false;
  const result = await redisDb.client.eval(RENEW_SCRIPT, { keys: [lockKey(telegramId, repo)], arguments: [lockToken, String(LOCK_TTL_MS)] });
  return Number(result) === 1;
}

async function ack(telegramId, repo, lockToken, eventCount = 0, droppedCount = 0) {
  if (!lockToken) return false;
  const result = await redisDb.client.eval(ACK_SCRIPT, {
    keys: [lockKey(telegramId, repo), bufferKey(telegramId, repo), dueKey(telegramId, repo)],
    arguments: [lockToken, String(eventCount)],
  });
  const ok = Number(result) === 1;
  if (ok && droppedCount > 0) {
    // Subtract only what this digest reported; drops that arrived meanwhile stay counted.
    const left = await redisDb.client.decrBy(droppedKey(telegramId, repo), droppedCount);
    if (left <= 0) await redisDb.client.del(droppedKey(telegramId, repo));
  }
  return ok;
}

/** Releases a claimed digest without deleting its events, allowing retry. */
async function release(telegramId, repo, lockToken) {
  if (!lockToken) return false;
  const result = await redisDb.client.eval(RELEASE_SCRIPT, {
    keys: [lockKey(telegramId, repo)],
    arguments: [lockToken],
  });
  return Number(result) === 1;
}

/** Composes one summary line for a digest, grouping identical summaries
 * (e.g. 5x "1 new commit pushed" -> "5 pushes"). */
function composeDigestMessage(repo, events, droppedCount = 0) {
  const counts = new Map();
  for (const e of events) counts.set(e.summary, (counts.get(e.summary) || 0) + 1);
  const parts = [...counts.entries()].map(([summary, count]) => (count > 1 ? `${count}× ${summary}` : summary));
  if (droppedCount > 0) {
    parts.push(`+${droppedCount} more event${droppedCount === 1 ? '' : 's'} not shown (too many arrived at once)`);
  }
  return `🔔 ${parts.join(', ')} → ${repo}`;
}

module.exports = { cleanLink, push, noteDropped, flushDue, ack, release, renew, composeDigestMessage, DEFAULT_DIGEST_WINDOW_MS };
