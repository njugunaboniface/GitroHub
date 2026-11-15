/** ⚡ Manage → Releases & tags (v1.2.4-multi): create/edit/delete releases, create/delete tags. */
const ui = require('../ui');
const input = require('../input');
const { repoCtx, num, pageOf, workBranch } = require('../common');
const rel = require('../../../lib/github/releases');

const { esc, btn, plain, back, code, ago, trunc, style } = ui;
const D = (action, repo, ...args) => `manage:releases:${[action, repo, ...args].join(':')}`;

async function list(ctx, c, pg) {
  const r = await rel.listReleases(c.token, c.owner, c.repo, { page: pg });
  const rows = ui.listRows({
    items: r.items,
    render: (x) => ({ label: `${x.draft ? '📝' : x.prerelease ? '🧪' : '🏷'} ${x.name === x.tag ? x.tag : `${x.tag} · ${x.name}`}`, data: D('view', c.repo, x.id) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('list', c.repo, x),
    extra: [[btn('➕ New release', D('new', c.repo), style.GREEN), plain('🏷 Tags', D('tags', c.repo, 1))]],
    backRow: back('Manage', `manage:hub:${c.repo}`),
  });
  return ui.screen(ctx, `🚀 *Releases* — ${esc(c.repo)}\n📝 draft · 🧪 pre\\-release${r.items.length ? '' : '\n\n_No releases yet\\._'}`, rows);
}

async function view(ctx, c, id) {
  const r = await rel.getRelease(c.token, c.owner, c.repo, id);
  const lines = [`🚀 *${esc(r.name)}*`, `${code(r.tag)} · ${r.draft ? 'Draft' : r.prerelease ? 'Pre\\-release' : 'Published'} · ${esc(ago(r.publishedAt || r.createdAt))}`];
  if (r.assets.length) lines.push(`📎 ${r.assets.length} file${r.assets.length === 1 ? '' : 's'} · ${r.assets.reduce((a, b) => a + (b.downloads || 0), 0)} downloads`);
  if (r.body) lines.push('', esc(trunc(r.body, 900)));
  const rows = [
    [plain(r.draft ? '📢 Publish' : '📝 Make draft', D('toggle', c.repo, id, 'draft')), plain(r.prerelease ? '✅ Mark stable' : '🧪 Mark pre-release', D('toggle', c.repo, id, 'prerelease'))],
    [plain('✏️ Title', D('edit', c.repo, id, 'name')), plain('✏️ Notes', D('edit', c.repo, id, 'body'))],
    [btn('🗑 Delete', D('delask', c.repo, id), style.RED)],
  ];
  if (r.url) rows.push([ui.link('🔗 Open on GitHub', r.url)]);
  rows.push(back('Releases', D('list', c.repo, 1)));
  return ui.screen(ctx, lines.join('\n'), rows);
}

async function tags(ctx, c, pg) {
  const r = await rel.listTags(c.token, c.owner, c.repo, { page: pg });
  const rows = ui.listRows({
    items: r.items, render: (t) => ({ label: `🏷 ${t.name}`, data: D('tagview', c.repo, t.name) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('tags', c.repo, x),
    extra: [[btn('➕ New tag', D('newtag', c.repo), style.GREEN)]], backRow: back('Releases', D('list', c.repo, 1)),
  });
  return ui.screen(ctx, `🏷 *Tags* — ${esc(c.repo)}${r.items.length ? '' : '\n\n_No tags yet\\._'}`, rows);
}

async function handle(ctx, { action, args, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const id = num(args[0]);
  switch (action) {
    case 'home': return list(ctx, c, 1);
    case 'list': return list(ctx, c, pageOf(args[0]));
    case 'view': if (!id) return; return view(ctx, c, id);
    case 'new': return input.ask(ctx, { area: 'releases', action: 'tag', repoName, prompt: '🚀 Send the tag for the release, e.g. v1.2.0. It is created on the default branch if it doesn’t exist.', maxLen: 100, cancelData: D('list', c.repo, 1) });
    case 'toggle': {
      if (!id || !['draft', 'prerelease'].includes(args[1])) return;
      const cur = await rel.getRelease(c.token, c.owner, c.repo, id);
      await rel.editRelease(c.token, c.owner, c.repo, id, { [args[1]]: !cur[args[1]] });
      return view(ctx, c, id);
    }
    case 'edit': if (!id || !['name', 'body'].includes(args[1])) return; return input.ask(ctx, { area: 'releases', action: `edit_${args[1]}`, repoName, args: [id], prompt: args[1] === 'name' ? '✏️ Send the new release title.' : '✏️ Send the new release notes.', maxLen: args[1] === 'name' ? 200 : 4000, cancelData: D('view', c.repo, id) });
    case 'delask': if (!id) return; return ui.screen(ctx, 'Delete this release?\n\nThe git tag stays unless you choose to remove it too\\.', [[btn('🗑 Delete release only', D('delok', c.repo, id, 'no'), style.RED)], [btn('🗑 Delete release and tag', D('delok', c.repo, id, 'yes'), style.RED)], [btn('❌ Cancel', D('view', c.repo, id), style.GREEN)]]);
    case 'delok': {
      if (!id) return;
      const cur = await rel.getRelease(c.token, c.owner, c.repo, id).catch(() => null);
      await rel.deleteRelease(c.token, c.owner, c.repo, id, { alsoTag: args[1] === 'yes' && cur ? cur.tag : null });
      return list(ctx, c, 1);
    }
    case 'tags': return tags(ctx, c, pageOf(args[0]));
    case 'tagview': {
      const name = args[0]; if (!name) return;
      return ui.screen(ctx, `🏷 *${esc(name)}*`, [[plain('🚀 Release from this tag', D('fromtag', c.repo, name))], [btn('🗑 Delete tag', D('tagdelask', c.repo, name), style.RED)], back('Tags', D('tags', c.repo, 1))]);
    }
    case 'fromtag': {
      const name = args[0]; if (!name) return;
      return input.ask(ctx, { area: 'releases', action: 'notes', repoName, args: [name], prompt: `📝 Send release notes for ${name}, or "-" to auto-generate them.`, cancelData: D('tags', c.repo, 1) });
    }
    case 'newtag': return input.ask(ctx, { area: 'releases', action: 'newtag', repoName, prompt: `🏷 Send the new tag name. It points at the tip of ${workBranch(ctx, c.repo, 'the default branch')}.`, maxLen: 100, cancelData: D('tags', c.repo, 1) });
    case 'tagdelask': { const name = args[0]; if (!name) return; return ui.screen(ctx, `Delete tag *${esc(name)}*?\n\nA release using it becomes a draft on GitHub\\.`, ui.confirmRows('🗑 Yes, delete tag', D('tagdelok', c.repo, name), D('tagview', c.repo, name))); }
    case 'tagdelok': { const name = args[0]; if (!name) return; await rel.deleteTag(c.token, c.owner, c.repo, name); return tags(ctx, c, 1); }
    default: return ctx.reply('This button has expired.');
  }
}

async function onInput(ctx, { action, args, repoName, text }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const id = num(args[0]);
  const tagOrThrow = (t) => { try { return rel.assertTagName(t); } catch (e) { throw input.inputError(e.message); } };
  if (action === 'tag') {
    const tag = tagOrThrow(text);
    return input.ask(ctx, { area: 'releases', action: 'notes', repoName, args: [tag], prompt: `📝 Send release notes for ${tag}, or "-" to auto-generate them.`, cancelData: D('list', c.repo, 1) });
  }
  if (action === 'notes') {
    const tag = args[0];
    const auto = text === '-';
    const r = await rel.createRelease(c.token, c.owner, c.repo, { tag, body: auto ? '' : text, generateNotes: auto });
    return ui.screen(ctx, `✅ Released *${esc(r.name)}*`, [[plain('🚀 View', D('view', c.repo, r.id))], ...(r.url ? [[ui.link('🔗 Open on GitHub', r.url)]] : [])]);
  }
  if (action === 'edit_name' || action === 'edit_body') {
    await rel.editRelease(c.token, c.owner, c.repo, id, { [action === 'edit_name' ? 'name' : 'body']: text });
    return view(ctx, c, id);
  }
  if (action === 'newtag') {
    const tag = tagOrThrow(text);
    await rel.createTag(c.token, c.owner, c.repo, tag, { branch: workBranch(ctx, c.repo) || (await require('../../../lib/github/core').get(c.token, 'GET /repos/{owner}/{repo}', { owner: c.owner, repo: c.repo }, 'Get repo')).default_branch });
    return tags(ctx, c, 1);
  }
}

module.exports = { key: 'releases', label: 'Releases', emoji: '🚀', level: 'repo', scopes: [], handle, onInput };
