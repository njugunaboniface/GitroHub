/**
 * "Needs you" counts (v1.2.5-multi) — the little line on the start card and the 📬 Needs attention screen.
 *
 *   🔀 PRs that need you   review requested from you  +  your own PRs where changes were requested
 *   🔀 open PRs of yours   every open PR you opened (GitHub never notifies you about your OWN pull request, so without this
 *                          a PR you just opened showed up nowhere)
 *   🐞 issues              open issues assigned to you
 *   ❌ failing             your own open PRs whose checks are failing
 *
 * Best-effort and cheap: four GitHub searches per refresh, cached for a few minutes per ACCOUNT, concurrent
 * callers share one refresh, and the start card only ever waits a moment for it — a slow GitHub means the line
 * is simply missing this time, never a slow /start. Counts are for the active account; other accounts are
 * refreshed quietly in the background so a "+N elsewhere" hint can be shown.
 */
const { BoundedMap } = require('./boundedMap');
const core = require('./github/core');
const format = require('./format');
const userPrefs = require('./userPrefs');
const logger = require('./logger');

const TTL_MS = 60 * 1000; // short on purpose: a PR opened a moment ago should show up on the next look, not five minutes later
const cache = new BoundedMap({ max: 4000, name: 'needsYou' }); // `${telegramId}:${account}` -> { counts, at }
cache.startSweeper((v) => Date.now() - v.at > TTL_MS * 4);
const inFlight = new Map();

const QUERIES = {
  review: 'is:pr is:open archived:false review-requested:@me',
  changes: 'is:pr is:open archived:false author:@me review:changes_requested',
  failing: 'is:pr is:open archived:false author:@me status:failure',
  issues: 'is:issue is:open archived:false assignee:@me',
  open: 'is:pr is:open archived:false author:@me',
};

async function total(token, q) {
  const data = await core.get(token, 'GET /search/issues', { q, per_page: 1 }, 'Count your work');
  return Number(data && data.total_count) || 0;
}

/** Live counts for one token. */
async function fetchCounts(token) {
  const [review, changes, failing, issues, open] = await Promise.all(Object.values(QUERIES).map((q) => total(token, q)));
  // Unread GitHub notifications (one page; "50+" when there are more). Never fails the other counts.
  let notifs = 0;
  try {
    const list = await core.get(token, 'GET /notifications', { per_page: 50 }, 'Count your notifications');
    notifs = Array.isArray(list) ? list.length : 0;
  } catch (_) { notifs = 0; }
  return { review, changes, prs: review + changes, open, failing, issues, notifs, at: Date.now() };
}

const keyOf = (telegramId, account) => `${telegramId}:${String(account || '').toLowerCase()}`;

/** Cached counts for an account (or null). */
function cached(telegramId, account) {
  const hit = cache.get(keyOf(telegramId, account));
  return hit ? hit.counts : null;
}

const fresh = (c) => c && Date.now() - c.at < TTL_MS;

/**
 * Counts for `account` using `token`. Uses the cache while fresh; otherwise refreshes (shared between concurrent
 * callers). Throws only when `force` is set and GitHub fails — otherwise failures fall back to what is cached.
 */
async function counts(telegramId, account, token, { force = false } = {}) {
  const have = cached(telegramId, account);
  if (!force && fresh(have)) return have;
  const key = keyOf(telegramId, account);
  if (inFlight.has(key)) return inFlight.get(key);
  const work = (async () => {
    try {
      const c = await fetchCounts(token);
      cache.set(key, { counts: c, at: Date.now() });
      return c;
    } catch (err) {
      if (force) throw err;
      logger.debug('needs-you refresh failed', { error: err && err.message });
      return have || null;
    }
  })();
  inFlight.set(key, work);
  try { return await work; } finally { inFlight.delete(key); }
}

/** Waits at most `waitMs` for the counts; a late answer still lands in the cache for next time. */
async function countsWithin(telegramId, account, token, waitMs = 1800) {
  const work = counts(telegramId, account, token);
  const timer = new Promise((resolve) => setTimeout(() => resolve(cached(telegramId, account)), waitMs).unref());
  return Promise.race([work, timer]);
}

