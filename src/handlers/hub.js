/**
 * 💼 Workspace — the always-there home (v1.3.0-multi).
 *
 * The bottom keyboard is one row for everybody ([📁 My Repos] [💼 Workspace], or [🔗 Connect GitHub] [💼 Workspace]
 * while disconnected). Everything else is an inline button reached from here:
 *
 *   💼 Workspace   🔔 Notifications · 🔀 Pull requests · 🐞 Issues · 🔍 Search · 📝 Gists · 📋 Projects
 *                  🏢 Organisations · 🧯 Restore center · ⚙️ Settings · 🛡️ Admin (admins only, with a live badge)
 *   ⚙️ Settings    👤 Accounts & access · 🤖 Automation · 🎛️ Preferences · 📜 History · 📦 Data & Trash
 *                  📊 Status & usage · ❓ Help & support
 *
 * Tiles adapt: a disconnected person sees a Connect button, a limited Settings and (admins) the Admin tile; a tile whose
 * feature an admin switched off disappears; a tile that needs a GitHub permission the person lacks gets a 🔒.
 *
 * `nav:<key>` callbacks are a bridge to the handlers that used to hang off bottom-keyboard buttons, so those screens
 * keep working unchanged while their buttons became inline (see registerNav, wired from bot.js).
 */
const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const ui = require('./manage/ui');
const users = require('../lib/users');
const features = require('../lib/features');
const scopesLib = require('../lib/scopes');
const config = require('../config');
const format = require('../lib/format');
const nav = require('../lib/nav');
const chrome = require('../lib/chrome');

const { plain, btn } = ui;
const NAV = {};

/** Registers the label→handler bridge (called once from createBot). */
function registerNav(map) { Object.assign(NAV, map); }

const navData = (key) => `nav:${key}`;

/** Counts for the admin badge; never throws. */
async function adminCounts(ctx) {
  try { return await require('../lib/adminAttention').counts(ctx.from.id, ctx.state || {}); } catch (_) { return { total: 0 }; }
}

/** A tile for a registered area, or null when the area is absent / switched off. */
function areaTile(areaKey, label, data, grantedScope, badge) {
  const registry = require('./manage/registry');
  const area = registry.get(areaKey);
  if (!area || !features.isEnabled(area.key)) return null;
  const lacking = area.scopes.length && scopesLib.missing(grantedScope, area.scopes).length;
  return plain(`${lacking ? '🔒 ' : ''}${label}${badge ? ` (${badge})` : ''}`, data);
}

function rowsOf(buttons, per = 2) {
  const flat = buttons.filter(Boolean);
  const rows = [];
  for (let i = 0; i < flat.length; i += per) rows.push(flat.slice(i, i + per));
  return rows;
}

const needsConnect = (ctx) => require('./start').sendConnectPrompt(ctx, { intro: 'Connect your GitHub account first.' });

