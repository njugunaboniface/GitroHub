/**
 * 🧭 Chrome (v2.0.0-multi) — the one place that owns the bottom bar, "Back", and chat tidiness.
 *
 * Four jobs, each in one home so no screen has to remember them:
 *
 *   1. THE BOTTOM BAR. Every screen has a context ("bar"): Home is the global 2×2, every other page swaps in its own
 *      (never more than two rows, ⬅️ Back always in the last row). Telegram only changes a bottom keyboard when a message
 *      is SENT with it, so a change posts one small marker message — and the previous marker is deleted, so only one
 *      marker is ever in the chat. A bar is only re-sent when it actually changes.
 *
 *   2. BACK. The bar's ⬅️ Back is the only Back in the bot. Inline "⬅️ …" / "💼 Workspace" rows are stripped from every
 *      message on the way out (see `isNav`) and the first one's callback becomes `session.backTo`; tapping ⬅️ Back
 *      replays that callback against the live screen. Screens may also set the target explicitly (`setBack`).
 *
 *   3. LIVE SCREEN. At most one "screen" (a message that is only buttons + a view) is live at a time. When a new screen
 *      is sent, the previous one is deleted; results/receipts are marked KEEP and never are. Edits in place keep the same
 *      message live — no scrolling back up, no pile of dead buttons.
 *
 *   4. THE USER'S OWN MESSAGES (bar taps, typed answers, commands) are deleted once handled.
 *
 * Everything here is defensive: a failed delete, a missing message or an old Telegram client never breaks a screen.
 */
const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const callbackRefs = require('./callbackRefs');

const BLUE = style.BLUE;
const WORKSPACE_LABEL = '💼 Workspace';
const KEEP_MAX = 40;

// ─── Bars ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Rule: ≤ 2 rows × 2 buttons, ⬅️ Back always last. A bar holds ONLY the page's own actions — never a Home button
// (My Repos / Workspace / Settings / Notifications are reachable from Home alone) and never anything the inline buttons already offer. `title` is the marker text (a short breadcrumb that reads as a header).
const BARS = {
  home: { title: '🏠 Home', rows: [['📁 My Repos', '💼 Workspace'], ['⚙️ Settings', '🔔 Notifications']] },
  repos: { title: '📁 My Repos', rows: [['➕ New Repo', '🔍 Search'], ['⭐ Pinned', '⬅️ Back']] },
  repo: { title: '📂 Repository', rows: [['📂 Files', '📤 Upload'], ['📥 Download', '⬅️ Back']] },
  files: { title: '📂 Files', rows: [['📤 Upload Here', '🔁 Replace Folder'], ['🔍 Find Files', '⬅️ Back']] },
  workspace: { title: '💼 Workspace', rows: [['⬅️ Back']] }, // Home-level buttons live on Home only; the tiles are inline
  notifications: { title: '🔔 Notifications', rows: [['✅ Mark all read', '🔄 Refresh'], ['🔕 Alert settings', '⬅️ Back']] },
  searchgh: { title: '🌐 Search GitHub', rows: [['🕘 Recent searches', '🗑️ Clear history'], ['⬅️ Back']] },
  settings: { title: '⚙️ Settings', rows: [['⬅️ Back']] },
  back: { title: '▫️', rows: [['⬅️ Back']] },
  cancel: { title: '✍️ Waiting for you…', rows: [['❌ Cancel']] },
  typing: { title: '✍️ Waiting for you…', rows: [['❌ Cancel'], ['⬅️ Back', '⏭️ Skip']] },
  typingBack: { title: '✍️ Waiting for you…', rows: [['❌ Cancel'], ['⬅️ Back']] },
  typingSkip: { title: '✍️ Waiting for you…', rows: [['❌ Cancel'], ['⏭️ Skip']] },
  disconnected: { title: '🔒 Not connected', rows: [['🔗 Connect GitHub', '💼 Workspace'], ['❓ Help', '📜 Legal']] },
  // v2.1.3: admins know /help and /legal already, and their role belongs to their Telegram account, not to a GitHub one — so
  // while not connected the second row is their dashboard.
  disconnectedAdmin: { title: '🔒 Not connected', rows: [['🔗 Connect GitHub', '💼 Workspace'], ['🛡️ Admin Dashboard']] },
};