/** Cached totals of the person's OTHER accounts, refreshing stale ones in the background (never awaited). */
async function elsewhere(telegramId, activeLogin) {
  try {
    const accounts = require('./accounts');
    const list = await accounts.list(telegramId);
    let sum = 0; let accountsWith = 0; let refreshed = 0;
    for (const a of list) {
      if (a.active || String(a.login).toLowerCase() === String(activeLogin || '').toLowerCase()) continue;
      const c = cached(telegramId, a.login);
      if (c) { const n = (c.prs || 0) + (c.open || 0) + (c.issues || 0) + (c.failing || 0); if (n > 0) { sum += n; accountsWith++; } }
      if (!fresh(c) && refreshed < 3) {
        refreshed++;
        accounts.tokenFor(telegramId, a.login).then((tok) => tok && counts(telegramId, a.login, tok)).catch(() => {});
      }
    }
    return { sum, accountsWith };
  } catch (_) { return { sum: 0, accountsWith: 0 }; }
}

/** What the toggles allow: { prs, issues, failing, notifs } numbers after switches (0 when switched off). */
function visible(c, prefs) {
  if (!c || !prefs.needs_line) return { prs: 0, open: 0, issues: 0, failing: 0, notifs: 0, total: 0 };
  const v = { prs: prefs.needs_prs ? c.prs : 0, open: prefs.needs_prs ? (c.open || 0) : 0, issues: prefs.needs_issues ? c.issues : 0, failing: prefs.needs_failing ? c.failing : 0, notifs: prefs.needs_notifs !== false ? (c.notifs || 0) : 0 };
  return { ...v, total: v.prs + v.open + v.issues + v.failing + v.notifs };
}

/** MarkdownV2 start-card line, or '' when there is nothing to say. */
function line(v, other = { sum: 0 }) {
  if (!v || !v.total) return '';
  const parts = [];
  if (v.prs) parts.push(`🔀 ${v.prs} PR${v.prs === 1 ? '' : 's'} need${v.prs === 1 ? 's' : ''} you`);
  if (v.open) parts.push(`🔀 ${v.open} open PR${v.open === 1 ? '' : 's'} of yours`);
  if (v.issues) parts.push(`🐞 ${v.issues} issue${v.issues === 1 ? '' : 's'}`);
  if (v.failing) parts.push(`❌ ${v.failing} failing`);
  if (v.notifs) parts.push(`🔔 ${v.notifs >= 50 ? '50+' : v.notifs} unread`);
  if (other.sum) parts.push(`\\+${other.sum} elsewhere`);
  return `▸ ${parts.map((p) => (p.includes('\\+') ? p : format.escapeMd(p))).join(' · ')}\n`;
}

/** The compact buttons under the start card: [🔀 Review PRs (N)] [🔔 Unread (N)] then [📬 Needs attention (N)]. */
function jumpRows(v, style) {
  if (!v || !v.total) return null;
  const top = [];
  if (v.prs) top.push(style.callback(`🔀 Review PRs (${v.prs})`, 'manage:mywork:v:review:1'));
  if (v.open) top.push(style.callback(`🔀 My open PRs (${v.open})`, 'manage:mywork:v:authored:1'));
  if (v.notifs) top.push(style.callback(`🔔 Unread (${v.notifs >= 50 ? '50+' : v.notifs})`, 'manage:notify:list:unread:1'));
  const attention = style.callback(`📬 Needs attention (${v.total})`, 'manage:attn:home');
  if (top.length === 1) return [[top[0], attention]];
  const rows = [];
  for (let i = 0; i < top.length; i += 2) rows.push(top.slice(i, i + 2));
  return [...rows, [attention]];
}

/** Start-card pieces for one person. Never throws. */
async function startCard(telegramId, account, token) {
  try {
    const prefs = await userPrefs.getAll(telegramId);
    if (!prefs.needs_line) return { line: '', rows: null, v: null };
    const c = await countsWithin(telegramId, account, token);
    const v = visible(c, prefs);
    const other = await elsewhere(telegramId, account);
    return { line: line(v, other), rows: jumpRows(v, require('../keyboards/buttonStyle')), v };
  } catch (err) {
    return { line: '', rows: null, v: null };
  }
}

module.exports = { QUERIES, fetchCounts, counts, countsWithin, cached, elsewhere, visible, line, jumpRows, startCard, TTL_MS, _cache: cache };
