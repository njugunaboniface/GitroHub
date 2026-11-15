#!/usr/bin/env node
/**
 * load-test.js (v1.2.1-multi) — progressive concurrent-user load test of the
 * REAL src/lib/github.js + traffic manager against a fake GitHub that behaves
 * like the real one under pressure:
 *
 *   • per-request latency is log-normal (median ≈ LATENCY_MS, long tail),
 *   • GitHub's secondary limit is modelled: too many requests in flight FOR
 *     ONE TOKEN, or too many in flight overall, are answered with
 *     403 + Retry-After instead of being served,
 *   • occasional 502s on reads.
 *
 * Each virtual user has their OWN token (as in production) and runs a
 * realistic operation mix: list repos, open repo, browse files, read file,
 * edit file, create repo, languages. Reports per step: latency percentiles,
 * throughput, queue wait, retries, secondary-limit events, errors, peak
 * concurrency, event-loop lag, memory — and, with --baseline, the same run
 * WITHOUT the traffic layer for comparison.
 *
 *   node scripts/load-test.js                 # 10 25 50 100 250 500 1000 users
 *   node scripts/load-test.js 10 100 500      # chosen steps
 *   node scripts/load-test.js --baseline 250  # also run unmanaged for comparison
 *
 * NOTE: this measures the bot's own traffic layer and event loop in-process
 * against a model of GitHub. It cannot measure real GitHub, Postgres, Redis or
 * Telegram latency — see docs/LOAD_TESTING.md for what to run against staging.
 */
const SCALE = Number(process.env.LOAD_TIME_SCALE) || 1; // >1 = slower fake GitHub
const LATENCY_MS = (Number(process.env.LOAD_LATENCY_MS) || 60) * SCALE;
const PER_TOKEN_LIMIT = Number(process.env.LOAD_PER_TOKEN_LIMIT) || 12; // concurrent requests one token may have before GitHub objects
const GLOBAL_LIMIT = Number(process.env.LOAD_GLOBAL_LIMIT) || 60; // concurrent requests overall before GitHub objects
const OPS_PER_USER = Number(process.env.LOAD_OPS_PER_USER) || 8;
// Mean pause between one user's actions. Real people read a screen before tapping again (seconds);
// set LOAD_THINK_MS=40 for a brutal "every user hammers the bot" stress run.
const THINK_MS = Number(process.env.LOAD_THINK_MS) || 1500;

const args = process.argv.slice(2);
const burst = args.includes('--burst');
const BURST_FANOUT = Number(process.env.LOAD_BURST_FANOUT) || 30; // parallel requests ONE user fires at once (bulk action / big upload)
const baseline = args.includes('--baseline');
let steps = args.filter((a) => /^\d+$/.test(a)).map(Number);
if (!steps.length) steps = [10, 25, 50, 100, 250, 500, 1000];

Object.assign(process.env, { GITHUB_MUTATION_MIN_INTERVAL_MS: '50' });
const Module = require('module');
const { monitorEventLoopDelay } = require('perf_hooks');
const { FakeGitHub, makeOctokit, requestError, secondaryLimit } = require('./lib/fakeGithub');

const gh = new FakeGitHub();
const real = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@octokit/rest') return { Octokit: makeOctokit(gh) };
  if (request === 'pino') { const f = () => ({ info() {}, warn() {}, error() {} }); f.stdTimeFunctions = { isoTime() {} }; return f; }
  return real.call(this, request, parent, isMain);
};
const github = require('../src/lib/github');
const traffic = require('../src/lib/githubTraffic');
const requestContext = require('../src/lib/requestContext');
const { gitBlobSha } = require('../src/lib/gitHash');

// ── fake GitHub behaviour ────────────────────────────────────────────
let globalActive = 0; let secondaryServed = 0; let fiveXX = 0; let peakGlobal = 0; let peakPerToken = 0; let served = 0;
const randn = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const latency = () => Math.min(LATENCY_MS * 12, LATENCY_MS * Math.exp(0.6 * randn()));
const ratelimitHeaders = () => ({ 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000) });
const files = new Map();

