/**
 * Shared screen-building helpers for the ⚡ Manage / 💼 Workspace areas (v1.2.4-multi), so every area
 * paginates, confirms, escapes and truncates the same way — and none can exceed Telegram's limits:
 *   • message text ≤ 4096 chars (we stop at 3900)
 *   • button text kept short; callback data ≤ 64 bytes (buttonStyle shortens long values)
 *   • every user/GitHub-supplied string goes through escapeMd before it reaches MarkdownV2
 */
const { Markup } = require('telegraf');
const style = require('../../keyboards/buttonStyle');
const format = require('../../lib/format');
const { safeEditMessageText } = require('../../lib/safeEdit');

const MAX_TEXT = 3900;
const BUTTON_TEXT_MAX = 56;

const esc = format.escapeMd;

/** Shortens to `n` characters with an ellipsis; collapses whitespace/newlines. */
function trunc(text, n = BUTTON_TEXT_MAX) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
}

/** v1.3.0-multi: a stale button — say so on the screen itself and offer one tap to start fresh. */
async function expired(ctx) {
  // v2.3.3: say WHICH button was stale, so "This screen is out of date" can be traced instead of guessed at.
  try {
    require('../../lib/logger').info('stale button — out-of-date screen shown', {
      data: ctx.callbackQuery && ctx.callbackQuery.data,
      text: ctx.message && typeof ctx.message.text === 'string' ? ctx.message.text.slice(0, 40) : undefined,
      bar: ctx.session && ctx.session.barId,
      backTo: ctx.session && ctx.session.backTo,
    });
  } catch (_) { /* diagnostics only */ }
  try { if (ctx.callbackQuery) await ctx.answerCbQuery('This screen is out of date.'); } catch (_) { /* optional */ }
  const extra = Markup.inlineKeyboard([[style.callback('🔄 Open Workspace', 'hub:ws', style.BLUE)]]);
  const text = '⌛ This screen is out of date. Tap below to refresh.';
  if (ctx.callbackQuery && (await safeEditMessageText(ctx, text, extra))) return;
  await ctx.reply(text, extra);
}

/** MarkdownV2 inline code, safe for any content. */
const code = (text) => `\`${format.escapeCodeBlock(String(text == null ? '' : text))}\``;

/** A fenced block, truncated to `max` characters of body (diffs, logs, comment text). */
function fenced(text, max = 2400) {
  let body = String(text == null ? '' : text);
  if (body.length > max) body = `${body.slice(0, max)}\n… (truncated)`;
  return `\`\`\`\n${format.escapeCodeBlock(body)}\n\`\`\``;
}

/** Keeps a finished MarkdownV2 message under Telegram's limit without cutting an escape in half. */
function fit(text, max = MAX_TEXT) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  cut = cut.replace(/\\+$/, '');          // a trailing backslash would escape the ellipsis
  const fences = (cut.match(/```/g) || []).length;
  if (fences % 2 === 1) cut += '\n```';   // close a code block we cut open
  return `${cut}\n\n…`;
}

/** Edits the tapped message in place when possible, otherwise sends a new one. */
async function show(ctx, text, extra) {
  if (ctx.callbackQuery && (await safeEditMessageText(ctx, text, extra))) return;
  await ctx.reply(text, extra);
}

/** v1.2.5-multi: "👤 @login" footer — only when the person has more than one GitHub account. */
async function accountFooter(ctx) {
  try {
    const text = await require('../../lib/ownerScope').label(ctx.from.id);
    return text || '';
  } catch (_) {
    return '';
  }
}

/** MarkdownV2 screen from finished text + button rows. */
async function screen(ctx, text, rows = []) {
  const extra = { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) };
  const who = await accountFooter(ctx);
  // Reserve room for the footer so a long screen is cut before it, never in the middle of it.
  const footer = who ? `\n\n👤 _${esc(who)}_` : '';
  return show(ctx, fit(text, MAX_TEXT - footer.length) + footer, extra);
}

