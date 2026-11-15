/** Small, explainable statistics for the Warden Brain. Deliberately plain
 * (medians, percentiles) rather than anything opaque: every number Warden
 * reports must be something the owner can sanity-check by hand. */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const ms = (t) => (t instanceof Date ? t.getTime() : Number(new Date(t)));

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
const median = (arr) => percentile(arr, 0.5);
/** Median absolute deviation, scaled to be comparable with a standard deviation. */
const mad = (arr) => { const m = median(arr); return 1.4826 * median(arr.map((x) => Math.abs(x - m))); };

/** Half-life decay: old evidence loses influence, it is never deleted. */
function decay(ageHours, halfLifeHours = 72) {
  return Math.pow(0.5, Math.max(0, ageHours) / halfLifeHours);
}

module.exports = { HOUR, DAY, clamp, ms, percentile, median, mad, decay };
