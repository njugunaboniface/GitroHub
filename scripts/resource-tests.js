#!/usr/bin/env node
/**
 * resource-tests.js (v1.2.1-multi) — gates, archive worker, webhook guards,
 * health verdicts and bounded structures. Standard library only.
 */
const assert = require('assert');
const zlib = require('zlib');
const Module = require('module');
// The sandbox has no node_modules: stub only the third-party packages that src/lib/logger.js and
// src/db/redis.js load at require time. Everything under test is this repo's own code.
Object.assign(process.env, { DATABASE_URL: process.env.DATABASE_URL || 'postgres://x/y', REDIS_URL: process.env.REDIS_URL || 'redis://x', BOT_TOKEN: process.env.BOT_TOKEN || '1:x', OWNER_ID: process.env.OWNER_ID || '1', BOT_USERNAME: 'x_bot', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', BASE_URL: 'https://example.test', SESSION_JWT_SECRET: 'x'.repeat(32), TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) });
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  if (request === 'pino') { const f = () => ({ info() {}, warn() {}, error() {}, debug() {} }); f.stdTimeFunctions = { isoTime() {} }; return f; }
  if (request === 'redis') return { createClient: () => ({ on() {}, isReady: false, isOpen: false, multi() {}, exists() {} }) };
  if (request === 'pg') return { Pool: class { on() {} query() {} connect() {} end() {} }, types: { setTypeParser() {} } };
  return realLoad.call(this, request, parent, isMain);
};
const { Gate, GateError, describeGateError } = require('../src/lib/gate');
const { precheck, Deduper, RateWindow, Limiter } = require('../src/lib/webhookGuard');
const runtimeMetrics = require('../src/lib/runtimeMetrics');
const archive = require('../src/lib/archive');
const archiveRunner = require('../src/lib/archiveRunner');
const { createTraffic } = require('../src/lib/githubTraffic');
const config = require('../src/lib/githubTraffic/config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = []; const test = (n, f) => tests.push({ n, f });

// ── Gate ─────────────────────────────────────────────────────────────
test('gate: never exceeds global or per-user concurrency; slot always released, even when jobs throw', async () => {
  const g = new Gate({ name: 't1', maxConcurrent: 3, perUser: 1, maxQueue: 50, queueTimeoutMs: 5000 });
  let active = 0; let peak = 0; const perUserPeak = {}; const cur = {};
  const job = (u, fail) => g.run(u, async () => {
    active++; cur[u] = (cur[u] || 0) + 1;
    peak = Math.max(peak, active); perUserPeak[u] = Math.max(perUserPeak[u] || 0, cur[u]);
    await sleep(8); active--; cur[u]--;
    if (fail) throw new Error('boom');
    return u;
  }).catch((e) => e.message);
  const res = await Promise.all(Array.from({ length: 24 }, (_, i) => job(`u${i % 12}`, i % 5 === 0)));
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.ok(Object.values(perUserPeak).every((n) => n === 1), JSON.stringify(perUserPeak));
  assert.strictEqual(res.filter((r) => r === 'boom').length, 5);
  assert.strictEqual(g.snapshot().active, 0); assert.strictEqual(g.snapshot().queued, 0);
});

test('gate: fair — one user with 30 queued jobs does not starve others', async () => {
  const g = new Gate({ name: 't2', maxConcurrent: 1, perUser: 1, maxQueue: 100, queueTimeoutMs: 5000 });
  const order = [];
  const mk = (u) => g.run(u, async () => { await sleep(4); order.push(u); });
  const all = [];
  for (let i = 0; i < 30; i++) all.push(mk('A').catch(() => {}));
  for (const u of ['B', 'C']) all.push(mk(u));
  await Promise.all(all);
  assert.ok(order.indexOf('B') < 6 && order.indexOf('C') < 8, `B at ${order.indexOf('B')}, C at ${order.indexOf('C')}`);
});

test('gate: bounded queue refuses truthfully (GATE_FULL / GATE_USER_LIMIT), times out waiters, supports cancel, reports state', async () => {
  const g = new Gate({ name: 't3', maxConcurrent: 1, perUser: 1, maxQueue: 3, queueTimeoutMs: 80 });
  let release; const hold = new Promise((r) => { release = r; });
  const first = g.run('x', () => hold);
  const outcomes = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((u) => g.run(u, async () => 'ran').then(() => 'ran', (e) => e.code)));
  assert.deepStrictEqual(outcomes.filter((o) => o === 'GATE_FULL').length, 2);
  assert.ok(outcomes.filter((o) => o === 'GATE_TIMEOUT').length === 3, JSON.stringify(outcomes));
  const g2 = new Gate({ name: 't3b', maxConcurrent: 1, perUser: 1, maxQueue: 10, queueTimeoutMs: 5000 });
  let rel2; const h2 = new Promise((r) => { rel2 = r; });
  g2.run('x', () => h2);
  const codes = await Promise.all(Array.from({ length: 5 }, () => g2.run('same', async () => 1).then(() => 'ok', (e) => e.code)).map((p, i) => (i === 0 ? Promise.race([p, sleep(20).then(() => 'pending')]) : p)));
  assert.ok(codes.includes('GATE_USER_LIMIT'), JSON.stringify(codes));
  const ac = new AbortController();
  const queued = g2.run('cancelme', async () => 1, { signal: ac.signal });
  ac.abort();
  await assert.rejects(queued, (e) => e.code === 'GATE_ABORTED');
  assert.ok(['BUSY', 'OVERLOADED'].includes(g2.state()));
  rel2(); release(); await first;
  assert.ok(/waited too long/.test(describeGateError(new GateError('GATE_TIMEOUT', 'x', 'archive'))));
});

test('gate: onQueued fires only when a job actually has to wait', async () => {
  const g = new Gate({ name: 't4', maxConcurrent: 1, perUser: 1, maxQueue: 5, queueTimeoutMs: 2000 });
  let queuedFor = 0; let rel; const hold = new Promise((r) => { rel = r; });
  const a = g.run('a', () => hold, { onQueued: () => { queuedFor++; } });
  const b = g.run('b', async () => 1, { onQueued: () => { queuedFor++; } });
  await sleep(5); rel(); await Promise.all([a, b]);
  assert.strictEqual(queuedFor, 1);
});

// ── Archive worker ───────────────────────────────────────────────────
function tar(files) {
  const blocks = [];
  for (const [name, data] of files) {
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('archive worker: tar.gz is gunzipped and extracted OFF the main thread, byte-exact, identical to the inline readers', async () => {
  const t = tar([['a.txt', Buffer.from('hello')], ['dir/b.bin', Buffer.from([0, 1, 2, 3, 255])]]);
  const gz = zlib.gzipSync(t);
  const raw = await archiveRunner.gunzipBounded(gz, 1 << 20, { userId: 1 });
  assert.ok(raw.equals(t));
  const viaWorker = await archiveRunner.extractTar(raw, { userId: 1 });
  const inline = require('../src/lib/tarReader').extractTar(raw);
  assert.deepStrictEqual(viaWorker.entries.map((e) => [e.path, Buffer.from(e.data).toString('hex')]), inline.entries.map((e) => [e.path, Buffer.from(e.data).toString('hex')]));
  assert.ok(Buffer.isBuffer(viaWorker.entries[0].data));
});

test('archive worker: the SAME limits and errors apply (decompression bomb → TOO_LARGE, garbage → CORRUPT), as typed ArchiveError', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024));
  await assert.rejects(archiveRunner.gunzipBounded(bomb, 1024 * 1024, { userId: 2 }), (e) => e instanceof archive.ArchiveError && e.code === 'TOO_LARGE');
  await assert.rejects(archiveRunner.gunzipBounded(Buffer.from('not gzip'), 1024, { userId: 2 }), (e) => e instanceof archive.ArchiveError && e.code === 'CORRUPT');
  await assert.rejects(archiveRunner.readZip(Buffer.from('definitely not a zip'), { maxTotalBytes: 1000, maxEntries: 10 }, { userId: 2 }), (e) => e instanceof archive.ArchiveError);
});

