#!/usr/bin/env node
/**
 * warden-tests.js (v1.2.1-multi) — tests + a replayable scenario backtest for
 * the Warden algorithm upgrades: hour-of-week seasonality, CUSUM sustained-shift
 * detection, correlation-aware evidence pooling, owner-feedback reliability,
 * cohort priors and GitHub-traffic signals. All pure functions; no database.
 *
 *   node scripts/warden-tests.js            # assertions
 *   node scripts/warden-tests.js --report   # also print the scenario matrix
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', 'src', 'lib', 'wardenBrain');
const stats = require(`${R}/stats`);
const baselineMod = require(`${R}/baseline`);
const evidenceMod = require(`${R}/evidence`);
const engine = require(`${R}/engine`);
const seasonal = require(`${R}/seasonal`);
const cp = require(`${R}/changepoint`);
const feedback = require(`${R}/feedback`);
const gh = require(`${R}/githubSignals`);

const { HOUR, DAY } = stats;
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const tests = []; const test = (n, f) => tests.push({ n, f });
const bucket = (t, o = {}) => ({ bucket_start: t, actions: 10, errors: 0, repeats: 0, cap_hits: 0, sessions: 0, active_minutes: 30, max_burst: 5, ...o });
let seed = 11; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;

/** A user active during `hours` (UTC hours of day) on `weekdays` (0=Sun) for `days` days. */
function routine({ days = 40, hours, weekdays = [0, 1, 2, 3, 4, 5, 6], median = 12 }) {
  const out = [];
  for (let d = days; d >= 1; d--) {
    const day0 = Math.floor((NOW - d * DAY) / DAY) * DAY;
    if (!weekdays.includes(new Date(day0).getUTCDay())) continue;
    for (const h of hours) {
      const a = Math.max(2, Math.round(median * (0.6 + 0.8 * rnd())));
      out.push(bucket(day0 + h * HOUR, { actions: a, errors: Math.round(a * 0.02), repeats: Math.round(a * 0.05), max_burst: Math.round(a / 3), sessions: rnd() < 0.3 ? 1 : 0 }));
    }
  }
  return out;
}
const at = (ago, o) => bucket(NOW - ago * HOUR, o);
const episode = (start, extra = {}) => [0, 1, 2, 3].map((i) => at(start + i, { actions: 90 + i, errors: 42, repeats: 57, max_burst: 70, sessions: 1, ...extra }));

function judge({ buckets, ageDays = 60, trusted = false, fleet = {}, benignIn = {}, identity = {}, prior, reliabilityAdj = null, extraItems = [] }) {
  const baseline = baselineMod.computeBaseline(buckets, NOW, { accountCreatedAt: NOW - ageDays * DAY });
  const evidence = evidenceMod.extractEvidence({ buckets, baseline, now: NOW, identity, prior, reliabilityAdj, extraItems });
  const benign = evidenceMod.benignChecks({ ageDays, fleet, ...benignIn });
  return { baseline, evidence, d: engine.evaluate({ isTrusted: trusted, ageDays, baseline, evidence, benign, fleet, history: { priorCases: 0 } }) };
}
const idx = engine.stageIndex;

// ── seasonality ──────────────────────────────────────────────────────
test('seasonal: a night worker\u2019s habitual busy hours are expected; their quiet hours are not excused', () => {
  const hist = routine({ days: 40, hours: [1, 2, 3, 4], median: 40 }).map((b) => ({ ...b, t: b.bucket_start }));
  const w = seasonal.learnWeekly(hist, NOW);
  assert.ok(w.usable);
  const busy = seasonal.factorAt(w, Date.UTC(2026, 8, 29, 2)); const quiet = seasonal.factorAt(w, Date.UTC(2026, 8, 29, 14));
  assert.strictEqual(quiet, 1, 'an hour with no history gets no allowance');
  assert.ok(busy >= 0.5 && busy <= seasonal.MAX_F);
});

