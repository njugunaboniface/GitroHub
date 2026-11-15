/** 💼 Workspace → Notifications (v1.2.4-multi): GitHub inbox — read, mark read, mute. */
const ui = require('../ui');
const { accountCtx, pageOf } = require('../common');
const notif = require('../../../lib/github/notifications');

const { esc, plain, back, ago, trunc } = ui;
const D = (action, ...args) => `manage:notify:${[action, ...args].join(':')}`;
const TYPE = { Issue: '🐞', PullRequest: '🔀', Release: '🚀', Commit: '📜', Discussion: '💭', CheckSuite: '⚙️', RepositoryVulnerabilityAlert: '🛡️' };
const REASON = { mention: 'mentioned you', review_requested: 'asked for your review', assign: 'assigned you', author: 'you opened it', comment: 'new comment', subscribed: 'you’re watching', team_mention: 'mentioned your team', state_change: 'state changed', security_alert: 'security alert', ci_activity: 'CI activity' };

/** 🔔 Notifications hub (v2.0.0-multi): lives in handlers/hub.js now (inbox, PRs, issues, failing). */
async function home(ctx) {
  return require('../../hub').showNotifications(ctx);
}

async function list(ctx, c, mode, pg) {
  const r = await notif.listNotifications(c.token, { all: mode === 'all', participating: mode === 'me', page: pg });
  const rows = ui.listRows({
    items: r.items,
    render: (n) => ({ label: `${n.unread ? '🔵' : '▫️'} ${TYPE[n.type] || '🔔'} ${n.repoName || ''}: ${n.title}`, data: D('view', n.id, mode) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('list', mode, x),
    extra: [
      [plain(`${mode === 'unread' ? '● ' : ''}Unread`, D('list', 'unread', 1)), plain(`${mode === 'me' ? '● ' : ''}About me`, D('list', 'me', 1)), plain(`${mode === 'all' ? '● ' : ''}All`, D('list', 'all', 1))],
    ],
    backRow: back('Notifications', D('home')),
  });
  return ui.screen(ctx, `🔔 *Notifications*\n${mode === 'unread' ? 'Unread' : mode === 'me' ? 'Directly about you' : 'Everything'} · page ${pg}${r.items.length ? '' : '\n\n_You’re all caught up\\. 🎉_'}`, rows);
}

async function handle(ctx, { action, args }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  switch (action) {
    case 'home': return home(ctx);
    case 'list': return list(ctx, c, ['all', 'me'].includes(args[0]) ? args[0] : 'unread', pageOf(args[1]));
    case 'view': {
      const id = args[0]; if (!/^\d{1,20}$/.test(id || '')) return;
      const mode = ['all', 'me'].includes(args[1]) ? args[1] : 'unread';
      const r = await notif.listNotifications(c.token, { all: true, perPage: 50 });
      const n = r.items.find((x) => x.id === id);
      if (!n) return list(ctx, c, mode, 1);
      const rows = [];
      if (n.url) rows.push([ui.link('🔗 Open on GitHub', n.url)]);
      if (n.kind && n.owner && n.owner.toLowerCase() === String(c.owner).toLowerCase()) rows.push([plain('⚡ Open in bot', `manage:${n.kind === 'pull' ? 'pulls' : 'issues'}:view:${n.repoName}:${n.number}`)]);
      rows.push([plain('✅ Mark read', D('read', id, mode)), plain('🔕 Mute thread', D('mute', id, mode))]);
      rows.push(back('Inbox', D('list', mode, 1)));
      return ui.screen(ctx, `${TYPE[n.type] || '🔔'} *${esc(trunc(n.title, 200))}*\n${esc(n.repo || '')}\n${esc(REASON[n.reason] || n.reason || '')} · ${esc(ago(n.updatedAt))}`, rows);
    }
    case 'read': { if (!/^\d{1,20}$/.test(args[0] || '')) return; await notif.markRead(c.token, args[0]); return list(ctx, c, ['all', 'me'].includes(args[1]) ? args[1] : 'unread', 1); }
    case 'mute': { if (!/^\d{1,20}$/.test(args[0] || '')) return; await notif.muteThread(c.token, args[0]); return list(ctx, c, ['all', 'me'].includes(args[1]) ? args[1] : 'unread', 1); }
    case 'allask': return ui.screen(ctx, 'Mark *all* notifications as read?', ui.confirmRows('✅ Yes, mark all', D('allok'), D('home')));
    case 'allok': await notif.markAllRead(c.token); return list(ctx, c, 'unread', 1);
    default: return ctx.reply('This button has expired.');
  }
}

module.exports = { key: 'notify', label: 'Notifications', emoji: '🔔', level: 'account', scopes: ['notifications'], handle };
