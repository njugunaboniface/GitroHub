#!/usr/bin/env node
/**
 * traffic-tests.js (v1.2.1-multi) — behavioural tests for the GitHub traffic
 * layer (src/lib/githubTraffic). Runs offline with only Node's standard
 * library: requests go to a scriptable fake transport, timings use short real
 * timers (config objects are built directly so tests can use millisecond-scale
 * limits that the production clamps would not allow).
 *
 * Covers: concurrency bound + slot release, fairness, interactive/background
 * isolation, secondary-limit detection + Retry-After + backoff + jitter, no
 * retry storm, primary-limit guard, outage handling, mutation safety
 * (confirmed / failed / UNKNOWN), write ordering, circuit breaker, queue
 * overload + shedding, cancellation, coalescing + conditional cache.
 */
const assert = require('assert');
const config = require('../src/lib/githubTraffic/config');
const { GithubTrafficManager } = require('../src/lib/githubTraffic/manager');
const { classifyError, KIND, parseRetryAfterMs } = require('../src/lib/githubTraffic/classify');
const { computeBackoffMs } = require('../src/lib/githubTraffic/backoff');
const { createTraffic } = require('../src/lib/githubTraffic/index');
const { describeRequest } = require('../src/lib/githubTraffic/request');
const metrics = require('../src/lib/metrics');
const requestContext = require('../src/lib/requestContext');
const { FakeGitHub, makeOctokit, requestError, networkError, secondaryLimit, primaryLimit, sleep } = require('./lib/fakeGithub');

const base = config.load({});
const mkCfg = (over = {}) => ({
  ...base,
  maxConcurrency: 5, backgroundConcurrency: 2, perIdentityConcurrency: 5,
  maxQueueSize: 500, perUserMaxQueue: 500, queueTimeoutMs: 2000, backgroundQueueTimeoutMs: 5000,
  requestTimeoutMs: 500, retryMaxAttempts: 4, retryBaseDelayMs: 20, retryMaxDelayMs: 200, retryJitterMs: 20,
  maxRetryDurationMs: 5000, secondaryDefaultWaitMs: 200, maxAutoWaitMs: 2000, backgroundMaxAutoWaitMs: 5000,
  mutationMinIntervalMs: 0, cacheTtlMs: 5000, cacheMaxEntries: 50, breakerMinFailures: 4, breakerWindowMs: 5000,
  breakerCooldownMs: 300, aimdSuccessesPerStep: 5, backgroundAgingMs: 60000,
  ...over,
});
const mk = (over, deps) => new GithubTrafficManager(mkCfg(over), { logger: { info() {}, warn() {}, error() {} }, ...deps });
const meta = (u, extra = {}) => ({ identity: `id-${u}`, userId: u, priority: 'interactive', category: 'repo', operation: 'test', mutation: false, ...extra });
const ok = (extra = {}) => ({ status: 200, headers: { 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) }, data: {}, ...extra });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ═══════════════ pure pieces ═══════════════
test('config: every knob has a default, is clamped, and cross-field limits hold', () => {
  const c = config.load({ GITHUB_MAX_CONCURRENCY: '9999', GITHUB_BACKGROUND_CONCURRENCY: '0', GITHUB_RETRY_BASE_DELAY_MS: 'abc', GITHUB_PER_IDENTITY_CONCURRENCY: '70' });
  assert.strictEqual(c.maxConcurrency, 80, 'clamped to max');
  assert.strictEqual(c.backgroundConcurrency, 1, 'clamped to min');
  assert.strictEqual(c.retryBaseDelayMs, 500, 'invalid → default');
  assert.ok(c.perIdentityConcurrency <= c.maxConcurrency);
  assert.ok(base.maxConcurrency < 100, 'default stays far below GitHub\u2019s documented 100');
  assert.ok(config.describe().every((d) => d.purpose && d.env.startsWith('GITHUB_')));
});

test('classify: secondary vs primary vs permissions 403 is decided by more than the status code', () => {
  assert.strictEqual(classifyError(secondaryLimit(30)).kind, KIND.RATE_LIMIT_SECONDARY);
  assert.strictEqual(classifyError(secondaryLimit(30)).retryAfterMs, 30000);
  assert.strictEqual(classifyError(requestError(403, 'Forbidden', { 'retry-after': 5 })).kind, KIND.RATE_LIMIT_SECONDARY, 'bare Retry-After on 403');
  assert.strictEqual(classifyError(primaryLimit(2000000000)).kind, KIND.RATE_LIMIT_PRIMARY);
  assert.strictEqual(classifyError(requestError(403, 'Resource not accessible by integration')).kind, KIND.NON_RETRYABLE_GITHUB_ERROR);
  assert.strictEqual(classifyError(requestError(429, 'Too Many Requests', { 'x-ratelimit-remaining': 0 })).kind, KIND.RATE_LIMIT_PRIMARY);
  assert.strictEqual(classifyError(requestError(429, 'slow down')).kind, KIND.RATE_LIMIT_SECONDARY);
  assert.strictEqual(classifyError(requestError(502, 'Bad Gateway')).kind, KIND.RETRYABLE_GITHUB_ERROR);
  assert.strictEqual(classifyError(requestError(404, 'Not Found')).kind, KIND.NON_RETRYABLE_GITHUB_ERROR);
  assert.strictEqual(classifyError(requestError(422, 'Validation Failed')).kind, KIND.NON_RETRYABLE_GITHUB_ERROR);
});