test('seasonal: thin history learns nothing; factors are clamped and shrunk', () => {
  const thin = routine({ days: 4, hours: [10, 11], median: 12 }).map((b) => ({ ...b, t: b.bucket_start }));
  const w = seasonal.learnWeekly(thin, NOW);
  assert.strictEqual(w.usable, false);
  assert.strictEqual(seasonal.factorAt(w, NOW), 1);
  const wild = [...routine({ days: 40, hours: [9], median: 5 }), ...routine({ days: 40, hours: [20], median: 500 })].map((b) => ({ ...b, t: b.bucket_start }));
  const w2 = seasonal.learnWeekly(wild, NOW);
  assert.ok(w2.factors.every((f) => f >= seasonal.MIN_F && f <= seasonal.MAX_F));
});

test('seasonal: a weekend-only user working their normal weekend peak is not flagged as a pace anomaly', () => {
  const H = routine({ days: 56, hours: [10, 11, 12, 13, 14], weekdays: [6, 0], median: 60 });
  const sat = Date.UTC(2026, 8, 26); // Saturday
  const now = Date.UTC(2026, 8, 27, 12); // Sunday noon
  const base = baselineMod.computeBaseline(H, now, { accountCreatedAt: now - 60 * DAY });
  assert.strictEqual(base.weekly.usable, true);
  const live = [10, 11, 12, 13].map((h) => bucket(Date.UTC(2026, 8, 27, h), { actions: 75, max_burst: 20, sessions: 1 }));
  const ev = evidenceMod.extractEvidence({ buckets: [...H, ...live], baseline: base, now, windowHours: 72 });
  assert.ok(!ev.items.some((i) => i.class === 'rate' && i.strength >= 0.3), `usual weekend peak flagged: ${JSON.stringify(ev.items.map((i) => [i.class, i.strength]))}`);
  void sat;
});

// ── CUSUM ────────────────────────────────────────────────────────────
test('CUSUM: an isolated spike is NOT a shift; a sustained step IS; a quiet user is quiet', () => {
  const eb = { rate: { median: 10 }, log: { mu: Math.log(11), sigma: 0.4 } };
  const mk = (arr) => arr.map((a, i) => ({ t: NOW - (arr.length - i) * HOUR, actions: a }));
  assert.strictEqual(cp.detectShift(mk([10, 11, 9, 80, 10, 12, 9, 10]), eb).detected, false, 'single spike');
  assert.strictEqual(cp.detectShift(mk([10, 11, 9, 60, 65, 70, 62, 68]), eb).detected, true, 'sustained step');
  assert.strictEqual(cp.detectShift(mk([9, 11, 10, 12, 8, 10]), eb).detected, false);
  assert.strictEqual(cp.detectShift([], eb).detected, false);
});

test('CUSUM: seasonal expectation is respected (a habitually 3× hour is not a shift)', () => {
  const eb = { rate: { median: 10 }, log: { mu: Math.log(11), sigma: 0.4 } };
  const hours = [30, 32, 29, 31, 33].map((a, i) => ({ t: NOW - (5 - i) * HOUR, actions: a }));
  assert.strictEqual(cp.detectShift(hours, eb).detected, true);
  assert.strictEqual(cp.detectShift(hours, eb, [3, 3, 3, 3, 3]).detected, false);
});

// ── pooling ──────────────────────────────────────────────────────────
test('pooling: one class equals the old noisy-OR exactly; correlated kinds add less than independent ones; more evidence never lowers risk', () => {
  const one = [{ class: 'rate', strength: 0.8 }];
  assert.ok(Math.abs(engine.poolRisk(one) - (1 - (1 - 0.55 * 0.8))) < 1e-9);
  const correlated = engine.poolRisk([{ class: 'rate', strength: 0.8 }, { class: 'throttle', strength: 0.8 }]);
  const independent = engine.poolRisk([{ class: 'rate', strength: 0.8 }, { class: 'failures', strength: 0.8 }]);
  assert.ok(independent > correlated, `independent ${independent} should exceed correlated ${correlated}`);
  assert.ok(correlated > engine.poolRisk(one), 'a second view still adds a little');
  let prev = 0; for (const n of [1, 2, 3, 4]) { const r = engine.poolRisk(['rate', 'failures', 'repetition', 'throttle'].slice(0, n).map((c) => ({ class: c, strength: 0.6 }))); assert.ok(r >= prev); prev = r; }
  assert.ok(prev < 1);
});