test('archive worker: main-thread event loop stays responsive while a large inflate runs', async () => {
  const big = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 'a'));
  let maxGap = 0; let last = Date.now();
  const tick = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 5);
  await archiveRunner.gunzipBounded(big, 64 * 1024 * 1024, { userId: 3 });
  clearInterval(tick);
  assert.ok(maxGap < 120, `event loop stalled for ${maxGap}ms during extraction`);
});

test('archive gate: concurrent extractions are bounded globally and per user', async () => {
  const { archiveGate } = require('../src/lib/gate');
  const gate = archiveGate();
  const gz = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 'b'));
  let peak = 0;
  const poll = setInterval(() => { peak = Math.max(peak, gate.active); }, 2);
  await Promise.all(Array.from({ length: 12 }, (_, i) => archiveRunner.gunzipBounded(gz, 64 * 1024 * 1024, { userId: `u${i % 6}` })));
  clearInterval(poll);
  assert.ok(peak <= gate.maxConcurrent, `peak ${peak} > ${gate.maxConcurrent}`);
  assert.strictEqual(gate.active, 0);
});

// ── Webhook guards ───────────────────────────────────────────────────
test('webhook precheck: junk is refused from headers alone (before any parsing/DB)', () => {
  const sig = `sha256=${'a'.repeat(64)}`;
  assert.strictEqual(precheck({}).ok, false);
  assert.strictEqual(precheck({ 'x-hub-signature-256': 'sha1=abc', 'x-github-event': 'push' }).status, 401);
  assert.strictEqual(precheck({ 'x-hub-signature-256': sig, 'x-github-event': 'PUSH; drop' }).status, 400);
  const ok = precheck({ 'x-hub-signature-256': sig, 'x-github-event': 'push', 'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958' });
  assert.ok(ok.ok && ok.delivery);
  assert.strictEqual(precheck({ 'x-hub-signature-256': sig, 'x-github-event': 'push', 'x-github-delivery': '<script>' }).delivery, null);
});

