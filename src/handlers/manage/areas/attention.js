/** 💼 Workspace → 📬 Needs attention (v1.2.5-multi): what is waiting on you, one tap to each list — and what the start card counts. */
const ui = require('../ui');
const { accountCtx } = require('../common');
const needs = require('../../../lib/needsYou');
const userPrefs = require('../../../lib/userPrefs');
const accounts = require('../../../lib/accounts');

const { esc, plain, back } = ui;
const D = (action, ...args) => `manage:attn:${[action, ...args].join(':')}`;

async function home(ctx, c, { force = false } = {}) {
  const account = await accounts.activeLoginOf(ctx.from.id);
  const prefs = await userPrefs.getAll(ctx.from.id);
  let counts = null; let stale = false;
  try { counts = await needs.counts(ctx.from.id, account, c.token, { force }); } catch (err) { counts = needs.cached(ctx.from.id, account); stale = true; if (!counts) throw err; }
  const other = await needs.elsewhere(ctx.from.id, account);
  const nothing = !counts || (!counts.review && !counts.changes && !counts.open && !counts.failing && !counts.issues && !counts.notifs);
  const row = (n, label, view) => (n ? [[plain(`${label} (${n})`, `manage:mywork:v:${view}:1`)]] : []);
  const rows = [
    ...row(counts && counts.review, '👀 PRs waiting for my review', 'review'),
    ...row(counts && counts.changes, '🛑 My PRs — changes requested', 'changes'),
    ...row(counts && counts.open, '🔀 My open PRs', 'authored'),
    ...row(counts && counts.failing, '❌ My PRs — failing checks', 'failing'),
    ...row(counts && counts.issues, '🐞 Issues assigned to me', 'assigned'),
    ...(counts && counts.notifs ? [[plain(`🔔 Unread notifications (${counts.notifs >= 50 ? '50+' : counts.notifs})`, 'manage:notify:list:unread:1')]] : []),
    [plain('🔄 Refresh', D('refresh')), plain('⚙️ What to count', D('prefs'))],
    back('Notifications', 'manage:notify:home'),
  ];
  const lines = ['📌 *Needs me*'];
  lines.push(nothing ? '\n_Nothing is waiting on you\\. 🎉_' : '\nWhat is waiting on you right now:');
  if (other.sum) lines.push(`\n\\+${other.sum} more on ${other.accountsWith === 1 ? 'another account' : `${other.accountsWith} other accounts`} — switch account to see ${other.accountsWith === 1 ? 'it' : 'them'}\\.`);
  if (stale) lines.push('\n_Showing the last known numbers — GitHub didn’t answer just now\\._');
  if (!prefs.needs_line) lines.push('\n_The start-card line is switched off \\(⚙️ What to count\\)\\._');
  return ui.screen(ctx, lines.join(''), rows);
}

async function prefsScreen(ctx) {
  const prefs = await userPrefs.getAll(ctx.from.id);
  const rows = userPrefs.KEYS.map((k) => [plain(`${prefs[k] ? '✅' : '▫️'} ${userPrefs.DEFS[k].label}`, D('tog', k))]);
  rows.push(back('Needs attention', D('home')));
  return ui.screen(ctx, `⚙️ *What to count*\n\nChoose what the start card’s “needs you” line includes\\. ${esc('The daily summary is sent around 8:00 your time, never during quiet hours.')}`, rows);
}

async function handle(ctx, { action, args }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  switch (action) {
    case 'home': return home(ctx, c);
    case 'refresh': return home(ctx, c, { force: true });
    case 'prefs': return prefsScreen(ctx);
    case 'tog': {
      const key = args[0];
      if (!userPrefs.DEFS[key]) return;
      await userPrefs.set(ctx.from.id, key, !(await userPrefs.get(ctx.from.id, key)));
      return prefsScreen(ctx);
    }
    default: return ctx.reply('This button has expired.');
  }
}

module.exports = { key: 'attn', label: 'Needs attention', emoji: '📬', level: 'account', scopes: [], handle };
