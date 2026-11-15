/**
 * Standard result card (v2.0.0-multi) — how every finished action reports back, so receipts all look alike:
 *
 *   ✅ *Repository created*          ← status icon + what happened (bold)
 *   📦 *my-repo*  🔒 Private          ← the subject
 *   >📄 README · ⚖️ MIT              ← details, in a quote block (only what is true; empty values never shown)
 *   🔗 github.com/…                  ← the link, when there is one
 *
 * Results are KEPT in the chat (never auto-deleted) and carry at most two buttons for the obvious next step.
 * Everything is MarkdownV2 and passes through escapeMd, so callers pass plain text.
 */
const { Markup } = require('telegraf');
const format = require('./format');

const ICONS = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️' };
const esc = format.escapeMd;

/** Builds the MarkdownV2 text of a result. `details` is an array of plain strings; falsy entries are dropped. */
function text({ kind = 'success', title, subject, details = [], link, note } = {}) {
  const lines = [`${ICONS[kind] || ICONS.info} *${esc(title)}*`];
  if (subject) lines.push(subject);
  const facts = details.filter(Boolean);
  if (facts.length) lines.push(facts.map((d) => `>${esc(d)}`).join('\n'));
  if (link) lines.push(`🔗 ${esc(String(link).replace(/^https?:\/\//, ''))}`);
  if (note) lines.push(`_${esc(note)}_`);
  return lines.join('\n');
}

/** Sends a result card (kept in the chat). `rows` are inline button rows. Returns the sent message. */
async function send(ctx, opts, rows = []) {
  const extra = { parse_mode: 'MarkdownV2', __keep: true, link_preview_options: { is_disabled: true } };
  if (rows.length) Object.assign(extra, Markup.inlineKeyboard(rows));
  return ctx.reply(text(opts), extra);
}

module.exports = { text, send };
