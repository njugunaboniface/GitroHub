/**
 * Evidence engine. Turns raw hourly buckets into TYPED EVIDENCE rather than
 * points: each item says what was observed, what it was compared with, how
 * reliable that kind of signal is, and which independence class it belongs to
 * (two signals of the same class are ONE witness, not two).
 *
 * Pure: no database, no clock (callers pass `now`).
 */
const { HOUR, clamp, ms, decay } = require('./stats');
const { effectiveBaseline } = require('./baseline');
const { factorAt } = require('./seasonal');
const { detectShift } = require('./changepoint');

// How much each KIND of signal can be trusted on its own. Connection events are
// noisy (people re-authorise for innocent reasons), repetition is noisy
// (paging through a list repeats the same control); failures are the most telling.
const RELIABILITY = { rate: 0.6, failures: 0.75, repetition: 0.45, throttle: 0.55, identity: 0.3, github: 0.4 };
const FLOORS = { rateActions: 40, burst: 20, errors: 8, errorActions: 10, repetitionActions: 30, throttleHits: 3 };
const ABNORMAL_MIN = 0.2;     // an hour counts as abnormal when any class reaches this
const MIN_ITEM_STRENGTH = 0.12;
const DECAY_HALF_LIFE_H = 72;

/** Strength (0–1) of each class for ONE hourly bucket against a baseline. */
function scaledBaseline(eb, mult) {
  if (!mult || mult === 1) return eb;
  return { ...eb, rate: { ...eb.rate, median: eb.rate.median * mult, p90: eb.rate.p90 * mult }, burst: { ...eb.burst, p90: eb.burst.p90 * mult } };
}

/** Seasonal multiplier for an hour (1 unless this is a personal baseline with a usable weekly model). */
function seasonFor(eb, t) { return eb.source === 'personal' ? factorAt(eb.weekly, t) : 1; }

function hourStrengths(b, ebIn, mult = 1) {
  const eb = scaledBaseline(ebIn, mult);
  const s = { rate: 0, failures: 0, repetition: 0, throttle: 0 };
  const a = b.actions || 0;

  let rateS = 0;
  if (a >= FLOORS.rateActions) {
    const ratio = a / Math.max(eb.rate.median, 3);
    if (ratio >= 3 && a > 1.5 * (eb.rate.p90 || 0)) rateS = Math.max(ABNORMAL_MIN, clamp((ratio - 3) / 7));
  }
  let burstS = 0;
  if ((b.max_burst || 0) >= FLOORS.burst) {
    const ratio = b.max_burst / Math.max(eb.burst.p90, 6);
    if (ratio >= 2.5) burstS = Math.max(ABNORMAL_MIN, clamp((ratio - 2.5) / 5.5));
  }
  s.rate = Math.max(rateS, burstS); // pace and burst are the same witness

  if ((b.errors || 0) >= FLOORS.errors && a >= FLOORS.errorActions) {
    const er = b.errors / a;
    const thr = Math.max(0.25, 3 * Math.max(eb.error_ratio.p90, 0.05));
    if (er >= thr) s.failures = Math.max(ABNORMAL_MIN, clamp((er - 0.25) / 0.5));
  }
  if (a >= FLOORS.repetitionActions) {
    const rr = (b.repeats || 0) / a;
    if (rr >= Math.max(0.5, (eb.repeat_ratio.p90 || 0) + 0.3)) s.repetition = Math.max(ABNORMAL_MIN, clamp((rr - 0.5) / 0.4));
  }
  if ((b.cap_hits || 0) >= FLOORS.throttleHits) s.throttle = Math.max(ABNORMAL_MIN, clamp(b.cap_hits / 15));
  return s;
}