/** Which "not connected" bar this person gets: admins get their dashboard on row 2, everyone else Help / Legal. */
const disconnectedBarId = (ctx) => (ctx && ctx.state && ctx.state.isAdmin ? 'disconnectedAdmin' : 'disconnected');

const buttons = (rows) => rows.map((row) => row.map((label) => style.text(label, BLUE)));

/** The Telegram keyboard for a bar id (null for an unknown id). */
function keyboardFor(barId) {
  const bar = BARS[barId];
  return bar ? Markup.keyboard(buttons(bar.rows)).resize() : null;
}

const signatureOfLabels = (rows) => rows.map((row) => row.map((b) => (typeof b === 'string' ? b : b && b.text)).join('|')).join('/');
const SIGNATURES = new Map(Object.entries(BARS).map(([id, bar]) => [signatureOfLabels(bar.rows), id]));

/** Which known bar a raw keyboard is (so session.barId always follows what is really on the person's screen). */
function barIdOfKeyboard(keyboard) {
  if (!Array.isArray(keyboard)) return null;
  return SIGNATURES.get(signatureOfLabels(keyboard)) || null;
}

// ─── Session helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
function sessionOf(ctx) {
  if (!ctx.session) ctx.session = {};
  return ctx.session;
}

const keepList = (s) => {
  if (!Array.isArray(s.keepIds)) s.keepIds = [];
  return s.keepIds;
};

function isKept(ctx, messageId) {
  const s = ctx.session;
  return !!(s && Array.isArray(s.keepIds) && s.keepIds.includes(messageId));
}

/** Marks a sent message as a result/receipt: never auto-deleted, never "the live screen". */
function keep(ctx, message) {
  if (!message || !message.message_id) return message;
  const s = sessionOf(ctx);
  const list = keepList(s);
  if (!list.includes(message.message_id)) list.push(message.message_id);
  if (list.length > KEEP_MAX) list.splice(0, list.length - KEEP_MAX);
  if (s.live && s.live.id === message.message_id) s.live = null;
  return message;
}

async function deleteQuietly(ctx, chatId, messageId) {
  if (!chatId || !messageId) return;
  try { await ctx.telegram.deleteMessage(chatId, messageId); } catch (_) { /* already gone, too old, or not allowed */ }
}

/** Deletes the live screen (if any). Used when a whole new context starts (Home, a new flow). */
async function dropLive(ctx) {
  const s = sessionOf(ctx);
  const live = s.live;
  s.live = null;
  if (live && live.id && !isKept(ctx, live.id)) deleteQuietly(ctx, live.chat || (ctx.chat && ctx.chat.id), live.id);
}

// ─── Back-row stripping ───────────────────────────────────────────────────────────────────────────────────────────────
const NOT_NAV = /Prev\b|Next\b|No, Go Back|Pick again|Cancel|Selection/i;

/** True for the buttons that only navigate "up" — they live on the bottom bar's ⬅️ Back now. */
function isNav(button) {
  if (!button || typeof button.callback_data !== 'string') return false;
  const text = String(button.text || '');
  if (text === WORKSPACE_LABEL) return true;
  if (NOT_NAV.test(text)) return false;
  return /^(⬅️|⬆️ Back|⬆️ Menu)/.test(text);
}

/** Removes navigation buttons from an inline keyboard. Returns { rows, back } (back = the first ⬅️ callback, if any). */
function stripNav(rows) {
  let back = null;
  const out = [];
  for (const row of rows || []) {
    const kept = [];
    for (const b of row) {
      if (isNav(b)) {
        if (!back && b.text !== WORKSPACE_LABEL) back = b.callback_data;
      } else {
        kept.push(b);
      }
    }
    if (kept.length) out.push(kept);
  }
  return { rows: out, back };
}