// ── feedback ─────────────────────────────────────────────────────────
test('feedback: nothing moves below the minimum number of closed cases; dismissals lower, confirmations raise — within bounds', () => {
  assert.deepStrictEqual(feedback.reliabilityMultipliers([{ class: 'rate', closed: 3, dismissed: 3 }]), {});
  const m = feedback.reliabilityMultipliers([{ class: 'rate', closed: 20, dismissed: 19 }, { class: 'failures', closed: 20, dismissed: 0 }, { class: 'throttle', closed: 10, dismissed: 3 }]);
  assert.ok(m.rate < 0.8 && m.rate >= feedback.MIN_MULT, `rate ${m.rate}`);
  assert.ok(m.failures > 1 && m.failures <= feedback.MAX_MULT, `failures ${m.failures}`);
  assert.ok(Math.abs(m.throttle - 1) < 0.1, 'in line with the prior → ~no change');
});

test('feedback: dismissals make a signal quieter but can never lift a user above what the gates allow', () => {
  const B = [...routine({ days: 60, hours: [9, 10, 11, 12, 13, 14] }), ...episode(1), ...episode(30), ...episode(54)];
  const plain = judge({ buckets: B }).d; const damped = judge({ buckets: B, reliabilityAdj: { rate: 0.6, failures: 0.6, repetition: 0.6 } }).d;
  assert.ok(damped.confidence <= plain.confidence);
  assert.ok(idx(damped.stage) <= idx(plain.stage));
  const boosted = judge({ buckets: [...routine({ days: 60, hours: [9, 10] }), at(1, { actions: 90, max_burst: 70 })], reliabilityAdj: { rate: 1.1 } }).d;
  assert.ok(idx(boosted.stage) <= idx('flag'), 'pace alone is still capped no matter the feedback');
});

// ── cohort prior ─────────────────────────────────────────────────────
test('cohort prior: needs enough mature users; blends with the static prior; clamped to ½×–2×', () => {
  const mature = (med, p90) => ({ maturity: 'mature', rate: { median: med, p90 }, burst: { median: 4, p90: 10 }, error_ratio: { median: 0.02, p90: 0.1 }, repeat_ratio: { median: 0.05, p90: 0.2 } });
  assert.strictEqual(baselineMod.buildCohortPrior([mature(50, 100), mature(50, 100)]), baselineMod.FLEET_PRIOR);
  const small = baselineMod.buildCohortPrior(Array.from({ length: 5 }, () => mature(30, 80)));
  assert.ok(small.rate.median > baselineMod.FLEET_PRIOR.rate.median && small.rate.median < 30, `shrunk toward static: ${small.rate.median}`);
  const huge = baselineMod.buildCohortPrior(Array.from({ length: 400 }, () => mature(5000, 9000)));
  assert.ok(huge.rate.median <= baselineMod.FLEET_PRIOR.rate.median * 2 + 1e-9, 'clamped');
});

test('cohort prior: judging a new user against it still carries fleet-source (low) reliability and never exceeds "observe"', () => {
  const prior = baselineMod.buildCohortPrior(Array.from({ length: 30 }, () => ({ maturity: 'mature', rate: { median: 20, p90: 50 }, burst: { median: 5, p90: 12 }, error_ratio: { median: 0.02, p90: 0.1 }, repeat_ratio: { median: 0.05, p90: 0.2 } })));
  const r = judge({ ageDays: 1, prior, buckets: [...[1, 2, 3, 4].map((i) => at(i, { actions: 400, errors: 200, repeats: 300, max_burst: 90, sessions: 2 }))] });
  assert.ok(idx(r.d.stage) <= idx('observe'), `new user reached ${r.d.stage}`);
  assert.ok(r.evidence.items.every((i) => i.reliability <= 0.4));
});