test('classify: Octokit reports network failure as status 500 WITHOUT a response — that is NETWORK_ERROR, a real 500 is not', () => {
  assert.strictEqual(classifyError(networkError()).kind, KIND.NETWORK_ERROR);
  assert.strictEqual(classifyError(networkError('x', 'ECONNREFUSED')).notSent, true);
  assert.strictEqual(classifyError(networkError('x', 'ECONNRESET')).notSent, false, 'reset mid-flight may have been applied');
  assert.strictEqual(classifyError(requestError(500, 'boom')).kind, KIND.RETRYABLE_GITHUB_ERROR);
  assert.strictEqual(classifyError(new Error('t'), { timedOut: true }).kind, KIND.TIMEOUT);
  assert.strictEqual(classifyError(new Error('c'), { callerAborted: true }).kind, KIND.ABORTED);
});

test('Retry-After: seconds and HTTP-date both parse; garbage is ignored', () => {
  assert.strictEqual(parseRetryAfterMs('12'), 12000);
  assert.strictEqual(parseRetryAfterMs('0.2'), 200);
  assert.strictEqual(parseRetryAfterMs(new Date(Date.now() + 5000).toUTCString(), Date.now()) > 3000, true);
  assert.strictEqual(parseRetryAfterMs('soon'), null);
  assert.strictEqual(parseRetryAfterMs(undefined), null);
});

test('backoff: exponential, capped, jittered — and delays from one failure wave are NOT synchronized', () => {
  const p = { baseMs: 100, maxMs: 1600, jitterMs: 100 };
  const lo = [1, 2, 3, 4, 5, 6].map((a) => computeBackoffMs({ ...p, attempt: a, random: () => 0 }));
  const hi = [1, 2, 3, 4, 5, 6].map((a) => computeBackoffMs({ ...p, attempt: a, random: () => 1 }));
  assert.deepStrictEqual(lo, [50, 100, 200, 400, 800, 800], 'minimum is half the capped exponential');
  assert.deepStrictEqual(hi, [200, 300, 500, 900, 1700, 1700], 'maximum adds the full jitter');
  const wave = new Set(Array.from({ length: 200 }, () => computeBackoffMs({ ...p, attempt: 3 })));
  assert.ok(wave.size > 100, `200 retries should spread over many distinct instants, got ${wave.size}`);
});

test('describeRequest: category, write/read, repo key and parallel-safety; endpoint label never carries repo names or file paths', () => {
  const a = describeRequest({ method: 'PUT', url: '/repos/{owner}/{repo}/contents/{path}', owner: 'Alice', repo: 'Secret-Repo', path: 'src/x.js' });
  assert.deepStrictEqual([a.category, a.mutation, a.repoKey], ['file', true, 'alice/secret-repo']);
  assert.ok(!/alice|secret/i.test(a.endpoint) && !/x\.js/.test(a.endpoint), a.endpoint);
  const b = describeRequest({ method: 'POST', url: '/repos/o/r/git/blobs' });
  assert.strictEqual(b.parallelSafe, true);
  assert.strictEqual(describeRequest({ method: 'POST', url: '/repos/o/r/git/commits' }).parallelSafe, false);
  assert.strictEqual(describeRequest({ method: 'GET', url: 'https://api.github.com/user/repos?per_page=100&page=2' }).category, 'repo');
  assert.strictEqual(describeRequest({ method: 'GET', url: '/search/code' }).resource, 'search');
  assert.strictEqual(describeRequest({ method: 'DELETE', url: '/repos/{owner}/{repo}', owner: 'a', repo: 'b' }).mutation, true);
});

test('metrics: label cardinality is capped, secret-looking labels are dropped, Prometheus text renders', () => {
  metrics.reset();
  const c = metrics.counter('t_cardinality', 'x');
  for (let i = 0; i < metrics.MAX_SERIES + 50; i++) c.inc({ user: `u${i}` });
  assert.ok(c.series.size <= metrics.MAX_SERIES + 1, `series ${c.size}`);
  const g = metrics.gauge('t_secret', 'x');
  g.set({ token: 'ghp_SECRET', authorization: 'Bearer x', ok: 'fine' }, 1);
  const text = metrics.renderPrometheus();
  assert.ok(!/ghp_SECRET|Bearer/.test(text), 'secrets never reach metrics');
  assert.ok(/t_secret\{ok="fine"\} 1/.test(text));
});

// ═══════════════ concurrency, slots ═══════════════
test('limiter: in-flight never exceeds the ceiling, everything completes, nothing leaks', async () => {
  const m = mk();
  let active = 0; let peak = 0;
  const run = async () => { active++; peak = Math.max(peak, active); await sleep(4); active--; return ok(); };
  await Promise.all(Array.from({ length: 120 }, (_, i) => m.schedule(meta(i % 12), run)));
  assert.ok(peak <= 5, `peak ${peak}`);
  assert.ok(peak >= 4, `should actually use the capacity, peak ${peak}`);
  const s = m.getSnapshot();
  assert.strictEqual(s.active, 0);
  assert.strictEqual(s.queued, 0);
});