/** Looks at an `extra` argument and returns what to actually send plus what we learned from it. */
function prepare(extra) {
  if (!extra || typeof extra !== 'object') return { extra, kind: 'plain', keep: false };
  const wantsKeep = !!extra.__keep;
  let e = extra;
  if (wantsKeep) { e = { ...extra }; delete e.__keep; }
  const rm = e.reply_markup;
  if (!rm) return { extra: e, kind: 'plain', keep: wantsKeep };
  if (rm.keyboard) return { extra: e, kind: 'reply', barId: barIdOfKeyboard(rm.keyboard), keep: wantsKeep };
  if (rm.remove_keyboard) return { extra: e, kind: 'reply', barId: null, keep: wantsKeep };
  if (Array.isArray(rm.inline_keyboard)) {
    const { rows, back } = stripNav(rm.inline_keyboard);
    const next = { ...e };
    if (rows.length) next.reply_markup = { ...rm, inline_keyboard: rows };
    else delete next.reply_markup;
    return { extra: next, kind: 'screen', back, hadInline: true, keep: wantsKeep };
  }
  return { extra: e, kind: 'plain', keep: wantsKeep };
}


// ─── Safe send ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** True when Telegram refused a message only because its MarkdownV2 could not be parsed. */
function isParseError(err) {
  const d = String((err && ((err.response && err.response.description) || err.description || err.message)) || '');
  return /can't parse entities|can’t parse entities/i.test(d);
}

/** MarkdownV2 → plain text: drops the formatting markers and the escaping backslashes (used only as a last-resort fallback). */
function plainFromMarkdownV2(text) {
  return String(text)
    .replace(/(^|\n)>/g, '$1')
    .replace(/(^|[^\\])[*_~]/g, '$1').replace(/(^|[^\\])[*_~]/g, '$1')
    .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
}

/** Runs a send/edit; if Telegram rejects the formatting, sends the same words as plain text instead of failing the flow. */
async function withPlainFallback(send, text, extra) {
  try {
    return await send(text, extra);
  } catch (err) {
    if (!isParseError(err) || !extra || extra.parse_mode !== 'MarkdownV2') throw err;
    try { require('./logger').warn({ err: err.message, text: String(text).slice(0, 120) }, 'MarkdownV2 rejected — resent as plain text'); } catch (_) { /* logging is optional */ }
    const plain = { ...extra };
    delete plain.parse_mode;
    return send(plainFromMarkdownV2(text), plain);
  }
}

// ─── Context wrapping ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Wraps `ctx.reply`, `ctx.editMessageText` and `ctx.editMessageReplyMarkup` for this update. The wrappers use `this`, so a
 * derived context (see `tap`) is covered too.
 */
