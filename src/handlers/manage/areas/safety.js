/** 💼 Workspace → 🛡️ My safety log (v1.2.5-multi): the sensitive things done with YOUR account through GitroHub — nothing hidden from you. */
const ui = require('../ui');
const { accountCtx } = require('../common');
const sens = require('../../../lib/sensitiveActions');

const { esc, back } = ui;

async function handle(ctx, { action }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  if (action !== 'home') return ctx.reply('This button has expired.');
  const rows = await sens.mine(ctx.from.id, 12);
  const lines = ['🛡️ *My safety log*', '', 'Transfers, deletes, rollbacks and access changes made through GitroHub, newest first\\. If you see something you didn’t do, remove the account in ⚙️ Settings and tell an admin\\.', ''];
  lines.push(rows.length ? rows.map((r) => `• ${esc(sens.LABELS[r.action] || r.action)}${r.repo_name ? ` · ${esc(r.repo_name)}` : ''}${r.account_login ? ` · ${esc(r.account_login)}` : ''} · ${esc(ui.ago(r.created_at))}`).join('\n') : '_Nothing yet\\._');
  return ui.screen(ctx, lines.join('\n'), [back('Workspace', 'manage:ws')]);
}

module.exports = { key: 'safety', label: 'My safety log', emoji: '🛡️', level: 'account', scopes: [], handle };
