/**
 * 🛡️ Admin dashboard, inline inside 💼 Workspace (v1.3.0-multi).
 *
 *   📥 Attention   what needs an admin right now, with one-tap actions (approve / deny / resolve / mark reviewed)
 *   👥 People      all users, reports, admins & roles, bulk actions
 *   🛰️ Watch       flagged actions, activity, audit log, fleet stats — and, for the Owner, Warden
 *   📢 Broadcast   cast, history
 *   🛠️ System      global config, feature switches, maintenance — and, for the Owner, lockdown, GitHub traffic, export/import
 *
 * The four tiers keep working exactly as before: moderators see counts only, admins see flagged items and activity,
 * super admins add the audit trail and alert rules, the Owner adds the hold switch, approvals and the Owner-only tools.
 * Every screen is one live message edited in place, ends with Back + Workspace, and never sends a bottom keyboard.
 */
const style = require('../keyboards/buttonStyle');
const ui = require('./manage/ui');

const { esc, plain, btn, navRow } = ui;
const nameOf = (r) => (r.telegram_username ? `@${r.telegram_username}` : (r.telegram_first_name || `#${r.telegram_id}`));

async function tier(ctx) {
  const roles = require('../lib/roles');
  const role = await roles.getRole(ctx.from.id);
  return { role, owner: roles.isOwner(ctx.from.id), admin: roles.atLeast(role, 'admin'), superAdmin: roles.atLeast(role, 'super_admin') };
}

/** Label for the first tile — what each tier actually gets there. */
function attentionLabel(t, total) {
  const base = t.admin ? '📥 Attention' : '📥 Reports';
  return total ? `${base} (${total})` : base;
}

async function show(ctx, text, rows) {
  return ui.show(ctx, ui.fit(text), { parse_mode: 'MarkdownV2', ...ui.Markup.inlineKeyboard(rows) });
}

// ─── 🛡️ Dashboard ──────────────────────────────────────────────────
async function showDashboard(ctx) {
  const admin = require('./admin');
  if (!(await admin.requireAdmin(ctx))) return;
  const t = await tier(ctx);
  const [overview, counts] = await Promise.all([
    require('../lib/adminStats').fleetOverview(),
    require('../lib/adminAttention').counts(ctx.from.id),
  ]);
  const maintenance = require('../lib/maintenance');
  const adminName = ctx.from.username ? `@${esc(ctx.from.username)}` : esc(ctx.from.first_name || String(ctx.from.id));
  const roster = (await require('../lib/roles').listAdmins().catch(() => [])).length || require('../config').ADMIN_IDS.length;
  const text =
    `🛡️ *Admin*\n` +
    `_${adminName}${roster > 1 ? ` · 1 of ${roster} admins` : ''}${t.owner ? ' · Owner' : ''}_\n\n` +
    (maintenance.isEnabled() ? `🩺 *MAINTENANCE MODE IS ON* — non\\-admins are blocked\\.\n\n` : '') +
    (counts.total ? `📥 *${counts.total}* waiting for you\\.\n\n` : '✅ Nothing waiting\\.\n\n') +
    `👥 ${overview.totalUsers} users \\(${overview.activeToday} active today\\) · 🆕 ${overview.newToday} today\n` +
    `🔗 ${overview.connected} connected · 🚫 ${overview.blocked} banned · ⏸️ ${overview.suspended} suspended\n` +
    `⚠️ ${overview.errorsToday} error\\(s\\) in 24h`;
  const rows = [
    [btn(attentionLabel(t, counts.total), 'admin:attn', counts.total ? style.GREEN : style.BLUE)],
    [plain('👥 People', 'admin:people'), plain('🛰️ Watch', 'admin:watch')],
    [plain('📢 Broadcast', 'admin:broadcast:hub'), plain('🛠️ System', 'admin:system')],
    [plain('🔄 Refresh', 'admin:refresh')],
    ...(require('../lib/roles').isOwner(ctx.from.id) && require('../lib/ownerWeb').enabled() ? [[plain('🌐 Web panel', 'admin:web')]] : []),
    [style.callback('💼 Workspace', 'manage:ws', style.BLUE)],
  ];
  return show(ctx, text, rows);
}

