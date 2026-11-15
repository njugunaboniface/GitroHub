/**
 * Confidence + Decision engines (pure).
 *
 *   evidence → risk (how unusual) and confidence (how sure it is NOT benign)
 *            → a stage on a progressive ladder
 *
 * Warden's ladder ENDS at review_candidate. There is no "restrict" stage:
 * enforcement is a separate, owner-invoked capability. The one sacred rule
 * is enforced structurally — every gate must pass, every cap can only LOWER
 * the result, and when evidence is thin, ambiguous, conflicting or
 * uncorroborated the answer is "do nothing" (and Warden says why).
 */
const { clamp } = require('./stats');

const STAGES = ['normal', 'observe', 'flag', 'enhanced_monitoring', 'review_candidate'];
const STAGE_LABEL = {
  normal: 'Normal', observe: 'Observing', flag: 'Flagged',
  enhanced_monitoring: 'Enhanced monitoring', review_candidate: 'Review candidate',
};
const STAGE_ICON = { normal: '🟢', observe: '🔵', flag: '🚩', enhanced_monitoring: '🔎', review_candidate: '🧾' };

// A class's weight when combined with others (noisy-OR): failures are the most
// telling signal, connection churn the weakest.
const CLASS_WEIGHT = { rate: 0.55, failures: 0.7, repetition: 0.5, throttle: 0.5, identity: 0.3, github: 0.35 };

// How strongly two kinds of evidence move together (0 = independent, 1 = same fact). Pace, repetition and
// throttling all come from the same stream of actions; failures and connection churn are different witnesses.
// Used to pool evidence without counting one underlying fact several times.
const CORRELATION = {
  rate: { repetition: 0.35, throttle: 0.5, failures: 0.1, identity: 0.05, github: 0.4 },
  repetition: { throttle: 0.3, failures: 0.15, identity: 0.05, github: 0.2 },
  throttle: { failures: 0.2, identity: 0.05, github: 0.3 },
  failures: { identity: 0.1, github: 0.2 },
  identity: { github: 0.1 },
};
const corr = (a, b) => (a === b ? 1 : (CORRELATION[a] && CORRELATION[a][b]) || (CORRELATION[b] && CORRELATION[b][a]) || 0.1);

/**
 * Correlation-aware evidence pooling. Each class contributes "evidence mass"
 * e = −ln(1 − w·strength) (so one class gives exactly the old noisy-OR value);
 * classes are added strongest-first, each discounted by how correlated it is
 * with the strongest class already counted. Independent kinds add in full;
 * two views of the same underlying fact add little. A single class is unchanged.
 */
function poolRisk(classes) {
  const parts = classes
    .map((c) => ({ cls: c.class, e: -Math.log(1 - Math.min(0.97, (CLASS_WEIGHT[c.class] || 0.4) * c.strength)) }))
    .filter((p) => p.e > 0)
    .sort((a, b) => b.e - a.e);
  let total = 0; const counted = [];
  for (const p of parts) {
    const maxCorr = counted.length ? Math.max(...counted.map((q) => corr(p.cls, q))) : 0;
    total += p.e * (1 - maxCorr);
    counted.push(p.cls);
  }
  return 1 - Math.exp(-total);
}
const WITNESS_MIN = 0.3;              // a class counts as an independent witness from this strength
const BEHAVIORAL = new Set(['failures', 'repetition', 'throttle']);
// A higher stage must HOLD continuously this long before Warden moves there.
const HOLD_MINUTES = { observe: 0, flag: 15, enhanced_monitoring: 45, review_candidate: 90 };
const DEMOTE_AFTER_MINUTES = 30;
const MIN_FLEET_USERS = 6; // below this, nothing is "fleet-wide"

const stageIndex = (s) => Math.max(0, STAGES.indexOf(s));

function confidenceLabel(c) {
  if (c >= 0.85) return 'very high';
  if (c >= 0.7) return 'high';
  if (c >= 0.5) return 'moderate';
  if (c >= 0.3) return 'low';
  return 'very low';
}

function persistenceScore(p) {
  return clamp(p.longest_run_hours / 3) * 0.5 + clamp(p.sessions_abnormal / 4) * 0.3 + clamp((p.episodes - 1) / 2) * 0.2;
}