test('limiter: a hung request (ignores its abort signal) is timed out, the slot is released, and nothing becomes an unhandled rejection', async () => {
  const m = mk({ maxConcurrency: 1, perIdentityConcurrency: 1, requestTimeoutMs: 80, retryMaxAttempts: 1 });
  let unhandled = 0; const h = () => { unhandled++; }; process.on('unhandledRejection', h);
  const hung = () => new Promise(() => {}); // never settles, ignores the signal
  const t0 = Date.now();
  await assert.rejects(m.schedule(meta(1), hung), (e) => /timed out/.test(e.message));
  assert.ok(Date.now() - t0 < 400);
  assert.strictEqual(m.getSnapshot().active, 0, 'slot released');
  assert.deepStrictEqual((await m.schedule(meta(1), async () => ok())).status, 200, 'the pool still works');
  const thrower = () => { throw new Error('sync boom'); };
  await assert.rejects(m.schedule(meta(1), thrower), /sync boom/);
  assert.strictEqual(m.getSnapshot().active, 0);
  await sleep(20); process.off('unhandledRejection', h);
  assert.strictEqual(unhandled, 0);
});

// ═══════════════ fairness / isolation ═══════════════
test('fairness: one user queueing 60 requests cannot starve three normal users', async () => {
  const m = mk({ maxConcurrency: 2, perIdentityConcurrency: 2, backgroundConcurrency: 1 });
  const order = [];
  const run = (tag) => async () => { await sleep(6); order.push(tag); return ok(); };
  const all = [];
  for (let i = 0; i < 60; i++) all.push(m.schedule(meta('A'), run('A')));
  for (const u of ['B', 'C', 'D']) all.push(m.schedule(meta(u), run(u)));
  await Promise.all(all);
  const pos = ['B', 'C', 'D'].map((u) => order.indexOf(u));
  assert.ok(Math.max(...pos) < 12, `B/C/D finished at positions ${pos} of ${order.length} — they were starved`);
});

test('isolation: a secondary-limit pause on ONE identity does not slow anyone else', async () => {
  const m = mk({ secondaryDefaultWaitMs: 400 });
  let xCalls = 0;
  const xRun = async () => { xCalls++; if (xCalls === 1) throw secondaryLimit('0.3'); return ok(); };
  const t0 = Date.now();
  const x = m.schedule(meta('X'), xRun);
  const yTimes = [];
  for (let i = 0; i < 10; i++) { await m.schedule(meta('Y'), async () => { await sleep(5); return ok(); }); yTimes.push(Date.now() - t0); }
  assert.ok(yTimes[9] < 250, `Y finished 10 calls in ${yTimes[9]}ms while X was paused`);
  await x;
  assert.ok(Date.now() - t0 >= 280, 'X waited out Retry-After');
  assert.strictEqual(xCalls, 2);
});

test('background isolation: background work never exceeds its slice, interactive stays fast', async () => {
  const m = mk({ maxConcurrency: 6, backgroundConcurrency: 2 });
  let bg = 0; let bgPeak = 0;
  const bgRun = async () => { bg++; bgPeak = Math.max(bgPeak, bg); await sleep(25); bg--; return ok(); };
  const bgJobs = Array.from({ length: 30 }, (_, i) => m.schedule(meta(`bg${i % 3}`, { priority: 'background' }), bgRun));
  await sleep(5);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 6 }, (_, i) => m.schedule(meta(`iu${i}`), async () => { await sleep(5); return ok(); })));
  assert.ok(Date.now() - t0 < 80, `interactive waited ${Date.now() - t0}ms behind background`);
  await Promise.all(bgJobs);
  assert.ok(bgPeak <= 2, `background peak ${bgPeak}`);
});

test('anti-starvation: an old background request still gets a slot while interactive traffic is constant', async () => {
  const m = mk({ maxConcurrency: 1, perIdentityConcurrency: 1, backgroundConcurrency: 1, backgroundAgingMs: 60 });
  const done = [];
  const bgP = m.schedule(meta('bg', { priority: 'background' }), async () => { done.push('bg'); return ok(); });
  const flood = [];
  for (let i = 0; i < 30; i++) flood.push(m.schedule(meta(`u${i}`), async () => { await sleep(8); done.push('i'); return ok(); }));
  await Promise.all([bgP, ...flood]);
  assert.ok(done.indexOf('bg') < 25, `background ran at position ${done.indexOf('bg')} of ${done.length}`);
});

// ═══════════════ secondary limits / retry storm ═══════════════
test('secondary limit: Retry-After is respected exactly once (no early retry), then the request succeeds', async () => {
  const m = mk();
  const starts = [];
  const run = async () => { starts.push(Date.now()); if (starts.length === 1) throw secondaryLimit('0.25'); return ok(); };
  const res = await m.schedule(meta(1), run);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 240, `retried after ${starts[1] - starts[0]}ms; Retry-After was 250ms`);
  const snap = m.getSnapshot();
  assert.strictEqual(snap.totals.secondary, 1);
  assert.strictEqual(snap.totals.retries, 1);
});

test('retry storm: after a pause the lane PROBES with one request instead of releasing its whole backlog at once', async () => {
  const m = mk({ perIdentityConcurrency: 5, maxConcurrency: 5 });
  const starts = [];
  let first = true;
  const run = async () => {
    starts.push(Date.now());
    if (first) { first = false; await sleep(10); throw secondaryLimit('0.2'); }
    await sleep(40);
    return ok();
  };
  await Promise.all(Array.from({ length: 6 }, () => m.schedule(meta('S'), run)));
  // 6 started together initially (5 slots + the burst), one was rejected; AFTER the pause only a probe may start first.
  const resumeAt = starts[0] + 10 + 200;
  const afterPause = starts.filter((t) => t >= resumeAt - 20);
  const firstWave = afterPause.filter((t) => t - afterPause[0] < 15).length;
  assert.ok(firstWave <= 2, `${firstWave} requests started in the first instant after the pause (expected a probe)`);
});

