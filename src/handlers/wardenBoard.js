/**
 * 🗂 Warden Owner Board — where Warden's findings land and where the OWNER
 * decides what (if anything) to do. Every action here is manual: trust,
 * shield, keep watching, dismiss, send a warning, or open the normal
 * user-actions screen. Warden itself never takes any of them.
 */
const cases = require('../lib/wardenBrain/cases');
const warnings = require('../lib/wardenBrain/warnings');
const { STAGE_LABEL } = require('../lib/wardenBrain/engine');
const adminActions = require('../lib/adminActions');
const repoShield = require('../lib/repoShield');
const users = require('../lib/users');
const inline = require('../keyboards/inline');
const { safeEditMessageText } = require('../lib/safeEdit');

const HTML = { parse_mode: 'HTML' };
const { esc } = warnings;

async function render(ctx, text, keyboard, edit) {
  if (edit && (await safeEditMessageText(ctx, text, { ...HTML, ...keyboard }))) return;
  await ctx.reply(text, { ...HTML, ...keyboard });
}

// ─── Board ────────────────────────────────────────────────────────────
async function showBoard(ctx, { page = 1, edit = true, adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const filterKey = (ctx.session && ctx.session.wardenBoardFilter) || 'all';
  const f = inline.BOARD_FILTERS.find((x) => x.key === filterKey) || inline.BOARD_FILTERS[0];
  const { rows, total } = await cases.listOpen({ minStage: f.minStage, page, perPage: 5 });
  const totalPages = Math.max(1, Math.ceil(total / 5));
  const text =
    `🗂 <b>Warden Board</b> — ${total} open case${total === 1 ? '' : 's'}\n` +
    `<i>Filter: ${esc(f.label)}</i>\n\n` +
    (rows.length
      ? `Tap a case to see the evidence and decide. <i>🚩 flagged · 🔎 enhanced monitoring · 🧾 ready for review · R = risk · 💤 snoozed</i>`
      : `Nothing needs your attention. 🎉\n<i>Cases appear here only when Warden has sustained, corroborated evidence — most users never reach this board.</i>`);
  await render(ctx, text, inline.wardenBoardList(rows, page, totalPages, f.key), edit);
}

async function cycleFilter(ctx, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const keys = inline.BOARD_FILTERS.map((f) => f.key);
  const cur = (ctx.session.wardenBoardFilter || 'all');
  ctx.session.wardenBoardFilter = keys[(keys.indexOf(cur) + 1) % keys.length];
  await ctx.answerCbQuery(`Filter: ${inline.BOARD_FILTERS.find((f) => f.key === ctx.session.wardenBoardFilter).label}`).catch(() => {});
  return showBoard(ctx, { page: 1, adminFn });
}

// ─── Case card ────────────────────────────────────────────────────────
async function loadCase(ctx, id, adminFn) {
  const c = await cases.getCase(id);
  if (!c) {
    await ctx.answerCbQuery('That case no longer exists.').catch(() => {});
    await showBoard(ctx, { page: 1, adminFn });
    return null;
  }
  return c;
}

async function showCase(ctx, id, { edit = true, adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const c = await loadCase(ctx, id, adminFn);
  if (!c) return;
  const [user, st, prof] = await Promise.all([users.getUser(c.telegram_id), cases.stats(c.telegram_id), cases.profileOf(c.telegram_id)]);
  const snoozed = prof.snooze_until && new Date(prof.snooze_until) > new Date() ? prof.snooze_until : null;
  let text = warnings.ownerCard({ caseRow: c, user, summary: c.summary, extras: { ...st, snoozedUntil: snoozed } });
  if (c.status !== 'open') text = `📁 <b>${esc(c.status === 'dismissed' ? 'Dismissed' : 'Resolved')}</b> — ${esc(c.close_reason || '')}\n\n` + text;
  await render(ctx, text, inline.wardenCaseCard(c.id, { trusted: !!(user && user.is_trusted), shielded: !!(user && user.repos_protected), isOpen: c.status === 'open' }), edit);
}

async function toggleTrust(ctx, id, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const c = await loadCase(ctx, id, adminFn); if (!c) return;
  const user = await users.getUser(c.telegram_id);
  const next = !(user && user.is_trusted);
  await adminActions.setTrusted(ctx.from.id, c.telegram_id, next);
  await cases.addEvent(c.id, c.telegram_id, next ? 'trusted' : 'untrusted', {}, ctx.from.id);
  await ctx.answerCbQuery(next ? '⭐ Trusted — still observed and logged, never acted on.' : 'Trust removed.').catch(() => {});
  return showCase(ctx, id, { adminFn });
}

async function toggleShield(ctx, id, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const c = await loadCase(ctx, id, adminFn); if (!c) return;
  const user = await users.getUser(c.telegram_id);
  const next = !(user && user.repos_protected);
  await repoShield.setOne(ctx.from.id, c.telegram_id, next);
  await cases.addEvent(c.id, c.telegram_id, next ? 'repos_shielded' : 'repos_unshielded', {}, ctx.from.id);
  await ctx.answerCbQuery(next ? '🛡 Repos shielded from other admins.' : 'Repo shield removed.').catch(() => {});
  return showCase(ctx, id, { adminFn });
}

async function keepWatching(ctx, id, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const c = await loadCase(ctx, id, adminFn); if (!c) return;
  await cases.snooze(c.id, ctx.from.id, 7);
  await ctx.answerCbQuery('💤 Snoozed 7 days — no pings. Warden keeps monitoring.').catch(() => {});
  return showCase(ctx, id, { adminFn });
}

async function dismissCase(ctx, id, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const c = await loadCase(ctx, id, adminFn); if (!c) return;
  await cases.dismiss(c.id, ctx.from.id, 7);
  await ctx.answerCbQuery("✅ Dismissed — recorded as a false positive. Warden won't reopen it for 7 days unless it becomes serious.").catch(() => {});
  return showBoard(ctx, { page: 1, adminFn });
}

// ─── Warning (always previewed, never automatic) ──────────────────────
function noticeFor(c) {
  return warnings.userNotice((c.summary && c.summary.classes) || []);
}

async function previewWarning(ctx, id, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const c = await loadCase(ctx, id, adminFn); if (!c) return;
  const text =
    `⚠️ <b>Preview</b> — this exact message will be sent to the user:\n\n<pre>${esc(noticeFor(c))}</pre>\n` +
    `<i>It contains no scores or thresholds, and nothing is restricted. Nothing is sent until you tap Send.</i>`;
  await render(ctx, text, inline.wardenWarnPreview(c.id), true);
}

async function sendWarning(ctx, id, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const c = await loadCase(ctx, id, adminFn); if (!c) return;
  const notice = noticeFor(c);
  try {
    await ctx.telegram.sendMessage(c.telegram_id, notice);
  } catch (err) {
    await ctx.answerCbQuery("Couldn't deliver — the user may have blocked the bot.", { show_alert: true }).catch(() => {});
    return showCase(ctx, id, { adminFn });
  }
  const first = warnings.observationsFor((c.summary && c.summary.classes) || [])[0] || null;
  await cases.addEvent(c.id, c.telegram_id, 'warning_sent', { summary: first, text: notice }, ctx.from.id);
  await adminActions.auditLog(ctx.from.id, c.telegram_id, 'warden_warning', first || 'unusual activity notice');
  await ctx.answerCbQuery('⚠️ Warning sent.').catch(() => {});
  return showCase(ctx, id, { adminFn });
}

// ─── Timeline ─────────────────────────────────────────────────────────
const EVENT_ICON = { opened: '🆕', stage_changed: '↕️', warning_sent: '⚠️', dismissed: '✅', snoozed: '💤', resolved: '🟢', trusted: '⭐', untrusted: '⭐', repos_shielded: '🛡', repos_unshielded: '🛡' };

function describeEvent(e) {
  const d = e.detail || {};
  switch (e.kind) {
    case 'opened': return `opened at ${STAGE_LABEL[d.stage] || d.stage}`;
    case 'stage_changed': return `${STAGE_LABEL[d.from] || d.from} → ${STAGE_LABEL[d.to] || d.to}`;
    case 'warning_sent': return `warning sent${d.summary ? ` (${d.summary})` : ''}`;
    case 'dismissed': return 'dismissed (false positive)';
    case 'snoozed': return `kept watching, snoozed ${d.days || 7} days`;
    case 'resolved': return 'resolved — returned to normal';
    case 'trusted': return 'marked Trusted';
    case 'untrusted': return 'trust removed';
    case 'repos_shielded': return 'repos shielded';
    case 'repos_unshielded': return 'repo shield removed';
    default: return e.kind;
  }
}

async function showTimeline(ctx, id, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const c = await loadCase(ctx, id, adminFn); if (!c) return;
  const events = await cases.getEvents(c.id, 12);
  let text = `📜 <b>Timeline — case #${c.id}</b>\n\n`;
  if (!events.length) text += '<i>No events yet.</i>';
  for (const e of events) {
    const ts = new Date(e.created_at).toISOString().slice(0, 16).replace('T', ' ');
    text += `${EVENT_ICON[e.kind] || '•'} ${esc(describeEvent(e))}\n<i>${esc(ts)} UTC${e.actor ? ' · by you' : ' · Warden'}</i>\n\n`;
  }
  await render(ctx, text, inline.wardenBackToCase(c.id), true);
}

// ─── Enforcement gate (a warning comes first, unless it's a severe case) ──
async function showEnforcementGate(ctx, id, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const c = await loadCase(ctx, id, adminFn); if (!c) return;
  const last = await cases.lastWarning(c.telegram_id);
  const text = last
    ? `🔨 <b>Enforcement</b>\n\nThis user was warned on <b>${esc(String(last.at.toISOString ? last.at.toISOString() : last.at).slice(0, 10))}</b>${last.summary ? ` (${esc(last.summary)})` : ''}.\n\nThe next screen has the normal user actions (suspend, ban, limits). Any notice they receive will mention the earlier warning and the exact reason you give.`
    : `🔨 <b>Enforcement</b>\n\n⚠️ <b>No warning has been sent to this user.</b>\n\nA specific warning first is strongly recommended — it gives them a chance to correct course. Skip it only for a severe case.\n\nWhatever you choose next, the reason you write is sent to the user exactly as written.`;
  await render(ctx, text, inline.wardenEnforcementGate(c.id, !!last), true);
}

async function enforcementContinue(ctx, id, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const c = await loadCase(ctx, id, adminFn); if (!c) return;
  return adminFn.showUserDetail(ctx, c.telegram_id, { edit: true });
}

// ─── 🛡 Repo Shield (bulk) ────────────────────────────────────────────
async function showShield(ctx, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const st = await repoShield.stats();
  const text =
    `🛡 <b>Repo Shield</b>\n\n` +
    `Protected accounts can't have their repositories viewed, downloaded, deleted or changed by other admins from the Dashboard. Only you can still act on them. Blocked attempts are written to the audit log.\n\n` +
    `<b>${st.connected_protected}</b> of <b>${st.connected}</b> connected users are protected (${st.protected} of ${st.total} accounts overall).\n` +
    `Tap a button to protect everyone in that group, or tap it again to unprotect them — 🛡 all protected, ◐ some, 🔓 none.\n` +
    `<i>New users start unprotected. Every bulk change can be undone.</i>`;
  await render(ctx, text, inline.wardenShieldMenu(st), true);
}

/** One tap on a scope button: set that whole scope to `protect`, no confirm step (it is undoable). */
async function setShield(ctx, scope, protect, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const pv = await repoShield.preview(scope, protect);
  if (!pv.willChange) {
    await ctx.answerCbQuery(`Already ${protect ? 'protected' : 'unprotected'} — nothing to change.`).catch(() => {});
    return showShield(ctx, { adminFn });
  }
  const r = await repoShield.bulk(ctx.from.id, scope, protect);
  await ctx.answerCbQuery(`${protect ? '🛡 Protected' : '🔓 Unprotected'} ${r.changed} account${r.changed === 1 ? '' : 's'}.`).catch(() => {});
  return showShield(ctx, { adminFn });
}

async function askShield(ctx, scope, protect, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const pv = await repoShield.preview(scope, protect);
  if (!pv.willChange) return ctx.answerCbQuery(`Already ${protect ? 'protected' : 'unprotected'} — nothing to change.`, { show_alert: true }).catch(() => {});
  const text = `🛡 <b>${protect ? 'Protect' : 'Unprotect'} ${esc(pv.label)}?</b>\n\nThis will change <b>${pv.willChange}</b> account${pv.willChange === 1 ? '' : 's'}. Accounts already ${protect ? 'protected' : 'unprotected'} are skipped, and you can undo it afterwards.`;
  await render(ctx, text, inline.wardenShieldConfirm(scope, protect), true);
}

async function doShield(ctx, scope, protect, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const r = await repoShield.bulk(ctx.from.id, scope, protect);
  await ctx.answerCbQuery(`${protect ? '🛡 Protected' : '🔓 Unprotected'} ${r.changed} account${r.changed === 1 ? '' : 's'}.`, { show_alert: true }).catch(() => {});
  return showShield(ctx, { adminFn });
}

async function undoShield(ctx, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const r = await repoShield.undoLast(ctx.from.id);
  await ctx.answerCbQuery(r.ok ? `↩️ Restored ${r.restored} account${r.restored === 1 ? '' : 's'}.` : 'Nothing to undo.', { show_alert: true }).catch(() => {});
  return showShield(ctx, { adminFn });
}

module.exports = {
  showBoard, cycleFilter, showCase, toggleTrust, toggleShield, keepWatching, dismissCase,
  previewWarning, sendWarning, showTimeline, showEnforcementGate, enforcementContinue,
  showShield, setShield, askShield, doShield, undoShield, describeEvent,
};
