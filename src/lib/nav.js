/**
 * Navigation trail (v1.4.0-multi, bars since 2.0.0) — ONE place that knows where "Back" goes.
 *
 * Every button in the bot does exactly one of three jobs, and each job has one home:
 *   • step back      → the footer row built here  ([⬅️ Back to <where you came from>] [💼 Workspace])
 *   • do something   → the inline buttons of the screen itself
 *   • jump somewhere → the bottom bar (see lib/chrome.js)
 *
 * How Back works. Screens that take part register in SCREENS with a label, the callback that re-opens them, the screens
 * they may be reached from (`parents`) and their default ancestors (`chain`). enter() is called whenever such a screen is
 * drawn: it keeps the trail up to the nearest allowed parent (so Help → Legal → Back returns to Help, while
 * Settings → Legal → Back returns to Settings), and when the trail is empty or unrelated — a typed /legal, an old message,
 * a restart — it rebuilds the default path, so Back never dead-ends. The Back button carries the parent's own callback data,
 * so even a stale message keeps working.
 */
const style = require('../keyboards/buttonStyle');

const MAX_TRAIL = 8;

const WS = 'ws';

/** id → { label, data, parents, chain }  (chain = default ancestors, outermost first). */
const SCREENS = {
  ws: { label: 'Workspace', data: 'manage:ws', parents: [], chain: [] },
  settings: { label: 'Settings', data: 'hub:settings', parents: ['ws'], chain: ['ws'] },
  hubhelp: { label: 'Help & support', data: 'hub:help', parents: ['settings'], chain: ['ws', 'settings'] },
  help: { label: 'Help', data: 'help:menu', parents: ['hubhelp'], chain: ['ws', 'settings', 'hubhelp'] },
  helptopic: { label: 'Help topic', data: 'help:menu', parents: ['help'], chain: ['ws', 'settings', 'hubhelp', 'help'] },
  legal: { label: 'Legal', data: 'legal:index', parents: ['help', 'hubhelp', 'settings'], chain: ['ws', 'settings', 'hubhelp'] },
  legalsection: { label: 'Legal section', data: 'legal:index', parents: ['legal'], chain: ['ws', 'settings', 'hubhelp', 'legal'] },
  prefs: { label: 'Preferences', data: 'hub:prefs', parents: ['settings'], chain: ['ws', 'settings'] },
  history: { label: 'History', data: 'hub:history', parents: ['settings'], chain: ['ws', 'settings'] },
  search: { label: 'Search GitHub', data: 'hub:search', parents: [], chain: [] },
  notify: { label: 'Notifications', data: 'hub:notify', parents: [], chain: [] },
};

const entryOf = (id) => ({ id, label: SCREENS[id].label, data: SCREENS[id].data });

function session(ctx) {
  if (!ctx.session) ctx.session = {};
  return ctx.session;
}

function trailOf(ctx) {
  const s = session(ctx);
  if (!Array.isArray(s.navTrail)) s.navTrail = [];
  return s.navTrail;
}

/**
 * Records that screen `id` is being shown and returns the trail (the last entry is the screen itself).
 * Safe to call more than once for the same screen (re-render, Prev/Next, a pressed toggle).
 */
function enter(ctx, id) {
  const screen = SCREENS[id];
  if (!screen) return trailOf(ctx);
  const trail = trailOf(ctx);
  let keep = -1;
  for (let i = trail.length - 1; i >= 0; i--) {
    if (trail[i].id === id || screen.parents.includes(trail[i].id)) { keep = i; break; }
  }
  let next;
  if (keep >= 0) next = trail.slice(0, trail[keep].id === id ? keep : keep + 1);
  else next = screen.chain.map(entryOf);
  next.push(entryOf(id));
  session(ctx).navTrail = next.slice(-MAX_TRAIL);
  return session(ctx).navTrail;
}

/** The screen Back leads to from `id` (never null — falls back to Workspace). */
function parentOf(ctx, id) {
  const trail = enter(ctx, id);
  return trail.length > 1 ? trail[trail.length - 2] : entryOf(WS);
}

/**
 * The standard footer row for a screen taking part in the trail: [⬅️ Back to X] [💼 Workspace].
 * The Workspace button is dropped when X already is Workspace.
 */
function backRow(ctx, id) {
  const parent = parentOf(ctx, id);
  const label = parent.label.length > 18 ? `${parent.label.slice(0, 17)}…` : parent.label;
  const row = [style.callback(`⬅️ ${label}`, parent.data, style.BLUE)];
  if (parent.id !== WS) row.push(style.callback('💼 Workspace', SCREENS.ws.data, style.BLUE));
  return row;
}

/** Starts a fresh trail at a top-level page (a page opened from the bottom bar: Back from its children returns here). */
function startAt(ctx, id) {
  if (SCREENS[id]) session(ctx).navTrail = [entryOf(id)];
}

/** Starts a fresh trail at Workspace (called when Workspace is shown). */
function resetToHome(ctx) {
  session(ctx).navTrail = [entryOf(WS)];
}

module.exports = { startAt, SCREENS, MAX_TRAIL, enter, parentOf, backRow, resetToHome };