function wrapContext(ctx) {
  if (ctx.__chromeWrapped) return;
  const proto = Object.getPrototypeOf(ctx);
  const origReply = proto.reply;
  const origEdit = proto.editMessageText;
  const origEditMarkup = proto.editMessageReplyMarkup;
  const origAnswer = proto.answerCbQuery;
  if (typeof origReply !== 'function') return;
  Object.defineProperty(ctx, '__chromeWrapped', { value: true });

  // v2.1.3: a callback query can be answered only ONCE. Handlers answer first with a bare `answerCbQuery()` (to stop the spinner)
  // and only later find out they have something to say ("🔒 Admin access needed", "The owner can't be paused") — and that second,
  // real answer was silently dropped by Telegram, so the tap looked ignored. A bare answer is now held back until the handler
  // finishes (or 1.5 s pass); a toast/alert always wins over it.
  if (typeof origAnswer === 'function') {
    ctx.answerCbQuery = function chromeAnswer(text, extra) {
      const st = answerState(this);
      if (st.cbDone) return Promise.resolve(true);
      const hasToast = (text !== undefined && text !== null && text !== '') || !!(extra && extra.show_alert);
      if (!hasToast) {
        if (!st.cbTimer) {
          st.cbTimer = setTimeout(() => { flushAnswer(this, origAnswer); }, BARE_ANSWER_DELAY_MS);
          if (st.cbTimer.unref) st.cbTimer.unref();
        }
        st.cbBare = true;
        return Promise.resolve(true);
      }
      if (st.cbTimer) { clearTimeout(st.cbTimer); st.cbTimer = null; }
      st.cbDone = true;
      return origAnswer.call(this, text, extra);
    };
    Object.defineProperty(ctx, '__origAnswer', { value: origAnswer });
  }

  ctx.reply = async function chromeReply(text, extra) {
    const prep = prepare(extra);
    if (prep.kind === 'reply') touchBar(this);
    await innerPageBar(this, prep);
    const message = await withPlainFallback((t, e) => origReply.call(this, t, e), text, prep.extra);
    try { await afterSend(this, message, prep); } catch (_) { /* tidiness must never break a reply */ }
    return message;
  };

  if (typeof origEdit === 'function') {
    ctx.editMessageText = async function chromeEdit(text, extra) {
      const prep = prepare(extra);
      noteBack(this, prep);
      await innerPageBar(this, prep);
      // A tap replayed from the bottom bar can have no live message to edit: send the screen instead.
      const tapped = this.callbackQuery && this.callbackQuery.message && this.callbackQuery.message.message_id;
      // No live message to edit (a tap replayed from the bar), or the tapped message is a kept result/receipt: send a new screen.
      if ((!tapped && !this.inlineMessageId) || (tapped && isKept(this, tapped))) return this.reply(text, extra);
      // A fresh bar marker was just posted by this same tap: edit-in-place would leave the old page ABOVE its own marker.
      // Send the page as a new message instead (the old one is retired as the previous live screen).
      if (tapped && prep.kind === 'screen' && !prep.keep && takeBarMoved(this)) return this.reply(text, extra);
      const result = await withPlainFallback((t, e) => origEdit.call(this, t, e), text, prep.extra);
      try { afterEdit(this, prep); } catch (_) { /* ignore */ }
      return result;
    };
  }

  if (typeof origEditMarkup === 'function') {
    ctx.editMessageReplyMarkup = async function chromeEditMarkup(markup) {
      if (markup && Array.isArray(markup.inline_keyboard)) {
        const { rows, back } = stripNav(markup.inline_keyboard);
        if (back) sessionOf(this).backTo = back;
        return origEditMarkup.call(this, rows.length ? { ...markup, inline_keyboard: rows } : undefined);
      }
      return origEditMarkup.call(this, markup);
    };
  }
}

// v2.3.1: bars that only make sense on their own page. A typed /command (or an admin/owner tap) that opens a screen with no bar
// of its own used to leave the previous page's bar stuck underneath it (Files bar under the Admin dashboard, My Repos bar under
// /help…) until the person tapped Back or sent /start.
const PAGE_BARS = new Set(['repos', 'repo', 'files', 'notifications', 'searchgh']);
const OUTSIDE_CALLBACK = /^(admin|warden|migrate|owner):/;

/** True when this update opens something that is not part of the current page: a typed /command, or an admin/owner tap. */
function opensOutsideBar(ctx) {
  const text = ctx.message && ctx.message.text;
  if (typeof text === 'string' && /^\/\w/.test(text)) return true;
  const data = ctx.callbackQuery && ctx.callbackQuery.data;
  return typeof data === 'string' && OUTSIDE_CALLBACK.test(data);
}

/** True once something in this update has already chosen the bar (setBar, or a reply that carries a keyboard). */
function barTouched(ctx) {
  return !!(ctx.state && ctx.state.__barTouched);
}

function touchBar(ctx) {
  try {
    if (!ctx.state || typeof ctx.state !== 'object') ctx.state = {};
    ctx.state.__barTouched = true;
  } catch (_) { /* a flag, nothing more */ }
}