test('webhook dedupe: a repeated delivery id is dropped (local LRU and Redis), bounded memory, fails open when Redis is down', async () => {
  const d = new Deduper({ maxLocal: 50 });
  assert.strictEqual(await d.seen('delivery-0001'), false);
  assert.strictEqual(await d.seen('delivery-0001'), true);
  for (let i = 0; i < 500; i++) await d.seen(`delivery-x${i}`.padEnd(12, '0'));
  assert.ok(d.local.size <= 50, `local ${d.local.size}`);
  const store = new Set();
  const redis = { isReady: true, set: async (k, _v, o) => (o.NX && store.has(k) ? null : (store.add(k), 'OK')) };
  const a = new Deduper({ redis }); const b = new Deduper({ redis }); // two "replicas"
  assert.strictEqual(await a.seen('shared-delivery-1'), false);
  assert.strictEqual(await b.seen('shared-delivery-1'), true, 'second replica sees it too');
  const broken = new Deduper({ redis: { isReady: true, set: async () => { throw new Error('down'); } } });
  assert.strictEqual(await broken.seen('whatever-id-1'), false, 'fails open');
});

test('webhook burst: 500 events from one repo → capped; counted, not lost silently; other repos unaffected; memory bounded', () => {
  const r = new RateWindow({ max: 60, maxKeys: 100 });
  let allowed = 0; let over = 0;
  for (let i = 0; i < 500; i++) { const h = r.hit('1:noisy'); h.allowed ? allowed++ : over++; }
  assert.strictEqual(allowed, 60); assert.strictEqual(over, 440);
  assert.ok(r.hit('2:quiet').allowed);
  for (let i = 0; i < 1000; i++) r.hit(`k${i}`);
  assert.ok(r.keys.size <= 100);
});

test('webhook limiter: 300 events are processed with bounded concurrency; overflow beyond the backlog is shed and counted; a throwing task cannot wedge it', async () => {
  const l = new Limiter({ concurrency: 4, maxBacklog: 100 });
  let active = 0; let peak = 0; let done = 0;
  let accepted = 0;
  for (let i = 0; i < 300; i++) {
    if (l.submit(async () => { active++; peak = Math.max(peak, active); await sleep(1); active--; done++; if (i % 7 === 0) throw new Error('bad'); })) accepted++;
  }
  await sleep(300);
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.strictEqual(accepted, 104); assert.strictEqual(l.stats().dropped, 196);
  assert.strictEqual(done, 104); assert.strictEqual(l.stats().active, 0);
});

