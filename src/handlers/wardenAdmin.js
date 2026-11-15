/**
 * 🤖 Warden — main screen, decision log and JSONL export. Owner-only, gated at
 * every entry point via admin.requireOwner() (passed in as `adminFn`).
 *
 * v1.2.0-multi: Warden is an observer. This screen shows what it is watching
 * and how many people sit at each stage; the work happens on the Owner Board
 * (handlers/wardenBoard.js). Nothing here — or anywhere in Warden — can
 * restrict, suspend, ban, delete or message a user.
 */
const warden = require('../lib/warden');
const cases = require('../lib/wardenBrain/cases');
const { STAGES, STAGE_ICON, STAGE_LABEL } = require('../lib/wardenBrain/engine');
const { esc } = require('../lib/wardenBrain/warnings');
const bbtb = require('../keyboards/bbtb');
const inline = require('../keyboards/inline');
const { safeEditMessageText } = require('../lib/safeEdit');
const ephemeral = require('../lib/ephemeral');

const HTML = { parse_mode: 'HTML' };

async function showWarden(ctx, { edit = false, adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const cfg = await warden.getConfig();
  if (!cfg) return ctx.reply('⚠️ Warden config not found — run the DB migration first.');
  const [{ stages, openCases }, moves] = await Promise.all([
    cases.stageCounts().catch(() => ({ stages: Object.fromEntries(STAGES.map((s) => [s, 0])), openCases: 0 })),
    warden.getRecentSummary().catch(() => ({})),
  ]);

  const status = cfg.enabled ? '🟢 <b>Watching</b>' : '⚫ <b>Off</b> — not observing anyone';
  const stageLine = STAGES.map((s) => `${STAGE_ICON[s]} ${stages[s]}`).join('  ');
  const moveParts = Object.entries(moves).filter(([s]) => s !== 'normal').map(([s, c]) => `${STAGE_ICON[s] || '•'} ${c} → ${esc((STAGE_LABEL[s] || s).toLowerCase())}`);

  const text =
    `🤖 <b>Warden</b> — observation only\n\n` +
    `${status}\n` +
    `Warden watches, builds evidence, evaluates and reports. It never restricts, suspends, bans or messages anyone on its own.\n\n` +
    `<b>Where people are right now</b>\n${stageLine}\n` +
    `<i>${STAGES.map((s) => `${STAGE_ICON[s]} ${STAGE_LABEL[s]}`).join(' · ')}</i>\n\n` +
    `<b>Last 24h</b>  ${moveParts.length ? moveParts.join('  ') : '<i>no stage changes</i>'}\n\n` +
    `Owner, admins and ⭐ Trusted users are never acted on. Trusted users are still observed and logged.\n` +
    `<i>Each button shows its current setting — tap to flip it.</i>`;

  const shield = await require('../lib/repoShield').stats().catch(() => null);
  const keyboard = inline.wardenMainMenu(cfg, openCases, shield);
  if (edit && (await safeEditMessageText(ctx, text, { ...HTML, ...keyboard }))) return;
  await ephemeral.sendEphemeral(ctx, '🤖 Warden', bbtb.adminDashboard);
  await ctx.reply(text, { ...HTML, ...keyboard });
}

async function toggleEnabled(ctx, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const cfg = await warden.getConfig();
  await warden.updateConfig(ctx.from.id, { enabled: !cfg.enabled });
  await ctx.answerCbQuery(cfg.enabled ? '⚫ Warden is OFF — no longer observing.' : '🟢 Warden is watching.');
  return showWarden(ctx, { edit: true, adminFn });
}

async function toggleAlerts(ctx, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const cfg = await warden.getConfig();
  await warden.updateConfig(ctx.from.id, { alerts_review: !cfg.alerts_review });
  await ctx.answerCbQuery(cfg.alerts_review ? '🔕 No pings. Cases still appear on the Board.' : "🔔 You'll be pinged when a case is ready for review.");
  return showWarden(ctx, { edit: true, adminFn });
}

/** A button from an older version of this menu (Stop Now, privilege toggles,
 * limits, templates…) was tapped: say so and redraw the current menu. */
async function refreshRemoved(ctx, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  await ctx.answerCbQuery('That control was removed — Warden no longer takes actions. Menu refreshed.').catch(() => {});
  return showWarden(ctx, { edit: true, adminFn });
}

// ─── Decision log ─────────────────────────────────────────────────────
const LOG_ICON = { 'stage:normal': '🟢', 'stage:observe': '🔵', 'stage:flag': '🚩', 'stage:enhanced_monitoring': '🔎', 'stage:review_candidate': '🧾', unrestrict: '✅' };

async function showActionLog(ctx, { page = 1, edit = false, adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const PER_PAGE = 8;
  const { rows, total } = await warden.getActionLog(page, PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  let text = `📋 <b>Warden Decision Log</b> (${total})\n\n`;
  if (!rows.length) text += '<i>No decisions recorded yet.</i>';
  for (const r of rows) {
    const who = r.telegram_username ? `@${esc(r.telegram_username)}` : `#${r.target_id}`;
    const ts = esc(new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' '));
    text += `${LOG_ICON[r.action_type] || '•'} <b>${esc(r.action_type.replace('stage:', ''))}</b> → ${who}\n<i>${esc((r.reason || '').slice(0, 220))}</i>\n<i>${ts} UTC</i>\n\n`;
  }
  const keyboard = inline.wardenActionLogPagination(page, totalPages);
  if (edit && (await safeEditMessageText(ctx, text, { ...HTML, ...keyboard }))) return;
  await ctx.reply(text, { ...HTML, ...keyboard });
}

// ─── JSONL export ─────────────────────────────────────────────────────
async function showExportMenu(ctx, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const text =
    `📤 <b>Export JSONL</b>\n\n` +
    `One JSON record per line, UTC timestamps, last 90 days. Every record has a <code>record_type</code> and a schema version, ` +
    `so the files load straight into jq, pandas or any log tool.\n\n` +
    `📋 Decision log · 🗂 Cases + timelines · 🔬 Evidence · 📦 Everything (also baselines and stages)`;
  const keyboard = inline.wardenExportMenu();
  if (await safeEditMessageText(ctx, text, { ...HTML, ...keyboard })) return;
  await ctx.reply(text, { ...HTML, ...keyboard });
}

async function exportDataset(ctx, dataset, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  if (!warden.DATASETS[dataset]) return ctx.answerCbQuery('Unknown dataset').catch(() => {});
  const { filename, body, count } = await warden.exportDataset(dataset);
  if (!count) return ctx.answerCbQuery('Nothing to export yet.', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery(`Exporting ${count} record${count === 1 ? '' : 's'}…`).catch(() => {});
  await ctx.replyWithDocument({ source: Buffer.from(body, 'utf8'), filename }, { caption: `${warden.DATASETS[dataset]} · ${count} record${count === 1 ? '' : 's'} · last 90 days · JSONL` });
}

module.exports = { showWarden, toggleEnabled, toggleAlerts, refreshRemoved, showActionLog, showExportMenu, exportDataset };
