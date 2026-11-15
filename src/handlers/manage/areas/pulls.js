/** ⚡ Manage → Pull requests (v1.2.4-multi): list, view, merge (merge/squash/rebase), close/reopen, comment, review, create from a branch. */
const ui = require('../ui');
const input = require('../input');
const { repoCtx, num, pageOf } = require('../common');
const pulls = require('../../../lib/github/pulls');
const branches = require('../../../lib/github/branches');
const actionLock = require('../../../lib/actionLock');

const { esc, btn, plain, back, icon, ago, trunc, code, style } = ui;
const D = (action, repo, ...args) => `manage:pulls:${[action, repo, ...args].join(':')}`;

const stateIcon = (p) => (p.merged ? icon('merged') : p.state === 'closed' ? icon('closed') : p.draft ? icon('draft') : icon('open'));

async function list(ctx, c, state, pg) {
  const r = await pulls.listPulls(c.token, c.owner, c.repo, { state, page: pg });
  const head = `🔀 *Pull requests* — ${esc(c.repo)}\n${state === 'open' ? 'Open' : 'Closed'} · page ${pg}`;
  const when = await ui.clock(ctx);
  const body = r.items.length
    ? '\n\n' + r.items.map((p) => esc(`${stateIcon(p)} #${p.number} · ${p.mergedAt ? `merged ${when(p.mergedAt)}` : p.state === 'closed' ? `closed ${when(p.closedAt)}` : `opened ${when(p.createdAt)}`}`)).join('\n') + `\n\n_${esc(`Times in ${when.tz}`)}_`
    : '\n\n_Nothing here\\._';
  const rows = ui.listRows({
    items: r.items,
    render: (p) => ({ label: `${stateIcon(p)} #${p.number} ${p.title}`, data: D('view', c.repo, p.number) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (n) => D('list', c.repo, state, n),
    extra: [
      [plain(state === 'open' ? '🔴 Show closed' : '🟢 Show open', D('list', c.repo, state === 'open' ? 'closed' : 'open', 1))],
      [btn('➕ New from a branch', D('newpick', c.repo, 1), style.GREEN)],
    ],
    backRow: back('Manage', `manage:hub:${c.repo}`),
  });
  return ui.screen(ctx, head + body, rows);
}

async function view(ctx, c, n) {
  const [p, reviews] = await Promise.all([pulls.getPull(c.token, c.owner, c.repo, n), pulls.listReviews(c.token, c.owner, c.repo, n).catch(() => [])]);
  const status = p.merged ? 'Merged' : p.state === 'closed' ? 'Closed' : p.draft ? 'Draft' : 'Open';
  const lines = [
    `${stateIcon(p)} *\\#${p.number} ${esc(p.title)}*`,
    `${esc(status)} · ${esc(p.head)} → ${esc(p.base)} · by ${esc(p.author || '?')}`,
    `${p.commits || 0} commits · \\+${p.additions || 0} \\-${p.deletions || 0} · ${p.changedFiles || 0} files · 💬 ${(p.comments || 0) + (p.reviewComments || 0)}`,
  ];
  if (p.state === 'open' && !p.merged) {
    const ms = p.mergeable === false || p.mergeableState === 'dirty' ? '⚠️ Has merge conflicts' : p.mergeableState === 'blocked' ? '⛔ Blocked by branch rules / checks' : p.mergeable ? '✅ Ready to merge' : '⏳ GitHub is still checking';
    lines.push(esc(ms));
  }
  const when = await ui.clock(ctx);
  const stamps = [`🗓 Opened ${when(p.createdAt)}`];
  if (p.mergedAt) stamps.push(`🟣 Merged ${when(p.mergedAt)}`); else if (p.state === 'closed' && p.closedAt) stamps.push(`🔴 Closed ${when(p.closedAt)}`);
  if (p.updatedAt && p.updatedAt !== p.createdAt) stamps.push(`✏️ Updated ${when(p.updatedAt)}`);
  lines.push(esc(stamps.join('\n') + `\n(${when.tz})`));
  if (p.labels.length) lines.push(`🏷 ${esc(p.labels.join(', '))}`);
  const latest = new Map();
  for (const r of reviews) if (r.state !== 'PENDING') latest.set(r.author, r.state);
  if (latest.size) lines.push('Reviews: ' + esc(Array.from(latest, ([a, s]) => `${a} ${s === 'APPROVED' ? '✅' : s === 'CHANGES_REQUESTED' ? '🛑' : '💬'}`).join(' · ')));
  if (p.body) lines.push('', esc(trunc(p.body, 700)));
  // v1.2.5-multi: GitHub never lets you approve or request changes on your OWN pull request, so those buttons
  // simply aren't offered for one — and if another connected account could review it, say so.
  const me = String((c.user && (c.user.personalLogin || c.user.login)) || '').toLowerCase();
  const ownPull = !!me && String(p.author || '').toLowerCase() === me;
  if (ownPull && p.state === 'open' && !p.merged) {
    lines.push('', esc('ℹ️ You opened this pull request, so GitHub doesn’t let you approve it. You can still comment.'));
    try {
      const others = (await require('../../../lib/accounts').list(ctx.from.id)).filter((a) => !a.active);
      if (others.length) lines.push(esc(`Another connected account (${others.map((a) => `@${a.login}`).join(', ')}) could review it — switch in 💼 Workspace → Accounts.`));
    } catch (_) { /* hint only */ }
  }
  const rows = [];
  if (p.state === 'open' && !p.merged) {
    rows.push([btn('🟣 Merge…', D('merge', c.repo, n), style.GREEN), btn('🔴 Close', D('closeask', c.repo, n), style.RED)]);
    if (!ownPull) rows.push([plain('✅ Approve', D('review', c.repo, n, 'APPROVE')), plain('🛑 Request changes', D('review', c.repo, n, 'REQUEST_CHANGES'))]);
    rows.push([plain('💬 Comment', D('comment', c.repo, n)), plain('📝 Review comment', D('review', c.repo, n, 'COMMENT'))]);
    rows.push([plain('🔄 Update branch', D('update', c.repo, n)), plain('📄 Files', D('files', c.repo, n, 1))]);
  } else if (p.state === 'closed' && !p.merged) {
    rows.push([btn('🟢 Reopen', D('reopen', c.repo, n), style.GREEN), plain('💬 Comment', D('comment', c.repo, n))]);
    rows.push([plain('📄 Files', D('files', c.repo, n, 1))]);
  } else rows.push([plain('📄 Files', D('files', c.repo, n, 1)), plain('💬 Comment', D('comment', c.repo, n))]);
  rows.push([plain('💬 Read comments', D('comments', c.repo, n, 1))]);
  if (p.url) rows.push([ui.link('🔗 Open on GitHub', p.url)]);
  rows.push(back('Pull requests', D('list', c.repo, 'open', 1)));
  return ui.screen(ctx, lines.join('\n'), rows);
}

async function files(ctx, c, n, pg) {
  const r = await pulls.listPullFiles(c.token, c.owner, c.repo, n, { page: pg, perPage: 6 });
  const body = r.items.map((f) => `• ${code(f.filename)} \\(${esc(f.status)} \\+${f.additions} \\-${f.deletions}\\)`).join('\n') || '_No files\\._';
  const rows = [];
  const pg2 = ui.pager(pg, r.hasNext, (x) => D('files', c.repo, n, x)); if (pg2.length) rows.push(pg2);
  rows.push(back('Pull request', D('view', c.repo, n)));
  return ui.screen(ctx, `📄 *Files in \\#${n}*\n\n${body}`, rows);
}

async function comments(ctx, c, n, pg) {
  const r = await pulls.listPullComments(c.token, c.owner, c.repo, n, { page: pg, perPage: 4 });
  const when = await ui.clock(ctx);
  const body = r.items.map((m) => `*${esc(m.author || '?')}* · ${esc(when(m.createdAt))} \\(${esc(ago(m.createdAt))}\\)\n${esc(trunc(m.body, 500))}`).join('\n\n') || '_No comments yet\\._';
  const rows = [];
  const pg2 = ui.pager(pg, r.hasNext, (x) => D('comments', c.repo, n, x)); if (pg2.length) rows.push(pg2);
  rows.push([plain('💬 Add comment', D('comment', c.repo, n))]);
  rows.push(back('Pull request', D('view', c.repo, n)));
  return ui.screen(ctx, `💬 *Comments on \\#${n}*\n\n${body}`, rows);
}

async function handle(ctx, { action, args, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const n = num(args[0]);
  switch (action) {
    case 'home': return list(ctx, c, 'open', 1);
    case 'list': return list(ctx, c, args[0] === 'closed' ? 'closed' : 'open', pageOf(args[1]));
    case 'view': if (!n) return; return view(ctx, c, n);
    case 'files': if (!n) return; return files(ctx, c, n, pageOf(args[1]));
    case 'comments': if (!n) return; return comments(ctx, c, n, pageOf(args[1]));
    case 'merge': {
      if (!n) return;
      return ui.screen(ctx, `🟣 *Merge \\#${n}* — choose how:\n\n• *Merge commit* keeps every commit\n• *Squash* combines them into one\n• *Rebase* replays them on the base`, [
        [btn('Merge commit', D('mergeask', c.repo, n, 'merge'), style.GREEN)],
        [btn('Squash and merge', D('mergeask', c.repo, n, 'squash'), style.GREEN)],
        [btn('Rebase and merge', D('mergeask', c.repo, n, 'rebase'), style.GREEN)],
        back('Pull request', D('view', c.repo, n)),
      ]);
    }
    case 'mergeask': {
      const method = args[1]; if (!n || !pulls.MERGE_METHODS.includes(method)) return;
      return ui.screen(ctx, `Merge *\\#${n}* with *${esc(method)}*?\n\nThis changes the base branch\\.`, ui.confirmRows('🟣 Yes, merge', D('mergeok', c.repo, n, method), D('view', c.repo, n)));
    }
    case 'mergeok': {
      const method = args[1]; if (!n || !pulls.MERGE_METHODS.includes(method)) return;
      await actionLock.withLock(ctx.from.id, `merge:${c.repo}:${n}`, async () => { await pulls.mergePull(c.token, c.owner, c.repo, n, method); });
      return ui.screen(ctx, `✅ Merged \\#${n} \\(${esc(method)}\\)\\.`, [[plain('📄 View', D('view', c.repo, n))], back('Pull requests', D('list', c.repo, 'open', 1))]);
    }
    case 'closeask': if (!n) return; return ui.screen(ctx, `Close *\\#${n}* without merging?`, ui.confirmRows('🔴 Yes, close', D('closeok', c.repo, n), D('view', c.repo, n)));
    case 'closeok': if (!n) return; await pulls.setPullState(c.token, c.owner, c.repo, n, 'closed'); return view(ctx, c, n);
    case 'reopen': if (!n) return; await pulls.setPullState(c.token, c.owner, c.repo, n, 'open'); return view(ctx, c, n);
    case 'update': if (!n) return; await pulls.updatePullBranch(c.token, c.owner, c.repo, n); return ui.screen(ctx, '🔄 GitHub is updating the branch with the latest base changes\\. Give it a few seconds, then reopen the PR\\.', [[plain('📄 View', D('view', c.repo, n))]]);
    case 'comment': if (!n) return; return input.ask(ctx, { area: 'pulls', action: 'comment', repoName, args: [n], prompt: `💬 Send your comment for #${n}.`, cancelData: D('view', c.repo, n) });
    case 'review': {
      const ev = args[1]; if (!n || !pulls.REVIEW_EVENTS.includes(ev)) return;
      if (ev === 'APPROVE') return ui.screen(ctx, `Approve *\\#${n}*?`, ui.confirmRows('✅ Approve', D('approveok', c.repo, n), D('view', c.repo, n)));
      return input.ask(ctx, { area: 'pulls', action: 'review', repoName, args: [n, ev], prompt: ev === 'REQUEST_CHANGES' ? `🛑 What needs to change in #${n}? Send your review comment.` : `📝 Send your review comment for #${n}.`, cancelData: D('view', c.repo, n) });
    }
    case 'approveok': if (!n) return; await pulls.reviewPull(c.token, c.owner, c.repo, n, 'APPROVE'); return view(ctx, c, n);
    case 'newpick': {
      const pg = pageOf(args[0]);
      const r = await branches.listBranches(c.token, c.owner, c.repo, { page: pg });
      const rows = ui.listRows({ items: r.items, render: (b) => ({ label: `🌿 ${b.name}`, data: D('newfrom', c.repo, b.name) }), pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('newpick', c.repo, x), backRow: back('Pull requests', D('list', c.repo, 'open', 1)) });
      return ui.screen(ctx, '➕ *New pull request*\n\nWhich branch has your changes?', rows);
    }
    case 'newfrom': {
      const head = args[0]; if (!head) return;
      const repoInfo = await require('../../../lib/github/core').get(c.token, 'GET /repos/{owner}/{repo}', { owner: c.owner, repo: c.repo }, 'Get repo');
      const base = repoInfo.default_branch;
      if (head === base) return ui.screen(ctx, `That's the default branch \\(${esc(base)}\\) — pick a different branch\\.`, [[plain('⬅️ Pick again', D('newpick', c.repo, 1))]]);
      const cmp = await branches.compare(c.token, c.owner, c.repo, base, head);
      if (!cmp.ahead) return ui.screen(ctx, `${esc(head)} has nothing new compared with ${esc(base)}, so there's nothing to open a PR for\\.`, [[plain('⬅️ Pick again', D('newpick', c.repo, 1))]]);
      return input.ask(ctx, { area: 'pulls', action: 'create', repoName, args: [head, base], prompt: `➕ ${head} → ${base} (${cmp.ahead} commit${cmp.ahead === 1 ? '' : 's'} ahead).\n\nSend the pull request title.`, maxLen: 256, cancelData: D('list', c.repo, 'open', 1) });
    }
    default: return ctx.reply('This button has expired.');
  }
}

async function onInput(ctx, { action, args, repoName, text }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const n = num(args[0]);
  if (action === 'comment') {
    await pulls.commentOnPull(c.token, c.owner, c.repo, n, text);
    return ui.screen(ctx, '✅ Comment posted\\.', [[plain('📄 View', D('view', c.repo, n))]]);
  }
  if (action === 'review') {
    try { await pulls.reviewPull(c.token, c.owner, c.repo, n, args[1], text); } catch (e) {
      if (e && e.status === 422) throw input.inputError(`GitHub refused that review: ${require('../../../lib/friendlyErrors').oneLine(e)}`);
      throw e;
    }
    return ui.screen(ctx, '✅ Review submitted\\.', [[plain('📄 View', D('view', c.repo, n))]]);
  }
  if (action === 'create') {
    const [head, base] = args;
    const pr = await pulls.createPull(c.token, c.owner, c.repo, { head, base, title: text });
    return ui.screen(ctx, `✅ Opened \\#${pr.number} ${esc(pr.title)}`, [[plain('📄 View', D('view', c.repo, pr.number))], [ui.link('🔗 Open on GitHub', pr.url)]]);
  }
}

module.exports = { key: 'pulls', label: 'Pull requests', emoji: '🔀', level: 'repo', scopes: [], handle, onInput };