test('webhook digest: the Redis buffer is capped and carries a TTL (uses MULTI rPush+lTrim+expire)', async () => {
  const redisDb = require('../src/db/redis');
  const calls = [];
  const chain = { rPush(k) { calls.push(['rPush', k]); return chain; }, lTrim(k, a, b) { calls.push(['lTrim', a, b]); return chain; }, expire(k, s) { calls.push(['expire', s]); return chain; }, exec: async () => [] };
  redisDb.client.multi = () => chain; redisDb.client.exists = async () => 1;
  await require('../src/lib/webhookDigest').push(1, 'repo', 'summary');
  assert.deepStrictEqual(calls.map((c) => c[0]), ['rPush', 'lTrim', 'expire']);
  assert.ok(calls[1][1] < 0 && calls[2][1] > 0);
});

// ── Health verdicts ──────────────────────────────────────────────────
test('health: UNAVAILABLE only when a dependency is down; pressure is DEGRADED (HTTP 200, so a busy process is not killed)', () => {
  const base = { pg: { ok: true }, redis: { ok: true }, rssMB: 100, memoryCeilingMB: 400, lagP99Ms: 5, poolWaiting: 0, traffic: { state: 'NORMAL', breaker: { state: 'CLOSED' } } };
  assert.strictEqual(runtimeMetrics.evaluate(base).status, 'HEALTHY');
  assert.strictEqual(runtimeMetrics.evaluate({ ...base, pg: { ok: false } }).status, 'UNAVAILABLE');
  assert.strictEqual(runtimeMetrics.evaluate({ ...base, redis: { ok: false } }).status, 'UNAVAILABLE');
  assert.strictEqual(runtimeMetrics.evaluate({ ...base, lagP99Ms: 900 }).status, 'DEGRADED');
  assert.strictEqual(runtimeMetrics.evaluate({ ...base, rssMB: 380 }).status, 'DEGRADED');
  assert.strictEqual(runtimeMetrics.evaluate({ ...base, poolWaiting: 9 }).status, 'DEGRADED');
  const g = runtimeMetrics.evaluate({ ...base, traffic: { state: 'OVERLOADED', breaker: { state: 'OPEN' } } });
  assert.strictEqual(g.status, 'DEGRADED'); assert.ok(g.reasons.length === 2);
});

test('runtime metrics: event-loop lag is actually measured and a blocked loop is visible', async () => {
  runtimeMetrics.start({ intervalMs: 600000 }); // only manual samples, so the reading can't be consumed by a timer
  await sleep(50);
  const end = Date.now() + 160; while (Date.now() < end) { /* block the loop */ }
  await sleep(40);
  runtimeMetrics.renderAll();
  assert.ok(runtimeMetrics.state.lag.max >= 100, `lag max ${runtimeMetrics.state.lag.max}`);
  assert.ok(/node_event_loop_lag_max_ms/.test(runtimeMetrics.renderAll()));
  runtimeMetrics.stop();
});

// ── Bounded structures in the traffic layer ──────────────────────────
test('traffic layer memory: lanes, user queues and usage stats stay bounded under many distinct identities', async () => {
  const t = createTraffic({ ...config.load({}), maxConcurrency: 20, perIdentityConcurrency: 20, maxQueueSize: 20000, perUserMaxQueue: 20000 }, { logger: { info() {}, warn() {}, error() {} } });
  const m = t.manager;
  await Promise.all(Array.from({ length: 6000 }, (_, i) => m.schedule({ identity: `id-${i}`, userId: i, category: 'repo', mutation: false }, async () => ({ status: 200, headers: {} }))));
  m.sweep({ idleMs: 0 });
  assert.ok(m.lanes.size <= 5000, `lanes ${m.lanes.size}`);
  assert.strictEqual(m.lanes.size, 0, 'idle lanes are reclaimed');
  assert.ok(m.usage.size <= 2000, `usage ${m.usage.size}`);
  assert.ok(m.users.size < 50, `idle users should be reaped, got ${m.users.size}`);
  assert.strictEqual(m.getSnapshot().active, 0);
});