/** True when the bar on screen belongs to another page than the one this update is opening. */
function barIsStranded(ctx) {
  const s = ctx.session;
  if (!s) return false;
  if (s.barId === 'home') return true;
  return PAGE_BARS.has(s.barId) && opensOutsideBar(ctx) && !barTouched(ctx);
}

/**
 * An inner page is about to be shown while another page's bar (or the Home 2×2) is still up (a typed /help, /admin, a stale
 * button…): that bar belongs to its own page only, so the small "back" bar goes in FIRST — its marker then sits above the page,
 * never underneath it.
 */
async function innerPageBar(ctx, prep) {
  if (!prep || prep.kind !== 'screen' || prep.keep) return;
  if (barIsStranded(ctx)) await setBar(ctx, 'back');
}

/** A screen that carries a ⬅️ button sets Back's target; a screen with buttons but no ⬅️ is a top-level page (Back = Home). */
function noteBack(ctx, prep) {
  if (prep.keep || prep.kind !== 'screen') return;
  sessionOf(ctx).backTo = prep.back || null;
}

async function afterSend(ctx, message, prep) {
  const s = sessionOf(ctx);
  noteBack(ctx, prep);
  if (!message) return;
  if (prep.kind === 'reply') {
    // Something other than a marker is carrying the bar (a receipt, a prompt…): remember which bar is really on screen,
    // and retire the old marker — this message carries the keyboard now.
    const previous = s.barMsgId;
    if (TYPING_BARS.has(prep.barId) && !TYPING_BARS.has(s.barId)) s.barBefore = s.barId || null;
    s.barId = prep.barId || null;
    s.barMsgId = null;
    if (previous && previous !== message.message_id) deleteQuietly(ctx, message.chat && message.chat.id, previous); // not awaited: a delete must never delay the reply
    return;
  }
  if (prep.kind !== 'screen') return;
  if (prep.keep) { keep(ctx, message); return; }
  s.screenSeq = (s.screenSeq || 0) + 1;
  const previous = s.live;
  s.live = { id: message.message_id, chat: message.chat && message.chat.id };
  if (previous && previous.id && previous.id !== message.message_id && !isKept(ctx, previous.id)) {
    deleteQuietly(ctx, previous.chat || (message.chat && message.chat.id), previous.id); // not awaited
  }
}

function afterEdit(ctx, prep) {
  const cbMessage = ctx.callbackQuery && ctx.callbackQuery.message;
  if (!cbMessage || !cbMessage.message_id) return;
  if (prep.kind === 'screen' && !prep.keep && !isKept(ctx, cbMessage.message_id)) {
    sessionOf(ctx).screenSeq = (sessionOf(ctx).screenSeq || 0) + 1;
    sessionOf(ctx).live = { id: cbMessage.message_id, chat: cbMessage.chat && cbMessage.chat.id };
  }
}

/** Middleware: wraps the context and marks the tapped message as the live screen. */
async function middleware(ctx, next) {
  wrapContext(ctx);
  const cb = ctx.callbackQuery;
  if (cb && cb.message && cb.message.message_id && ctx.session && !isKept(ctx, cb.message.message_id)) {
    ctx.session.live = { id: cb.message.message_id, chat: cb.message.chat && cb.message.chat.id };
  }
  const seqBefore = (ctx.session && ctx.session.screenSeq) || 0;
  try {
    return await next();
  } finally {
    try { if (ctx.callbackQuery && !(ctx.callbackQuery.id || '').startsWith('chrome:')) await flushAnswer(ctx); } catch (_) { /* never fail an update over a spinner */ }
    try {
      const s = ctx.session;
      // An inner page was opened while another page's bar (or the Home 2×2) is up (a typed /help or /admin, a stale button…).
      if (s && (s.screenSeq || 0) > seqBefore && barIsStranded(ctx)) await setBar(ctx, 'back');
      await restoreBarIfIdle(ctx);
    } catch (_) { /* the bar is a convenience, never a reason to fail an update */ }
  }
}

