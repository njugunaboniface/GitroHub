const users = require('../lib/users');
const repoCache = require('../lib/repoCache');
const oauth = require('../lib/oauth');
const inline = require('../keyboards/inline');
const format = require('../lib/format');
const chrome = require('../lib/chrome');

/**
 * Shared "you need to connect" prompt — used by /start, requireConnected(),
 * Settings, Disconnect, and the "🔗 Connect GitHub" BBTB button, so every
 * entry point shows the exact same message and resets the BBTB to the
 * disconnected-state bar (per the "distinct disconnected flow" rule).
 *
 * `showVersion` is only true when called directly from /start — so you can
 * always confirm a deploy actually landed without checking Railway, without
 * cluttering every mid-flow "you need to connect" interruption with it too.
 */
async function sendConnectPrompt(ctx, { intro } = {}) {
  const telegramId = ctx.from.id;
  const url = await oauth.connectUrl(telegramId);
  // The disconnected bar rides on a small marker; the card itself only carries the Connect button.
  await chrome.setBar(ctx, chrome.disconnectedBarId(ctx));
  await ctx.reply(
    (intro ? format.escapeMd(intro) :
      '👋 *Welcome to GitroHub*\n' +
      'Your GitHub, right inside Telegram\\.\n\n' +
      'Create, manage, upload, and download repositories\n' +
      '— all without leaving this chat\\.\n\n' +
      '>🔒 *NOT CONNECTED YET*\n' +
      '>Link your GitHub account to get started\\.'),
    { parse_mode: 'MarkdownV2', ...inline.connectButton(url) }
  );
}

const esc = format.escapeMd;

/** Hour of day (0–23) in the person's own timezone (falls back to UTC). */
function localHour(timezone) {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', hour12: false }).format(new Date());
    return Number(h) % 24;
  } catch (_) { return new Date().getUTCHours(); }
}

function greeting(timezone) {
  const h = localHour(timezone);
  if (h >= 5 && h < 12) return '🌅 Good morning';
  if (h >= 12 && h < 17) return '☀️ Good afternoon';
  if (h >= 17 && h < 22) return '🌆 Good evening';
  return '🌌 Good night';
}

const GAP = '\u3000\u3000'; // two ideographic spaces: an even gutter between the two columns

/** Two items per line with an even gutter; empty items are dropped (zero counts simply disappear). */
function twoColumns(items) {
  const flat = items.filter(Boolean);
  const lines = [];
  for (let i = 0; i < flat.length; i += 2) lines.push(flat.slice(i, i + 2).join(GAP));
  return lines;
}