function factFor(cls, b, eb) {
  const personal = eb.source === 'personal';
  switch (cls) {
    case 'rate': {
      const usual = Math.max(Math.round(eb.rate.median), 1);
      const ratio = (b.actions / Math.max(eb.rate.median, 3)).toFixed(1);
      return `${b.actions} actions in one hour (${ratio}× ${personal ? "this user's usual" : 'the fleet typical'} ~${usual}/hour)` +
        ((b.max_burst || 0) >= FLOORS.burst ? `, peak burst ${b.max_burst} within a minute` : '');
    }
    case 'failures': return `${b.errors} failed operations (${Math.round((b.errors / b.actions) * 100)}% of that hour's actions)`;
    case 'repetition': return `${Math.round((b.repeats / b.actions) * 100)}% of actions re-used the same control within seconds`;
    case 'throttle': return `${b.cap_hits} actions were refused by the hourly limit`;
    default: return cls;
  }
}

/**
 * @param {object} p
 * @param {Array}  p.buckets   hourly rows (any range; last `windowHours` are used)
 * @param {object} p.baseline  from computeBaseline (may be null)
 * @param {number} p.now       epoch ms
 * @param {object} [p.identity] { anomalies24h, tokenRejected24h }
 */
function extractEvidence({ buckets, baseline, now, identity = {}, windowHours = 72, prior, reliabilityAdj = null, extraItems = [] }) {
  const eb = effectiveBaseline(baseline, prior);
  const since = now - windowHours * HOUR;
  const hours = (buckets || [])
    .map((b) => ({ ...b, t: ms(b.bucket_start) }))
    .filter((b) => b.t >= since && b.t <= now)
    .sort((x, y) => x.t - y.t)
    .map((b) => {
      const season = seasonFor(eb, b.t);
      const s = hourStrengths(b, eb, season);
      const ageH = (now - (b.t + HOUR)) / HOUR;
      return { b, s, season, w: decay(ageH, DECAY_HALF_LIFE_H), abnormal: Math.max(s.rate, s.failures, s.repetition, s.throttle) >= ABNORMAL_MIN };
    });

  // ── per-class evidence: the strongest DECAYED hour stands for the class
  const items = [];
  // v1.2.1-multi: is the pace a SUSTAINED shift (CUSUM) or an isolated spike? It adjusts how much the
  // pace signal is trusted, never whether a gate exists.
  const shift = detectShift(hours.map((h) => ({ t: h.b.t, actions: h.b.actions })), eb, hours.map((h) => h.season));
  const adj = (cls) => (reliabilityAdj && reliabilityAdj[cls]) || 1;
  const fleetPenalty = eb.source === 'fleet' ? 0.4 : 1; // judged against strangers → much less reliable
  for (const cls of ['rate', 'failures', 'repetition', 'throttle']) {
    let best = null; let firing = 0;
    for (const h of hours) {
      if (h.s[cls] >= ABNORMAL_MIN) firing += 1;
      const eff = h.s[cls] * h.w;
      if (!best || eff > best.eff) best = { eff, raw: h.s[cls], h };
    }
    if (best && best.eff >= MIN_ITEM_STRENGTH) {
      items.push({
        type: `${cls}_anomaly`, class: cls,
        strength: Number(best.eff.toFixed(3)), raw_strength: Number(best.raw.toFixed(3)),
        reliability: Number((Math.min(0.85, RELIABILITY[cls] * fleetPenalty * adj(cls) * (cls === 'rate' ? (shift.detected ? 1.2 : firing <= 1 ? 0.85 : 1) : 1))).toFixed(3)),
        firing_hours: firing,
        ...(cls === 'rate' ? { shift: { detected: shift.detected, since: shift.sinceT ? new Date(shift.sinceT).toISOString() : null, magnitude: shift.magnitude } } : {}),
        observed: { hour: new Date(best.h.b.t).toISOString(), actions: best.h.b.actions, errors: best.h.b.errors || 0, repeats: best.h.b.repeats || 0, cap_hits: best.h.b.cap_hits || 0, max_burst: best.h.b.max_burst || 0 },
        baseline: { source: eb.source, rate_median: eb.rate.median, rate_p90: eb.rate.p90, burst_p90: eb.burst.p90, error_p90: eb.error_ratio.p90, repeat_p90: eb.repeat_ratio.p90 },
        fact: factFor(cls, best.h.b, eb),
      });
    }
  }
  // ── connection-event evidence (low reliability; an innocent explanation halves it)
  const n = identity.anomalies24h || 0;
  if (n > 0) {
    let st = n >= 3 ? 0.6 : n === 2 ? 0.4 : 0.2;
    if (identity.tokenRejected24h > 0) st *= 0.5; // GitHub revoked the token → reconnecting is expected
    items.push({
      type: 'connection_churn', class: 'identity', strength: Number(st.toFixed(3)), raw_strength: st,
      reliability: Number((RELIABILITY.identity * adj('identity')).toFixed(3)), firing_hours: 0,
      observed: { anomalies_24h: n, token_rejected_24h: identity.tokenRejected24h || 0 },
      baseline: { source: 'n/a' }, fact: `${n} unusual connection event${n === 1 ? '' : 's'} in 24h`,
    });
  }

  for (const x of extraItems) if (x) items.push({ ...x, reliability: Number((x.reliability * adj(x.class)).toFixed(3)) });

  // ── persistence: how long, across how many sessions and separate episodes
  const abn = hours.filter((h) => h.abnormal);
  let longest = 0; let run = 0; let prev = null; let episodes = 0; let lastEnd = null;
  for (const h of abn) {
    run = prev !== null && h.b.t - prev === HOUR ? run + 1 : 1;
    longest = Math.max(longest, run);
    if (lastEnd === null || h.b.t - lastEnd >= 6 * HOUR) episodes += 1; // ≥6 quiet hours separates episodes
    prev = h.b.t; lastEnd = h.b.t;
  }
  const persistence = {
    longest_run_hours: longest,
    abnormal_hours: abn.length,
    episodes,
    sessions_abnormal: abn.reduce((sum, h) => sum + (h.b.sessions || 0), 0),
    distinct_days: new Set(abn.map((h) => new Date(h.b.t).toISOString().slice(0, 10))).size,
    window: abn.length ? { start: new Date(abn[0].b.t).toISOString(), end: new Date(abn[abn.length - 1].b.t + HOUR).toISOString() } : null,
  };
  return { items, persistence, baseline_source: eb.source };
}