// ── Retention & buffer budgets ───────────────────────────────────────
test('retention: deletes in bounded batches with a per-run cap, never one giant DELETE', async () => {
  const { pruneBatched } = require('../src/lib/retention');
  const calls = []; let remaining = 23000;
  const db = { query: async (sql, params) => { calls.push({ sql, n: params[0] }); const d = Math.min(params[0], remaining); remaining -= d; return { rowCount: d }; } };
  const r = await pruneBatched('t', 'created_at < $2', ['x'], { batchSize: 5000, maxBatches: 100, pauseMs: 0, db });
  assert.strictEqual(r.deleted, 23000); assert.strictEqual(r.batches, 5);
  assert.ok(calls.every((c) => c.n === 5000 && /LIMIT \$1/.test(c.sql) && /ctid/.test(c.sql)));
  remaining = 1e9;
  const capped = await pruneBatched('t', '1=1', [], { batchSize: 1000, maxBatches: 7, pauseMs: 0, db });
  assert.strictEqual(capped.capped, true); assert.strictEqual(capped.batches, 7);
});

test('upload buffers: memory is bounded by a byte budget (oldest evicted but still served from Redis); Redis budget stops growth; release frees accounting', async () => {
  process.env.FILEBUF_MAX_MEMORY_MB = '1'; process.env.FILEBUF_REDIS_BUDGET_MB = '3';
  delete require.cache[require.resolve('../src/lib/fileBufferCache')];
  const redisDb = require('../src/db/redis');
  const kv = new Map();
  redisDb.client.set = async (k, v) => { kv.set(k, v); return 'OK'; };
  redisDb.client.get = async (k) => (kv.has(k) ? kv.get(k) : null);
  redisDb.client.del = async (k) => { kv.delete(k); };
  const cache = require('../src/lib/fileBufferCache');
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await cache.put(Buffer.alloc(400 * 1024, i)));
  const st = cache.stats();
  assert.ok(st.memoryBytes <= st.memoryBudget, `memory ${st.memoryBytes} > ${st.memoryBudget}`);
  const first = await cache.get(ids[0]);
  assert.ok(first && first.length === 400 * 1024 && first[0] === 0, 'evicted from memory, still served from Redis');
  const before = cache.stats().redisBytes;
  for (let i = 0; i < 6; i++) await cache.put(Buffer.alloc(400 * 1024, 9)).catch(() => {});
  assert.ok(cache.stats().redisBytes <= st.redisBudget, `redis ${cache.stats().redisBytes} > budget`);
  assert.ok(cache.stats().redisBytes >= before);
  await cache.releaseAll(ids);
  assert.ok(cache.stats().redisBytes < before + 1, 'released entries are un-accounted');
  await assert.rejects(cache.put(Buffer.alloc(2 * 1024 * 1024)).then(() => { throw new Error('should not fit'); }), /too many pending uploads|should not fit/);
});

test('webhook secrets: encrypted at rest, legacy plaintext still verifies and is upgraded, every candidate registration is returned', async () => {
  const { pool } = require('../src/db/postgres');
  const rw = require('../src/lib/repoWebhooks');
  const written = []; const updates = [];
  pool.query = async (sql, p) => {
    if (/^\s*INSERT/.test(sql)) { written.push(p[3]); return {}; }
    if (/SELECT rw/.test(sql)) return { rows: [{ telegram_id: 1, secret: 'legacyplaintexthex' }, { telegram_id: 2, secret: written[0] }] };
    if (/^\s*UPDATE repo_webhooks SET secret/.test(sql)) { updates.push(p); return { rowCount: 1 }; }
    return { rowCount: 0, rows: [] };
  };
  await rw.save(2, 'repo', 5, 'topsecretvalue');
  assert.ok(written[0].startsWith('enc1:') && !written[0].includes('topsecretvalue'), 'stored sealed, no plaintext');
  const all = await rw.getAllByRepo('repo', 'owner');
  assert.deepStrictEqual(all.map((r) => [r.telegram_id, r.secret]), [[1, 'legacyplaintexthex'], [2, 'topsecretvalue']]);
  await sleep(5);
  assert.strictEqual(updates.length, 1, 'only the legacy row is upgraded'); assert.strictEqual(updates[0][0], 1);
});