test('retry storm: against a GitHub that rejects bursts, total rejections stay small and EVERY request still completes', async () => {
  const m = mk({ maxConcurrency: 12, perIdentityConcurrency: 12, aimdSuccessesPerStep: 1000, retryMaxAttempts: 6 });
  let inflight = 0; let rejections = 0; let calls = 0;
  const run = async () => {
    calls++;
    inflight++;
    try {
      if (inflight > 3) { rejections++; throw secondaryLimit('0.1'); }
      await sleep(15);
      return ok();
    } finally { inflight--; }
  };
  const results = await Promise.allSettled(Array.from({ length: 60 }, () => m.schedule(meta('burst'), run)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  assert.strictEqual(failed, 0, `${failed} operations were lost`);
  assert.ok(rejections <= 14, `${rejections} rejections for 60 requests — retries amplified instead of damping`);
  assert.ok(calls <= 60 + 14, `${calls} calls total`);
});

test('global AIMD: secondary limits on three DIFFERENT identities lower the global ceiling; successes raise it again', async () => {
  const m = mk({ maxConcurrency: 8, aimdSuccessesPerStep: 3 });
  const before = m.limit;
  const hit = (u) => { let n = 0; return m.schedule(meta(u), async () => { if (++n === 1) throw secondaryLimit('0.05'); return ok(); }); };
  await Promise.all([hit('a'), hit('b'), hit('c')]);
  assert.ok(m.limit < before, `limit ${m.limit} should be below ${before}`);
  const lowered = m.limit;
  m.lastGlobalCut = Date.now() - 20000;
  await Promise.all(Array.from({ length: 30 }, (_, i) => m.schedule(meta(`ok${i % 4}`), async () => ok())));
  assert.ok(m.limit > lowered, `limit should recover, ${lowered} → ${m.limit}`);
});

// ═══════════════ primary limits ═══════════════
test('primary limit: once quota hits 0 with a far reset, new requests fail LOCALLY (GitHub is not hammered) with an error the UI already understands', async () => {
  const m = mk();
  let calls = 0;
  const resetAt = Math.floor(Date.now() / 1000) + 3000;
  await m.schedule(meta('P'), async () => { calls++; return { status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(resetAt) }, data: {} }; });
  const err = await m.schedule(meta('P'), async () => { calls++; return ok(); }).catch((e) => e);
  assert.strictEqual(calls, 1, 'no second request reached GitHub');
  assert.strictEqual(err.status, 403);
  assert.ok(/rate limit/i.test(err.message) && !/secondary/i.test(err.message), err.message);
  assert.ok(Number(err.response.headers['x-ratelimit-reset']) >= resetAt - 2);
  assert.strictEqual(err.outcome, 'failed');
  // someone else is unaffected
  assert.strictEqual((await m.schedule(meta('Q'), async () => ok())).status, 200);
  assert.ok(m.getRateLimit('id-P').remaining === 0);
});

test('primary limit: a short wait is waited out transparently', async () => {
  const m = mk();
  const resetAt = Math.floor(Date.now() / 1000) + 1; // ≤ ~2s
  let n = 0;
  const res = await m.schedule(meta('W'), async () => { n++; if (n === 1) throw primaryLimit(resetAt); return ok(); });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(n, 2);
});

// ═══════════════ outage handling ═══════════════
test('reads: 5xx / network errors / timeouts are retried with backoff, then fail truthfully', async () => {
  const m = mk({ retryMaxAttempts: 3 });
  let n = 0;
  assert.strictEqual((await m.schedule(meta(1), async () => { if (++n < 3) throw requestError(503, 'unavailable'); return ok(); })).status, 200);
  assert.strictEqual(n, 3);
  let k = 0;
  const err = await m.schedule(meta(1), async () => { k++; throw requestError(502, 'bad gateway'); }).catch((e) => e);
  assert.strictEqual(k, 3, 'bounded attempts');
  assert.strictEqual(err.status, 502);
  assert.strictEqual(err.outcome, 'failed', 'a failed READ is simply failed — nothing was changed');
  let net = 0;
  assert.strictEqual((await m.schedule(meta(1), async () => { if (++net < 2) throw networkError(); return ok(); })).status, 200);
  let to = 0;
  const m2 = mk({ retryMaxAttempts: 2, requestTimeoutMs: 60 });
  const res = await m2.schedule(meta(1), (signal) => new Promise((resolve, reject) => { to++; if (to === 1) { signal.addEventListener('abort', () => reject(networkError('aborted'))); } else resolve(ok()); }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(to, 2);
});

test('retries are bounded in TIME too (maxRetryDuration), not just in count', async () => {
  const m = mk({ retryMaxAttempts: 50, retryBaseDelayMs: 50, retryMaxDelayMs: 100, maxRetryDurationMs: 300 });
  let n = 0; const t0 = Date.now();
  await m.schedule(meta(1), async () => { n++; throw requestError(500, 'x'); }).catch(() => {});
  assert.ok(Date.now() - t0 < 800, `retried for ${Date.now() - t0}ms`);
  assert.ok(n < 12, `${n} attempts`);
});

// ═══════════════ mutation safety ═══════════════
test('mutations: confirmed success / confirmed failure / UNKNOWN are distinguished, and unknown writes are never blindly retried', async () => {
  const m = mk();
  const W = (extra) => meta(1, { mutation: true, repoKey: 'o/r', category: 'file', ...extra });
  // confirmed success
  assert.strictEqual((await m.schedule(W(), async () => ok())).status, 200);
  // confirmed failure (4xx — GitHub answered and refused)
  let calls = 0;
  const e422 = await m.schedule(W(), async () => { calls++; throw requestError(422, 'Validation Failed'); }).catch((e) => e);
  assert.strictEqual(e422.outcome, 'failed'); assert.strictEqual(calls, 1);
  // 5xx on a write: it MAY have been applied → unknown, exactly one attempt
  calls = 0;
  const e502 = await m.schedule(W(), async () => { calls++; throw requestError(502, 'Bad Gateway'); }).catch((e) => e);
  assert.strictEqual(e502.outcome, 'unknown'); assert.strictEqual(e502.code, 'GITHUB_OUTCOME_UNKNOWN'); assert.strictEqual(calls, 1, 'NOT retried');
  // timeout on a write → unknown, exactly one attempt
  const m2 = mk({ requestTimeoutMs: 60 });
  calls = 0;
  const eT = await m2.schedule(W(), () => { calls++; return new Promise(() => {}); }).catch((e) => e);
  assert.strictEqual(eT.outcome, 'unknown'); assert.strictEqual(calls, 1);
  // connection dropped mid-flight → unknown
  calls = 0;
  const eN = await m.schedule(W(), async () => { calls++; throw networkError('socket hang up', 'ECONNRESET'); }).catch((e) => e);
  assert.strictEqual(eN.outcome, 'unknown'); assert.strictEqual(calls, 1);
  assert.ok(m.getSnapshot().totals.unknownOutcomes >= 2);
});

test('mutations: failures that PROVE nothing was applied (never connected, or GitHub rate-limited it) ARE retried safely', async () => {
  const m = mk();
  const W = () => meta(1, { mutation: true, repoKey: 'o/r', category: 'repo' });
  let a = 0;
  assert.strictEqual((await m.schedule(W(), async () => { if (++a < 3) throw networkError('connect', 'ECONNREFUSED'); return ok(); })).status, 200);
  assert.strictEqual(a, 3);
  let b = 0;
  assert.strictEqual((await m.schedule(W(), async () => { if (++b < 2) throw secondaryLimit('0.05'); return ok(); })).status, 200);
  assert.strictEqual(b, 2, 'a rate-limited write is retried exactly once more, after the pause');
});

test('mutations: writes to one repo are serialized and in order; other repos and content-addressed blobs run in parallel', async () => {
  const m = mk({ maxConcurrency: 8, perIdentityConcurrency: 8 });
  const track = () => { const s = { active: 0, peak: 0, order: [] }; return s; };
  const run = (s, tag) => async () => { s.active++; s.peak = Math.max(s.peak, s.active); s.order.push(tag); await sleep(12); s.active--; return ok(); };
  const same = track();
  await Promise.all([0, 1, 2, 3, 4].map((i) => m.schedule(meta(1, { mutation: true, repoKey: 'o/same', category: 'file' }), run(same, i))));
  assert.strictEqual(same.peak, 1);
  assert.deepStrictEqual(same.order, [0, 1, 2, 3, 4], 'submission order preserved');
  const diff = track();
  await Promise.all([0, 1, 2, 3].map((i) => m.schedule(meta(1, { mutation: true, repoKey: `o/r${i}`, category: 'file' }), run(diff, i))));
  assert.ok(diff.peak >= 3, `different repos should overlap, peak ${diff.peak}`);
  const blobs = track();
  await Promise.all([0, 1, 2, 3, 4, 5].map((i) => m.schedule(meta(1, { mutation: true, parallelSafe: true, repoKey: 'o/same', category: 'git' }), run(blobs, i))));
  assert.ok(blobs.peak >= 4, `blobs should overlap, peak ${blobs.peak}`);
});

test('mutations: write pacing spaces writes of one identity apart', async () => {
  const m = mk({ mutationMinIntervalMs: 40 });
  const starts = [];
  await Promise.all([0, 1, 2].map((i) => m.schedule(meta(1, { mutation: true, repoKey: `o/r${i}` }), async () => { starts.push(Date.now()); return ok(); })));
  starts.sort((a, b) => a - b);
  assert.ok(starts[1] - starts[0] >= 35 && starts[2] - starts[1] >= 35, `gaps ${starts[1] - starts[0]}, ${starts[2] - starts[1]}`);
});

// ═══════════════ breaker / overload / cancellation ═══════════════
test('circuit breaker: GitHub-wide failures open it (background stops, interactive only probes), then it recovers via half-open', async () => {
  const m = mk({ retryMaxAttempts: 1, breakerCooldownMs: 250, breakerMinFailures: 4 });
  for (let i = 0; i < 6; i++) await m.schedule(meta(i % 2 ? 'a' : 'b'), async () => { throw requestError(503, 'down'); }).catch(() => {});
  assert.strictEqual(m.breaker.current(), 'OPEN');
  assert.ok(['DEGRADED', 'OVERLOADED'].includes(m.getState()));
  let bgRan = false;
  const bg = m.schedule(meta('bg', { priority: 'background' }), async () => { bgRan = true; return ok(); });
  await sleep(100);
  assert.strictEqual(bgRan, false, 'background held back while open');
  await sleep(200); // cooldown → HALF_OPEN
  assert.strictEqual(m.breaker.current(), 'HALF_OPEN');
  for (let i = 0; i < 3; i++) await m.schedule(meta('a'), async () => ok());
  assert.strictEqual(m.breaker.current(), 'CLOSED');
  await bg;
  assert.strictEqual(bgRan, true);
});

test('circuit breaker scope: ONE identity failing alone does not open the shared breaker while others are healthy', async () => {
  const m = mk({ retryMaxAttempts: 1, breakerMinFailures: 4 });
  for (let i = 0; i < 4; i++) await m.schedule(meta('ok'), async () => ok());
  for (let i = 0; i < 8; i++) await m.schedule(meta('bad'), async () => { throw requestError(500, 'repo-specific'); }).catch(() => {});
  assert.strictEqual(m.breaker.current(), 'CLOSED');
});

test('overload: queue is bounded, background is shed first, interactive makes room, state is reported, and it drains', async () => {
  const m = mk({ maxConcurrency: 1, perIdentityConcurrency: 1, backgroundConcurrency: 1, maxQueueSize: 20, perUserMaxQueue: 20 });
  let release; const gate = new Promise((r) => { release = r; });
  const blocker = m.schedule(meta('blk'), async () => { await gate; return ok(); });
  await sleep(5);
  const bgs = Array.from({ length: 15 }, (_, i) => m.schedule(meta(`b${i % 5}`, { priority: 'background' }), async () => ok()).catch((e) => e));
  const ints = Array.from({ length: 5 }, (_, i) => m.schedule(meta(`i${i}`), async () => ok()));
  assert.strictEqual(m.getSnapshot().queued, 20);
  assert.strictEqual(m.getState(), 'OVERLOADED');
  const extraBg = await m.schedule(meta('late', { priority: 'background' }), async () => ok()).catch((e) => e);
  assert.strictEqual(extraBg.code, 'GITHUB_OVERLOADED');
  const extraInt = m.schedule(meta('vip'), async () => ok()); // interactive pushes a background job out
  await sleep(5);
  assert.ok(m.getSnapshot().queued <= 20, 'queue stays bounded');
  release();
  await Promise.all([blocker, ...ints, extraInt]);
  const settled = await Promise.all(bgs);
  assert.ok(settled.some((r) => r && r.code === 'GITHUB_OVERLOADED'), 'a background job was shed for the interactive one');
  assert.notStrictEqual(m.getState(), 'OVERLOADED');
  assert.strictEqual(m.getSnapshot().queued, 0);
  assert.ok(m.getSnapshot().totals.shed >= 2);
});

test('per-user queue cap: one user flooding the queue is refused truthfully, others unaffected', async () => {
  const m = mk({ maxConcurrency: 1, perIdentityConcurrency: 1, perUserMaxQueue: 5 });
  let release; const gate = new Promise((r) => { release = r; });
  const first = m.schedule(meta('flood'), async () => { await gate; return ok(); });
  await sleep(5);
  const res = await Promise.all(Array.from({ length: 9 }, () => m.schedule(meta('flood'), async () => ok()).then(() => 'ok', (e) => e.code)));
  assert.strictEqual(res.filter((r) => r === 'GITHUB_USER_QUEUE_FULL').length, 4);
  const other = m.schedule(meta('other'), async () => ok());
  release(); await first; assert.strictEqual((await other).status, 200);
});

test('queue timeout: a request stuck behind a busy pool fails truthfully with outcome "failed" (nothing was sent)', async () => {
  const m = mk({ maxConcurrency: 1, perIdentityConcurrency: 1, queueTimeoutMs: 80 });
  let release; const gate = new Promise((r) => { release = r; });
  const blocker = m.schedule(meta('a'), async () => { await gate; return ok(); });
  await sleep(5);
  let ran = false;
  const err = await m.schedule(meta('b', { mutation: true, repoKey: 'o/r' }), async () => { ran = true; return ok(); }).catch((e) => e);
  assert.strictEqual(err.code, 'GITHUB_QUEUE_TIMEOUT'); assert.strictEqual(err.outcome, 'failed'); assert.strictEqual(ran, false);
  assert.ok(/busy/i.test(err.message));
  release(); await blocker;
});

test('cancellation: aborting a queued request removes it; aborting an active one frees its slot', async () => {
  const m = mk({ maxConcurrency: 1, perIdentityConcurrency: 1 });
  const c1 = new AbortController(); const c2 = new AbortController();
  let r2ran = false;
  const active = m.schedule({ ...meta('a'), signal: c1.signal }, (signal) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(networkError('aborted'))); }));
  await sleep(5);
  const queued = m.schedule({ ...meta('b'), signal: c2.signal }, async () => { r2ran = true; return ok(); });
  c2.abort();
  await assert.rejects(queued, (e) => e.name === 'AbortError');
  assert.strictEqual(m.getSnapshot().queued, 0);
  c1.abort();
  await assert.rejects(active, (e) => e.name === 'AbortError');
  assert.strictEqual(m.getSnapshot().active, 0, 'slot freed');
  assert.strictEqual(r2ran, false);
  assert.strictEqual((await m.schedule(meta('c'), async () => ok())).status, 200);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(m.schedule({ ...meta('d'), signal: pre.signal }, async () => ok()), (e) => e.name === 'AbortError');
});

