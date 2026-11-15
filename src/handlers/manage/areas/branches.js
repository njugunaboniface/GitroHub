/** ⚡ Manage → Branches (v1.2.4-multi): list, switch working branch, create, delete, rename, set default, compare, protection rules, fork sync. */
const ui = require('../ui');
const input = require('../input');
const { repoCtx, pageOf, workBranch, setWorkBranch } = require('../common');
const branches = require('../../../lib/github/branches');
const core = require('../../../lib/github/core');

const { esc, btn, plain, back, code, style } = ui;
const D = (action, repo, ...args) => `manage:branches:${[action, repo, ...args].join(':')}`;

const repoInfo = (c) => core.get(c.token, 'GET /repos/{owner}/{repo}', { owner: c.owner, repo: c.repo }, 'Get repo');

async function list(ctx, c, pg) {
  const [info, r] = await Promise.all([repoInfo(c), branches.listBranches(c.token, c.owner, c.repo, { page: pg })]);
  const work = workBranch(ctx, c.repo, info.default_branch);
  const rows = ui.listRows({
    items: r.items,
    render: (b) => ({ label: `${b.name === work ? '📍' : '🌿'} ${b.name}${b.name === info.default_branch ? ' ⭐' : ''}${b.protected ? ' 🔒' : ''}`, data: D('view', c.repo, b.name) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('list', c.repo, x),
    extra: [[btn('➕ New branch', D('new', c.repo), style.GREEN)], ...(info.fork ? [[plain('🔄 Sync fork with upstream', D('fork', c.repo))]] : [])],
    backRow: back('Manage', `manage:hub:${c.repo}`),
  });
  return ui.screen(ctx, `🌿 *Branches* — ${esc(c.repo)}\n⭐ default · 📍 you're working on · 🔒 protected\n\nWorking branch: ${code(work)}`, rows);
}

async function view(ctx, c, name) {
  const [info, sha] = await Promise.all([repoInfo(c), branches.getBranchSha(c.token, c.owner, c.repo, name)]);
  if (!sha) return ui.screen(ctx, '⚠️ That branch no longer exists\\.', [back('Branches', D('list', c.repo, 1))]);
  const isDefault = name === info.default_branch;
  const work = workBranch(ctx, c.repo, info.default_branch);
  let cmpLine = '';
  if (!isDefault) {
    try { const k = await branches.compare(c.token, c.owner, c.repo, info.default_branch, name); cmpLine = `\n${k.ahead} ahead · ${k.behind} behind ${esc(info.default_branch)}`; } catch (_) { /* optional */ }
  }
  const rows = [];
  if (name !== work) rows.push([btn('📍 Work on this branch', D('switch', c.repo, name), style.GREEN)]);
  rows.push([plain('📜 Commits', `manage:commits:list:${c.repo}:${name}:1`), plain('🔒 Protection', D('prot', c.repo, name))]);
  if (!isDefault) {
    rows.push([plain('🔀 Open pull request', `manage:pulls:newfrom:${c.repo}:${name}`), plain('⭐ Make default', D('defask', c.repo, name))]);
    rows.push([plain('✏️ Rename', D('rename', c.repo, name)), btn('🗑 Delete', D('delask', c.repo, name), style.RED)]);
  }
  rows.push([plain('🌱 New branch from this', D('newfrom', c.repo, name))]);
  rows.push(back('Branches', D('list', c.repo, 1)));
  return ui.screen(ctx, `🌿 *${esc(name)}*${isDefault ? ' ⭐ default' : ''}${name === work ? ' 📍' : ''}\nCommit ${code(sha.slice(0, 7))}${cmpLine}`, rows);
}

const yn = (b) => (b ? '✅' : '▫️');

async function protection(ctx, c, name) {
  let p;
  try { p = await branches.getProtection(c.token, c.owner, c.repo, name); } catch (err) {
    if (err && (err.code === 'PLAN_LIMIT' || err.code === 'NO_ACCESS')) {
      return ui.screen(ctx, '🔒 *Branch protection*\n\nGitHub doesn’t allow protection rules here — private repos need a paid GitHub plan, and you need admin rights\\.', [back('Branch', D('view', c.repo, name))]);
    }
    throw err;
  }
  const s = branches.summarizeProtection(p);
  const t = (key, label) => plain(`${yn(s[key])} ${label}`, D('ptoggle', c.repo, name, key));
  const rows = [];
  if (!s.protected) {
    rows.push([btn('🔒 Protect this branch', D('padd', c.repo, name), style.GREEN)]);
  } else {
    rows.push([plain(`${yn(s.reviews > 0)} Require PR reviews (${s.reviews || 0})`, D('prev', c.repo, name))]);
    rows.push([t('dismissStale', 'Dismiss stale reviews'), t('codeOwners', 'Code owner review')]);
    rows.push([t('enforceAdmins', 'Include admins'), t('linear', 'Linear history')]);
    rows.push([t('conversation', 'Resolve conversations'), t('forcePush', 'Allow force pushes')]);
    rows.push([t('deletions', 'Allow deletion')]);
    rows.push([btn('🔓 Remove protection', D('prmask', c.repo, name), style.RED)]);
  }
  rows.push(back('Branch', D('view', c.repo, name)));
  const text = s.protected
    ? `🔒 *Protection — ${esc(name)}*\n\nTap a rule to switch it\\. Status checks are kept as they are on GitHub\\.`
    : `🔓 *${esc(name)}* has no protection rules\\.\n\nProtecting it requires a pull request with 1 approval and blocks force pushes and deletion — you can fine\\-tune afterwards\\.`;
  return ui.screen(ctx, text, rows);
}

async function handle(ctx, { action, args, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const name = args[0];
  switch (action) {
    case 'home': return list(ctx, c, 1);
    case 'list': return list(ctx, c, pageOf(args[0]));
    case 'view': if (!name) return; return view(ctx, c, name);
    case 'switch': if (!name) return; setWorkBranch(ctx, c.repo, name); return list(ctx, c, 1);
    case 'new': return input.ask(ctx, { area: 'branches', action: 'create', repoName, args: [], prompt: '🌱 Send the new branch name (created from the default branch).', maxLen: 120, cancelData: D('list', c.repo, 1) });
    case 'newfrom': if (!name) return; return input.ask(ctx, { area: 'branches', action: 'create', repoName, args: [name], prompt: `🌱 Send the new branch name (created from ${name}).`, maxLen: 120, cancelData: D('view', c.repo, name) });
    case 'rename': if (!name) return; return input.ask(ctx, { area: 'branches', action: 'rename', repoName, args: [name], prompt: `✏️ Send the new name for ${name}.`, maxLen: 120, cancelData: D('view', c.repo, name) });
    case 'delask': if (!name) return; return ui.screen(ctx, `Delete branch *${esc(name)}*?\n\nCommits not merged anywhere else become hard to find\\.`, ui.confirmRows('🗑 Yes, delete', D('delok', c.repo, name), D('view', c.repo, name)));
    case 'delok': {
      if (!name) return;
      const info = await repoInfo(c);
      if (name === info.default_branch) return ctx.reply('The default branch can’t be deleted. Make another branch the default first.');
      await branches.deleteBranch(c.token, c.owner, c.repo, name);
      if (workBranch(ctx, c.repo) === name) setWorkBranch(ctx, c.repo, null);
      return list(ctx, c, 1);
    }
    case 'defask': if (!name) return; return ui.screen(ctx, `Make *${esc(name)}* the default branch?\n\nNew clones, pull requests and the repo page will use it\\.`, ui.confirmRows('⭐ Yes, make default', D('defok', c.repo, name), D('view', c.repo, name)));
    case 'defok': if (!name) return; await branches.setDefaultBranch(c.token, c.owner, c.repo, name); setWorkBranch(ctx, c.repo, null); return list(ctx, c, 1);
    case 'prot': if (!name) return; return protection(ctx, c, name);
    case 'padd': if (!name) return; await branches.setProtection(c.token, c.owner, c.repo, name, null, { requirePr: true, reviews: 1, forcePush: false, deletions: false }); return protection(ctx, c, name);
    case 'ptoggle': {
      const key = args[1];
      if (!name || !['dismissStale', 'codeOwners', 'enforceAdmins', 'linear', 'conversation', 'forcePush', 'deletions'].includes(key)) return;
      const cur = await branches.getProtection(c.token, c.owner, c.repo, name);
      if (!cur) return protection(ctx, c, name);
      const s = branches.summarizeProtection(cur);
      const changes = { [key]: !s[key] };
      if ((key === 'dismissStale' || key === 'codeOwners') && !s.requirePr) changes.requirePr = true;
      await branches.setProtection(c.token, c.owner, c.repo, name, cur, changes);
      return protection(ctx, c, name);
    }
    case 'prev': {
      if (!name) return;
      const cur = await branches.getProtection(c.token, c.owner, c.repo, name);
      if (!cur) return protection(ctx, c, name);
      const s = branches.summarizeProtection(cur);
      const next = !s.requirePr ? 1 : s.reviews >= 6 ? 0 : s.reviews + 1; // off → 1 → … → 6 → off
      await branches.setProtection(c.token, c.owner, c.repo, name, cur, next === 0 ? { requirePr: false, reviews: 0 } : { requirePr: true, reviews: next });
      return protection(ctx, c, name);
    }
    case 'prmask': if (!name) return; return ui.screen(ctx, `Remove all protection from *${esc(name)}*?`, ui.confirmRows('🔓 Yes, remove', D('prmok', c.repo, name), D('prot', c.repo, name)));
    case 'prmok': if (!name) return; await branches.removeProtection(c.token, c.owner, c.repo, name); return protection(ctx, c, name);
    case 'fork': {
      const st = await branches.forkStatus(c.token, c.owner, c.repo);
      if (!st) return ui.screen(ctx, 'This repo isn’t a fork\\.', [back('Branches', D('list', c.repo, 1))]);
      const rows = [];
      if (st.behind > 0) rows.push([btn('🔄 Sync now', D('forkok', c.repo), style.GREEN)]);
      rows.push(back('Branches', D('list', c.repo, 1)));
      return ui.screen(ctx, `🔄 *Fork of ${esc(st.parent)}*\n\nBranch ${code(st.branch)}: ${st.behind} behind · ${st.ahead} ahead upstream\\.${st.behind === 0 ? '\n\n✅ Already up to date\\.' : ''}${st.ahead > 0 && st.behind > 0 ? '\n\n⚠️ It also has its own commits — GitHub may refuse if they conflict\\.' : ''}`, rows);
    }
    case 'forkok': {
      const info = await repoInfo(c);
      const r = await branches.syncFork(c.token, c.owner, c.repo, info.default_branch);
      return ui.screen(ctx, `✅ ${esc(r.message)}`, [back('Branches', D('list', c.repo, 1))]);
    }
    default: return ctx.reply('This button has expired.');
  }
}

async function onInput(ctx, { action, args, repoName, text }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  if (action === 'create') {
    let name;
    try { name = core.assertBranchName(text); } catch (e) { throw input.inputError(e.message); }
    let from = args[0];
    if (!from) from = (await repoInfo(c)).default_branch;
    const sha = await branches.getBranchSha(c.token, c.owner, c.repo, from);
    if (!sha) throw input.inputError('The branch to copy from no longer exists.');
    if (await branches.getBranchSha(c.token, c.owner, c.repo, name)) throw input.inputError(`A branch called ${name} already exists.`);
    await branches.createBranch(c.token, c.owner, c.repo, name, sha);
    setWorkBranch(ctx, c.repo, name);
    return ui.screen(ctx, `✅ Created *${esc(name)}* from ${esc(from)} and switched to it\\.`, [[plain('🌿 Open branch', D('view', c.repo, name))], back('Branches', D('list', c.repo, 1))]);
  }
  if (action === 'rename') {
    let to;
    try { to = core.assertBranchName(text); } catch (e) { throw input.inputError(e.message); }
    await branches.renameBranch(c.token, c.owner, c.repo, args[0], to);
    if (workBranch(ctx, c.repo) === args[0]) setWorkBranch(ctx, c.repo, to);
    return ui.screen(ctx, `✅ Renamed to *${esc(to)}*\\.`, [[plain('🌿 Open branch', D('view', c.repo, to))], back('Branches', D('list', c.repo, 1))]);
  }
}

module.exports = { key: 'branches', label: 'Branches', emoji: '🌿', level: 'repo', scopes: [], handle, onInput };