test('telegram sends: flood control (retry_after) is waited out and retried (bounded); blocked users are not retried; 4xx is not retried; failures are reported, not swallowed', async () => {
  const { sendWithRetry } = require('../src/lib/telegramRetry');
  const waits = []; const sleepFn = async (ms) => { waits.push(ms); };
  let n = 0;
  assert.strictEqual(await sendWithRetry(async () => { if (++n < 3) throw Object.assign(new Error('Too Many Requests'), { response: { error_code: 429, parameters: { retry_after: 2 } } }); }, { sleepFn }), 'sent');
  assert.strictEqual(n, 3); assert.ok(waits.length === 2 && waits.every((w) => w >= 2000 && w < 2300), JSON.stringify(waits));
  n = 0;
  assert.strictEqual(await sendWithRetry(async () => { n++; throw Object.assign(new Error('Forbidden: bot was blocked by the user'), { response: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } }); }, { sleepFn }), 'blocked');
  assert.strictEqual(n, 1);
  n = 0;
  assert.strictEqual(await sendWithRetry(async () => { n++; throw Object.assign(new Error('Bad Request: message is too long'), { response: { error_code: 400, description: 'message is too long' } }); }, { sleepFn }), 'failed');
  assert.strictEqual(n, 1, 'a 4xx other than blocked is not retried');
  n = 0;
  assert.strictEqual(await sendWithRetry(async () => { n++; throw Object.assign(new Error('flood'), { response: { error_code: 429, parameters: { retry_after: 3600 } } }); }, { sleepFn }), 'failed');
  assert.strictEqual(n, 1, 'an unreasonably long retry_after is not waited out');
  n = 0;
  assert.strictEqual(await sendWithRetry(async () => { n++; throw new Error('socket hang up'); }, { sleepFn, maxRetries: 2 }), 'failed');
  assert.strictEqual(n, 3, 'network errors: bounded attempts');
});

test('dependency errors: DB/Redis outages become a truthful non-leaky message; ordinary errors are untouched', () => {
  const { describeDependencyError } = require('../src/lib/dependencyErrors');
  const leaks = (e) => { const d = describeDependencyError(e); return d && /10\.0|5432|ECONN|password|postgres:\/\//i.test(d.message); };
  const pgDown = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
  assert.strictEqual(describeDependencyError(pgDown).kind, 'database'); assert.ok(!leaks(pgDown));
  assert.strictEqual(describeDependencyError(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })).kind, 'database');
  assert.strictEqual(describeDependencyError(new Error('timeout exceeded when trying to connect')).kind, 'database');
  assert.strictEqual(describeDependencyError(Object.assign(new Error('The client is closed'), { name: 'ClientClosedError' })).kind, 'redis');
  assert.strictEqual(describeDependencyError(Object.assign(new Error('Socket closed unexpectedly'), { name: 'SocketClosedUnexpectedlyError' })).kind, 'redis');
  assert.strictEqual(describeDependencyError(new Error('Validation Failed')), null);
  assert.strictEqual(describeDependencyError(Object.assign(new Error('Not Found'), { status: 404 })), null);
  assert.ok(!/nothing was changed/i.test(describeDependencyError(pgDown).message));
});