/** Gates for reaching each stage, with owner-readable text for the ones that fail. */
function gatesFor(stage, m) {
  const p = m.persistence;
  switch (stage) {
    case 'observe': return [{ ok: m.risk >= 12, text: 'Nothing unusual enough to note yet' }];
    case 'flag': return [
      { ok: m.risk >= 30, text: 'Risk is below the flag level' },
      { ok: p.longest_run_hours >= 2 || p.abnormal_hours >= 3, text: 'The unusual activity has not lasted long enough (needs 2+ consecutive hours, or 3+ unusual hours)' },
    ];
    case 'enhanced_monitoring': return [
      { ok: m.risk >= 50, text: 'Risk is below the enhanced-monitoring level' },
      { ok: m.confidence >= 0.5, text: 'Confidence is too low' },
      { ok: m.witnesses >= 2, text: 'Only one kind of evidence — at least two independent kinds are required' },
      { ok: m.maturity !== 'none', text: 'Not enough history of this user yet' },
    ];
    case 'review_candidate': return [
      { ok: m.risk >= 70, text: 'Risk is below the review level' },
      { ok: m.confidence >= 0.7, text: 'Confidence is below the review level' },
      { ok: m.witnesses >= 2, text: 'Needs at least two independent kinds of evidence' },
      { ok: m.hasBehavioral, text: 'Pace alone is not enough — needs corroboration from failures, repetition or throttling' },
      { ok: m.maturity === 'mature', text: "This user's baseline is not mature yet (needs 14+ days of history)" },
      { ok: p.longest_run_hours >= 2, text: 'The pattern has not persisted for 2+ consecutive hours' },
      { ok: p.sessions_abnormal >= 3 || (p.episodes >= 3 && p.distinct_days >= 2), text: 'Not yet persistent across enough separate sessions or days' },
      { ok: m.benignTotal < 0.3, text: 'A plausible innocent explanation remains' },
      { ok: !m.fleet.systemic, text: 'Many users are affected at once — this looks like a system event' },
    ];
    default: return [];
  }
}

/**
 * @returns {{stage,risk,confidence,...}} — see fields below. Never throws on
 * thin data: thin data simply yields a low stage with the reason recorded.
 */
function evaluate({ isAdmin = false, isTrusted = false, ageDays = 0, baseline = null, evidence, benign = [], fleet = {}, history = {} }) {
  const maturity = baseline ? baseline.maturity : 'none';
  if (isAdmin) {
    return { stage: 'normal', uncapped: 'normal', risk: 0, confidence: 0, confidenceLabel: 'very low', witnesses: 0, classes: [], persistence: evidence.persistence,
      persistenceScore: 0, benign: [], benignTotal: 0, blockers: [], reasons: [], caps: [], trustCapped: false, maturity, doNothing: true,
      doNothingReason: 'Administrator accounts are not evaluated.' };
  }

  // innocent explanations (plus a small credit for a long clean record)
  const benignAll = [...benign];
  if ((history.priorCases || 0) === 0 && ageDays >= 60 && maturity === 'mature') {
    benignAll.push({ code: 'clean_history', weight: 0.1, note: `Clean record over ${Math.round(ageDays)} days with no earlier cases.` });
  }
  const benignTotal = Math.min(0.85, benignAll.reduce((s, b) => s + b.weight, 0));

  // classes → independent witnesses (fleet-wide failures halve the failures witness)
  const classes = evidence.items.map((i) => ({
    class: i.class, type: i.type,
    strength: i.strength * (i.class === 'failures' && fleet.errorsHigh ? 0.5 : 1),
    reliability: i.reliability, fact: i.fact, observed: i.observed, baseline: i.baseline, firing_hours: i.firing_hours,
  }));
  // The GitHub-load class is derived from the same stream of actions as pace, so it supports the risk
  // estimate (see poolRisk) but is never an INDEPENDENT witness.
  const witnessList = classes.filter((c) => c.strength >= WITNESS_MIN && c.class !== 'github');
  const witnesses = witnessList.length;
  const hasBehavioral = witnessList.some((c) => BEHAVIORAL.has(c.class));

  // risk: noisy-OR across classes (several classes add up SUB-additively), scaled by persistence
  const baseRisk = poolRisk(classes);
  const ps = persistenceScore(evidence.persistence);
  const risk = Math.round(100 * baseRisk * (0.35 + 0.65 * ps));

  // confidence: baseline maturity × corroboration × persistence × reliability × (1 − innocent explanations)
  const cBase = { mature: 1, low: 0.6, none: 0.25 }[maturity] ?? 0.25;
  const cCorr = witnesses === 0 ? 0 : witnesses === 1 ? 0.4 : witnesses === 2 ? 0.8 : 1;
  const avgRel = witnessList.length ? witnessList.reduce((s, c) => s + c.reliability, 0) / witnessList.length : 0.5;
  const confidence = Number((cBase * cCorr * (0.5 + 0.5 * ps) * (0.75 + 0.25 * avgRel) * (1 - benignTotal)).toFixed(3));

  const metrics = { risk, confidence, witnesses, hasBehavioral, persistence: evidence.persistence, maturity, benignTotal, fleet };

  // climb the ladder one rung at a time — each rung needs ALL its gates AND the rung below
  let stage = 'normal';
  for (const s of STAGES.slice(1)) {
    if (gatesFor(s, metrics).every((g) => g.ok)) stage = s; else break;
  }
  const uncapped = stage;

  // caps can only LOWER the result
  const caps = [];
  const cap = (max, why) => { if (stageIndex(stage) > stageIndex(max)) { stage = max; caps.push(why); } };
  if (maturity === 'none') cap('observe', 'Not enough history of this user to judge them — Warden never compares a new user with the fleet average to reach a verdict.');
  else if (maturity === 'low') cap('flag', "This user's baseline is still forming (under 14 days) — capped at Flagged.");
  if (fleet.systemic) cap('observe', 'A large share of users spiked at the same time — treated as a system event, not user behaviour.');
  if (benignTotal >= 0.5) cap('flag', 'A strong innocent explanation applies.');
  if (risk >= 50 && confidence >= 0.3 && confidence < 0.5) cap('flag', 'The evidence is ambiguous (risk is elevated but confidence is low).');
  let trustCapped = false;
  if (isTrusted && stageIndex(stage) > stageIndex('enhanced_monitoring')) { stage = 'enhanced_monitoring'; trustCapped = true; caps.push('User is ⭐ Trusted — still monitored and logged, but never raised to review.'); }

  // why not higher? (what the NEXT rung still needs)
  const next = STAGES[stageIndex(stage) + 1];
  const blockers = [...caps];
  if (next && stageIndex(uncapped) <= stageIndex(stage)) {
    for (const g of gatesFor(next, metrics)) if (!g.ok) blockers.push(g.text);
  }

  const reasons = witnessList
    .sort((a, b) => b.strength - a.strength)
    .map((c) => c.fact);
  const doNothing = stageIndex(stage) <= stageIndex('observe');
  return {
    stage, uncapped, risk, confidence, confidenceLabel: confidenceLabel(confidence), witnesses, classes,
    persistence: evidence.persistence, persistenceScore: Number(ps.toFixed(2)), benign: benignAll, benignTotal: Number(benignTotal.toFixed(2)),
    blockers, reasons, caps, trustCapped, maturity, doNothing,
    doNothingReason: doNothing ? (blockers[0] || 'Nothing unusual.') : null,
  };
}

