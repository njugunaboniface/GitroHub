/** 💼 Workspace → Organisations (v1.2.4-multi): choose whose repos 📁 My Repos shows — you or one of your orgs. */
const ui = require('../ui');
const { accountCtx, pageOf } = require('../common');
const orgsApi = require('../../../lib/github/orgs');
const accounts = require('../../../lib/accounts');

const { esc, plain, back, trunc } = ui;
const D = (action, ...args) => `manage:orgs:${[action, ...args].join(':')}`;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

async function home(ctx, c, pg) {
  const [r, active] = await Promise.all([orgsApi.listOrgs(c.token, { page: pg }), accounts.getActiveOwner(ctx.from.id)]);
  const me = c.user.personalLogin || c.user.login;
  const rows = [];
  if (pg === 1) rows.push([plain(`${active ? '⚪' : '✅'} ${me} (personal)`, D('use', '-'))]);
  for (const o of r.items) rows.push([plain(`${active && active.toLowerCase() === o.login.toLowerCase() ? '✅' : '⚪'} 🏢 ${o.login}`, D('use', o.login))]);
  const p = ui.pager(pg, r.hasNext, (x) => D('home', x)); if (p.length) rows.push(p);
  rows.push([plain('📁 Open My Repos', 'repos:refresh')]);
  rows.push(back('Workspace', 'manage:ws'));
  return ui.screen(ctx, `🏢 *Organisations*\n\nShowing: *${esc(active || `${me} (personal)`)}*\n\n📁 My Repos, ➕ New Repo and the Manage tools all work on the selected owner — repos never mix\\.${r.items.length ? '' : '\n\n_You aren’t in any organisation \\(or none has approved GitroHub — see GitHub → Settings → Applications\\)\\._'}`, rows);
}

async function handle(ctx, { action, args }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  switch (action) {
    case 'home': return home(ctx, c, pageOf(args[0]));
    case 'use': {
      const login = args[0];
      if (login === '-') await accounts.setActiveOwner(ctx.from.id, null);
      else {
        if (!LOGIN.test(login || '')) return;
        const m = await orgsApi.membership(c.token, login).catch(() => null);
        if (!m || m.state !== 'active') return ctx.reply(`You don’t have an active membership in ${trunc(login, 40)} (or the organisation hasn’t approved GitroHub).`);
        await accounts.setActiveOwner(ctx.from.id, login);
      }
      ctx.session.workBranch = {}; delete ctx.session.currentRepo;
      return home(ctx, c, 1);
    }
    default: return ctx.reply('This button has expired.');
  }
}

module.exports = { key: 'orgs', label: 'Organisations', emoji: '🏢', level: 'account', scopes: ['read:org'], handle };