/** Middleware: removes the person's own message (bar tap, typed answer, command) after it has been handled. */
async function tidyUserMessages(ctx, next) {
  const message = ctx.message;
  const chat = ctx.chat;
  const deletable = !!(message && message.message_id && chat && chat.type === 'private' && typeof message.text === 'string');
  try {
    return await next();
  } finally {
    if (deletable) deleteQuietly(ctx, chat.id, message.message_id);
  }
}

// ─── The bar ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Makes `barId` the bar on the person's screen. Sends one marker message (and retires the previous marker) only when the
 * bar actually changes. `opts.title` overrides the marker text; `opts.force` re-sends even if unchanged.
 */
async function setBar(ctx, barId, opts = {}) {
  const bar = BARS[barId];
  if (!bar) return false;
  touchBar(ctx);
  const s = sessionOf(ctx);
  const titleOf = opts.title || bar.title;
  if (!opts.force && s.barId === barId && (!opts.title || s.barTitle === opts.title)) return false;
  const keyboard = keyboardFor(barId);
  let message;
  try {
    message = await Object.getPrototypeOf(ctx).reply.call(ctx, titleOf, keyboard);
  } catch (_) {
    return false;
  }
  const previous = s.barMsgId;
  if (TYPING_BARS.has(barId) && !TYPING_BARS.has(s.barId)) s.barBefore = s.barId || null;
  s.barId = barId;
  s.barTitle = opts.title || null;
  s.barMsgId = message && message.message_id ? message.message_id : null;
  if (previous && previous !== s.barMsgId) deleteQuietly(ctx, message && message.chat && message.chat.id, previous); // not awaited
  // v2.1.2: the marker is now the newest message in the chat. The screen that follows must be sent AFTER it (not edited into
  // an older message above it), or the marker ends up underneath the page it introduces.
  markBarMoved(ctx);
  return true;
}

const BARE_ANSWER_DELAY_MS = 1500;

function answerState(ctx) {
  if (!ctx.state || typeof ctx.state !== 'object') ctx.state = {};
  return ctx.state;
}

/** Sends the held-back bare answer now (once). */
function flushAnswer(ctx, orig) {
  const st = answerState(ctx);
  if (st.cbTimer) { clearTimeout(st.cbTimer); st.cbTimer = null; }
  if (st.cbDone) return Promise.resolve(true);
  st.cbDone = true;
  const fn = orig || ctx.__origAnswer;
  if (typeof fn !== 'function') return Promise.resolve(false);
  return Promise.resolve(fn.call(ctx)).catch(() => false);
}

/** Flags (for the rest of this update) that a new bar marker was just posted, so the next screen goes below it. */
function markBarMoved(ctx) {
  try {
    if (!ctx.state || typeof ctx.state !== 'object') ctx.state = {};
    ctx.state.__barMoved = true;
  } catch (_) { /* a flag, nothing more */ }
}

/** True once (then cleared) when a marker was posted earlier in this update. */
function takeBarMoved(ctx) {
  try {
    if (ctx.state && ctx.state.__barMoved) { ctx.state.__barMoved = false; return true; }
  } catch (_) { /* ignore */ }
  return false;
}

/**
 * v2.3.1: a keyboard sent from OUTSIDE an update (the GitHub-connect page in the browser sends the Home 2×2 straight to the
 * chat) changes what is on the person's screen without the saved session knowing. The session then still named the old bar, so
 * the next page that wanted that bar saw "already up" and never sent it — Home's 2×2 stayed stuck under My Repos, and so on.
 * Call this right after such a send. `store` is only for tests. Never throws.
 */
async function syncBarFromOutside(telegramId, barId, store) {
  try {
    if (!telegramId || !BARS[barId]) return false;
    const sessions = store || require('../middleware/redisSessionStore');
    const key = `${telegramId}:${telegramId}`; // private chats: chat id === user id (see lib/users.js purgeRedisFootprint)
    const saved = await sessions.get(key);
    if (!saved) return false;
    saved.barId = barId;
    saved.barTitle = null;
    saved.barMsgId = null;
    saved.barBefore = null;
    saved.backTo = null;
    await sessions.set(key, saved);
    return true;
  } catch (_) {
    return false; // a convenience: the next /start fixes it anyway
  }
}

