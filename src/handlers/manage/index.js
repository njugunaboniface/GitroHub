/**
 * ⚡ Manage hub + callback dispatcher (v1.2.4-multi).
 *
 * ONE entry point — `route(ctx, data)` — for every `manage:*` button, so each
 * feature area gets the same guards in the same order without re-implementing
 * them:
 *
 *   1. the person is connected (else the normal connect prompt)
 *   2. the area exists and its feature switch is on
 *   3. they have every OAuth scope the area needs (else a one-tap
 *      "grant one more permission" prompt — never a half-working feature)
 *   4. repo-level callbacks carry a valid repo name
 *   5. the area's handler runs inside a try/catch that reports GitHub errors
 *      the standard way (rate limits, revoked token → reconnect, …)
 *
 * Hub screens:  manage:hub:<repo>   per-repo ⚡ Manage
 *               manage:ws           account-level 💼 Workspace
 */
const registry = require('./registry');
const style = require('../../keyboards/buttonStyle');
const { Markup } = require('telegraf');
const format = require('../../lib/format');
const users = require('../../lib/users');
const scopes = require('../../lib/scopes');
const features = require('../../lib/features');
const { validateRepoName } = require('../../lib/repoName');

const PREFIX = 'manage:';

/** Parses `manage:<seg>:<seg>…` → string[] without the prefix, or null. */
function parse(data) {
  if (typeof data !== 'string' || !data.startsWith(PREFIX)) return null;
  const parts = data.slice(PREFIX.length).split(':');
  return parts.length && parts[0] ? parts : null;
}

const { show } = require('./ui');

async function promptConnect(ctx) {
  const { sendConnectPrompt } = require('../start');
  return sendConnectPrompt(ctx, { intro: 'Connect your GitHub account first.' });
}

/** Shown when a needed scope is missing: explains and offers the reconnect link. */
async function promptMissingScopes(ctx, area, missingScopes) {
  const url = require('../../lib/oauth').buildAuthorizeUrl(ctx.from.id, { extraScopes: missingScopes });
  const names = missingScopes.map((s) => `\`${format.escapeMd(s)}\``).join(', ');
  await ctx.reply(
    `🔐 *${format.escapeMd(area.label)}* needs one more GitHub permission: ${names}\\.\n\n` +
    'Tap below and approve it on GitHub\\. Your repos, tags and settings stay exactly as they are\\.',
    { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.url('🔗 Grant permission on GitHub', url)]]) }
  );
}

/** Validates a repo-level callback's repo name; replies and returns null if bad. */
async function repoFrom(ctx, raw) {
  const v = validateRepoName(raw);
  if (!v.ok) {
    await ctx.reply('⚠️ That button points at an invalid repo name. Open the repo again from 📁 My Repos.');
    return null;
  }
  return v.name;
}

async function runArea(ctx, area, parts) {
  const [action, ...rest] = parts;
  if (!action || !registry.SEGMENT_RE.test(action)) {
    await ctx.reply('This button has expired.');
    return;
  }
  const call = { action, args: rest, repoName: null };
  if (area.level === 'repo') {
    const repoName = await repoFrom(ctx, rest[0]);
    if (!repoName) return;
    call.repoName = repoName;
    call.args = rest.slice(1);
  }
  try {
    await area.handle(ctx, call);
  } catch (err) {
    await require('../../lib/errorHelpers').replyGithubError(ctx, err, area.label);
  }
}

