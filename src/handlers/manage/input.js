/**
 * Typed-answer prompts for the manage areas (v1.2.4-multi): "send the PR title", "paste the secret value".
 *
 * One session flag (`manageInput`) holds what we are waiting for; the free-text router in bot.js calls
 * handleText/handleDocument. The flag is dropped when the person taps any button, a menu label or ❌ Cancel
 * (it is in the bot's REARMABLE list), so a stale prompt can never swallow an unrelated message.
 */
const { Markup } = require('telegraf');
const style = require('../../keyboards/buttonStyle');
const registry = require('./registry');

const DEFAULT_MAX = 4000;

/**
 * Starts a prompt. `area` is the registered area key whose `onInput(ctx, { action, args, repoName, text })`
 * receives the answer. `secret: true` deletes the person's message right after it is read.
 */
async function ask(ctx, { area, action, repoName = null, args = [], prompt, secret = false, maxLen = DEFAULT_MAX, acceptsDocument = false, cancelData = 'manage:cancel' }) {
  ctx.session.manageInput = { area, action, repoName, args: args.map(String), secret: !!secret, maxLen, acceptsDocument: !!acceptsDocument };
  const rows = [[style.callback('❌ Cancel', cancelData, style.RED)]];
  const sent = await ctx.reply(prompt, Markup.inlineKeyboard(rows));
  if (sent && sent.message_id) ctx.session.manageInput.promptId = sent.message_id;
}

/**
 * v1.3.0-multi — re-anchor: once an answer was accepted, the typed message and the bot's prompt are deleted so the
 * result (sent fresh by the area, with its next-step buttons) is the last thing in the chat and nothing has to be
 * scrolled to. Best effort: a message that can't be deleted (too old, no rights) is simply left.
 */
async function reanchor(ctx, pending) {
  try { if (!pending.secret && ctx.message && typeof ctx.deleteMessage === 'function') await ctx.deleteMessage(); } catch (_) { /* leave it */ }
  try { if (pending.promptId && ctx.chat && ctx.telegram && ctx.telegram.deleteMessage) await ctx.telegram.deleteMessage(ctx.chat.id, pending.promptId); } catch (_) { /* leave it */ }
}

function clear(ctx) { if (ctx.session) delete ctx.session.manageInput; }

async function dispatch(ctx, pending, text) {
  const area = registry.get(pending.area);
  if (!area || typeof area.onInput !== 'function') return ctx.reply('That prompt has expired.');
  const features = require('../../lib/features');
  if (!features.isEnabled(area.key)) return ctx.reply('This feature was switched off by the bot’s admins.');
  try {
    return await area.onInput(ctx, { action: pending.action, args: pending.args, repoName: pending.repoName, text });
  } catch (err) {
    // Keep the prompt armed after a failure so the person can fix their answer or cancel; a GitHub error is
    // reported the standard way (rate limit, revoked token → reconnect flow…).
    if (err && err.userInput) {
      ctx.session.manageInput = pending;
      return ctx.reply(`⚠️ ${err.message}\nSend it again, or tap ❌ Cancel.`);
    }
    return require('../../lib/errorHelpers').replyGithubError(ctx, err, area.label);
  }
}

/** Free-text router entry. Returns when the message was consumed. */
async function handleText(ctx) {
  const pending = ctx.session.manageInput;
  if (!pending) return false;
  clear(ctx); // consumed first: a crash can never leave the prompt armed forever (see dispatch for re-arming)
  const raw = String(ctx.message.text || '');
  if (pending.secret) ctx.deleteMessage().catch(() => {});
  const text = raw.trim();
  if (!text) { ctx.session.manageInput = pending; await ctx.reply('Send some text, or tap ❌ Cancel.'); return true; }
  if (text.length > pending.maxLen) {
    ctx.session.manageInput = pending;
    await ctx.reply(`That’s ${text.length} characters — the limit here is ${pending.maxLen}. Shorten it and send again, or tap ❌ Cancel.`);
    return true;
  }
  await dispatch(ctx, pending, text);
  if (ctx.session.manageInput !== pending) await reanchor(ctx, pending); // answer accepted (not re-armed after a bad input)
  return true;
}

/** A text/code file sent while a prompt that accepts documents is armed (e.g. gist content). */
async function handleDocument(ctx) {
  const pending = ctx.session.manageInput;
  if (!pending || !pending.acceptsDocument) return false;
  const doc = ctx.message.document;
  if (!doc || (doc.file_size || 0) > 512 * 1024) {
    await ctx.reply('That file is too large (limit 512 KB) — send a smaller one, or tap ❌ Cancel.');
    return true;
  }
  clear(ctx);
  let text;
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(String(link), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.includes(0)) throw new Error('binary');
    text = buf.toString('utf8');
  } catch (_) {
    ctx.session.manageInput = pending;
    await ctx.reply('I couldn’t read that as a text file. Send a plain text/code file, paste the text, or tap ❌ Cancel.');
    return true;
  }
  await dispatch(ctx, { ...pending, fileName: doc.file_name || null }, text);
  return true;
}

/** An error an area's onInput throws to say "bad answer, ask again" (re-arms the prompt). */
function inputError(message) {
  return Object.assign(new Error(message), { userInput: true });
}

module.exports = { ask, clear, handleText, handleDocument, inputError, DEFAULT_MAX };