/** A MarkdownV2 section: the title on its own line, then the (already escaped) lines in one block quote. */
function quote(title, lines) {
  return [title, ...lines.map((l) => `>${l}`)].join('\n');
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

/**
 * 🏠 Home card (v2.0.0-multi): greeting, what needs you, your GitHub at a glance, help. No buttons on the card — the 2×2
 * bottom bar is Home's navigation — and anything that is zero simply isn't shown.
 */
async function handleStart(ctx) {
  if (ctx.session) ctx.session.adminZone = false;
  await chrome.dropLive(ctx);

  const telegramId = ctx.from.id;
  const connected = await users.isConnected(telegramId);

  if (!connected) {
    const rawUser = await users.getUser(telegramId);
    if (!rawUser || !rawUser.connected_at) {
      const globalConfig = require('../lib/globalConfig');
      if (globalConfig.isSignupsPaused()) {
        await chrome.setBar(ctx, chrome.disconnectedBarId(ctx));
        return ctx.reply('🚦 New signups are paused right now — please check back soon. If you’ve connected before, this doesn’t affect you.');
      }
    }
    return sendConnectPrompt(ctx);
  }

  const user = await users.getUser(telegramId);

  // Best-effort extras. Everything is fetched at the same time and each part has its own short deadline, so Home can
  // never wait on one slow GitHub or database call (and one slow part never hides the others).
  const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]).catch(() => null);
  const token = await within(users.getDecryptedToken(telegramId), 1500);
  const [repoList, pinList, activityRows, needsRaw] = await Promise.all([
    token ? within(repoCache.getRepos(telegramId, token), 2500) : null,
    within(require('../lib/pins').list(telegramId), 1500),
    within(require('../lib/activity').recent(telegramId, { limit: 1 }), 1500),
    token ? within((async () => {
      const account = await require('../lib/accounts').activeLoginOf(telegramId);
      return account ? (await require('../lib/needsYou').startCard(telegramId, account, token)).v : null;
    })(), 2500) : null,
  ]);
  const repos = Array.isArray(repoList) ? repoList : [];
  const pinCount = Array.isArray(pinList) ? pinList.length : 0;
  const lastActivity = activityRows && activityRows.rows && activityRows.rows[0] ? activityRows.rows[0].created_at : null;
  const needs = needsRaw || null;

  const needLines = [];
  if (needs) {
    if (needs.prs) needLines.push(`🔀 ${esc(plural(needs.prs, 'pull request'))} waiting on you`);
    if (needs.open) needLines.push(`🔀 ${esc(plural(needs.open, 'open pull request'))} of yours`);
    if (needs.issues) needLines.push(`🐞 ${esc(plural(needs.issues, 'issue'))} assigned to you`);
    if (needs.failing) needLines.push(`❌ ${esc(plural(needs.failing, 'PR'))} failing checks`);
    if (needs.notifs) needLines.push(`🔔 ${esc(`${needs.notifs >= 50 ? '50+' : needs.notifs} unread`)}`);
  }
  if (ctx.state && ctx.state.isAdmin) {
    try {
      const { pool } = require('../db/postgres');
      const [rep, cases] = await Promise.all([
        require('../lib/reports').openCount(),
        pool.query(`SELECT COUNT(*)::int AS c FROM warden_cases WHERE status = 'open'`),
      ]);
      const flagged = (cases.rows[0] && cases.rows[0].c) || 0;
      if (rep) needLines.push(`🛡️ ${esc(plural(rep, 'open report'))}`);
      if (flagged) needLines.push(`🚩 ${esc(`${flagged} flagged`)}`);
    } catch (_) { /* optional */ }
  }

  const stars = repos.reduce((sum, r) => sum + (r.stargazers_count || 0), 0);
  const privateCount = repos.filter((r) => r.private).length;
  const publicCount = repos.length - privateCount;
  const touched = (r) => Date.parse(r.pushed_at || r.updated_at || 0) || 0;
  const latest = repos.length ? repos.reduce((a, b) => (touched(b) > touched(a) ? b : a)) : null;
  const github = twoColumns([
    repos.length ? `📁 ${esc(plural(repos.length, 'repo'))}` : '',
    publicCount ? `🌐 ${esc(`${publicCount} public`)}` : '',
    privateCount ? `🔒 ${esc(`${privateCount} private`)}` : '',
    stars ? `⭐ ${esc(plural(stars, 'star'))}` : '',
    pinCount ? `📌 ${esc(`${pinCount} pinned`)}` : '',
    lastActivity ? `🕒 ${esc(format.relativeTime(lastActivity))}` : '',
    latest && latest.name ? `📦 ${esc(latest.name)}` : '',
  ]);
  const help = twoColumns(['❓ /help', '📜 /legal']);

  // Dynamic status: a calm "all clear" line, or a Needs-you section with only the things that actually need attention.
  const blocks = [`${greeting(user && user.timezone)}, *${esc(user.github_username)}*`];
  blocks.push(needLines.length
    ? quote('🔔 *NEEDS YOU*', needLines)
    : '✨ *All clear\\.* Nothing needs you right now\\.');
  if (github.length) blocks.push(quote('📊 *YOUR GITHUB*', github));
  blocks.push(quote('🧭 *HELP*', help));

  // The 2×2 bar rides on the card itself (a reply keyboard can't share a message with inline buttons, and the card has none).
  const previousHome = ctx.session && ctx.session.homeMsgId;
  const sent = await ctx.reply(blocks.join('\n\n'), { parse_mode: 'MarkdownV2', __keep: true, ...chrome.keyboardFor('home') });
  if (ctx.session) { ctx.session.backTo = null; ctx.session.homeMsgId = sent && sent.message_id; }
  if (previousHome && sent && previousHome !== sent.message_id) ctx.telegram.deleteMessage(ctx.chat.id, previousHome).catch(() => {});
}

module.exports = { handleStart, sendConnectPrompt, greeting, twoColumns, quote };
