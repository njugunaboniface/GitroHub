const { createClient } = require('redis');
const config = require('../config');
const logger = require('../lib/logger');

const client = createClient({
  url: config.REDIS_URL,
  socket: {
    connectTimeout: 5000, // fail fast instead of hanging if Redis is unreachable
    // v1.2.1-multi: bounded, JITTERED reconnect backoff (100ms → 5s cap) so a Redis restart is not met by
    // every replica/connection retrying on the same beat.
    reconnectStrategy: (retries) => Math.min(5000, 100 * 2 ** Math.min(retries, 6)) + Math.floor(Math.random() * 250),
  },
  // v1.2.1-multi: with the default offline queue, every command issued while Redis is down waits in
  // memory (unbounded) until it reconnects — each user's update hangs and they pile up. Failing fast
  // instead means a Redis outage produces quick, truthful "temporarily unavailable" replies and a flat
  // memory curve. Set REDIS_OFFLINE_QUEUE=1 to restore the old queue-and-wait behaviour.
  disableOfflineQueue: process.env.REDIS_OFFLINE_QUEUE !== '1',
});

client.on('error', (err) => {
  logger.error('Redis client error', { message: err.message });
});
client.on('reconnecting', () => {
  logger.warn('Redis reconnecting...');
});
client.on('ready', () => {
  logger.info('Redis connection ready');
});

let connected = false;
let connectPromise = null;

async function connect() {
  if (connected || client.isReady) {
    connected = true;
    return;
  }
  // Coalesce simultaneous startup/reconnect calls. Without this, two
  // requests arriving while Redis is still connecting can both call
  // client.connect(), causing a "Socket already opened" error and making
  // callers unnecessarily fall back to degraded local-only behavior.
  if (connectPromise) return connectPromise;

  connectPromise = client.connect()
    .then(() => {
      connected = true;
      logger.info('Redis connected');
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

/**
 * Ping Redis and return round-trip latency in ms.
 * Used by Settings screen to show live DB health. Cached for 5s — same
 * reasoning as Postgres's ping cache.
 */
let cachedPing = null;
async function ping() {
  if (cachedPing && Date.now() - cachedPing.timestamp < 5000) {
    return cachedPing.result;
  }
  const start = Date.now();
  let result;
  try {
    await Promise.race([
      client.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    result = { ok: true, ms: Date.now() - start };
  } catch (err) {
    result = { ok: false, ms: null, error: err.message };
  }
  cachedPing = { result, timestamp: Date.now() };
  return result;
}

/** Closes the Redis connection cleanly — used on graceful shutdown (SIGTERM). */
async function close() {
  if (connectPromise) {
    try { await connectPromise; } catch (_) { /* close below is best-effort */ }
  }
  if (connected || client.isOpen) {
    await client.quit();
    connected = false;
  }
}

module.exports = { client, connect, ping, close };