/** 💼 Workspace home: the account-level tools that are not about one repo. Five tiles, two columns. */
async function showWorkspace(ctx) {
  nav.startAt(ctx, 'ws');
  await chrome.setBar(ctx, 'workspace');
  const connected = await users.isConnected(ctx.from.id);
  if (!connected) {
    const rows = [];
    try { rows.push([ui.link('🔗 Connect GitHub', await require('../lib/oauth').connectUrl(ctx.from.id))]); } catch (_) { /* optional */ }
    return ui.show(ctx, '💼 *Workspace*\n\n🔒 Not connected yet\\. Connect your GitHub account to unlock search, gists, projects and organisations\\.', { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
  }
  const user = await users.getUser(ctx.from.id);
  const granted = user && user.github_scope;
  const tiles = [
    plain('🌐 Search GitHub', 'hub:search'),
    areaTile('gists', '📝 Gists', 'manage:gists:home', granted),
    areaTile('projects', '📋 Projects', 'manage:projects:home', granted),
    areaTile('orgs', '🏢 Organisations', 'manage:orgs:home', granted),
    areaTile('restorec', '🧯 Restore center', 'manage:restorec:home', granted),
  ];
  return ui.screen(ctx, '💼 *Workspace*\n\nTools that go beyond a single repo\\.\n\n>🌐 Search public repos and code\n>📝 Gists · 📋 Projects · 🏢 Organisations\n>🧯 Bring back deleted things', rowsOf(tiles));
}

/** 🔔 Notifications hub: inbox, pull requests, issues and failing checks — a 2×2 of tiles; counts only when there is something. */
async function showNotifications(ctx, { force = false } = {}) {
  nav.startAt(ctx, 'notify');
  const connected = await users.isConnected(ctx.from.id);
  if (!connected) return needsConnect(ctx);
  await chrome.setBar(ctx, 'notifications');
  const user = await users.getUser(ctx.from.id);
  const granted = user && user.github_scope;
  let c = null;
  try {
    const needs = require('../lib/needsYou');
    const account = await require('../lib/accounts').activeLoginOf(ctx.from.id);
    const token = await users.getDecryptedToken(ctx.from.id);
    c = force ? await needs.counts(ctx.from.id, account, token, { force: true }).catch(() => needs.cached(ctx.from.id, account)) : await needs.countsWithin(ctx.from.id, account, token, 1800);
  } catch (_) { /* counts are optional */ }
  const n = (x) => (x ? ` (${x >= 50 ? '50+' : x})` : '');
  const tiles = [
    areaTile('notify', `📥 Inbox${n(c && c.notifs)}`, 'manage:notify:list:unread:1', granted),
    areaTile('mywork', `🔀 Pull requests${n(c && ((c.review || 0) + (c.open || 0)))}`, 'manage:mywork:prs', granted),
    areaTile('mywork', `🐞 Issues${n(c && c.issues)}`, 'manage:mywork:issues', granted),
    areaTile('mywork', `❌ Failing${n(c && c.failing)}`, 'manage:mywork:v:failing:1', granted),
  ];
  const waiting = c ? (c.notifs || 0) + (c.prs || 0) + (c.open || 0) + (c.issues || 0) + (c.failing || 0) : 0;
  const lines = [];
  if (c && c.notifs) lines.push(`>📥 ${ui.esc(c.notifs >= 50 ? '50+ unread' : `${c.notifs} unread`)}`);
  if (c && c.prs) lines.push(`>🔀 ${ui.esc(`${c.prs} PR${c.prs === 1 ? '' : 's'} need you`)}`);
  if (c && c.open) lines.push(`>🔀 ${ui.esc(`${c.open} open PR${c.open === 1 ? '' : 's'} of yours`)}`);
  if (c && c.issues) lines.push(`>🐞 ${ui.esc(`${c.issues} assigned issue${c.issues === 1 ? '' : 's'}`)}`);
  if (c && c.failing) lines.push(`>❌ ${ui.esc(`${c.failing} failing check${c.failing === 1 ? '' : 's'}`)}`);
  const body = waiting ? lines.join('\n') : '_You’re all caught up\\. 🎉_';
  return ui.screen(ctx, `🔔 *Notifications*\n\n${body}`, rowsOf(tiles));
}

/** ⚙️ Settings hub (inline, two columns). */
async function showSettings(ctx) {
  nav.startAt(ctx, 'settings');
  await chrome.setBar(ctx, 'settings');
  const connected = await users.isConnected(ctx.from.id);
  const isAdmin = !!(ctx.state && ctx.state.isAdmin);
  const tiles = [];
  if (connected) {
    tiles.push(plain('👤 Accounts', 'manage:accounts:home'), plain('🤖 Automation', navData('automation')),
      plain('🎛️ Preferences', 'hub:prefs'), plain('📜 History', 'hub:history'),
      plain('📦 Data & Trash', navData('storage')), plain('📊 Status & usage', 'settings:status'));
  }
  tiles.push(plain('❓ Help & support', 'hub:help'));
  if (isAdmin) {
    const admin = await adminCounts(ctx);
    tiles.push(btn(`🛡️ Admin${admin.total ? ` (${admin.total})` : ''}`, 'admin:dashboard', admin.total ? style.GREEN : style.BLUE));
  } else if (!connected) {
    tiles.push(plain('📜 Legal', 'legal:index'));
  }
  const version = isAdmin ? `\n\n🔧 v${format.escapeMd(config.BOT_VERSION)}` : '';
  const text = `⚙️ *Settings*\n\n${connected ? 'Accounts, automation, preferences, history and data\\.' : 'Help and support work without GitHub\\. Connect to unlock the rest\\.'}${version}`;
  return ui.show(ctx, text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rowsOf(tiles)) });
}

