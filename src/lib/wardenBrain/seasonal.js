/**
 * Hour-of-week seasonality (v1.2.1-multi). A user who works nights, or only on
 * weekends, is NOT unusual at 3 a.m. Saturday just because the all-hours median
 * is low. This learns, per user, how active each of the 168 hours of the week
 * normally is RELATIVE to their own typical hour, and lets the evidence engine
 * scale expectations accordingly.
 *
 * Safeguards (all deliberate — a seasonal model that over-trusts thin data
 * would let a burst hide behind its own history):
 *  • each slot's factor is SHRUNK toward 1 in proportion to how few samples it
 *    has (n / (n + SHRINK_K)),
 *  • factors are clamped to [MIN_F, MAX_F], so no hour can "excuse" a 10× spike,
 *  • nothing is learned unless the user has enough distinct days of history,
 *  • the factor only ever RAISES the allowance for habitually-busy hours up to
 *    MAX_F; it can lower it down to MIN_F for habitually-quiet hours (a spike
 *    when the user is normally asleep is MORE notable, not less).
 * Pure: buckets in, 168 factors out.
 */
const { ms, median } = require('./stats');

const MIN_F = 0.5;
const MAX_F = 2.5;
const SHRINK_K = 3;
const MIN_DAYS = 10;

const slotOf = (t) => { const d = new Date(t); return d.getUTCDay() * 24 + d.getUTCHours(); };

/** @returns {{factors:number[], samples:number[], usable:boolean}} */
function learnWeekly(hist, nowMs) {
  const bySlot = Array.from({ length: 168 }, () => []);
  const days = new Set();
  for (const b of hist) {
    const t = b.t != null ? b.t : ms(b.bucket_start);
    bySlot[slotOf(t)].push(b.actions || 0);
    days.add(new Date(t).toISOString().slice(0, 10));
  }
  const all = hist.map((b) => b.actions || 0).filter((a) => a > 0);
  const overall = median(all);
  const factors = new Array(168).fill(1);
  const samples = bySlot.map((a) => a.length);
  if (days.size < MIN_DAYS || overall <= 0) return { factors, samples, usable: false };
  // Only hours that HAD activity are stored and learned (an idle hour has no row), so a slot's
  // factor describes how busy the person is when they ARE active in that slot — it cannot mark a
  // habitually empty slot as "quiet". Example: 6 observations of "4 actions" against an overall
  // median of 20 → raw 0.2 → clamped, then shrunk toward 1 by the small sample.
  for (let s = 0; s < 168; s++) {
    const n = bySlot[s].length;
    if (!n) continue;
    const raw = median(bySlot[s]) / overall;
    const shrink = n / (n + SHRINK_K);
    factors[s] = Math.min(MAX_F, Math.max(MIN_F, 1 + (raw - 1) * shrink));
  }
  return { factors: factors.map((f) => Number(f.toFixed(3))), samples, usable: true };
}

/** Factor for the hour containing epoch-ms `t` (1 when no usable weekly model). */
function factorAt(weekly, t) {
  if (!weekly || !weekly.usable) return 1;
  return weekly.factors[slotOf(t)] || 1;
}

module.exports = { learnWeekly, factorAt, slotOf, MIN_F, MAX_F, MIN_DAYS };
