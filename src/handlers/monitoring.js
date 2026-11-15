/**
 * 🛰️ Monitoring (v1.2.5-multi) — Warden Watch's screens, with the SAME data shown to each admin tier at a
 * different depth:
 *
 *   guest / moderator   read-only COUNTS (no names, no lists)
 *   admin               + flagged actions, one person's activity across all their accounts, per-person feature pauses
 *   super admin / owner + full audit trail of Manage actions, alert rules (notify admins, burst threshold, daily briefing)
 *   owner only          + the "hold risky actions for my OK" switch and the approve/deny buttons
 *
 * Tokens, secrets and file contents are never stored by the monitoring layer, so no tier can ever see them.
 * Callback data: admin:mon[:<screen>[:<args>]]
 */
const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const format = require('../lib/format');
const { safeEditMessageText } = require('../lib/safeEdit');
const sens = require('../lib/sensitiveActions');
const globalConfig = require('../lib/globalConfig');

const esc = format.escapeMd;
const cb = (t, d, c) => style.callback(t, d, c);
const back = (label, data) => [cb(`⬅️ ${label}`, data, style.BLUE)];

async function show(ctx, text, rows) {
  const extra = { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) };
  if (ctx.callbackQuery && (await safeEditMessageText(ctx, text.slice(0, 3900), extra))) return;
  await ctx.reply(text.slice(0, 3900), extra);
}

const nameOf = (r) => (r.telegram_username ? `@${r.telegram_username}` : (r.telegram_first_name || `#${r.telegram_id}`));
const ago = (d) => format.relativeTime(d);

async function tier(ctx) {
  const roles = require('../lib/roles');
  const role = await roles.getRole(ctx.from.id);
  return { role, owner: roles.isOwner(ctx.from.id), admin: roles.atLeast(role, 'admin'), superAdmin: roles.atLeast(role, 'super_admin') };
}

async function hub(ctx, t) {
  const c = await sens.counts();
  const lines = [
    '🛰️ *Monitoring*', '',
    `🚩 Flagged, not yet reviewed: *${c.flagged_open}*`,
    `⚡ Sensitive actions \\(24h\\): *${c.actions_24h}*`,
    `🧭 Manage taps \\(24h\\): *${c.manage_24h}*`,
    `⏸️ Feature pauses in force: *${c.pauses}*`,
    `⏳ Waiting for owner approval: *${c.approvals_pending}*`,
    `🔌 Extra GitHub accounts found revoked: *${c.dead_accounts}*`,
  ];
  if (!t.admin) lines.push('', '_Counts only at your level\\._');
  const rows = [];
  if (t.admin) rows.push([cb(`🚩 Flagged actions (${c.flagged_open})`, 'admin:mon:flag:1')]);
  if (t.superAdmin) rows.push([cb('🧾 Audit trail', 'admin:mon:audit:1:c'), cb('⚙️ Alert rules', 'admin:mon:rules')]);
  rows.push([cb('🔄 Refresh', 'admin:mon')]);
  rows.push(back('Back to Watch', 'admin:watch'));
  return show(ctx, lines.join('\n'), rows);
}

async function flagged(ctx, pg) {
  const r = await sens.listFlagged({ limit: 6, offset: (pg - 1) * 6 });
  const rows = r.items.map((i) => [cb(`🚩 ${nameOf(i)} · ${sens.LABELS[i.action] || i.action} · ${i.score}`.slice(0, 60), `admin:mon:fv:${i.id}`)]);
  const nav = [];
  if (pg > 1) nav.push(cb('◀️ Prev', `admin:mon:flag:${pg - 1}`));
  if (r.hasNext) nav.push(cb('Next ▶️', `admin:mon:flag:${pg + 1}`));
  if (nav.length) rows.push(nav);
  rows.push(back('Monitoring', 'admin:mon'));
  return show(ctx, `🚩 *Flagged actions*${r.items.length ? '\nTap one to look closer\\.' : '\n\n_Nothing flagged\\. 🎉_'}`, rows);
}

async function flagView(ctx, id) {
  const { pool } = require('../db/postgres');
  const { rows } = await pool.query(
    `SELECT s.*, u.telegram_username, u.telegram_first_name FROM sensitive_actions s LEFT JOIN users u ON u.telegram_id = s.telegram_id WHERE s.id = $1`, [id]);
  const i = rows[0];
  if (!i) return show(ctx, '⚠️ That entry is gone\\.', [back('Flagged', 'admin:mon:flag:1')]);
  const lines = [
    `🚩 *${esc(sens.LABELS[i.action] || i.action)}*`,
    `${esc(nameOf(i))}${i.account_login ? ` · GitHub ${esc(i.account_login)}` : ''}`,
    `${i.repo_name ? `Repo ${esc(i.repo_name)} · ` : ''}risk ${i.score}/100 · ${esc(ago(i.created_at))}`,
    i.detail ? `_${esc(i.detail)}_` : '',
    i.reviewed_at ? '\n✅ Reviewed' : '',
  ].filter(Boolean);
  const kb = [];
  if (!i.reviewed_at) kb.push([cb('✅ Mark reviewed', `admin:mon:rev:${i.id}`, style.GREEN)]);
  kb.push([cb('👤 Open user', `admin:user:${i.telegram_id}`), cb('📈 Activity', `admin:mon:u:${i.telegram_id}`)]);
  kb.push(back('Flagged', 'admin:mon:flag:1'));
  return show(ctx, lines.join('\n'), kb);
}