/** Handles any `manage:*` callback. Returns true if it recognised the data. */
async function route(ctx, data) {
  const parts = parse(data);
  if (!parts) return false;

  // v1.3.0-multi: the Workspace home is visible while disconnected too (it shows a Connect button and limited tiles)
  if (parts[0] === 'ws') { await showWorkspace(ctx); return true; }
  if (!(await users.isConnected(ctx.from.id))) { await promptConnect(ctx); return true; }

  if (parts[0] === 'hub') {
    const repoName = await repoFrom(ctx, parts[1]);
    if (repoName) await showHub(ctx, repoName);
    return true;
  }
  if (parts[0] === 'cancel') {
    require('./input').clear(ctx);
    try { await ctx.editMessageReplyMarkup(undefined); } catch (_) { /* already gone */ }
    await ctx.reply('Cancelled.');
    return true;
  }
  if (parts[0] === 'ws') { await showWorkspace(ctx); return true; }

  const area = registry.get(parts[0]);
  if (!area) { await require('./ui').expired(ctx); return true; }

  if (!features.isEnabled(area.key)) {
    await ctx.reply(`⏸️ ${area.label} is switched off by the bot's admins right now. Try again later.`);
    return true;
  }
  if (area.scopes.length) {
    const user = await users.getUser(ctx.from.id);
    const lacking = scopes.missing(user && user.github_scope, area.scopes);
    if (lacking.length) { await promptMissingScopes(ctx, area, lacking); return true; }
  }
  // v1.2.5-multi: an admin may have paused this area for THIS person only; every tap is audited (who, which account).
  const watch = require('../../lib/sensitiveActions');
  if (await watch.isPaused(ctx.from.id, area.key)) {
    await ctx.reply(`⏸️ ${area.label} is paused for your account by the bot's admins. Contact an admin if you think this is a mistake.`);
    return true;
  }
  watch.audit(ctx.from.id, area.key, parts[1] || 'home', area.level === 'repo' ? parts[2] : null).catch(() => {});
  await runArea(ctx, area, parts.slice(1));
  return true;
}

const available = (level) => registry.list(level).filter((a) => features.isEnabled(a.key));

/** v1.3.0-multi: the ⚡ Manage hub is shown in four groups so ten areas don't read as one long list. */
const MANAGE_GROUPS = [
  { title: '🤝 Collaborate', keys: ['pulls', 'issues', 'milestones'] },
  { title: '💻 Code', keys: ['branches', 'commits', 'restore', 'releases'] },
  { title: '🤖 Automate', keys: ['actions', 'security', 'access'] },
  { title: '📈 Insights', keys: ['insights'] },
];

/** Groups the enabled repo areas; any area not named above lands in a trailing "More" group. */
function manageGroups() {
  const enabled = available('repo');
  const named = new Set(MANAGE_GROUPS.flatMap((g) => g.keys));
  const groups = MANAGE_GROUPS.map((g) => ({ title: g.title, areas: g.keys.map((k) => enabled.find((a) => a.key === k)).filter(Boolean) }));
  const rest = enabled.filter((a) => !named.has(a.key));
  if (rest.length) groups.push({ title: '➕ More', areas: rest });
  return groups.filter((g) => g.areas.length);
}

/** Per-repo ⚡ Manage screen. */
async function showHub(ctx, repoName) {
  const rows = [];
  const lines = [];
  for (const g of manageGroups()) {
    lines.push(`${g.title}: ${g.areas.map((a) => format.escapeMd(a.label)).join(' · ')}`);
    const buttons = g.areas.map((a) => style.callback(`${a.emoji} ${a.label}`, `manage:${a.key}:home:${repoName}`, style.BLUE));
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  }
  if (!rows.length) {
    await show(ctx, 'Nothing to manage here yet.', Markup.inlineKeyboard([[style.callback('⬅️ Back', `repo:${repoName}`, style.BLUE)]]));
    return;
  }
  rows.push([style.callback('⬅️ Back to repo', `repo:${repoName}`, style.BLUE), style.callback('💼 Workspace', 'manage:ws', style.BLUE)]);
  await show(ctx, `⚡ *Manage* — ${format.escapeMd(repoName)}\n\n${lines.join('\n')}`, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

/** Account-level 💼 Workspace screen (v1.3.0-multi: built by handlers/hub.js). */
async function showWorkspace(ctx) { return require('../hub').showWorkspace(ctx); }

/** True when ⚡ Manage / 💼 Workspace have at least one live area to show. */
const hasRepoAreas = () => available('repo').length > 0;
const hasAccountAreas = () => available('account').length > 0;

module.exports = { route, parse, showHub, showWorkspace, hasRepoAreas, hasAccountAreas, registry };