// ─── 📥 Attention ──────────────────────────────────────────────────
async function showAttention(ctx) {
  const admin = require('./admin');
  if (!(await admin.requireAdmin(ctx))) return;
  const t = await tier(ctx);
  const attention = require('../lib/adminAttention');
  const [counts, list] = await Promise.all([attention.counts(ctx.from.id), attention.items(ctx.from.id, { limit: 3 })]);
  const sens = require('../lib/sensitiveActions');
  const lines = ['📥 *Attention*', ''];
  const rows = [];

  if (!t.admin) {
    lines.push(`🚩 Open reports: *${counts.reports}*`, `⚠️ Flagged items: *${counts.flagged}*`, '', '_Counts only at your level\\._');
  } else {
    if (list.approvals.length) {
      lines.push(`⏳ *Waiting for your OK* \\(${counts.held}\\)`);
      for (const a of list.approvals) {
        lines.push(`• ${esc(nameOf(a))} — ${esc(sens.LABELS[a.action] || a.action)}${a.repo_name ? ` · ${esc(a.repo_name)}` : ''}`);
        rows.push([btn(`✅ Allow ${nameOf(a)}`.slice(0, 30), `admin:mon:appr:${a.id}:ok:a`, style.GREEN), btn('🚫 Deny', `admin:mon:appr:${a.id}:no:a`, style.RED)]);
      }
      lines.push('');
    }
    if (list.reports.length) {
      lines.push(`🚩 *Reports* \\(${counts.reports}\\)`);
      for (const r of list.reports) {
        const preview = String(r.message || '').replace(/\s+/g, ' ').slice(0, 40);
        lines.push(`• ${esc(nameOf(r))}: ${esc(preview)}`);
        rows.push([plain(`👁 ${nameOf(r)}`.slice(0, 22), `admin:report:${r.id}`), btn('✅', `admin:report:${r.id}:resolve`, style.GREEN), btn('🗑', `admin:report:${r.id}:dismiss`, style.RED)]);
      }
      lines.push('');
    }
    if (list.flagged.length) {
      lines.push(`🚩 *Flagged actions* \\(${counts.flagged}\\)`);
      for (const f of list.flagged) {
        lines.push(`• ${esc(nameOf(f))} — ${esc(sens.LABELS[f.action] || f.action)} · risk ${f.score}`);
        rows.push([plain(`🔎 ${nameOf(f)}`.slice(0, 22), `admin:mon:fv:${f.id}`), btn('✅ Reviewed', `admin:mon:rev:${f.id}`, style.GREEN)]);
      }
      lines.push('');
    }
    if (list.openCases) {
      lines.push(`🤖 Open Warden cases: *${list.openCases}*`);
      if (t.owner) rows.push([plain(`🗂 Warden board (${list.openCases})`, 'warden:board:1')]);
      lines.push('');
    }
    if (!rows.length && !list.openCases) lines.push('_All clear\\. 🎉_');
  }
  rows.push([plain('🔄 Refresh', 'admin:attn')]);
  rows.push(navRow('Admin', 'admin:dashboard'));
  return show(ctx, lines.join('\n'), rows);
}

// ─── 🛰️ Watch ──────────────────────────────────────────────────────
async function showWatch(ctx) {
  const admin = require('./admin');
  if (!(await admin.requireAdmin(ctx))) return;
  const t = await tier(ctx);
  const c = await require('../lib/sensitiveActions').counts().catch(() => ({}));
  const text =
    `🛰️ *Watch*\n\nLook\\-don't\\-act screens\\.\n\n` +
    `🚩 Flagged, not reviewed: *${c.flagged_open || 0}*\n` +
    `⚡ Sensitive actions \\(24h\\): *${c.actions_24h || 0}*\n` +
    `⏸️ Feature pauses: *${c.pauses || 0}*` +
    (t.admin ? '' : '\n\n_Counts only at your level\\._');
  const rows = [];
  if (t.admin) rows.push([plain(`🚩 Flagged (${c.flagged_open || 0})`, 'admin:mon:flag:1'), plain('📜 Audit log', 'admin:audit:entry')]);
  rows.push([plain('📊 Fleet stats', 'admin:fleet'), plain('🛰️ Activity & counts', 'admin:mon')]);
  if (t.superAdmin) rows.push([plain('🧾 Manage audit', 'admin:mon:audit:1:c'), plain('⚙️ Alert rules', 'admin:mon:rules')]);
  if (t.owner) rows.push([plain('🤖 Warden Brain', 'warden:main')]);
  rows.push(navRow('Admin', 'admin:dashboard'));
  return show(ctx, text, rows);
}

// ─── 🛠️ System ─────────────────────────────────────────────────────
async function showSystem(ctx) {
  const admin = require('./admin');
  if (!(await admin.requireAdmin(ctx))) return;
  const t = await tier(ctx);
  const maintenance = require('../lib/maintenance');
  const text = `🛠️ *System*\n\nFleet\\-wide levers — none are about one person\\.${maintenance.isEnabled() ? '\n\n🩺 *Maintenance mode is ON\\.*' : ''}`;
  const rows = [
    [plain('⚙️ Global config', 'admin:config'), plain('🧩 Feature switches', 'admin:features')],
    [plain(maintenance.isEnabled() ? '🩺 Maintenance (ON)' : '🩺 Maintenance', 'admin:maintenance')],
  ];
  if (t.owner) {
    rows.push([plain('🔒 Lockdown', 'admin:lockdown'), plain('🌐 GitHub traffic', 'admin:ghtraffic')]);
    rows.push([plain('🗄️ Export / Import', 'migrate:hub')]);
  }
  rows.push(navRow('Admin', 'admin:dashboard'));
  return show(ctx, text, rows);
}

module.exports = { showDashboard, showAttention, showWatch, showSystem, attentionLabel, tier };