test('owner controls: pausing background work holds it without touching interactive; tune() takes effect live', async () => {
  const m = mk();
  m.setBackgroundPaused(true);
  const err = await m.schedule(meta('b', { priority: 'background' }), async () => ok()).catch((e) => e);
  assert.strictEqual(err.code, 'GITHUB_OVERLOADED');
  assert.strictEqual((await m.schedule(meta('i'), async () => ok())).status, 200);
  m.setBackgroundPaused(false);
  assert.strictEqual((await m.schedule(meta('b', { priority: 'background' }), async () => ok())).status, 200);
  m.tune({ maxConcurrency: 2 });
  assert.strictEqual(m.limit, 2);
});

// ═══════════════ hook level: coalescing + conditional cache + isolation ═══════════════
function hooked(over = {}) {
  const gh = new FakeGitHub();
  const Octokit = makeOctokit(gh);
  const traffic = createTraffic(mkCfg(over), { logger: { info() {}, warn() {}, error() {} } });
  const client = (token) => { const o = new Octokit({ auth: token }); traffic.installHook(o, token); return o; };
  return { gh, traffic, client };
}

test('coalescing: identical in-flight GETs from one identity share ONE request; a different identity never shares', async () => {
  const { gh, client, traffic } = hooked();
  gh.latencyMs = 30;
  gh.on('GET /repos/{owner}/{repo}', async () => ({ data: { name: 'r' }, headers: { etag: 'W/"1"', 'content-length': '10' } }));
  const a = client('tokA'); const b = client('tokB');
  const rs = await Promise.all([a.repos.get({ owner: 'o', repo: 'r' }), a.repos.get({ owner: 'o', repo: 'r' }), a.repos.get({ owner: 'o', repo: 'r' }), b.repos.get({ owner: 'o', repo: 'r' })]);
  assert.strictEqual(gh.calls.length, 2, `expected 1 for A + 1 for B, got ${gh.calls.length}`);
  assert.strictEqual(traffic.manager.getSnapshot().totals.coalesced, 2);
  assert.ok(rs.every((r) => r.data.name === 'r'));
});