// ── GitHub signals ───────────────────────────────────────────────────
test('github: a degraded GitHub is an innocent explanation for failures; a healthy one is not', () => {
  assert.strictEqual(gh.githubFleetState(null).degraded, false);
  assert.strictEqual(gh.githubFleetState({ state: 'NORMAL', breaker: { state: 'CLOSED' }, pausedLanes: 0 }).degraded, false);
  const bad = gh.githubFleetState({ state: 'NORMAL', breaker: { state: 'OPEN' }, pausedLanes: 0 });
  assert.ok(bad.degraded && /circuit/i.test(bad.reason));
  assert.ok(gh.githubFleetState({ state: 'DEGRADED', breaker: { state: 'CLOSED' } }).degraded);
  assert.ok(gh.githubFleetState({ state: 'NORMAL', breaker: { state: 'CLOSED' }, pausedLanes: 3 }).degraded);
  const fleet = engine.fleetState([], { actions: 0, errors: 0 }, bad);
  const benign = evidenceMod.benignChecks({ ageDays: 60, fleet });
  assert.ok(benign.some((b) => b.code === 'github_degraded'));
  const H = routine({ days: 60, hours: [9, 10, 11, 12, 13, 14] });
  const withGh = judge({ buckets: [...H, ...episode(1)], fleet, benignIn: {} });
  const without = judge({ buckets: [...H, ...episode(1)] });
  assert.ok(withGh.d.confidence < without.d.confidence);
});

test('github: heavy GitHub use is weak evidence, requires a real crowd, and can NEVER count as behavioural corroboration', () => {
  const snap = (rows, total = 1000) => ({ topConsumers: rows, lastHour: { req: total } });
  assert.strictEqual(gh.githubEvidenceFor(1, snap([{ user: 1, requests: 900, writes: 5, secondaryLimits: 0 }]), {}), null, 'too few users → meaningless share');
  const crowd = [{ user: 1, requests: 600, writes: 30, secondaryLimits: 3 }, { user: 2, requests: 150 }, { user: 3, requests: 100 }, { user: 4, requests: 100 }];
  const item = gh.githubEvidenceFor(1, snap(crowd), {});
  assert.ok(item && item.class === 'github' && item.reliability <= 0.4 && item.strength > 0.3);
  assert.strictEqual(gh.githubEvidenceFor(2, snap(crowd), {}), null, 'a light user gets nothing');
  const H = routine({ days: 60, hours: [9, 10, 11, 12, 13, 14] });
  const r = judge({ buckets: H, extraItems: [item] });
  assert.ok(idx(r.d.stage) <= idx('flag'), `GitHub load alone reached ${r.d.stage}`);
  assert.ok(!r.d.classes.some((c) => c.class === 'github') || r.d.hasBehavioral !== true);
  const withPace = judge({ buckets: [...H, ...[1, 2, 3, 4].map((i) => at(i, { actions: 90, max_burst: 70, sessions: 1 }))], extraItems: [item] });
  assert.ok(idx(withPace.d.stage) <= idx('flag'), 'pace + GitHub load still lacks behavioural corroboration');
});

