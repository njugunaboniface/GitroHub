/**
 * Learning from the owner's decisions (v1.2.1-multi).
 *
 * When the owner DISMISSES a case ("false positive") that is information about
 * the signals which raised it. This turns closed-case outcomes into a small,
 * bounded, explainable adjustment of each evidence class's reliability:
 *
 *   fpRate(class) = (dismissed + prior·α) / (closed + α)       (Beta-style smoothing)
 *   multiplier    = 1 − 0.5·(fpRate − BASE_FP)/(1 − BASE_FP)    clamped to [0.6, 1.1]
 *
 * It can only nudge reliability within ±40%/+10%, needs a minimum number of
 * closed cases before it moves at all, and never changes WHICH gates exist —
 * so a run of dismissals makes Warden quieter on that signal, but can never
 * switch a protection off or invent a verdict. Pure.
 */
const BASE_FP = 0.3;   // assumed false-positive rate before any evidence
const PRIOR_N = 5;     // pseudo-cases of prior belief
const MIN_CASES = 4;   // below this, no adjustment at all
const MIN_MULT = 0.6;
const MAX_MULT = 1.1;

/** @param {Array<{class:string, closed:number, dismissed:number}>} rows */
function reliabilityMultipliers(rows) {
  const out = {};
  for (const r of rows || []) {
    const closed = Number(r.closed) || 0; const dismissed = Math.min(closed, Number(r.dismissed) || 0);
    if (closed < MIN_CASES) continue;
    const fp = (dismissed + BASE_FP * PRIOR_N) / (closed + PRIOR_N);
    const m = 1 - 0.5 * ((fp - BASE_FP) / (1 - BASE_FP));
    out[r.class] = Number(Math.min(MAX_MULT, Math.max(MIN_MULT, m)).toFixed(3));
  }
  return out;
}

module.exports = { reliabilityMultipliers, BASE_FP, PRIOR_N, MIN_CASES, MIN_MULT, MAX_MULT };