test('coalescing: a write to the repo invalidates sharing — a read after a write is never served a pre-write result', async () => {
  const { gh, client } = hooked();
  gh.latencyMs = 20;
  let name = 'old';
  gh.on('GET /repos/{owner}/{repo}', async () => ({ data: { name } }));
  gh.on('PATCH /repos/{owner}/{repo}', async () => { name = 'new'; return { data: { name } }; });
  const a = client('tokA');
  const readBefore = a.repos.get({ owner: 'o', repo: 'r' });
  await sleep(2);
  const write = a.repos.update({ owner: 'o', repo: 'r', name: 'new' });
  await Promise.all([readBefore, write]);
  const readAfter = await a.repos.get({ owner: 'o', repo: 'r' });
  assert.strictEqual(readAfter.data.name, 'new');
});

test('conditional cache: repeat metadata reads within the TTL cost nothing; after it a 304 costs no quota; writes bust it; users never share entries', async () => {
  const { gh, client, traffic } = hooked({ cacheTtlMs: 60 });
  let etagHits = 0; let version = 1;
  gh.on('GET /repos/{owner}/{repo}', async (opts) => {
    const inm = opts.headers && (opts.headers['if-none-match'] || opts.headers['If-None-Match']);
    if (inm === `"v${version}"`) { etagHits++; throw requestError(304, 'Not modified', {}); }
    return { data: { name: 'r', version }, headers: { etag: `"v${version}"`, 'content-length': '20' } };
  });
  gh.on('PATCH /repos/{owner}/{repo}', async () => { version++; return { data: {} }; });
  const a = client('tokA'); const b = client('tokB');
  await a.repos.get({ owner: 'o', repo: 'r' });
  await a.repos.get({ owner: 'o', repo: 'r' });
  assert.strictEqual(gh.calls.length, 1, 'second read served from the fresh cache');
  await sleep(80);
  const r3 = await a.repos.get({ owner: 'o', repo: 'r' });
  assert.strictEqual(gh.calls.length, 2); assert.strictEqual(etagHits, 1, 'revalidated with If-None-Match');
  assert.strictEqual(r3.data.version, 1);
  await a.repos.update({ owner: 'o', repo: 'r', description: 'x' });
  const r4 = await a.repos.get({ owner: 'o', repo: 'r' });
  assert.strictEqual(r4.data.version, 2, 'a write invalidates freshness');
  await b.repos.get({ owner: 'o', repo: 'r' });
  assert.ok(gh.calls.filter((c) => c.token === 'tokB').length === 1, 'B did not receive A\u2019s cached private data');
  const clone = await a.repos.get({ owner: 'o', repo: 'r' });
  clone.data.name = 'MUTATED';
  assert.strictEqual((await a.repos.get({ owner: 'o', repo: 'r' })).data.name, 'r', 'callers cannot poison the cache');
  assert.ok(traffic.manager.getSnapshot().totals.cacheHits >= 2);
});