test('Telegram updates: per-user ORDER preserved, users never wait on each other, 1,000 simultaneous users, no map growth, spam is capped', async () => {
  const { UserSerializer } = require('../src/lib/userSerializer');
  for (const users of [10, 100, 1000]) {
    const s = new UserSerializer({ maxPending: 50 });
    const running = new Map(); let overlap = 0; const order = new Map(); let globalActive = 0; let peakGlobal = 0;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: users }, (_, u) => Promise.all(Array.from({ length: 5 }, (_, i) => s.run(u, async () => {
      globalActive++; peakGlobal = Math.max(peakGlobal, globalActive);
      if (running.get(u)) overlap++; running.set(u, true);
      (order.get(u) || order.set(u, []).get(u)).push(i);
      await sleep(5);
      running.set(u, false); globalActive--;
    })))));
    const ms = Date.now() - t0;
    assert.strictEqual(overlap, 0, `${users} users: two updates of one user overlapped`);
    assert.ok([...order.values()].every((o) => o.join() === '0,1,2,3,4'), 'per-user order preserved');
    assert.ok(peakGlobal >= Math.min(users, 50), `users must run in parallel, peak ${peakGlobal}`);
    assert.ok(ms < 25 + 5 * 5 + users * 0.6 + 200, `${users} users took ${ms}ms — users are waiting on each other`);
    assert.strictEqual(s.stats().users, 0, 'drained users are removed');
  }
  const s2 = new UserSerializer({ maxPending: 5 });
  let release; const gate = new Promise((r) => { release = r; });
  const first = s2.run('spam', () => gate);
  const results = await Promise.all(Array.from({ length: 20 }, () => s2.run('spam', async () => 1)).map((p, i) => (i < 4 ? Promise.race([p, sleep(5).then(() => 'queued')]) : p)));
  assert.ok(results.filter((r) => r && r.dropped).length === 16, JSON.stringify(results.map((r) => (r && r.dropped) || r)));
  assert.strictEqual((await s2.run('other', async () => 'ok')).value, 'ok', 'another user is unaffected by the spammer');
  release(); await first;
  const err = await new UserSerializer().run('x', async () => { throw new Error('boom'); }).catch((e) => e.message);
  assert.strictEqual(err, 'boom');
});

test('admin overview: ONE aggregate per table on a single path, cached with single-flight (N admins share one computation)', async () => {
  const { pool } = require('../src/db/postgres');
  const stats = require('../src/lib/adminStats');
  stats._resetOverviewCache();
  let queries = 0;
  pool.query = async (sql) => {
    queries++; await sleep(10);
    if (/FROM users\s*$/.test(sql.trim())) return { rows: [{ users: 5000, active_today: 400, connected: 4000, blocked: 3, suspended: 1, new_today: 20, new_week: 90 }] };
    if (/FROM activity_log WHERE is_commit = TRUE\)/.test(sql)) return { rows: [{ commits: 123456, errors_today: 7 }] };
    return { rows: [{ avg: '3.5' }] };
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => stats.fleetOverview()));
  assert.ok(queries <= 4, `20 simultaneous opens issued ${queries} queries (expected ≤4 — one per aggregate — was 10 per open)`);
  assert.ok(results.every((r) => r === results[0]));
  assert.deepStrictEqual([results[0].totalUsers, results[0].activeToday, results[0].totalCommits, results[0].errorsToday, results[0].avgCommitsPerActiveUser], [5000, 400, 123456, 7, 3.5]);
  const before = queries; await stats.fleetOverview();
  assert.strictEqual(queries, before, 'a repeat within the TTL costs nothing');
});

test('BoundedMap: entry cap with LRU, weight cap, TTL sweep, and full Map compatibility', async () => {
  const { BoundedMap } = require('../src/lib/boundedMap');
  const m = new BoundedMap({ max: 3 });
  m.set('a', 1).set('b', 2).set('c', 3); m.get('a'); m.set('d', 4);
  assert.deepStrictEqual([...m.keys()].sort(), ['a', 'c', 'd'], 'b (least recently used) was evicted');
  assert.strictEqual(m.size, 3); assert.strictEqual(m.has('b'), false);
  for (let i = 0; i < 10000; i++) m.set(`k${i}`, i);
  assert.ok(m.size <= 3, 'never exceeds the cap');
  const w = new BoundedMap({ max: 100, maxWeight: 100, weight: (v) => v.n });
  for (let i = 0; i < 20; i++) w.set(`t${i}`, { n: 30 });
  assert.ok(w.totalWeight <= 100 && w.size <= 3, `weight ${w.totalWeight}, entries ${w.size}`);
  w.set('big', { n: 1000 });
  assert.ok(w.has('big') && w.size === 1, 'a single oversized entry is kept alone rather than looping forever');
  w.delete('big'); assert.strictEqual(w.totalWeight, 0);
  const t = new BoundedMap({ max: 10 });
  t.set('old', { timestamp: 1 }); t.set('new', { timestamp: Date.now() });
  assert.strictEqual(t.sweep((v) => Date.now() - v.timestamp > 1000), 1);
  assert.deepStrictEqual([...t.keys()], ['new']);
  let seen = 0; for (const k of t.keys()) { t.delete(k); seen++; } assert.strictEqual(seen, 1, 'deleting while iterating keys() is safe');
});

