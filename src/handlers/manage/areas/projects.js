/** 💼 Workspace → Projects (v1.2.4-multi): GitHub Projects (v2) — browse boards, add draft items. */
const ui = require('../ui');
const input = require('../input');
const { accountCtx } = require('../common');
const proj = require('../../../lib/github/projects');

const { esc, btn, plain, back, trunc, style } = ui;
const D = (action, ...args) => `manage:projects:${[action, ...args].join(':')}`;
const ITEM = { OPEN: '🟢', CLOSED: '🔴', MERGED: '🟣' };

// Project ids are long GraphQL node ids; they are kept server-side per person (session) and referenced by index.
async function list(ctx, c) {
  const org = c.user.isOrg ? c.user.login : null;
  const items = await proj.listProjects(c.token, { org });
  ctx.session.projectIds = items.map((p) => p.id);
  const rows = items.map((p, i) => [plain(`${p.closed ? '✅' : '📋'} ${p.title}`, D('view', i))]);
  rows.push(back('Workspace', 'manage:ws'));
  return ui.screen(ctx, `📋 *Projects* — ${esc(org || c.user.personalLogin || c.user.login)}${items.length ? '' : '\n\n_No projects found\\._'}`, rows);
}

async function handle(ctx, { action, args }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  const idx = Number(args[0]);
  const id = Number.isInteger(idx) ? (ctx.session.projectIds || [])[idx] : null;
  switch (action) {
    case 'home': return list(ctx, c);
    case 'view': {
      if (!id) return list(ctx, c);
      const p = await proj.listItems(c.token, id);
      const body = p.items.slice(0, 20).map((i) => `${ITEM[i.state] || '📝'} ${esc(trunc(i.title || 'Untitled', 70))}${i.status ? ` — _${esc(i.status)}_` : ''}`).join('\n') || '_No items\\._';
      return ui.screen(ctx, `📋 *${esc(p.title)}*\n\n${body}`, [[btn('➕ Add draft item', D('add', idx), style.GREEN)], [ui.link('🔗 Open on GitHub', p.url)], back('Projects', D('home'))]);
    }
    case 'add': if (!id) return list(ctx, c); return input.ask(ctx, { area: 'projects', action: 'add', args: [idx], prompt: '➕ Send the title of the new draft item.', maxLen: 256, cancelData: D('view', idx) });
    default: return ctx.reply('This button has expired.');
  }
}

async function onInput(ctx, { action, args, text }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  const id = (ctx.session.projectIds || [])[Number(args[0])];
  if (action === 'add' && id) {
    await proj.addDraftItem(c.token, id, text);
    return handle(ctx, { action: 'view', args: [args[0]] });
  }
}

module.exports = { key: 'projects', label: 'Projects', emoji: '📋', level: 'account', scopes: ['project'], handle, onInput };
