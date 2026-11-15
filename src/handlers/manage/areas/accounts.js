/** 💼 Workspace → GitHub accounts (v1.2.4-multi): switch between up to 5 connected accounts, add another, remove one. */
const ui = require('../ui');
const { accountCtx } = require('../common');
const accounts = require('../../../lib/accounts');
const oauth = require('../../../lib/oauth');

const { esc, plain, back } = ui;
const D = (action, ...args) => `manage:accounts:${[action, ...args].join(':')}`;

async function home(ctx) {
  const list = await accounts.list(ctx.from.id);
  const rows = list.map((a) => [a.active ? plain(`✅ @${a.login} (active)`, D('home')) : plain(`⚪ @${a.login}`, D('use', a.login))]);
  if (list.length < accounts.MAX_ACCOUNTS) rows.push([ui.link('➕ Add another account', await oauth.connectUrl(ctx.from.id))]);
  const others = list.filter((a) => !a.active);
  if (others.length) rows.push([plain('🗑 Remove an account', D('rm'))]);
  rows.push([plain('🔐 Permissions', D('perms')), plain('🔑 Sign-in log', 'activity:accesslog')]);
  rows.push([plain('🚪 Disconnect', 'nav:disconnect')]);
  rows.push(back('Settings', 'hub:settings'));
  return ui.screen(ctx, `👤 *Accounts & access* — GitHub accounts \\(${list.length}/${accounts.MAX_ACCOUNTS}\\)\n\nEverything in the bot — repos, tags, settings — works on the *active* account\\. Tap another one to switch\\.\n\n_To add an account tap Add, then choose *Use a different account* on GitHub’s account picker\\._`, rows);
}

const SCOPE_WORDS = {
  repo: 'Repos, files, pull requests, issues, notifications', delete_repo: 'Deleting a repo (always asks you first)',
  gist: 'Gists', notifications: 'GitHub notifications inbox', 'read:org': 'Your organisations', project: 'GitHub Projects',
};

/** What this account has granted, in plain words, plus one tap to grant everything the bot can use. */
async function perms(ctx) {
  const user = await require('../../../lib/users').getUser(ctx.from.id);
  const granted = require('../../../lib/scopes').parse(user && user.github_scope);
  const all = require('../../../lib/scopes');
  const lines = [...all.BASE_SCOPES, ...all.ALLOWED_EXTRA_SCOPES].map((s) => `${all.hasScope(granted, s) ? '✅' : '▫️'} ${esc(SCOPE_WORDS[s] || s)}`);
  const lacking = [...all.BASE_SCOPES, ...all.ALLOWED_EXTRA_SCOPES].some((s) => !all.hasScope(granted, s));
  const rows = [];
  if (lacking) rows.push([ui.link('🔓 Grant all permissions', await oauth.connectUrl(ctx.from.id))]);
  rows.push(back('Accounts', D('home')));
  return ui.screen(ctx, `🔐 *Permissions*\n\n${lines.join('\n')}${lacking ? '\n\nOne tap grants the rest\\. Nothing changes until you approve on GitHub\\.' : '\n\nEverything the bot can use is granted\\.'}`, rows);
}

async function handle(ctx, { action, args }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  const login = args[0];
  switch (action) {
    case 'home': return home(ctx);
    case 'perms': return perms(ctx);
    case 'use': {
      if (!login) return;
      const done = await accounts.activate(ctx.from.id, login);
      if (!done) return ctx.reply('That account can’t be switched to any more — add it again.');
      ctx.session.workBranch = {}; delete ctx.session.currentRepo;
      await ctx.reply(`✅ Switched to @${done.login}.`);
      return home(ctx);
    }
    case 'rm': {
      const list = (await accounts.list(ctx.from.id)).filter((a) => !a.active);
      return ui.screen(ctx, 'Remove which account from GitroHub?\n\nThe active account is removed from ⚙️ Settings → Disconnect\\.', [...list.map((a) => [plain(`🗑 @${a.login}`, D('rmask', a.login))]), back('Accounts', D('home'))]);
    }
    case 'rmask': if (!login) return; return ui.screen(ctx, `Remove *@${esc(login)}* from GitroHub?\n\nYour GitHub account itself is untouched \\(you can also revoke GitroHub under GitHub → Settings → Applications\\)\\.`, ui.confirmRows('🗑 Yes, remove', D('rmok', login), D('home')));
    case 'rmok': {
      if (!login) return;
      const active = await accounts.activeLoginOf(ctx.from.id);
      if (active && active.toLowerCase() === login.toLowerCase()) return ctx.reply('That’s your active account — use ⚙️ Settings → Disconnect for it.');
      await accounts.removeAccount(ctx.from.id, login);
      require('../../../lib/sensitiveActions').note(ctx, { action: 'account_removed', detail: login }).catch(() => {});
      return home(ctx);
    }
    default: return ctx.reply('This button has expired.');
  }
}

module.exports = { key: 'accounts', label: 'Accounts', emoji: '👤', level: 'account', scopes: [], handle };