/** Declares where ⬅️ Back goes from here: a callback string, or 'bar:home' (the Home card). */
function setBack(ctx, target) {
  sessionOf(ctx).backTo = target || null;
}

// ─── Bar actions + Back ───────────────────────────────────────────────────────────────────────────────────────────────
const ACTIONS = Object.create(null); // barId -> { label: handler }
const GLOBAL = Object.create(null); // label -> handler (same meaning on every bar)
const hooks = { callbackRouter: null, beforeTap: null, home: null, releaseTyped: null, isTyping: null };
const INTERNAL = new Set(['❌ Cancel', '⏭️ Skip', '⬅️ Back']);
const TYPING_BARS = new Set(['cancel', 'typing', 'typingBack', 'typingSkip']);

/** Wiring from bot.js: the callback router, the "moved on" cleanup, the Home screen and the typed-input probes. */
function configure(options) {
  Object.assign(hooks, options || {});
}

/** Handlers for the buttons of ONE bar (a label may mean different things on different bars). */
function registerActions(barId, map) {
  ACTIONS[barId] = { ...(ACTIONS[barId] || {}), ...map };
}

/** Handlers for labels that mean the same thing wherever they appear (My Repos, Settings, …). */
function registerGlobal(map) {
  Object.assign(GLOBAL, map);
}

/** Every label that has a handler (bar-specific or global) — used to let these taps escape an open wizard. */
function knownLabels() {
  const set = new Set(Object.keys(GLOBAL));
  for (const map of Object.values(ACTIONS)) for (const label of Object.keys(map)) set.add(label);
  for (const bar of Object.values(BARS)) for (const row of bar.rows) for (const label of row) set.add(label);
  for (const label of INTERNAL) set.delete(label);
  return set;
}

function actionFor(ctx, label) {
  const barId = ctx.session && ctx.session.barId;
  if (barId && ACTIONS[barId] && ACTIONS[barId][label]) return ACTIONS[barId][label];
  return GLOBAL[label] || null;
}

/** Runs the handler for a bar label; true when one ran. */
async function runLabel(ctx, label) {
  const fn = actionFor(ctx, label);
  if (!fn) return false;
  if (hooks.releaseTyped && !INTERNAL.has(label)) { try { hooks.releaseTyped(ctx); } catch (_) { /* ignore */ } }
  await fn(ctx);
  return true;
}

/** Middleware: a text that is a button of the CURRENT bar runs that bar's action (before any legacy label handler). */
async function dispatcher(ctx, next) {
  const text = ctx.message && ctx.message.text;
  if (typeof text !== 'string' || INTERNAL.has(text)) return next();
  const barId = ctx.session && ctx.session.barId;
  if (!barId || !(ACTIONS[barId] && ACTIONS[barId][text])) return next();
  return runLabel(ctx, text);
}

/** True while a typed answer is expected (a wizard is open, or a typed-input flag is armed). */
function isTyping(ctx) {
  if (ctx.scene && ctx.scene.current) return true;
  if (ctx.session && ctx.session.__scenes && ctx.session.__scenes.current) return true;
  return !!(hooks.isTyping && hooks.isTyping(ctx));
}

const SCREENS = Object.create(null); // barId -> async (ctx) => re-draws the page that bar belongs to

/** How to draw the page a bar belongs to again (used when a typing prompt is cancelled). */
function registerScreens(map) {
  Object.assign(SCREENS, map);
}

/** After ❌ Cancel: back to the page the person was on, with that page's bar. */
async function returnFromTyping(ctx) {
  const s = sessionOf(ctx);
  const before = s.barBefore && BARS[s.barBefore] && !TYPING_BARS.has(s.barBefore) ? s.barBefore : null;
  s.barBefore = null;
  if (before && SCREENS[before]) {
    await dropLive(ctx);
    return SCREENS[before](ctx);
  }
  if (before) return setBar(ctx, before);
  return goHome(ctx);
}

