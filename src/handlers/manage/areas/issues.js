/** ⚡ Manage → Issues (v1.2.4-multi): list, create, comment, close/reopen, labels, assignees, milestone. */
const ui = require('../ui');
const input = require('../input');
const { repoCtx, num, pageOf } = require('../common');
const issues = require('../../../lib/github/issues');

const { esc, btn, plain, back, icon, ago, trunc, style } = ui;
const D = (action, repo, ...args) => `manage:issues:${[action, repo, ...args].join(':')}`;
const si = (i) => (i.state === 'open' ? icon('open') : icon('closed'));
const LABELS_PER_PAGE = 10;

async function list(ctx, c, state, pg) {
  const r = await issues.listIssues(c.token, c.owner, c.repo, { state, page: pg });
  const rows = ui.listRows({
    items: r.items,
    render: (i) => ({ label: `${si(i)} #${i.number} ${i.title}`, data: D('view', c.repo, i.number) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('list', c.repo, state, x),
    extra: [
      [plain(state === 'open' ? '🔴 Show closed' : '🟢 Show open', D('list', c.repo, state === 'open' ? 'closed' : 'open', 1))],
      [btn('➕ New issue', D('new', c.repo), style.GREEN)],
    ],
    backRow: back('Manage', `manage:hub:${c.repo}`),
  });
  return ui.screen(ctx, `🐞 *Issues* — ${esc(c.repo)}\n${state === 'open' ? 'Open' : 'Closed'} · page ${pg}${r.items.length ? '' : '\n\n_Nothing here\\._'}`, rows);
}

async function view(ctx, c, n) {
  const i = await issues.getIssue(c.token, c.owner, c.repo, n);
  const lines = [
    `${si(i)} *\\#${i.number} ${esc(i.title)}*`,
    `${i.state === 'open' ? 'Open' : `Closed${i.stateReason === 'not_planned' ? ' \\(not planned\\)' : ''}`} · by ${esc(i.author || '?')} · ${esc(ago(i.createdAt))} · 💬 ${i.comments}`,
  ];
  if (i.labels.length) lines.push(`🏷 ${esc(i.labels.join(', '))}`);
  if (i.assignees.length) lines.push(`👤 ${esc(i.assignees.join(', '))}`);
  if (i.milestone) lines.push(`🎯 ${esc(i.milestone.title)}`);
  if (i.body) lines.push('', esc(trunc(i.body, 800)));
  const rows = [];
  rows.push(i.state === 'open'
    ? [btn('✅ Close', D('closeask', c.repo, n), style.RED), plain('💬 Comment', D('comment', c.repo, n))]
    : [btn('🟢 Reopen', D('reopen', c.repo, n), style.GREEN), plain('💬 Comment', D('comment', c.repo, n))]);
  rows.push([plain('🏷 Labels', D('labels', c.repo, n, 1)), plain('👤 Assign', D('assign', c.repo, n))]);
  rows.push([plain('🎯 Milestone', D('ms', c.repo, n)), plain('💬 Read comments', D('comments', c.repo, n, 1))]);
  if (i.url) rows.push([ui.link('🔗 Open on GitHub', i.url)]);
  rows.push(back('Issues', D('list', c.repo, 'open', 1)));
  return ui.screen(ctx, lines.join('\n'), rows);
}

async function labelsScreen(ctx, c, n, pg) {
  const [issue, all] = await Promise.all([issues.getIssue(c.token, c.owner, c.repo, n), issues.listLabels(c.token, c.owner, c.repo)]);
  const start = (pg - 1) * LABELS_PER_PAGE;
  const slice = all.slice(start, start + LABELS_PER_PAGE);
  const on = new Set(issue.labels);
  const rows = slice.map((l, k) => [plain(`${on.has(l.name) ? '✅' : '▫️'} ${l.name}`, D('lbl', c.repo, n, start + k, pg))]);
  const p = ui.pager(pg, start + LABELS_PER_PAGE < all.length, (x) => D('labels', c.repo, n, x)); if (p.length) rows.push(p);
  rows.push([btn('➕ Create label', D('newlabel', c.repo, n), style.GREEN)]);
  rows.push(back('Issue', D('view', c.repo, n)));
  return ui.screen(ctx, `🏷 *Labels for \\#${n}*\n\nTap to add or remove\\.${all.length ? '' : '\n\n_This repo has no labels yet\\._'}`, rows);
}

async function assignScreen(ctx, c, n) {
  const [issue, people] = await Promise.all([issues.getIssue(c.token, c.owner, c.repo, n), issues.listAssignable(c.token, c.owner, c.repo)]);
  const on = new Set(issue.assignees);
  const rows = people.slice(0, 20).map((l) => [plain(`${on.has(l) ? '✅' : '▫️'} ${l}`, D('who', c.repo, n, l))]);
  rows.push(back('Issue', D('view', c.repo, n)));
  return ui.screen(ctx, `👤 *Assign \\#${n}*\n\nTap to assign or unassign\\.`, rows);
}

async function msScreen(ctx, c, n) {
  const [issue, ms] = await Promise.all([issues.getIssue(c.token, c.owner, c.repo, n), issues.listMilestones(c.token, c.owner, c.repo, { perPage: 10 })]);
  const rows = ms.items.map((m) => [plain(`${issue.milestone && issue.milestone.number === m.number ? '✅' : '▫️'} ${m.title}`, D('setms', c.repo, n, m.number))]);
  if (issue.milestone) rows.push([plain('🚫 Clear milestone', D('setms', c.repo, n, 0))]);
  rows.push(back('Issue', D('view', c.repo, n)));
  return ui.screen(ctx, `🎯 *Milestone for \\#${n}*${ms.items.length ? '' : '\n\n_No open milestones\\. Create one from Manage → Milestones\\._'}`, rows);
}

async function handle(ctx, { action, args, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const n = num(args[0]);
  switch (action) {
    case 'home': return list(ctx, c, 'open', 1);
    case 'list': return list(ctx, c, args[0] === 'closed' ? 'closed' : 'open', pageOf(args[1]));
    case 'view': if (!n) return; return view(ctx, c, n);
    case 'comments': {
      if (!n) return; const pg = pageOf(args[1]);
      const r = await issues.listIssueComments(c.token, c.owner, c.repo, n, { page: pg, perPage: 4 });
      const body = r.items.map((m) => `*${esc(m.author || '?')}* ${esc(ago(m.createdAt))}\n${esc(trunc(m.body, 500))}`).join('\n\n') || '_No comments yet\\._';
      const rows = []; const p = ui.pager(pg, r.hasNext, (x) => D('comments', c.repo, n, x)); if (p.length) rows.push(p);
      rows.push([plain('💬 Add comment', D('comment', c.repo, n))], back('Issue', D('view', c.repo, n)));
      return ui.screen(ctx, `💬 *Comments on \\#${n}*\n\n${body}`, rows);
    }
    case 'new': return input.ask(ctx, { area: 'issues', action: 'newtitle', repoName, prompt: '➕ Send the issue title.', maxLen: 256, cancelData: D('list', c.repo, 'open', 1) });
    case 'comment': if (!n) return; return input.ask(ctx, { area: 'issues', action: 'comment', repoName, args: [n], prompt: `💬 Send your comment for #${n}.`, cancelData: D('view', c.repo, n) });
    case 'closeask': if (!n) return;
      return ui.screen(ctx, `Close *\\#${n}* as:`, [[btn('✅ Completed', D('closeok', c.repo, n, 'completed'), style.RED)], [btn('🚫 Not planned', D('closeok', c.repo, n, 'not_planned'), style.RED)], [btn('❌ Cancel', D('view', c.repo, n), style.GREEN)]]);
    case 'closeok': if (!n) return; await issues.setIssueState(c.token, c.owner, c.repo, n, 'closed', args[1] === 'not_planned' ? 'not_planned' : 'completed'); return view(ctx, c, n);
    case 'reopen': if (!n) return; await issues.setIssueState(c.token, c.owner, c.repo, n, 'open'); return view(ctx, c, n);
    case 'labels': if (!n) return; return labelsScreen(ctx, c, n, pageOf(args[1]));
    case 'lbl': {
      const idx = Number(args[1]); if (!n || !Number.isInteger(idx) || idx < 0) return;
      const [issue, all] = await Promise.all([issues.getIssue(c.token, c.owner, c.repo, n), issues.listLabels(c.token, c.owner, c.repo)]);
      const label = all[idx]; if (!label) return ctx.reply('That label list changed — open Labels again.');
      if (issue.labels.includes(label.name)) await issues.removeLabel(c.token, c.owner, c.repo, n, label.name); else await issues.addLabel(c.token, c.owner, c.repo, n, label.name);
      return labelsScreen(ctx, c, n, pageOf(args[2]));
    }
    case 'newlabel': if (!n) return; return input.ask(ctx, { area: 'issues', action: 'newlabel', repoName, args: [n], prompt: '🏷 Send the new label as `name` or `name #ff8800` (colour optional).', maxLen: 120, cancelData: D('labels', c.repo, n, 1) });
    case 'assign': if (!n) return; return assignScreen(ctx, c, n);
    case 'who': {
      const login = args[1]; if (!n || !login) return;
      const issue = await issues.getIssue(c.token, c.owner, c.repo, n);
      if (issue.assignees.includes(login)) await issues.removeAssignee(c.token, c.owner, c.repo, n, login); else await issues.addAssignee(c.token, c.owner, c.repo, n, login);
      return assignScreen(ctx, c, n);
    }
    case 'ms': if (!n) return; return msScreen(ctx, c, n);
    case 'setms': if (!n) return; await issues.setIssueMilestone(c.token, c.owner, c.repo, n, num(args[1]) || null); return view(ctx, c, n);
    default: return ctx.reply('This button has expired.');
  }
}

async function onInput(ctx, { action, args, repoName, text }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const n = num(args[0]);
  if (action === 'newtitle') {
    return input.ask(ctx, { area: 'issues', action: 'newbody', repoName, args: [Buffer.from(text).toString('base64url')], prompt: `Title: ${text}\n\nNow send a description, or send "-" to skip.`, cancelData: D('list', c.repo, 'open', 1), maxLen: 4000 });
  }
  if (action === 'newbody') {
    const title = Buffer.from(args[0] || '', 'base64url').toString('utf8');
    const issue = await issues.createIssue(c.token, c.owner, c.repo, { title, body: text === '-' ? '' : text });
    return ui.screen(ctx, `✅ Created \\#${issue.number} ${esc(issue.title)}`, [[plain('📄 View', D('view', c.repo, issue.number))], [ui.link('🔗 Open on GitHub', issue.url)]]);
  }
  if (action === 'comment') {
    await issues.commentOnIssue(c.token, c.owner, c.repo, n, text);
    return ui.screen(ctx, '✅ Comment posted\\.', [[plain('📄 View', D('view', c.repo, n))]]);
  }
  if (action === 'newlabel') {
    const m = /^(.*?)(?:\s+#?([0-9a-fA-F]{6}))?$/.exec(text);
    try { await issues.createLabel(c.token, c.owner, c.repo, m[1], m[2] || 'ededed'); } catch (e) {
      if (e && e.status === 422) throw input.inputError('That label already exists or isn’t valid.');
      throw e;
    }
    return labelsScreen(ctx, c, n, 1);
  }
}

module.exports = { key: 'issues', label: 'Issues', emoji: '🐞', level: 'repo', scopes: [], handle, onInput };