gh.latencyMs = () => latency();
const origTransport = gh.transport.bind(gh);
gh.transport = async (opts, token) => {
  globalActive++; peakGlobal = Math.max(peakGlobal, globalActive);
  const perToken = (gh.byToken.get(token) || { active: 0 }).active + 1;
  peakPerToken = Math.max(peakPerToken, perToken);
  try {
    if (perToken > PER_TOKEN_LIMIT || globalActive > GLOBAL_LIMIT) {
      secondaryServed++;
      await new Promise((r) => setTimeout(r, 5));
      throw secondaryLimit(1);
    }
    if (opts.method === 'GET' && Math.random() < 0.003) { fiveXX++; await new Promise((r) => setTimeout(r, latency() / 2)); throw requestError(502, 'Bad Gateway'); }
    served++;
    return await origTransport(opts, token);
  } finally { globalActive--; }
};
gh.on('GET /user', async () => ({ headers: ratelimitHeaders(), data: { login: 'u' } }));
gh.on('GET /user/repos', async (o) => ({ headers: ratelimitHeaders(), data: o.params.page === 1 ? Array.from({ length: 40 }, (_, i) => ({ name: `repo${i}`, default_branch: 'main' })) : [] }));
gh.on('GET /repos/{owner}/{repo}', async () => ({ headers: { ...ratelimitHeaders(), etag: '"x"', 'content-length': '300' }, data: { name: 'r', default_branch: 'main', size: 100, created_at: new Date().toISOString() } }));
gh.on('GET /repos/{owner}/{repo}/languages', async () => ({ headers: ratelimitHeaders(), data: { JS: 100 } }));
gh.on('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', async () => ({ headers: ratelimitHeaders(), data: { sha: 't', truncated: false, tree: Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.js`, type: 'blob', sha: `s${i}`, size: 100 })) } }));
gh.on('GET /repos/{owner}/{repo}/git/ref/{ref}', async () => ({ headers: ratelimitHeaders(), data: { object: { sha: 'c' } } }));
gh.on('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', async () => ({ headers: ratelimitHeaders(), data: { tree: { sha: 't' } } }));
gh.on('GET /repos/{owner}/{repo}/contents/{path}', async (o) => ({ headers: ratelimitHeaders(), data: { sha: files.get(o.params.path) || 'abc', content: Buffer.from('console.log(1)').toString('base64'), encoding: 'base64', size: 14 } }));
gh.on('PUT /repos/{owner}/{repo}/contents/{path}', async (o) => { files.set(o.params.path, gitBlobSha(Buffer.from(o.params.content, 'base64'))); return { headers: ratelimitHeaders(), data: { content: { sha: 'n' }, commit: { sha: 'c' } } }; });
gh.on('POST /user/repos', async (o) => ({ headers: ratelimitHeaders(), data: { name: o.params.name, created_at: new Date().toISOString() } }));

// ── virtual user ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);

async function burstSession(id, stats, prefix) {
  const token = `${prefix}-${id}`;
  const t0 = process.hrtime.bigint();
  const results = await Promise.allSettled(Array.from({ length: BURST_FANOUT }, (_, i) => requestContext.runOperation({ userId: id, operation: 'bulk' }, () => github.getLanguages(token, `u${id}`, `repo${i}`))));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  for (const r of results) {
    if (r.status === 'fulfilled') stats.ok++; else { stats.fail++; const k = `${r.reason.code || r.reason.status || r.reason.message}`.slice(0, 40); stats.errors[k] = (stats.errors[k] || 0) + 1; }
    stats.lat.push(ms);
  }
}

async function userSession(id, stats, prefix) {
  if (burst) return burstSession(id, stats, prefix);
  const token = `${prefix}-${id}`;
  const ops = [
    ['browse repos', () => github.listRepos(token)],
    ['open repo', () => github.getRepo(token, `u${id}`, 'repo1')],
    ['languages', () => github.getLanguages(token, `u${id}`, 'repo1')],
    ['browse files', () => github.getTree(token, `u${id}`, 'repo1', 'main')],
    ['read file', () => github.getFileContent(token, `u${id}`, 'repo1', 'f1.js')],
    ['edit file', () => github.putFile(token, `u${id}`, 'repo1', 'f1.js', `v${Math.random()}`, 'edit', 'abc')],
    ['create repo', () => github.createRepo(token, { name: `new-${id}-${Math.floor(Math.random() * 1e6)}`, isPrivate: true })],
  ];
  for (let i = 0; i < OPS_PER_USER; i++) {
    await sleep(Math.random() * 2 * THINK_MS);
    const [name, fn] = ops[Math.floor(Math.random() * ops.length)];
    const t0 = process.hrtime.bigint();
    try {
      await requestContext.runOperation({ userId: id, operation: name }, fn);
      stats.ok++;
    } catch (err) {
      stats.fail++;
      const k = `${err.code || err.status || err.message}`.slice(0, 40);
      stats.errors[k] = (stats.errors[k] || 0) + 1;
    }
    stats.lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
}

// handlers are registered once above; keep a snapshot so each step can restore them
const HANDLERS = gh.handlers.slice();

async function step(users, { managed }) {
  gh.handlers = HANDLERS.map((h) => ({ ...h, times: Infinity }));
  gh.calls = []; gh.byToken.clear(); gh.peak = 0;
  globalActive = 0; secondaryServed = 0; fiveXX = 0; peakGlobal = 0; peakPerToken = 0; served = 0;
  const tr = traffic.getTraffic();
  const m = tr.manager;
  const before = m.getSnapshot().totals;
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  let rssPeak = 0; let heapPeak = 0; let cpu0 = process.cpuUsage();
  const mem = setInterval(() => { const u = process.memoryUsage(); rssPeak = Math.max(rssPeak, u.rss); heapPeak = Math.max(heapPeak, u.heapUsed); }, 50);
  let peakActive = 0; let peakQueued = 0;
  const poll = setInterval(() => { const s = m.getSnapshot(); peakActive = Math.max(peakActive, s.active); peakQueued = Math.max(peakQueued, s.queued); }, 10);
  const stats = { ok: 0, fail: 0, lat: [], errors: {} };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: users }, (_, i) => userSession(i, stats, `${managed ? 'm' : 'u'}${users}`)));
  const wall = (Date.now() - t0) / 1000;
  clearInterval(mem); clearInterval(poll); loop.disable();
  const after = m.getSnapshot();
  const cpu = process.cpuUsage(cpu0);
  stats.lat.sort((a, b) => a - b);
  const win = after.lastFiveMinutes;
  return {
    managed, users, wall, ops: stats.ok + stats.fail, ok: stats.ok, fail: stats.fail, errors: stats.errors,
    p50: pct(stats.lat, 50), p95: pct(stats.lat, 95), p99: pct(stats.lat, 99),
    throughput: (stats.ok + stats.fail) / wall, ghRequests: gh.calls.length, ghRps: gh.calls.length / wall,
    queueWaitAvg: win.avgQueueWaitMs, peakActive, peakQueued, peakGlobal, peakPerToken,
    secondaryServedByGitHub: secondaryServed, retries: after.totals.retries - before.retries, secondaryDetected: after.totals.secondary - before.secondary,
    shed: after.totals.shed - before.shed, coalesced: after.totals.coalesced - before.coalesced, cacheHits: after.totals.cacheHits - before.cacheHits,
    unknown: after.totals.unknownOutcomes - before.unknownOutcomes, state: after.state,
    loopP99: loop.percentile(99) / 1e6, loopMax: loop.max / 1e6, rssMB: rssPeak / 1048576, heapMB: heapPeak / 1048576,
    cpuPct: ((cpu.user + cpu.system) / 1000 / (wall * 1000)) * 100, lanes: after.lanes,
  };
}

const f = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '-');
function table(rows, title) {
  console.log(`\n${title}`);
  const cols = [
    ['users', (r) => r.users], ['ops', (r) => r.ops], ['fail', (r) => r.fail], ['ops/s', (r) => f(r.throughput, 0)],
    ['p50ms', (r) => f(r.p50)], ['p95ms', (r) => f(r.p95)], ['p99ms', (r) => f(r.p99)], ['qwait', (r) => (r.managed ? f(r.queueWaitAvg) : '-')],
    ['gh req/s', (r) => f(r.ghRps, 0)], ['peak gh', (r) => r.peakGlobal], ['peak/tok', (r) => r.peakPerToken], ['2ndry@GH', (r) => r.secondaryServedByGitHub],
    ['retry', (r) => r.retries], ['shed', (r) => r.shed], ['unkn', (r) => r.unknown], ['loop p99', (r) => f(r.loopP99, 1)], ['RSS MB', (r) => f(r.rssMB)],
  ];
  const widths = cols.map(([h, fn]) => Math.max(h.length, ...rows.map((r) => String(fn(r)).length)));
  console.log(cols.map(([h], i) => h.padStart(widths[i])).join('  '));
  for (const r of rows) console.log(cols.map(([, fn], i) => String(fn(r)).padStart(widths[i])).join('  '));
}

(async () => {
  const keep = setInterval(() => {}, 1000);
  console.log(`GitHub model: median ${LATENCY_MS}ms, GitHub objects above ${PER_TOKEN_LIMIT} in-flight per token or ${GLOBAL_LIMIT} overall; ${OPS_PER_USER} ops/user, think ≈${THINK_MS}ms`);
  const managedRows = [];
  for (const n of steps) { managedRows.push(await step(n, { managed: true })); if (global.gc) global.gc(); }
  table(managedRows, 'MANAGED (traffic layer on)' + (burst ? ` — BURST: every user fires ${BURST_FANOUT} requests at once` : ''));
  const worst = managedRows[managedRows.length - 1];
  const errs = Object.entries(worst.errors).map(([k, v]) => `${k}×${v}`).join(', ');
  if (errs) console.log(`  errors at ${worst.users} users: ${errs}`);

  if (baseline) {
    const tr = traffic.getTraffic();
    const origInstall = tr.installHook;
    tr.installHook = () => false; // bypass: Octokit talks to GitHub directly, as before v1.2.1
    // fresh Octokit clients are needed (clients are cached per token) → new token namespace
    const baseRows = [];
    for (const n of steps.filter((x) => x <= 250 || args.includes('--baseline-all'))) { baseRows.push(await step(n, { managed: false })); }
    tr.installHook = origInstall;
    table(baseRows, 'UNMANAGED baseline (no traffic layer; same fake GitHub; RSS is not comparable — same process)' + (burst ? ' — BURST' : ''));
  }
  clearInterval(keep);
  process.exit(0);
})();