/**
 * The typing prompt's bar (Cancel / Skip) must not outlive the question. When an update finishes and nothing is waiting for
 * typed input any more, the bar the person had before the prompt (or Home) comes back.
 */
async function restoreBarIfIdle(ctx) {
  const s = ctx.session;
  if (!s || !TYPING_BARS.has(s.barId)) return false;
  if (isTyping(ctx)) return false;
  const target = s.barBefore && BARS[s.barBefore] && !TYPING_BARS.has(s.barBefore) ? s.barBefore : 'home';
  s.barBefore = null;
  return setBar(ctx, target);
}

/**
 * Replays a callback as if the person had tapped it on the live screen. Used by the bar (⬅️ Back and every bar button that
 * simply opens an inline screen) so each of them reaches exactly the same handler the inline button did.
 */
async function tap(ctx, rawData) {
  if (!hooks.callbackRouter) return false;
  const s = sessionOf(ctx);
  let data = rawData;
  if (callbackRefs.needsResolve(data)) {
    const resolved = await callbackRefs.resolve(data);
    if (!resolved) { await expiredNotice(ctx); return false; }
    data = resolved.data;
    if (resolved.repo && s.currentRepo !== resolved.repo) {
      s.currentRepo = resolved.repo;
      const login = ctx.state && ctx.state.user && ctx.state.user.github_username;
      s.repoUrl = login ? `https://github.com/${login}/${resolved.repo}` : null;
    }
  }
  const live = s.live && s.live.id ? s.live : null;
  const chat = ctx.chat;
  const callbackQuery = {
    id: `chrome:${Date.now()}`,
    from: ctx.from,
    chat_instance: 'chrome',
    data,
    message: live ? { message_id: live.id, chat, date: Math.floor(Date.now() / 1000) } : undefined,
  };
  const derived = Object.create(ctx);
  Object.defineProperty(derived, 'update', { value: { update_id: (ctx.update && ctx.update.update_id) || 0, callback_query: callbackQuery } });
  Object.defineProperty(derived, 'callbackQuery', { value: callbackQuery });
  Object.defineProperty(derived, 'message', { value: undefined });
  Object.defineProperty(derived, 'chat', { value: chat });
  Object.defineProperty(derived, 'from', { value: ctx.from });
  Object.defineProperty(derived, 'answerCbQuery', { value: async () => true });
  if (hooks.beforeTap) { try { hooks.beforeTap(derived); } catch (_) { /* ignore */ } }
  await hooks.callbackRouter(derived, async () => {});
  return true;
}

async function expiredNotice(ctx) {
  try { await require('../handlers/manage/ui').expired(ctx); } catch (_) { /* ignore */ }
}

/** The bar's ⬅️ Back: replays the current screen's own Back target, or goes Home when there is none. */
async function goBack(ctx) {
  const s = sessionOf(ctx);
  const target = s.backTo;
  s.backTo = null;
  if (!target || target === 'bar:home') return goHome(ctx);
  if (target.startsWith('bar:')) return goHome(ctx);
  return tap(ctx, target);
}

async function goHome(ctx) {
  await dropLive(ctx);
  if (hooks.home) return hooks.home(ctx);
  return false;
}

module.exports = {
  BARS,
  keyboardFor,
  barIdOfKeyboard,
  isNav,
  stripNav,
  prepare,
  wrapContext,
  middleware,
  tidyUserMessages,
  dispatcher,
  setBar,
  syncBarFromOutside,
  setBack,
  keep,
  isKept,
  dropLive,
  tap,
  goBack,
  goHome,
  configure,
  registerActions,
  registerGlobal,
  knownLabels,
  runLabel,
  restoreBarIfIdle,
  returnFromTyping,
  registerScreens,
  isTyping,
  flushAnswer,
  disconnectedBarId,
  plainFromMarkdownV2,
  withPlainFallback,
  isParseError,
  TYPING_BARS,
  _hooks: hooks,
};