/** A plain (non-markdown) notice with buttons. */
async function notice(ctx, text, rows = []) {
  const who = await accountFooter(ctx);
  const footer = who ? `\n\n👤 ${who}` : '';
  return show(ctx, String(text).slice(0, MAX_TEXT - footer.length) + footer, Markup.inlineKeyboard(rows));
}

const btn = (label, data, color = style.BLUE) => style.callback(trunc(label), data, color);
const plain = (label, data) => style.callback(trunc(label), data);
const link = (label, url) => style.url(trunc(label), url);
const back = (label, data) => [style.callback(`⬅️ ${trunc(label, 24)}`, data, style.BLUE)];

/** One row: [⬅️ <parent>] [💼 Workspace] — the standard footer of every inline screen. */
const navRow = (label, data) => [style.callback(`⬅️ ${trunc(label, 18)}`, data, style.BLUE), style.callback('💼 Workspace', 'manage:ws', style.BLUE)];
const homeRow = () => [style.callback('💼 Workspace', 'manage:ws', style.BLUE)];

/** [⬅️ Prev] [n] [Next ➡️] — only the sides that exist. `dataFor(page)` builds each callback. */
function pager(pageNo, hasNext, dataFor) {
  const row = [];
  if (pageNo > 1) row.push(style.callback('◀️ Prev', dataFor(pageNo - 1)));
  row.push(style.callback(`· ${pageNo} ·`, 'noop'));
  if (hasNext) row.push(style.callback('Next ▶️', dataFor(pageNo + 1)));
  return row.length > 1 ? row : [];
}

/** Two-button confirm: red action, green way out (the bot's standing colour convention). */
function confirmRows(yesLabel, yesData, noData, noLabel = '❌ Cancel') {
  return [[style.callback(yesLabel, yesData, style.RED)], [style.callback(noLabel, noData, style.GREEN)]];
}

/** One button per list item, then the pager, extra rows and a Back row. */
function listRows({ items, render, pageNo = 1, hasNext = false, pageData, extra = [], backRow = null }) {
  const rows = items.map((it) => {
    const r = render(it);
    return [style.callback(trunc(r.label), r.data, r.color || style.BLUE)];
  });
  if (pageData) { const p = pager(pageNo, hasNext, pageData); if (p.length) rows.push(p); }
  for (const e of extra) rows.push(e);
  if (backRow) rows.push(backRow);
  return rows;
}

const ICON = {
  open: '🟢', closed: '🔴', merged: '🟣', draft: '⚪', success: '✅', failure: '❌', cancelled: '🚫', skipped: '⏭️',
  in_progress: '🔄', queued: '⏳', completed: '🏁', neutral: '➖', timed_out: '⌛', action_required: '🟡',
};
const icon = (key) => ICON[key] || '▫️';

/** "3d ago" style, tolerant of missing dates. */
const ago = (date) => (date ? format.relativeTime(date) : '');

/**
 * Full date, time AND year in the person's own timezone/clock (My Defaults → 🌍 Timezone), e.g. "23 Oct 2026, 09:24".
 * `const when = await ui.clock(ctx)` once per screen, then `when(iso)` per line (plain text — escape it for MarkdownV2).
 * Falls back to UTC; a missing/invalid date gives ''.
 */
async function clock(ctx) {
  let tz = 'UTC'; let hour12 = false;
  try {
    const user = await require('../../lib/users').getUser(ctx.from.id);
    if (user) { tz = user.timezone || 'UTC'; hour12 = user.time_format === '12h'; }
  } catch (_) { /* UTC */ }
  const timezone = require('../../lib/timezone');
  if (!timezone.isValidTimeZone(tz)) tz = 'UTC';
  const fn = (iso) => {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return timezone.formatInZone(d, tz, { hour12 });
  };
  fn.tz = tz;
  return fn;
}

module.exports = { expired, MAX_TEXT, esc, trunc, code, fenced, fit, show, screen, notice, btn, plain, link, back, navRow, homeRow, pager, confirmRows, listRows, icon, ago, clock, Markup, style, format };
