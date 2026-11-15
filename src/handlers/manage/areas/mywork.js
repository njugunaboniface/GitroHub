/** 💼 Workspace → 🔀 Pull requests and 🐞 Issues (v1.2.4-multi as "My work"; split and renamed in v1.3.0-multi): open PRs and issues assigned to you, authored by you, awaiting your review. */
const ui = require('../ui');
const { accountCtx, pageOf } = require('../common');
const search = require('../../../lib/github/search');

const { esc, plain, back } = ui;
const D = (action, ...args) => `manage:mywork:${[action, ...args].join(':')}`;
const VIEWS = {
  review: { kind: 'pr', role: 'review', title: '👀 PRs waiting for my review' },
  changes: { kind: 'pr', role: 'changes', title: '🛑 My PRs with changes requested' },
  failing: { kind: 'pr', role: 'failing', title: '❌ My PRs with failing checks' },
  prs: { kind: 'pr', role: 'authored', title: '🔀 PRs I opened' },
  authored: { kind: 'pr', role: 'authored', title: '🔀 PRs I opened' },
  prassigned: { kind: 'pr', role: 'assigned', title: '🔀 PRs assigned to me' },
  assigned: { kind: 'issue', role: 'assigned', title: '🐞 Issues assigned to me' },
  issues: { kind: 'issue', role: 'authored', title: '🐞 Issues I opened' },
  mentioned: { kind: 'issue', role: 'mentioned', title: '📣 Issues mentioning me' },
};

async function handle(ctx, { action, args }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  // v1.3.0-multi: "My work" is two clearly named screens — 🔀 Pull requests and 🐞 Issues — each with its tabs.
  if (action === 'prs' || action === 'home') {
    return ui.screen(ctx, '🔀 *Pull requests*\n\nAcross all your repos\\.', [
      [plain('👀 To review', D('v', 'review', 1)), plain('🛑 Changes requested', D('v', 'changes', 1))],
      [plain('❌ Failing checks', D('v', 'failing', 1)), plain('🔀 Opened by me', D('v', 'authored', 1))],
      [plain('🔀 Assigned to me', D('v', 'prassigned', 1))],
      back('Workspace', 'manage:ws'),
    ]);
  }
  if (action === 'issues') {
    return ui.screen(ctx, '🐞 *Issues*\n\nAcross all your repos\\.', [
      [plain('🐞 Assigned to me', D('v', 'assigned', 1)), plain('🐞 Opened by me', D('v', 'issues', 1))],
      [plain('📣 Mentioning me', D('v', 'mentioned', 1))],
      back('Workspace', 'manage:ws'),
    ]);
  }
  if (action === 'v') {
    const v = VIEWS[args[0]]; if (!v) return;
    const pg = pageOf(args[1]);
    const r = await search.myWork(c.token, v.kind, v.role, { page: pg });
    const rows = r.items.map((i) => {
      const own = i.owner && i.owner.toLowerCase() === String(c.owner).toLowerCase();
      const label = `${i.isPull ? '🔀' : '🐞'} ${i.repoName || ''} #${i.number} ${i.title}`;
      return own ? [plain(label, `manage:${i.isPull ? 'pulls' : 'issues'}:view:${i.repoName}:${i.number}`)] : [ui.link(label, i.url)];
    });
    const p = ui.pager(pg, r.hasNext, (x) => D('v', args[0], x)); if (p.length) rows.push(p);
    rows.push(back(v.kind === 'pr' ? 'Pull requests' : 'Issues', D(v.kind === 'pr' ? 'prs' : 'issues')));
    const when = await ui.clock(ctx);
    const list = r.items.length
      ? '\n\n' + r.items.map((i) => esc(`${i.isPull ? '🔀' : '🐞'} ${i.repoName || ''} #${i.number} · opened ${when(i.createdAt)} · updated ${when(i.updatedAt)}`)).join('\n') + `\n\n_${esc(`Times in ${when.tz}`)}_`
      : '\n\n_Nothing\\. 🎉_';
    return ui.screen(ctx, `*${esc(v.title)}*${list}`, rows);
  }
  return ctx.reply('This button has expired.');
}

module.exports = { key: 'mywork', label: 'PRs & issues', emoji: '🔀', level: 'account', scopes: [], handle };