test('snapshot import: a column this version lacks (admin_moderation_protected) no longer aborts the import — it is skipped and reported; unknown tables are never truncated', async () => {
  const { pool } = require('../src/db/postgres');
  const mig = require('../src/lib/instanceMigration');
  const TARGET = { users: ['telegram_id', 'github_username', 'repos_protected', 'github_token_enc', 'disconnected_at'], activity_log: ['id', 'telegram_id', 'message'] };
  const run = async (snapshotTables, env) => {
    const queries = [];
    const client = { query: async (sql, params) => {
      queries.push({ sql, params });
      if (/information_schema/.test(sql) && !params) return { rows: [] }; // per-person table listing (stray-table sweep)
      if (/information_schema/.test(sql)) return { rows: (TARGET[params[0]] || []).map((c) => ({ column_name: c })) };
      if (/pg_get_serial_sequence/.test(sql)) return { rows: [{ seq: null }] };
      return { rows: [], rowCount: 0 };
    }, release() {} };
    pool.connect = async () => client;
    const old = process.env.IMPORT_COLUMN_ALIASES; if (env === undefined) delete process.env.IMPORT_COLUMN_ALIASES; else process.env.IMPORT_COLUMN_ALIASES = env;
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ version: 1, tables: snapshotTables })));
    const msgs = [];
    try { const r = await mig.importInstance(gz, 'a'.repeat(64), async (m) => { msgs.push(m); }); return { r, queries, msgs }; } finally { if (old === undefined) delete process.env.IMPORT_COLUMN_ALIASES; else process.env.IMPORT_COLUMN_ALIASES = old; }
  };
  const snap = { users: [{ telegram_id: 1, github_username: 'a', admin_moderation_protected: true, repos_protected: false, extra_future_col: 'x' }], ghost_table: [{ id: 1 }], activity_log: [{ id: 5, telegram_id: 1, message: 'hi' }] };

  const { r, queries, msgs } = await run(snap);
  const insertUsers = queries.find((q) => /^INSERT INTO users/.test(q.sql));
  assert.ok(insertUsers, 'the import proceeded');
  assert.ok(!/admin_moderation_protected|extra_future_col/.test(insertUsers.sql), 'unknown columns are not inserted');
  assert.deepStrictEqual(insertUsers.params, [1, 'a', false]);
  assert.ok(!queries.some((q) => /ghost_table/.test(q.sql) && /TRUNCATE|INSERT/.test(q.sql)), 'a table this version lacks is never touched');
  assert.deepStrictEqual(r.summary.skippedTables, ['ghost_table']);
  assert.deepStrictEqual(r.summary.skippedColumns.users, ['admin_moderation_protected', 'extra_future_col']);
  assert.deepStrictEqual(r.summary.safetyColumnsSkipped, ['users.admin_moderation_protected'], 'a dropped protection flag is called out, not hidden');
  assert.ok(msgs[msgs.length - 1].includes('safety-related'), 'the final progress message warns about it');

  // an explicit alias carries the value across instead of dropping it
  const aliased = await run({ users: [{ telegram_id: 2, admin_moderation_protected: true }] }, 'users.admin_moderation_protected=repos_protected');
  const ins = aliased.queries.find((q) => /^INSERT INTO users/.test(q.sql));
  assert.ok(/"repos_protected"/.test(ins.sql) && ins.params.includes(true), 'aliased onto repos_protected');
  assert.strictEqual(aliased.r.summary.safetyColumnsSkipped.length, 0);

  // a snapshot that matches the schema exactly behaves as before (nothing skipped)
  const exact = await run({ users: [{ telegram_id: 3, github_username: 'z' }] });
  assert.strictEqual(Object.keys(exact.r.summary.skippedColumns).length, 0);
  assert.strictEqual(exact.r.summary.skippedTables.length, 0);
});

(async () => {
  const keep = setInterval(() => {}, 1000);
  let failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); } catch (e) { failed++; console.log(`  ✗ ${n}\n      ${(e && e.stack ? e.stack : String(e)).split('\n').slice(0, 5).join('\n      ')}`); }
  }
  clearInterval(keep);
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
