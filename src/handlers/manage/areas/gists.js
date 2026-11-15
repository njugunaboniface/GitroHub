/** 💼 Workspace → Gists (v1.2.4-multi): list, view, create from text or a file, edit description, delete. */
const ui = require('../ui');
const input = require('../input');
const { accountCtx, pageOf } = require('../common');
const gists = require('../../../lib/github/gists');

const { esc, btn, plain, back, fenced, ago, style } = ui;
const D = (action, ...args) => `manage:gists:${[action, ...args].join(':')}`;
const label = (g) => `${g.public ? '🌐' : '🔒'} ${g.files[0] ? g.files[0].name : 'gist'}${g.description ? ` — ${g.description}` : ''}`;

async function list(ctx, c, pg) {
  const r = await gists.listGists(c.token, { page: pg });
  const rows = ui.listRows({
    items: r.items, render: (g) => ({ label: label(g), data: D('view', g.id) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('list', x),
    extra: [[btn('➕ New gist', D('new'), style.GREEN)]], backRow: back('Workspace', 'manage:ws'),
  });
  return ui.screen(ctx, `📝 *Gists*\n🌐 public · 🔒 secret${r.items.length ? '' : '\n\n_No gists yet\\._'}`, rows);
}

async function view(ctx, g) {
  const f = g.files[0];
  const preview = f && f.content ? fenced(f.content, 1400) : '';
  const lines = [`${g.public ? '🌐' : '🔒'} *${esc(g.description || (f && f.name) || 'Gist')}*`, `${g.files.length} file${g.files.length === 1 ? '' : 's'}: ${esc(g.files.map((x) => x.name).slice(0, 5).join(', '))} · ${esc(ago(g.updatedAt))}`, '', preview];
  return ui.screen(ctx, lines.join('\n'), [
    [ui.link('🔗 Open on GitHub', g.url)],
    [plain('✏️ Description', D('desc', g.id)), btn('🗑 Delete', D('delask', g.id), style.RED)],
    back('Gists', D('list', 1)),
  ]);
}

async function handle(ctx, { action, args }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  const id = args[0];
  switch (action) {
    case 'home': return list(ctx, c, 1);
    case 'list': return list(ctx, c, pageOf(args[0]));
    case 'view': { if (!id) return; return view(ctx, await gists.getGist(c.token, id)); }
    case 'new':
      return input.ask(ctx, { area: 'gists', action: 'content', prompt: '📝 Paste the gist text, or send a text/code file.', acceptsDocument: true, maxLen: 200000, cancelData: D('list', 1) });
    case 'vis': {
      const draft = ctx.session.gistDraft;
      if (!draft || !['public', 'secret'].includes(id)) return ctx.reply('That draft expired — start again with New gist.');
      delete ctx.session.gistDraft;
      const g = await gists.createGist(c.token, { description: draft.description, isPublic: id === 'public', filename: draft.filename, content: draft.content });
      return ui.screen(ctx, `✅ Gist created \\(${id === 'public' ? 'public' : 'secret'}\\)\\.`, [[ui.link('🔗 Open on GitHub', g.url)], [plain('📝 Gists', D('list', 1))]]);
    }
    case 'desc': if (!id) return; return input.ask(ctx, { area: 'gists', action: 'desc', args: [id], prompt: '✏️ Send the new description.', maxLen: 500, cancelData: D('view', id) });
    case 'delask': if (!id) return; return ui.screen(ctx, 'Delete this gist?\n\nThis can’t be undone\\.', ui.confirmRows('🗑 Yes, delete', D('delok', id), D('view', id)));
    case 'delok': if (!id) return; await gists.deleteGist(c.token, id); return list(ctx, c, 1);
    default: return ctx.reply('This button has expired.');
  }
}

async function askVisibility(ctx) {
  return ui.screen(ctx, 'Who can see this gist?', [[plain('🔒 Secret (link only)', D('vis', 'secret'))], [btn('🌐 Public', D('vis', 'public'), style.RED)]]);
}

async function onInput(ctx, { action, args, text }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  if (action === 'content') {
    const fileName = (ctx.message && ctx.message.document && ctx.message.document.file_name) || null;
    ctx.session.gistDraft = { content: text, filename: fileName, description: '' };
    if (fileName) return input.ask(ctx, { area: 'gists', action: 'description', prompt: 'Send a short description, or "-" to skip.', maxLen: 500, cancelData: D('list', 1) });
    return input.ask(ctx, { area: 'gists', action: 'filename', prompt: 'Send the file name (e.g. notes.md).', maxLen: 120, cancelData: D('list', 1) });
  }
  const draft = ctx.session.gistDraft;
  if (action === 'filename') {
    if (!draft) return ctx.reply('That draft expired — start again with New gist.');
    if (!/^[^/\\\0]{1,255}$/.test(text)) throw input.inputError('That isn’t a valid file name.');
    draft.filename = text;
    return input.ask(ctx, { area: 'gists', action: 'description', prompt: 'Send a short description, or "-" to skip.', maxLen: 500, cancelData: D('list', 1) });
  }
  if (action === 'description') {
    if (!draft) return ctx.reply('That draft expired — start again with New gist.');
    draft.description = text === '-' ? '' : text;
    return askVisibility(ctx);
  }
  if (action === 'desc') {
    await gists.updateGistDescription(c.token, args[0], text);
    return view(ctx, await gists.getGist(c.token, args[0]));
  }
}

module.exports = { key: 'gists', label: 'Gists', emoji: '📝', level: 'account', scopes: ['gist'], handle, onInput };