async function showPrefs(ctx) {
  return ui.show(ctx, '🎛️ *Preferences*\n\nHow the bot behaves for you\\.', { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([
    [plain('⚙️ My defaults', navData('defaults'))],
    [plain('🌍 Timezone & time format', 'automation:timezone')],
    nav.backRow(ctx, 'prefs'),
  ]) });
}

async function showHistory(ctx) {
  const rows = [
    [plain('📜 Activity', navData('activity'))],
    [plain('🛡️ Sensitive actions (safety log)', 'manage:safety:home')],
    [plain('🔑 Sign-ins', 'activity:accesslog')],
    nav.backRow(ctx, 'history'),
  ];
  return ui.show(ctx, '📜 *History*\n\nWhat happened on your account\\.', { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

async function showHelp(ctx) {
  const isAdmin = !!(ctx.state && ctx.state.isAdmin);
  const intro = isAdmin ? `\n\n🔧 v${format.escapeMd(config.BOT_VERSION)}` : '\n\nGuides, legal info and a way to reach us\\.';
  return ui.show(ctx, `❓ *Help & support*${intro}`, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([
    [plain('❓ Features & FAQ', 'help:menu'), plain('📜 Legal', 'legal:index')],
    [plain('🚩 Report a problem', 'settings:report')],
    nav.backRow(ctx, 'hubhelp'),
  ]) });
}

async function showSearch(ctx) {
  nav.startAt(ctx, 'search');
  const connected = await users.isConnected(ctx.from.id);
  if (!connected) return needsConnect(ctx);
  await chrome.setBar(ctx, 'searchgh');
  const code = areaTileSimple('codesearch', '🔎 Code', 'manage:codesearch:home');
  const tiles = [plain('🌐 Public repo by link', 'search:type:public'), code].filter(Boolean);
  return ui.show(ctx, '🌐 *Search GitHub*\n\nFind code anywhere on GitHub, or open any public repo by its link\\.\nLooking for one of your own repos? Use 📁 *Search my repos* below\\.', { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rowsOf(tiles)) });
}

/** 🕘 Recent searches — each one a button that runs it again. */
async function showRecentSearches(ctx) {
  const recent = await require('../lib/searchHistory').recent(ctx.from.id, 5).catch(() => []);
  if (!recent.length) return ui.show(ctx, '🕘 *Recent searches*\n\n_Nothing yet\\. Searches you run in My Repos show up here\\._', { parse_mode: 'MarkdownV2' });
  const rows = recent.map((q) => [style.callback(`🕘 ${ui.trunc(q, 40)}`, `search:recent:${q}`.slice(0, 60))]);
  return ui.show(ctx, '🕘 *Recent searches*\n\nTap one to run it again\\.', { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

function areaTileSimple(areaKey, label, data) {
  const found = require('./manage/registry').get(areaKey);
  return found && features.isEnabled(found.key) ? plain(label, data) : null;
}

/** Handles `hub:*` and `nav:*` callbacks. Returns true when it recognised the data. */
async function route(ctx, data) {
  if (typeof data !== 'string') return false;
  if (data.startsWith('nav:')) {
    const [key, ...rest] = data.slice(4).split(':');
    const fn = NAV[key];
    if (!fn) { await ui.expired(ctx); return true; }
    // `nav:uploadhere:<dir>` carries the folder the button was rendered for, so an older message acts on its own folder.
    if ((key === 'uploadhere' || key === 'replacefolder') && ctx.session) ctx.session.currentBrowseDir = rest.join(':');
    await fn(ctx);
    return true;
  }
  if (!data.startsWith('hub:')) return false;
  const [, what] = data.split(':');
  switch (what) {
    case 'settings': await showSettings(ctx); return true;
    case 'prefs': await showPrefs(ctx); return true;
    case 'history': await showHistory(ctx); return true;
    case 'help': await showHelp(ctx); return true;
    case 'search': await showSearch(ctx); return true;
    case 'ws': await showWorkspace(ctx); return true;
    case 'notify': await showNotifications(ctx); return true;
    default: await ui.expired(ctx); return true;
  }
}

module.exports = { showWorkspace, showNotifications, showRecentSearches, showSettings, showPrefs, showHistory, showHelp, showSearch, route, registerNav, NAV, rowsOf };