test('hook: context (user, priority, operation) flows into the request; background context is honoured', async () => {
  const { gh, client, traffic } = hooked({ backgroundConcurrency: 1 });
  const a = client('tokA');
  const seen = [];
  const orig = traffic.manager.schedule.bind(traffic.manager);
  traffic.manager.schedule = (m, run) => { seen.push({ user: m.userId, priority: m.priority, op: m.operation, parent: m.parentId }); return orig(m, run); };
  await requestContext.runOperation({ userId: 42, operation: 'Browse files' }, () => a.users.getAuthenticated());
  await requestContext.runBackground('poller', () => a.users.getAuthenticated(), 7);
  assert.strictEqual(seen[0].user, 42); assert.strictEqual(seen[0].priority, 'interactive'); assert.strictEqual(seen[0].op, 'Browse files'); assert.ok(/^op_/.test(seen[0].parent));
  assert.strictEqual(seen[1].priority, 'background'); assert.strictEqual(seen[1].user, 7);
  assert.strictEqual(gh.calls.length, 2);
});

test('request context never leaks between concurrent operations', async () => {
  const seen = [];
  await Promise.all([1, 2, 3, 4, 5].map((u) => requestContext.runOperation({ userId: u }, async () => { await sleep(Math.random() * 10); seen.push([u, requestContext.current().userId]); })));
  assert.ok(seen.every(([a, b]) => a === b));
});