test('Warden only OBSERVES the GitHub layer: no code in wardenBrain can change traffic settings or act on accounts', () => {
  const files = fs.readdirSync(R).filter((f) => f.endsWith('.js'));
  const forbidden = /\b(setBackgroundPaused|resetBreaker|resetLane|\.tune\(|schedule\(|installHook|suspendUser|banUser|deleteUser|setBlocked|setSuspended)\b/;
  for (const f of files) {
    const code = fs.readFileSync(path.join(R, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!forbidden.test(code), `${f} must not control traffic or accounts`);
  }
});

// ── scenario backtest ────────────────────────────────────────────────
const SCEN = [
  ['quiet regular user', () => ({ buckets: routine({ days: 60, hours: [9, 10, 11, 12, 13, 14] }) }), 'normal'],
  ['one busy morning', () => ({ buckets: [...routine({ days: 60, hours: [9, 10, 11, 12, 13, 14] }), at(1, { actions: 70, max_burst: 40, sessions: 1 })] }), 'observe'],
  ['night worker on their usual night', () => ({ buckets: [...routine({ days: 60, hours: [1, 2, 3, 4], median: 30 }), ...[2, 3, 4].map((h) => bucket(NOW - 9 * HOUR + (h - 3) * HOUR, { actions: 36, max_burst: 14 }))] }), 'normal'],
  ['bulk operation (explained)', () => ({ buckets: [...routine({ days: 60, hours: [9, 10, 11, 12] }), at(1, { actions: 120, max_burst: 60, sessions: 1 })], benignIn: { bulkOps6h: 2 } }), 'observe'],
  ['scripted abuse, single episode', () => ({ buckets: [...routine({ days: 60, hours: [9, 10, 11, 12, 13, 14] }), ...episode(1)] }), 'enhanced_monitoring'],
  ['scripted abuse, recurring', () => ({ buckets: [...routine({ days: 60, hours: [9, 10, 11, 12, 13, 14] }), ...episode(1), ...episode(30), ...episode(54)] }), 'review_candidate'],
  ['same abuse during a GitHub outage', () => ({ buckets: [...routine({ days: 60, hours: [9, 10, 11, 12, 13, 14] }), ...episode(1), ...episode(30), ...episode(54)], fleet: { githubDegraded: true, githubReason: 'GitHub circuit breaker is not closed' } }), 'flag'], // identical abuse reaches review without the outage; the outage can only lower the verdict
  ['fleet-wide retry storm', () => ({ buckets: [...routine({ days: 60, hours: [9, 10, 11, 12, 13, 14] }), ...episode(1)], fleet: { systemic: true, errorsHigh: true } }), 'observe'],
  ['brand-new user exploring', () => ({ ageDays: 1, buckets: [at(2, { actions: 100, max_burst: 30, sessions: 1 }), at(1, { actions: 100, max_burst: 30 })] }), 'observe'],
  ['trusted user, same abuse', () => ({ trusted: true, buckets: [...routine({ days: 60, hours: [9, 10, 11, 12, 13, 14] }), ...episode(1), ...episode(30), ...episode(54)] }), 'enhanced_monitoring'],
];
for (const [name, make, expected] of SCEN) {
  test(`scenario: ${name} → ${expected}`, () => {
    const r = judge(make());
    SCEN.results = SCEN.results || []; SCEN.results.push({ name, expected, stage: r.d.stage, risk: r.d.risk, confidence: r.d.confidence });
    if (name === 'same abuse during a GitHub outage') assert.ok(idx(r.d.stage) < idx('review_candidate'), 'an outage must never raise the verdict');
    assert.strictEqual(r.d.stage, expected, `got ${r.d.stage} (risk ${r.d.risk}, conf ${r.d.confidence}); blockers: ${r.d.blockers.join(' | ')}`);
  });
}

(async () => {
  let failed = 0;
  for (const { n, f } of tests) { try { await f(); console.log(`  ✓ ${n}`); } catch (e) { failed++; console.log(`  ✗ ${n}\n      ${(e && e.stack ? e.stack : String(e)).split('\n').slice(0, 4).join('\n      ')}`); } }
  if (process.argv.includes('--report') && SCEN.results) {
    console.log('\nScenario matrix');
    for (const r of SCEN.results) console.log(`  ${r.name.padEnd(40)} expected ${r.expected.padEnd(20)} got ${r.stage.padEnd(20)} risk ${String(r.risk).padStart(3)}  conf ${r.confidence}`);
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
