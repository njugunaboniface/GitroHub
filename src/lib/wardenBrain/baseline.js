/**
 * Personal baseline — what "normal" looks like for ONE user, learned from
 * their own hourly history instead of comparing everyone to the same numbers.
 *
 * Pure function: buckets in, baseline out. The most recent hours are left
 * out of the learning set on purpose, so an abnormal stretch that is
 * happening right now cannot teach Warden that it is normal.
 */
const { HOUR, DAY, ms, median, mad, percentile } = require('./stats');
const { learnWeekly } = require('./seasonal');
const { logStats } = require('./changepoint');

const MATURITY = {
  mature: { minDays: 14, minActiveHours: 40 },
  low: { minDays: 3, minActiveHours: 10 },
};

// Used only when a user has (almost) no history of their own. Evidence judged
// against this carries low reliability and can never rise above "observe".
const FLEET_PRIOR = {
  rate: { median: 8, p90: 25 },
  burst: { median: 4, p90: 10 },
  error_ratio: { median: 0.02, p90: 0.12 },
  repeat_ratio: { median: 0.05, p90: 0.2 },
};

/**
 * Keeps unusual hours from teaching Warden that they are usual. Two defences:
 *  1. Learn from history OLDER than the evidence window (72h) whenever there
 *     is enough of it, so an abnormal stretch that is still being evaluated
 *     cannot leak into its own yardstick (falls back to a short 6h margin for
 *     very young accounts, which are capped at low confidence anyway).
 *  2. Trim outlier hours (far above the user's own median) before taking
 *     percentiles, so a persistent pattern can't drag the p90 up to meet it.
 */
const EVIDENCE_WINDOW_HOURS = 72;
const MIN_LEARNING_HOURS = 10;

function trimOutliers(hist) {
  if (hist.length < 12) return hist;
  const acts = hist.map((b) => b.actions);
  const m = median(acts);
  const cut = Math.max(m * 4, m + 6 * mad(acts));
  const kept = hist.filter((b) => b.actions <= cut);
  return kept.length >= MIN_LEARNING_HOURS ? kept : hist;
}

function computeBaseline(buckets, now, { excludeRecentHours = 6, accountCreatedAt = null } = {}) {
  const all = (buckets || []).map((b) => ({ ...b, t: ms(b.bucket_start) })).filter((b) => b.actions > 0);
  const older = all.filter((b) => b.t <= now - EVIDENCE_WINDOW_HOURS * HOUR);
  const learning = older.length >= MIN_LEARNING_HOURS ? older : all.filter((b) => b.t <= now - excludeRecentHours * HOUR);
  const hist = trimOutliers(learning);

  const first = all.length ? Math.min(...all.map((b) => b.t)) : now;
  const origin = accountCreatedAt ? Math.min(first, ms(accountCreatedAt)) : first;
  const daysOfHistory = Math.max(0, (now - origin) / DAY);

  const rate = hist.map((b) => b.actions);
  const burst = hist.map((b) => b.max_burst).filter((x) => x > 0);
  const errRatio = hist.filter((b) => b.actions >= 10).map((b) => b.errors / b.actions);
  const repRatio = hist.filter((b) => b.actions >= 10).map((b) => b.repeats / b.actions);

  const days = new Map();
  for (const b of hist) {
    const d = new Date(b.t).toISOString().slice(0, 10);
    const cur = days.get(d) || { hours: 0, sessions: 0 };
    cur.hours += 1; cur.sessions += b.sessions || 0;
    days.set(d, cur);
  }
  const dayVals = [...days.values()];

  let maturity = 'none';
  if (daysOfHistory >= MATURITY.mature.minDays && hist.length >= MATURITY.mature.minActiveHours) maturity = 'mature';
  else if (daysOfHistory >= MATURITY.low.minDays && hist.length >= MATURITY.low.minActiveHours) maturity = 'low';

  return {
    maturity,
    days_of_history: Number(daysOfHistory.toFixed(1)),
    active_hours: hist.length,
    rate: { median: median(rate), p90: percentile(rate, 0.9) },
    burst: { median: median(burst), p90: percentile(burst, 0.9) },
    error_ratio: { median: median(errRatio), p90: percentile(errRatio, 0.9) },
    repeat_ratio: { median: median(repRatio), p90: percentile(repRatio, 0.9) },
    sessions_per_day: dayVals.length ? median(dayVals.map((d) => d.sessions)) : 0,
    active_hours_per_day: dayVals.length ? median(dayVals.map((d) => d.hours)) : 0,
    // v1.2.1-multi: hour-of-week seasonality (usable only with enough days) and robust log-space location/scale for CUSUM.
    weekly: (() => { const w = learnWeekly(hist, now); return { usable: w.usable, factors: w.usable ? w.factors : null }; })(),
    log: logStats(rate),
    last_older_t: older.length ? Math.max(...older.map((b) => b.t)) : null, // newest activity before the evidence window (idle-gap check)
    computed_at: now,
  };
}

/** The numbers evidence is judged against: the user's own when they have
 * enough history, otherwise the fleet prior (flagged as such). */
function effectiveBaseline(baseline, prior = FLEET_PRIOR) {
  if (baseline && baseline.maturity !== 'none') return { ...baseline, source: 'personal' };
  return { ...prior, maturity: 'none', source: 'fleet', days_of_history: baseline ? baseline.days_of_history : 0, active_hours: baseline ? baseline.active_hours : 0 };
}

/**
 * Cohort prior (v1.2.1-multi): instead of judging a brand-new user against a
 * hard-coded guess, learn what "typical" is from the MATURE baselines of the
 * current fleet — blended with the static prior in proportion to how many
 * mature users there are (shrinkage), and clamped to [½×, 2×] of the static
 * prior so a strange fleet can't set an absurd yardstick. Evidence judged
 * against it is still flagged source:'fleet' (low reliability, never above
 * "observe"), so this only makes the yardstick fairer, never more trusting.
 */
const COHORT_SHRINK = 10;
function buildCohortPrior(baselines) {
  const mature = (baselines || []).filter((b) => b && b.maturity === 'mature');
  if (mature.length < 3) return FLEET_PRIOR;
  const blend = (get, fallback) => {
    const xs = mature.map(get).filter((x) => Number.isFinite(x) && x > 0);
    if (xs.length < 3) return fallback;
    const w = xs.length / (xs.length + COHORT_SHRINK);
    return Math.min(fallback * 2, Math.max(fallback * 0.5, w * median(xs) + (1 - w) * fallback));
  };
  return {
    rate: { median: blend((b) => b.rate.median, FLEET_PRIOR.rate.median), p90: blend((b) => b.rate.p90, FLEET_PRIOR.rate.p90) },
    burst: { median: blend((b) => b.burst.median, FLEET_PRIOR.burst.median), p90: blend((b) => b.burst.p90, FLEET_PRIOR.burst.p90) },
    error_ratio: { median: blend((b) => b.error_ratio.median, FLEET_PRIOR.error_ratio.median), p90: blend((b) => b.error_ratio.p90, FLEET_PRIOR.error_ratio.p90) },
    repeat_ratio: { median: blend((b) => b.repeat_ratio.median, FLEET_PRIOR.repeat_ratio.median), p90: blend((b) => b.repeat_ratio.p90, FLEET_PRIOR.repeat_ratio.p90) },
    cohort_n: mature.length,
  };
}

module.exports = { computeBaseline, effectiveBaseline, buildCohortPrior, FLEET_PRIOR, MATURITY };
