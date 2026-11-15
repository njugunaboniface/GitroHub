/** 💼 Workspace → Alert types (v1.2.4-multi): choose which GitHub events send live alerts, and refresh older repo alerts to cover them. */
const ui = require('../ui');
const { accountCtx } = require('../common');
const prefs = require('../../../lib/alertPrefs');
const { EVENT_DEFS } = require('../../../lib/webhookEvents');
const repoWebhooks = require('../../../lib/repoWebhooks');
const accounts = require('../../../lib/accounts');
const github = require('../../../lib/github');

const { btn, plain, back, style } = ui;
const D = (action, ...args) => `manage:alerts:${[action, ...args].join(':')}`;
const MAX_UPDATE = 25;

async function home(ctx) {
  const p = await prefs.getAll(ctx.from.id);
  const rows = EVENT_DEFS.map((d, i) => [plain(`${p[d.key] ? '✅' : '▫️'} ${d.emoji} ${d.label}`, D('t', i))]);
  rows.push([plain('🕒 Quiet hours, digests & system alerts', 'defaults:notifications')]);
  rows.push([btn('🔄 Update my repo alerts', D('upd'), style.GREEN)]);
  rows.push(back('Notifications', 'manage:notify:home'));
  return ui.screen(ctx, '🔔 *Alert settings*\n\nChoose which GitHub events send you live alerts \\(repos with ✅ Live alerts on\\)\\. Alerts are grouped into one message every few minutes\\.\n\n_Repos whose alerts were enabled in an older version only know the first six types — tap *Update my repo alerts* once to bring them up to date\\._', rows);
}

async function handle(ctx, { action, args }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  switch (action) {
    case 'home': return home(ctx);
    case 't': {
      const def = EVENT_DEFS[Number(args[0])]; if (!def) return home(ctx);
      const cur = await prefs.getAll(ctx.from.id);
      await prefs.set(ctx.from.id, def.key, !cur[def.key]);
      return home(ctx);
    }
    case 'upd': {
      const active = await accounts.activeLoginOf(ctx.from.id);
      const regs = active ? await repoWebhooks.getAllForAccount(ctx.from.id, active, { includeLegacy: true }) : [];
      if (!regs.length) return ui.screen(ctx, 'No repos have live alerts on for this account\\.', [back('Alert types', D('home'))]);
      let ok = 0; let failed = 0;
      for (const r of regs.slice(0, MAX_UPDATE)) {
        try { await github.updateWebhookEvents(c.token, r.owner_login || active, r.repo_name, Number(r.webhook_id)); ok++; } catch (_) { failed++; }
      }
      const left = regs.length - MAX_UPDATE;
      return ui.screen(ctx, `🔄 Updated *${ok}* repo${ok === 1 ? '' : 's'}${failed ? `, ${failed} couldn’t be updated \\(deleted hook or no admin access\\)` : ''}${left > 0 ? `\\. Tap again for the remaining ${left}` : ''}\\.`, [[plain('🔔 Alert types', D('home'))]]);
    }
    default: return ctx.reply('This button has expired.');
  }
}

module.exports = { key: 'alerts', label: 'Alert types', emoji: '🔔', level: 'account', scopes: [], handle };