test('logs and metrics contain no tokens: a failing request with an Authorization header is logged without it', async () => {
  const lines = [];
  const logger = { info: (...a) => lines.push(JSON.stringify(a)), warn: (...a) => lines.push(JSON.stringify(a)), error: (...a) => lines.push(JSON.stringify(a)) };
  const m = new GithubTrafficManager(mkCfg({ retryMaxAttempts: 1 }), { logger });
  const err = requestError(500, 'boom'); err.request = { headers: { authorization: 'token ghp_TOPSECRET' } };
  await m.schedule({ ...meta('s'), endpoint: '/repos/:owner/:repo', method: 'GET' }, async () => { throw err; }).catch(() => {});
  const text = lines.join('\n') + metrics.renderPrometheus() + JSON.stringify(m.getSnapshot());
  assert.ok(!/ghp_TOPSECRET|authorization/i.test(text));
  assert.ok(lines.length >= 1 && /ghreq_/.test(lines[0]), 'every request has a correlation id in its log line');
});

// ═══════════════ admin screen ═══════════════
/** Is `text` valid Telegram MarkdownV2? Every reserved char must be escaped, outside *bold* spans which must balance. */
function assertValidMarkdownV2(text) {
  const RESERVED = '_*[]()~`>#+-=|{}.!';
  let i = 0; let boldOpen = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '>' && (i === 0 || text[i - 1] === '\n')) { i++; continue; } // blockquote line
    if (c === '*') { boldOpen = !boldOpen; i++; continue; }
    assert.ok(!RESERVED.includes(c), `unescaped '${c}' at ${i}: …${text.slice(Math.max(0, i - 25), i + 25)}…`);
    i++;
  }
  assert.ok(!boldOpen, 'unbalanced *bold*');
}

test('GitHub Traffic screen is valid MarkdownV2 in EVERY state (a single unescaped # made Telegram reject the whole message)', () => {
  const { render } = require('../src/lib/githubTrafficView');
  const win = { req: 1200, ok: 1100, fail: 40, retry: 12, timeout: 3, sec: 5, pri: 1, shed: 7, unknown: 2, avgQueueWaitMs: 45, avgDurationMs: 130 };
  const full = {
    state: 'DEGRADED', since: Date.now() - 125000, active: 12, limit: 10, maxConcurrency: 20, backgroundActive: 1, backgroundConcurrency: 4,
    queued: 33, maxQueue: 500, queuedInteractive: 30, queuedBackground: 3, backgroundPaused: true,
    breaker: { state: 'OPEN', retryInMs: 8000, opens: 2 }, lanes: 9, pausedLanes: 2,
    pausedList: [{ user: 123456789, resumeInMs: 42000, strikes: 2 }, { user: 'id:ab12cd34', resumeInMs: 3600000, strikes: 1 }],
    lowestRemaining: { core: { remaining: 12, limit: 5000, resetAt: Date.now() + 1000 } },
    totals: { coalesced: 10, cacheHits: 5 }, lastHour: win, lastFiveMinutes: win,
    topConsumers: [{ user: 111, requests: 400, writes: 20, secondaryLimits: 3, shed: 1 }, { user: 'id:xyz', requests: 50, writes: 0, secondaryLimits: 0, shed: 0 }],
  };
  assertValidMarkdownV2(render(full));
  const quiet = { ...full, state: 'NORMAL', limit: 20, backgroundPaused: false, breaker: { state: 'CLOSED', retryInMs: 0, opens: 0 }, pausedLanes: 0, pausedList: [], lowestRemaining: {}, topConsumers: [], lastHour: { ...win, unknown: 0 }, lastFiveMinutes: { ...win, unknown: 0 } };
  assertValidMarkdownV2(render(quiet));
  assert.ok(/\\#111/.test(render(full)), 'user ids are shown with an escaped #');
});

// ═══════════════ run ═══════════════
(async () => {
  // The manager's timers are unref'd on purpose (they must never keep a production process alive);
  // in a test process nothing else would, so hold the loop open ourselves.
  const keepAlive = setInterval(() => {}, 1000);
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n      ${(err && err.stack ? err.stack : String(err)).split('\n').slice(0, 5).join('\n      ')}`);
    }
  }
  clearInterval(keepAlive);
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