/** Progressive response: move at most ONE rung per step, and only after the
 * higher stage has held continuously for its hold time. */
function progress(profile, target, now) {
  const cur = profile.stage || 'normal';
  const ci = stageIndex(cur); const ti = stageIndex(target);
  const out = { stage: cur, stageSince: profile.stageSince || now, pendingStage: null, pendingSince: null, changed: false };

  if (ti < ci) {                                     // coming down: only after it has been calmer for a while
    if (now - (profile.stageSince || 0) >= DEMOTE_AFTER_MINUTES * 60000) {
      out.stage = STAGES[Math.max(ti, ci - 1)]; out.stageSince = now; out.changed = true;
    }
    return out;
  }
  if (ti === ci) return out;

  const nextStage = STAGES[ci + 1];                  // going up: one rung, and it must HOLD
  const pendingSince = profile.pendingStage === nextStage && profile.pendingSince ? profile.pendingSince : now;
  if (now - pendingSince >= HOLD_MINUTES[nextStage] * 60000) {
    out.stage = nextStage; out.stageSince = now; out.changed = true;
  } else {
    out.pendingStage = nextStage; out.pendingSince = pendingSince;
  }
  return out;
}

/** Is this a fleet-wide event (ours) rather than one user's behaviour?
 * Callers should pass the fleet EXCLUDING the user being judged (see runner.js),
 * otherwise a user's own spike or failures would excuse themselves. */
function fleetState(perUser, totals = { actions: 0, errors: 0 }, github = null) {
  const active = perUser.filter((u) => u.active);
  const abnormal = active.filter((u) => u.recentRateAbnormal).length;
  const fraction = active.length ? abnormal / active.length : 0;
  return {
    systemic: active.length >= MIN_FLEET_USERS && fraction >= 0.25,
    // Needs a real crowd too: with a handful of users, "the fleet's" failure rate is just
    // the person being judged talking to themselves.
    errorsHigh: active.length >= MIN_FLEET_USERS && totals.actions >= 100 && totals.errors / totals.actions >= 0.2,
    fraction: Number(fraction.toFixed(2)), activeUsers: active.length,
    githubDegraded: !!(github && github.degraded), githubReason: github && github.reason ? github.reason : null,
  };
}

module.exports = { poolRisk, CORRELATION, STAGES, STAGE_LABEL, STAGE_ICON, HOLD_MINUTES, CLASS_WEIGHT, evaluate, progress, fleetState, gatesFor, stageIndex, confidenceLabel, persistenceScore };
