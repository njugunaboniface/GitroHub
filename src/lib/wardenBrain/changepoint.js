/**
 * Sustained-shift detection (v1.2.1-multi) — one-sided CUSUM on log activity.
 *
 * A single loud hour and a user whose pace has genuinely stepped up for hours
 * look alike to a threshold test. CUSUM accumulates evidence of a persistent
 * upward shift relative to the user's own baseline and only fires when the
 * excess is SUSTAINED, so it separates "spiky" from "shifted":
 *
 *   S_t = max(0, S_{t-1} + z_t − k)        z_t = (ln(1+a_t) − μ) / σ
 *   alarm when S_t ≥ h                     (k = allowance, h = decision threshold)
 *
 * μ/σ come from the user's own baseline (median / MAD in log space), with a
 * floor on σ so a very regular user can't produce enormous z-scores from
 * trivial noise. Pure and clock-free.
 */
const { HOUR, median, mad } = require('./stats');

const K = 0.75; // allowance (in σ): shifts smaller than ~1.5σ are ignored
const H = 4.0;  // alarm threshold (in σ·hours)
const SIGMA_FLOOR = 0.35;
const Z_CAP = 2.5; // one hour can contribute at most this much, so a lone spike can never alarm: ≥3 sustained hours are needed

/**
 * @param {Array} hours  evidence-window buckets, oldest→newest ({t, actions})
 * @param {{rate:{median:number}, log?:{mu:number, sigma:number}}} eb  effective baseline
 * @param {number[]} [expected]  optional per-hour multiplier (seasonality) aligned with `hours`
 */
/**
 * Hours with no activity have no stored row, so the evidence window arrives with gaps.
 * CUSUM must see those quiet hours — a zero-activity hour is exactly what pulls the running
 * sum back down. Without them, three busy hours on three different days looked like one
 * "sustained" run (v1.2.3-multi fix). Gaps are filled with zero-action hours.
 */
function fillIdleHours(hours, expected) {
  const rows = [];
  const mults = [];
  const MAX_FILL = 72;
  hours.forEach((h, i) => {
    if (i > 0) {
      const gap = Math.round((h.t - hours[i - 1].t) / HOUR) - 1;
      for (let k = 0; k < Math.min(gap, MAX_FILL); k++) {
        rows.push({ t: hours[i - 1].t + (k + 1) * HOUR, actions: 0 });
        mults.push(1);
      }
    }
    rows.push(h);
    mults.push(expected ? expected[i] || 1 : 1);
  });
  return { rows, mults };
}

function detectShift(rawHours, eb, rawExpected = null) {
  if (!rawHours.length) return { detected: false, magnitude: 0, sinceT: null, peak: 0 };
  const { rows: hours, mults: expected } = fillIdleHours(rawHours, rawExpected);
  const mu = eb.log ? eb.log.mu : Math.log(1 + Math.max(eb.rate.median, 1));
  const sigma = Math.max(SIGMA_FLOOR, eb.log ? eb.log.sigma : 0.6);
  let s = 0; let peak = 0; let start = null; let alarmStart = null; let excess = 0; let n = 0;
  hours.forEach((h, i) => {
    const mult = expected[i] || 1;
    const z = Math.min(Z_CAP, (Math.log(1 + (h.actions || 0)) - (mu + Math.log(mult))) / sigma);
    const next = Math.max(0, s + z - K);
    if (s === 0 && next > 0) { start = h.t; excess = 0; n = 0; }
    if (next > 0) { excess += z; n += 1; }
    if (next === 0) { start = null; }
    s = next;
    if (s > peak) peak = s;
    if (s >= H && alarmStart === null) alarmStart = start;
  });
  return { detected: peak >= H, magnitude: Number((n ? excess / n : 0).toFixed(2)), sinceT: alarmStart, peak: Number(peak.toFixed(2)), currentS: Number(s.toFixed(2)) };
}

/** Log-space location/scale for a baseline's learning hours (robust: median / MAD). */
function logStats(actionsList) {
  const xs = actionsList.filter((a) => a > 0).map((a) => Math.log(1 + a));
  if (xs.length < 5) return null;
  return { mu: Number(median(xs).toFixed(3)), sigma: Number(Math.max(SIGMA_FLOOR, mad(xs)).toFixed(3)) };
}

module.exports = { detectShift, logStats, K, H, SIGMA_FLOOR, Z_CAP };