async function userActivity(ctx, t, targetId) {
  const roles = require('../lib/roles');
  if (roles.isOwner(targetId) && !t.owner) return show(ctx, '🔒 The owner’s activity is private\\.', [back('Monitoring', 'admin:mon')]);
  const a = await sens.userActivity(targetId);
  const pauses = await sens.listPauses(targetId);
  const lines = [`📈 *Activity* — \\#${targetId}`, ''];
  lines.push(a.accounts.length
    ? `*GitHub accounts*\n${a.accounts.map((x) => `• ${esc(x.github_login)}${x.health_status === 'revoked' ? ' ⚠️ revoked' : ''}`).join('\n')}`
    : '_No extra GitHub accounts\\._');
  lines.push('', '*Sensitive actions*');
  lines.push(a.sensitive.length ? a.sensitive.map((s) => `• ${s.flagged ? '🚩 ' : ''}${esc(sens.LABELS[s.action] || s.action)}${s.repo_name ? ` · ${esc(s.repo_name)}` : ''}${s.account_login ? ` · ${esc(s.account_login)}` : ''} · ${esc(ago(s.created_at))}`).join('\n') : '_None\\._');
  lines.push('', '*Recent changes in Manage*');
  lines.push(a.changes.length ? a.changes.slice(0, 8).map((s) => `• ${esc(s.area)}/${esc(s.action)}${s.repo_name ? ` · ${esc(s.repo_name)}` : ''}${s.account_login ? ` · ${esc(s.account_login)}` : ''} · ${esc(ago(s.created_at))}`).join('\n') : '_None\\._');
  if (pauses.length) lines.push('', `*Paused for them:* ${pauses.map((p) => esc(p.feature_key)).join(', ')}`);
  const canPause = !roles.isOwner(targetId);
  return show(ctx, lines.join('\n'), [
    ...(canPause ? [[cb('⏸️ Pause / resume a feature', `admin:mon:pz:${targetId}`)]] : []),
    [cb('👤 Open user', `admin:user:${targetId}`)],
    back('Monitoring', 'admin:mon'),
  ]);
}

async function pausePicker(ctx, targetId) {
  const registry = require('./manage/registry');
  if (require('../lib/roles').isOwner(targetId)) {
    return show(ctx, `⏸️ *Pause a feature for \\#${targetId}*\n\n🔒 This is the owner\\. The owner can’t be paused\\.`, [back('Activity', `admin:mon:u:${targetId}`)]);
  }
  const paused = new Set((await sens.listPauses(targetId)).map((p) => p.feature_key));
  const rows = registry.list().map((a) => [cb(`${paused.has(a.key) ? '⏸️' : '▶️'} ${a.emoji} ${a.label}`.slice(0, 60), `admin:mon:pzt:${targetId}:${a.key}`, paused.has(a.key) ? style.RED : style.BLUE)]);
  rows.push(back('Activity', `admin:mon:u:${targetId}`));
  return show(ctx, `⏸️ *Pause a feature for \\#${targetId}*\n\nTap to pause or resume one area *for this person only*\\. Everyone else is unaffected\\. ⏸️ means paused now\\.`, rows);
}

async function audit(ctx, pg, onlyChanges) {
  const r = await sens.auditTrail({ onlyChanges, limit: 8, offset: (pg - 1) * 8 });
  const lines = [`🧾 *Audit trail* — ${onlyChanges ? 'changes only' : 'every tap'}`, ''];
  lines.push(r.items.length ? r.items.map((a) => `• ${esc(nameOf(a))}${a.account_login ? ` \\(${esc(a.account_login)}\\)` : ''} — ${esc(a.area)}/${esc(a.action)}${a.repo_name ? ` · ${esc(a.repo_name)}` : ''} · ${esc(ago(a.created_at))}`).join('\n') : '_Nothing yet\\._');
  const nav = [];
  const f = onlyChanges ? 'c' : 'a';
  if (pg > 1) nav.push(cb('◀️ Prev', `admin:mon:audit:${pg - 1}:${f}`));
  if (r.hasNext) nav.push(cb('Next ▶️', `admin:mon:audit:${pg + 1}:${f}`));
  const rows = [];
  if (nav.length) rows.push(nav);
  rows.push([cb(onlyChanges ? '👁 Show every tap' : '✏️ Changes only', `admin:mon:audit:1:${onlyChanges ? 'a' : 'c'}`)]);
  rows.push(back('Monitoring', 'admin:mon'));
  return show(ctx, lines.join('\n'), rows);
}

const BURSTS = [3, 5, 8, 12];

