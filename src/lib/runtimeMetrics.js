/**
 * Runtime health & resource metrics (v1.2.1-multi).
 *
 * One place that samples the process (CPU, RSS/heap, event-loop lag), the
 * Postgres pool (size, waiters), Redis (latency, memory, key count) and the
 * GitHub traffic layer, publishes them to the metrics registry, and turns
 * them into ONE health verdict:
 *
 *   HEALTHY      everything nominal
 *   DEGRADED     serving, but under pressure (event-loop lag, memory close to
 *                the watchdog ceiling, pool waiters, GitHub overloaded or its
 *                circuit open) — HTTP 200 so the platform does NOT restart a
 *                process that is merely busy
 *   UNAVAILABLE  cannot do its job (Postgres or Redis unreachable) — HTTP 503
 *
 * Everything here is cheap and bounded: sampling is on timers (never per
 * request), Redis INFO/DBSIZE run at most once a minute, and /health reuses
 * the cached pings the Settings screen already relies on.
 *
 * Nothing in this module controls traffic — it only OBSERVES and reports.
 */
const { monitorEventLoopDelay } = require('perf_hooks');
const metrics = require('./metrics');

const THRESHOLDS = Object.freeze({
  eventLoopLagP99Ms: Number(process.env.HEALTH_LOOP_LAG_P99_MS) || 250,
  memoryFraction: Number(process.env.HEALTH_MEMORY_FRACTION) || 0.85, // of the watchdog ceiling
  poolWaiters: Number(process.env.HEALTH_POOL_WAITERS) || 5,
});

const G = {
  lagP50: metrics.gauge('node_event_loop_lag_p50_ms', 'Event-loop delay p50 over the last sample window'),
  lagP99: metrics.gauge('node_event_loop_lag_p99_ms', 'Event-loop delay p99 over the last sample window'),
  lagMax: metrics.gauge('node_event_loop_lag_max_ms', 'Event-loop delay max over the last sample window'),
  rss: metrics.gauge('node_memory_rss_bytes', 'Resident set size'),
  heapUsed: metrics.gauge('node_memory_heap_used_bytes', 'V8 heap used'),
  heapTotal: metrics.gauge('node_memory_heap_total_bytes', 'V8 heap total'),
  external: metrics.gauge('node_memory_external_bytes', 'External (Buffer) memory'),
  cpu: metrics.gauge('node_cpu_percent', 'CPU use of this process since the previous sample (100 = one full core)'),
  uptime: metrics.gauge('node_uptime_seconds', 'Process uptime'),
  poolTotal: metrics.gauge('pg_pool_total', 'Postgres pool connections (open)'),
  poolIdle: metrics.gauge('pg_pool_idle', 'Postgres pool connections (idle)'),
  poolWaiting: metrics.gauge('pg_pool_waiting', 'Requests waiting for a Postgres connection'),
  poolMax: metrics.gauge('pg_pool_max', 'Configured Postgres pool ceiling'),
  redisUp: metrics.gauge('redis_up', '1 when Redis answered the last ping'),
  redisPing: metrics.gauge('redis_ping_ms', 'Redis ping round trip'),
  redisKeys: metrics.gauge('redis_keys', 'Redis key count (DBSIZE), sampled once a minute'),
  redisMem: metrics.gauge('redis_used_memory_bytes', 'Redis used_memory, sampled once a minute'),
  pgUp: metrics.gauge('pg_up', '1 when Postgres answered the last ping'),
  pgPing: metrics.gauge('pg_ping_ms', 'Postgres ping round trip'),
};

let lagHist = null;
let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();
let timer = null;
let slowTimer = null;
const state = { lag: { p50: 0, p99: 0, max: 0 }, cpuPercent: 0, redisKeys: null, redisMemBytes: null };

function sampleProcess() {
  const mem = process.memoryUsage();
  G.rss.set({}, mem.rss); G.heapUsed.set({}, mem.heapUsed); G.heapTotal.set({}, mem.heapTotal); G.external.set({}, mem.external || 0);
  G.uptime.set({}, Math.round(process.uptime()));
  const nowNs = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const dtUs = Number(nowNs - lastCpuAt) / 1000;
  if (dtUs > 0) {
    const usedUs = (cpu.user - lastCpu.user) + (cpu.system - lastCpu.system);
    state.cpuPercent = Math.round((usedUs / dtUs) * 1000) / 10;
    G.cpu.set({}, state.cpuPercent);
  }
  lastCpu = cpu; lastCpuAt = nowNs;
  if (lagHist) {
    const ms = (ns) => Math.round((ns / 1e6) * 10) / 10;
    state.lag = { p50: ms(lagHist.percentile(50)), p99: ms(lagHist.percentile(99)), max: ms(lagHist.max) };
    G.lagP50.set({}, state.lag.p50); G.lagP99.set({}, state.lag.p99); G.lagMax.set({}, state.lag.max);
    lagHist.reset();
  }
}

// Evidence-based pool advisor: the pool size (PG_POOL_MAX, default 3) is deliberately NOT raised blindly.
// Instead, if callers keep WAITING for a connection across many consecutive samples, say so once per
// 10 minutes with the numbers needed to decide (the operator must check Postgres max_connections first).
let waitingStreak = 0; let lastAdvice = 0;
function adviseOnPool(pgPool) {
  const waiting = pgPool.waitingCount || 0;
  waitingStreak = waiting >= 2 ? waitingStreak + 1 : 0;
  if (waitingStreak >= 6 && Date.now() - lastAdvice > 10 * 60 * 1000) {
    lastAdvice = Date.now();
    require('./logger').warn('Postgres pool is saturated: callers have been waiting for a connection for ~30s', {
      waiting, total: pgPool.totalCount, idle: pgPool.idleCount, poolMax: pgPool.options && pgPool.options.max,
      hint: 'Check pg_pool_wait_ms / pg_query_duration_ms first. If queries are fast and waiters persist, raise PG_POOL_MAX in small steps (3→5→8) while staying under Postgres max_connections divided by the number of bot replicas.',
    });
  }
}

