/** ⚡ Manage → Milestones (v1.2.4-multi): list, create, close/reopen, delete. */
const ui = require('../ui');
const input = require('../input');
const { repoCtx, num, pageOf } = require('../common');
const iss = require('../../../lib/github/issues');

const { esc, btn, plain, back, trunc, style } = ui;
const D = (action, repo, ...args) => `manage:milestones:${[action, repo, ...args].join(':')}`;
const bar = (open, closed) => { const t = open + closed; if (!t) return '▱▱▱▱▱▱▱▱▱▱ 0%'; const f = Math.round((closed / t) * 10); return `${'▰'.repeat(f)}${'▱'.repeat(10 - f)} ${Math.round((closed / t) * 100)}%`; };

async function list(ctx, c, state, pg) {
  const r = await iss.listMilestones(c.token, c.owner, c.repo, { state, page: pg });
  const rows = ui.listRows({
    items: r.items, render: (m) => ({ label: `🎯 ${m.title} · ${m.closed}/${m.open + m.closed}`, data: D('view', c.repo, m.number) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('list', c.repo, state, x),
    extra: [[plain(state === 'open' ? '🔴 Show closed' : '🟢 Show open', D('list', c.repo, state === 'open' ? 'closed' : 'open', 1))], [btn('➕ New milestone', D('new', c.repo), style.GREEN)]],
    backRow: back('Manage', `manage:hub:${c.repo}`),
  });
  return ui.screen(ctx, `🎯 *Milestones* — ${esc(c.repo)} \\(${esc(state)}\\)${r.items.length ? '' : '\n\n_None here\\._'}`, rows);
}

async function handle(ctx, { action, args, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const n = num(args[0]);
  switch (action) {
    case 'home': return list(ctx, c, 'open', 1);
    case 'list': return list(ctx, c, args[0] === 'closed' ? 'closed' : 'open', pageOf(args[1]));
    case 'view': {
      if (!n) return;
      const m = await iss.getMilestone(c.token, c.owner, c.repo, n);
      const rows = [[plain(m.state === 'open' ? '✅ Close' : '🟢 Reopen', D('state', c.repo, n, m.state === 'open' ? 'closed' : 'open')), btn('🗑 Delete', D('delask', c.repo, n), style.RED)]];
      if (m.url) rows.push([ui.link('🔗 Open on GitHub', m.url)]);
      rows.push(back('Milestones', D('list', c.repo, 'open', 1)));
      return ui.screen(ctx, `🎯 *${esc(m.title)}*\n${esc(m.state)} · ${m.open} open · ${m.closed} closed\n${esc(bar(m.open, m.closed))}${m.dueOn ? `\nDue ${esc(String(m.dueOn).slice(0, 10))}` : ''}${m.description ? `\n\n${esc(trunc(m.description, 500))}` : ''}`, rows);
    }
    case 'state': if (!n || !['open', 'closed'].includes(args[1])) return; await iss.setMilestoneState(c.token, c.owner, c.repo, n, args[1]); return list(ctx, c, 'open', 1);
    case 'delask': if (!n) return; return ui.screen(ctx, 'Delete this milestone?\n\nIssues keep existing — they just lose the milestone\\.', ui.confirmRows('🗑 Yes, delete', D('delok', c.repo, n), D('view', c.repo, n)));
    case 'delok': if (!n) return; await iss.deleteMilestone(c.token, c.owner, c.repo, n); return list(ctx, c, 'open', 1);
    case 'new': return input.ask(ctx, { area: 'milestones', action: 'new', repoName, prompt: '🎯 Send the milestone title, optionally followed by a due date: `v2 launch 2026-12-31`.', maxLen: 255, cancelData: D('list', c.repo, 'open', 1) });
    default: return ctx.reply('This button has expired.');
  }
}

async function onInput(ctx, { action, repoName, text }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  if (action === 'new') {
    const m = /^(.*?)(?:\s+(\d{4}-\d{2}-\d{2}))?$/.exec(text);
    let dueOn = null;
    if (m[2]) { const d = new Date(`${m[2]}T12:00:00Z`); if (Number.isNaN(d.getTime())) throw input.inputError('That date isn’t valid (use YYYY-MM-DD).'); dueOn = d.toISOString(); }
    const ms = await iss.createMilestone(c.token, c.owner, c.repo, { title: m[1], dueOn });
    return ui.screen(ctx, `✅ Created milestone *${esc(ms.title)}*`, [[plain('🎯 Open', D('view', c.repo, ms.number))], back('Milestones', D('list', c.repo, 'open', 1))]);
  }
}

module.exports = { key: 'milestones', label: 'Milestones', emoji: '🎯', level: 'repo', scopes: [], handle, onInput };
