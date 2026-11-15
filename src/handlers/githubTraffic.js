/**
 * 🌐 GitHub Traffic — owner-only screen over the GitHub traffic layer
 * (lib/githubTraffic). v1.2.1-multi.
 *
 * It SHOWS live pressure (state, concurrency, queue, circuit breaker, rate
 * limits, secondary-limit events, top consumers) and offers three owner
 * levers that act on the traffic layer itself — never on users:
 *   • pause / resume BACKGROUND GitHub work,
 *   • reset the circuit breaker,
 *   • clear paused lanes.
 * Warden does not appear here as a controller; it only receives the same
 * snapshot as observation data (see wardenBrain/githubSignals.js).
 */
const inline = require('../keyboards/inline');
const { safeEditMessageText } = require('../lib/safeEdit');
const { getTraffic } = require('../lib/githubTraffic');

const { render } = require('../lib/githubTrafficView');

async function show(ctx, { edit = false } = {}) {
  const admin = require('./admin');
  if (!(await admin.requireOwner(ctx))) return;
  const snap = getTraffic().manager.getSnapshot();
  const text = render(snap);
  const keyboard = inline.githubTrafficMenu({ backgroundPaused: snap.backgroundPaused, breakerOpen: snap.breaker.state !== 'CLOSED', pausedLanes: snap.pausedLanes });
  if (edit && (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard }))) return;
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

// The three owner levers return the toast text to show (or null when the tap was refused); the
// route answers the callback query with it, so there is exactly one answer per tap.
async function toggleBackground(ctx) {
  const admin = require('./admin');
  if (!(await admin.requireOwner(ctx))) return null;
  const m = getTraffic().manager;
  const pause = !m.backgroundPaused;
  m.setBackgroundPaused(pause);
  await require('../lib/adminActions').auditLog(ctx.from.id, null, 'github_traffic', pause ? 'background paused' : 'background resumed').catch(() => {});
  await show(ctx, { edit: true });
  return pause ? 'Background GitHub work paused.' : 'Background GitHub work resumed.';
}

async function resetBreaker(ctx) {
  const admin = require('./admin');
  if (!(await admin.requireOwner(ctx))) return null;
  getTraffic().manager.resetBreaker();
  await require('../lib/adminActions').auditLog(ctx.from.id, null, 'github_traffic', 'circuit breaker reset').catch(() => {});
  await show(ctx, { edit: true });
  return 'Circuit breaker reset.';
}

async function clearPauses(ctx) {
  const admin = require('./admin');
  if (!(await admin.requireOwner(ctx))) return null;
  const m = getTraffic().manager;
  let n = 0;
  for (const identity of [...m.lanes.keys()]) if (m.resetLane(identity)) n++;
  await require('../lib/adminActions').auditLog(ctx.from.id, null, 'github_traffic', 'paused accounts cleared').catch(() => {});
  await show(ctx, { edit: true });
  return `Cleared ${n} account state${n === 1 ? '' : 's'}.`;
}

module.exports = { show, toggleBackground, resetBreaker, clearPauses, render };