function samplePool() {
  try {
    const livePool = require('../db/postgres').pool;
    G.poolTotal.set({}, livePool.totalCount || 0);
    G.poolIdle.set({}, livePool.idleCount || 0);
    G.poolWaiting.set({}, livePool.waitingCount || 0);
    G.poolMax.set({}, (livePool.options && livePool.options.max) || 0);
    adviseOnPool(livePool);
  } catch (_) { /* pool not available (tests) */ }
}

async function sampleRedisSlow() {
  try {
    const { client } = require('../db/redis');
    if (!client || !client.isReady) return;
    const [keys, info] = await Promise.all([client.dbSize(), client.info('memory')]);
    state.redisKeys = Number(keys);
    const m = /used_memory:(\d+)/.exec(String(info));
    state.redisMemBytes = m ? Number(m[1]) : null;
    G.redisKeys.set({}, state.redisKeys);
    if (state.redisMemBytes != null) G.redisMem.set({}, state.redisMemBytes);
  } catch (_) { /* best-effort */ }
}

/** Starts the lightweight samplers. Idempotent; timers are unref'd. */
function start({ intervalMs = 5000 } = {}) {
  if (timer) return;
  try {
    lagHist = monitorEventLoopDelay({ resolution: 20 });
    lagHist.enable();
  } catch (_) { lagHist = null; }
  timer = setInterval(() => { sampleProcess(); samplePool(); }, intervalMs);
  timer.unref();
  slowTimer = setInterval(sampleRedisSlow, 60000);
  slowTimer.unref();
  sampleProcess();
}

function stop() {
  clearInterval(timer); clearInterval(slowTimer); timer = slowTimer = null;
  if (lagHist) { lagHist.disable(); lagHist = null; }
}

/**
 * Pure health verdict from already-collected facts (unit-testable).
 * @param {{pg:{ok:boolean}, redis:{ok:boolean}, rssMB:number, memoryCeilingMB:number, lagP99Ms:number, poolWaiting:number, traffic?:{state:string, breaker?:{state:string}}}} f
 */
function evaluate(f) {
  const reasons = [];
  if (!f.pg || !f.pg.ok) return { status: 'UNAVAILABLE', reasons: ['postgres unreachable'] };
  if (!f.redis || !f.redis.ok) return { status: 'UNAVAILABLE', reasons: ['redis unreachable'] };
  if (f.lagP99Ms > THRESHOLDS.eventLoopLagP99Ms) reasons.push(`event loop lag p99 ${Math.round(f.lagP99Ms)}ms`);
  if (f.memoryCeilingMB && f.rssMB > f.memoryCeilingMB * THRESHOLDS.memoryFraction) reasons.push(`memory ${f.rssMB}MB near ${f.memoryCeilingMB}MB ceiling`);
  if (f.poolWaiting >= THRESHOLDS.poolWaiters) reasons.push(`${f.poolWaiting} requests waiting for a database connection`);
  const t = f.traffic;
  if (t && (t.state === 'OVERLOADED' || t.state === 'DEGRADED')) reasons.push(`GitHub traffic ${t.state.toLowerCase()}`);
  if (t && t.breaker && t.breaker.state !== 'CLOSED') reasons.push(`GitHub circuit ${t.breaker.state.toLowerCase().replace('_', '-')}`);
  return { status: reasons.length ? 'DEGRADED' : 'HEALTHY', reasons };
}

/** Collects live facts (cached pings — cheap) and evaluates them. */
async function getHealth() {
  const { getHealthStatus } = require('./healthCheck');
  const { pgStatus, redisStatus } = await getHealthStatus();
  G.pgUp.set({}, pgStatus.ok ? 1 : 0); if (pgStatus.ms != null) G.pgPing.set({}, pgStatus.ms);
  G.redisUp.set({}, redisStatus.ok ? 1 : 0); if (redisStatus.ms != null) G.redisPing.set({}, redisStatus.ms);
  let traffic = null;
  try { traffic = require('./githubTraffic').getTraffic().manager.getSnapshot(); } catch (_) { /* optional */ }
  let ceiling = 0;
  try { ceiling = require('../config').MEMORY_WATCHDOG_MB || 0; } catch (_) { /* optional */ }
  const mem = process.memoryUsage();
  let poolWaiting = 0;
  try { poolWaiting = require('../db/postgres').pool.waitingCount || 0; } catch (_) { /* optional */ }
  const verdict = evaluate({ pg: pgStatus, redis: redisStatus, rssMB: Math.round(mem.rss / 1048576), memoryCeilingMB: ceiling, lagP99Ms: state.lag.p99, poolWaiting, traffic });
  return { ...verdict, pgStatus, redisStatus, rssMB: Math.round(mem.rss / 1048576), lag: { ...state.lag }, cpuPercent: state.cpuPercent, poolWaiting, traffic };
}

/** Refreshes gauges that are computed on read, then renders Prometheus text. */
function renderAll() {
  sampleProcess(); samplePool();
  try { require('./githubTraffic').getTraffic().manager.getState(); } catch (_) { /* optional */ }
  return metrics.renderPrometheus();
}

module.exports = { start, stop, evaluate, getHealth, renderAll, THRESHOLDS, state };
