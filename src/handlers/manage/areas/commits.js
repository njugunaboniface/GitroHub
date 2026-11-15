/** ⚡ Manage → Commits (v1.2.4-multi): browse history, view a commit's diff, revert a commit. */
const ui = require('../ui');
const { repoCtx, pageOf, workBranch } = require('../common');
const commits = require('../../../lib/github/commits');
const core = require('../../../lib/github/core');

const { esc, btn, plain, back, code, fenced, ago, trunc, style } = ui;
const D = (action, repo, ...args) => `manage:commits:${[action, repo, ...args].join(':')}`;
const SHA = /^[0-9a-f]{7,40}$/i;
const BR = (b) => (b && b !== '-' ? b : null);

async function list(ctx, c, branch, pg) {
  const sha = branch || workBranch(ctx, c.repo);
  const r = await commits.listCommits(c.token, c.owner, c.repo, { sha, page: pg });
  const rows = ui.listRows({
    items: r.items,
    render: (m) => ({ label: `${m.short} ${m.message}`, data: D('view', c.repo, m.short, sha || '-') }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('list', c.repo, sha || '-', x),
    backRow: back(sha ? 'Branch' : 'Manage', sha ? `manage:branches:view:${c.repo}:${sha}` : `manage:hub:${c.repo}`),
  });
  return ui.screen(ctx, `📜 *Commits* — ${esc(c.repo)}${sha ? ` · ${esc(sha)}` : ''}\nPage ${pg}${r.items.length ? '' : '\n\n_No commits\\._'}`, rows);
}

async function view(ctx, c, sha, branch) {
  const m = await commits.getCommit(c.token, c.owner, c.repo, sha);
  const lines = [
    `📜 *${esc(m.short)}* — ${esc(trunc(m.message.split('\n')[0], 200))}`,
    `${esc(m.author)} · ${esc(ago(m.date))}`,
    `${m.files.length} file${m.files.length === 1 ? '' : 's'} · \\+${m.stats.additions} \\-${m.stats.deletions}`,
    '',
    ...m.files.slice(0, 15).map((f) => `• ${code(f.filename)} \\(${esc(f.status)}\\)`),
  ];
  if (m.files.length > 15) lines.push(`… and ${m.files.length - 15} more`);
  const rows = m.files.slice(0, 8).map((f, i) => [plain(`📄 ${f.filename.split('/').pop()}`, D('file', c.repo, m.short, i, branch || '-'))]);
  rows.push([btn('↩️ Revert this commit', D('revask', c.repo, m.short, branch || '-'), style.RED), plain('⏪ More undo options', `manage:restore:vview:${c.repo}:${m.short}:${branch || '-'}`)]);
  if (m.url) rows.push([ui.link('🔗 Open on GitHub', m.url)]);
  rows.push(back('Commits', D('list', c.repo, branch || '-', 1)));
  return ui.screen(ctx, lines.join('\n'), rows);
}

async function handle(ctx, { action, args, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  switch (action) {
    case 'home': return list(ctx, c, null, 1);
    case 'list': return list(ctx, c, BR(args[0]), pageOf(args[1]));
    case 'view': if (!SHA.test(args[0] || '')) return; return view(ctx, c, args[0], BR(args[1]));
    case 'file': {
      const [sha, idxRaw, br] = args; const idx = Number(idxRaw);
      if (!SHA.test(sha || '') || !Number.isInteger(idx)) return;
      const m = await commits.getCommit(c.token, c.owner, c.repo, sha);
      const f = m.files[idx]; if (!f) return ctx.reply('That file is no longer listed.');
      const body = f.patch ? fenced(f.patch, 2800) : '_No text diff \\(binary, renamed or too large\\)\\._';
      return ui.screen(ctx, `📄 ${code(f.filename)}\n${esc(f.status)} · \\+${f.additions} \\-${f.deletions}\n\n${body}`, [back('Commit', D('view', c.repo, sha, br || '-'))]);
    }
    case 'revask': {
      const [sha, br] = args; if (!SHA.test(sha || '')) return;
      const info = await core.get(c.token, 'GET /repos/{owner}/{repo}', { owner: c.owner, repo: c.repo }, 'Get repo');
      const target = BR(br) || workBranch(ctx, c.repo, info.default_branch);
      return ui.screen(ctx, `↩️ Revert *${esc(sha)}* on *${esc(target)}*?\n\nA new commit that undoes it is added — history isn’t rewritten\\. If any file changed since, nothing is touched and you’re told which ones\\.`, ui.confirmRows('↩️ Yes, revert', `manage:restore:rv:${c.repo}:${sha}:${target}:strict:-`, D('view', c.repo, sha, br || '-')));
    }
    case 'revok': { // stale buttons from before 1.2.5 — hand over to ⏪ Undo & Restore, which also offers conflict help
      const [sha, target] = args; if (!SHA.test(sha || '') || !target) return;
      return require('./restore').handle(ctx, { action: 'rv', args: [sha, target, 'strict', '-'], repoName });
    }
    default: return ctx.reply('This button has expired.');
  }
}

module.exports = { key: 'commits', label: 'Commits', emoji: '📜', level: 'repo', scopes: [], handle };
