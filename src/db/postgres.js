const pg = require('pg');
const { Pool } = pg;
const config = require('../config');
const logger = require('../lib/logger');

// BIGINT (Postgres type OID 20) comes back from `pg` as a STRING by default,
// but every Telegram ID in this codebase is compared against numbers —
// config.OWNER_ID / ADMIN_IDS / SUPER_ADMIN_IDS, ctx.from.id, Number()-parsed
// callback data — with `===` / `.includes()` / Set lookups, all of which
// silently fail on '123' vs 123 (the Owner badge never showed, and the
// 👑 Admins roster listed every env-seeded admin twice). Telegram IDs and
// byte counts are far below 2^53, so parsing every BIGINT to a JS number is
// exact. (Defensive Number() coercions were also added at the comparison
// sites themselves, so a stray string can never reintroduce the bug.)
if (pg.types && typeof pg.types.setTypeParser === 'function') {
  pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
}

// Default pool size is up to 10 idle connections — far more than a
// single-owner bot ever needs, and each idle connection holds its own
// buffers in memory. Capped low to keep the baseline footprint small on
// Railway's 512MB free-tier limit.
//
// connectionTimeoutMillis / statement_timeout: previously UNSET, meaning a
// request that couldn't get a free connection (e.g. the pool exhausted by
// orphaned connections from a prior crashed instance) just waited forever
// instead of failing with a clear error — this is what caused the whole
// bot to appear frozen, including /start, since even the "are you
// connected" check is a DB query. Now both fail fast instead of hanging.
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000, // fail fast if no connection is available
  statement_timeout: 10000, // cancel any single query that hangs server-side
  ssl: config.DATABASE_URL.includes('railway') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  logger.error('Unexpected Postgres pool error', { message: err.message });
});

// ── v1.2.1-multi: instrumentation ────────────────────────────────────────
// Measures what the scaling audit needs to see — query latency, errors, slow
// queries, how long callers wait for a connection, and how long transaction
// clients are held (a client held for minutes is a leak). Wraps the pool
// IN PLACE so no call site changes; label values are fixed strings, never SQL
// text or parameters (those can contain private data).
const metrics = require('../lib/metrics');
const M = {
  queryMs: metrics.histogram('pg_query_duration_ms', 'Postgres query duration (pool.query)', [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 10000]),
  queryErr: metrics.counter('pg_query_errors', 'Postgres query errors'),
  slow: metrics.counter('pg_slow_queries', 'Queries slower than PG_SLOW_QUERY_MS'),
  connectMs: metrics.histogram('pg_pool_wait_ms', 'Time spent waiting for a pooled connection (pool.connect)', [1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000]),
  holdMs: metrics.histogram('pg_client_hold_ms', 'How long a checked-out client (transaction) was held', [10, 50, 100, 500, 1000, 5000, 10000, 30000, 60000]),
  longHold: metrics.counter('pg_long_client_holds', 'Checked-out clients held longer than PG_LONG_HOLD_MS (possible leak)'),
};
const SLOW_QUERY_MS = Number(process.env.PG_SLOW_QUERY_MS) || 1000;
const LONG_HOLD_MS = Number(process.env.PG_LONG_HOLD_MS) || 15000;

const rawQuery = pool.query.bind(pool);
pool.query = async function instrumentedQuery(...args) {
  const t0 = process.hrtime.bigint();
  try {
    return await rawQuery(...args);
  } catch (err) {
    M.queryErr.inc({ code: String((err && err.code) || 'unknown').slice(0, 12) });
    throw err;
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    M.queryMs.observe({}, ms);
    if (ms >= SLOW_QUERY_MS) {
      M.slow.inc({});
      logger.warn('Slow Postgres query', { ms: Math.round(ms) }); // SQL deliberately not logged
    }
  }
};

const rawConnect = pool.connect.bind(pool);
pool.connect = async function instrumentedConnect(...args) {
  const t0 = process.hrtime.bigint();
  const client = await rawConnect(...args);
  M.connectMs.observe({}, Number(process.hrtime.bigint() - t0) / 1e6);
  if (client && typeof client.release === 'function') {
    const heldFrom = process.hrtime.bigint();
    const rawRelease = client.release.bind(client);
    let released = false;
    client.release = (...a) => {
      if (!released) {
        released = true;
        const held = Number(process.hrtime.bigint() - heldFrom) / 1e6;
        M.holdMs.observe({}, held);
        if (held >= LONG_HOLD_MS) { M.longHold.inc({}); logger.warn('Postgres client held for a long time', { ms: Math.round(held) }); }
      }
      return rawRelease(...a);
    };
  }
  return client;
};

/**
 * Ping the database and return round-trip latency in ms.
 * Used by Settings screen to show live DB health. Cached for 5s — Settings'
 * Refresh Status is trivially spammable (inline, chained, one tap = a
 * fresh message with another refresh button), so an uncached ping here
 * would be real, easily-repeated DB load.
 */
let cachedPing = null;
async function ping() {
  if (cachedPing && Date.now() - cachedPing.timestamp < 5000) {
    return cachedPing.result;
  }
  const start = Date.now();
  let result;
  try {
    await pool.query('SELECT 1');
    result = { ok: true, ms: Date.now() - start };
  } catch (err) {
    result = { ok: false, ms: null, error: err.message };
  }
  cachedPing = { result, timestamp: Date.now() };
  return result;
}

/** Closes all pool connections cleanly — used on graceful shutdown (SIGTERM). */
async function close() {
  await pool.end();
}

module.exports = { pool, ping, close };