/** Did this user show abnormal PACE in the last few hours? (feeds the fleet check) */
function recentRateAbnormal(buckets, baseline, now, lastHours = 3, prior) {
  const eb = effectiveBaseline(baseline, prior);
  return (buckets || []).some((b) => {
    const t = ms(b.bucket_start);
    return t >= now - lastHours * HOUR && hourStrengths(b, eb, seasonFor(eb, t)).rate >= ABNORMAL_MIN;
  });
}

/** "What legitimate explanation could produce this?" — each returns a weight
 * that LOWERS confidence. */
function benignChecks({ ageDays, bulkOps6h = 0, idleDaysBefore = 0, fleet = {} }) {
  const out = [];
  if (ageDays < 7) out.push({ code: 'new_account', weight: 0.35, note: `Account is only ${ageDays.toFixed(1)} days old — new users explore in bursts.` });
  if (bulkOps6h > 0) out.push({ code: 'bulk_operation', weight: 0.3, note: `${bulkOps6h} bulk operation${bulkOps6h === 1 ? '' : 's'} in the last 6h can legitimately generate many actions.` });
  if (idleDaysBefore >= 14) out.push({ code: 'returned_after_idle', weight: 0.2, note: `Returned after ~${Math.round(idleDaysBefore)} idle days — catching up is normal.` });
  if (fleet.systemic) out.push({ code: 'fleet_wide_spike', weight: 0.8, note: 'Many users spiked at the same time — this points to a bot, GitHub or Telegram event, not this user.' });
  if (fleet.errorsHigh) out.push({ code: 'fleet_wide_errors', weight: 0.5, note: 'Failures are elevated across the whole fleet (likely an upstream outage).' });
  if (fleet.githubDegraded && !fleet.errorsHigh) out.push({ code: 'github_degraded', weight: 0.4, note: `${fleet.githubReason || 'GitHub is degraded'} — failures and throttling right now say little about this user.` });
  return out;
}

module.exports = { extractEvidence, hourStrengths, recentRateAbnormal, benignChecks, RELIABILITY, FLOORS, ABNORMAL_MIN };