async function rules(ctx, t) {
  const on = (k) => sens.isOn(k);
  const burst = Number(globalConfig.get('sens_burst')) || 5;
  const rows = [
    [cb(`${on('sens_notify_admins') ? '✅' : '▫️'} Tell admins about flagged actions`, 'admin:mon:rt:sens_notify_admins')],
    [cb(`🔁 Burst: flag at ${burst} sensitive actions in 10 min`, 'admin:mon:burst')],
    [cb(`${on('warden_briefing') ? '✅' : '▫️'} Daily Warden briefing (owner)`, 'admin:mon:rt:warden_briefing')],
  ];
  if (t.owner) rows.push([cb(`${on('sens_hold') ? '✅' : '▫️'} Hold risky actions for my OK`, 'admin:mon:rt:sens_hold')]);
  rows.push(back('Monitoring', 'admin:mon'));
  const hold = t.owner ? '\n\n*Hold risky actions:* when on, an ordinary person’s transfer, branch rollback or forced revert waits for your one\\-time OK \\(admins are never held\\)\\.' : '';
  return show(ctx, `⚙️ *Alert rules*\n\nWarden Watch scores every sensitive action; high scores and bursts are flagged\\. Choose who hears about it\\.${hold}`, rows);
}

async function route(ctx, data) {
  const admin = require('./admin');
  if (!(await admin.requireAdmin(ctx))) return true;
  const [, , screen, ...args] = data.split(':');
  const t = await tier(ctx);
  const needAdmin = async () => { if (t.admin) return true; await ctx.answerCbQuery('🔒 Admin access needed for this.', { show_alert: true }).catch(() => {}); return false; };
  const needSuper = async () => { if (t.superAdmin) return true; await ctx.answerCbQuery('🔒 Super admin access needed for this.', { show_alert: true }).catch(() => {}); return false; };
  const num = (v) => (/^\d{1,15}$/.test(String(v)) ? Number(v) : null);
  const pg = (v) => Math.max(1, Math.min(500, num(v) || 1));
  await ctx.answerCbQuery().catch(() => {});
  switch (screen) {
    case undefined: case '': await hub(ctx, t); return true;
    case 'flag': if (await needAdmin()) await flagged(ctx, pg(args[0])); return true;
    case 'fv': if (await needAdmin() && num(args[0])) await flagView(ctx, num(args[0])); return true;
    case 'rev': if (await needAdmin() && num(args[0])) { await sens.markReviewed(ctx.from.id, num(args[0])); await flagged(ctx, 1); } return true;
    case 'u': if (await needAdmin() && num(args[0])) await userActivity(ctx, t, num(args[0])); return true;
    case 'pz': if (await needAdmin() && num(args[0])) await pausePicker(ctx, num(args[0])); return true;
    case 'pzt': {
      if (!(await needAdmin()) || !num(args[0])) return true;
      const target = num(args[0]); const key = args[1];
      if (!require('./manage/registry').get(key)) return true;
      if (require('../lib/roles').isOwner(target)) { await ctx.answerCbQuery('The owner can’t be paused.', { show_alert: true }).catch(() => {}); return true; }
      if ((await sens.listPauses(target)).some((p) => p.feature_key === key)) await sens.unpause(ctx.from.id, target, key); else await sens.pause(ctx.from.id, target, key);
      await pausePicker(ctx, target);
      return true;
    }
    case 'audit': if (await needSuper()) await audit(ctx, pg(args[0]), args[1] !== 'a'); return true;
    case 'rules': if (await needSuper()) await rules(ctx, t); return true;
    case 'rt': {
      if (!(await needSuper())) return true;
      const key = args[0];
      if (!['sens_notify_admins', 'warden_briefing', 'sens_hold'].includes(key)) return true;
      if (key === 'sens_hold' && !t.owner) { await ctx.answerCbQuery('Only the owner can change this.', { show_alert: true }).catch(() => {}); return true; }
      await globalConfig.set(ctx.from.id, key, sens.isOn(key) ? 'off' : 'on');
      await rules(ctx, t);
      return true;
    }
    case 'burst': {
      if (!(await needSuper())) return true;
      const cur = Number(globalConfig.get('sens_burst')) || 5;
      await globalConfig.set(ctx.from.id, 'sens_burst', BURSTS[(BURSTS.indexOf(cur) + 1) % BURSTS.length]);
      await rules(ctx, t);
      return true;
    }
    case 'appr': {
      if (!t.owner) { await ctx.answerCbQuery('Only the owner can decide this.', { show_alert: true }).catch(() => {}); return true; }
      const id = num(args[0]);
      if (!id) return true;
      const r = await sens.decide(ctx, id, args[1] === 'ok');
      const text = r.ok ? (args[1] === 'ok' ? '✅ Allowed once — they were told.' : '🚫 Denied — they were told.') : 'Already decided.';
      if (args[2] === 'a') { await ctx.answerCbQuery(text.slice(0, 180)).catch(() => {}); await require('./adminHub').showAttention(ctx); return true; }
      await safeEditMessageText(ctx, text, {}).catch(() => {});
      return true;
    }
    default: return true;
  }
}

module.exports = { route, hub, tier };
