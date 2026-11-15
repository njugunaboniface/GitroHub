/**
 * Bot API 9.4 (Feb 2026) added a `style` field to both InlineKeyboardButton
 * and KeyboardButton — three preset colors: 'danger' (red), 'success'
 * (green), 'primary' (blue). Telegram just reads whatever JSON is sent, so
 * these helpers attach `style` directly onto the button object Telegraf's
 * own Markup.button.* produces, regardless of whether the installed
 * Telegraf version's own TypeScript types have caught up to this Bot API
 * version yet — sidesteps that uncertainty entirely rather than depending
 * on it.
 *
 * How the colours are used (v1.2.3-multi: this describes what the bot actually
 * does — an older version of this comment promised a locked "exactly 9 red
 * buttons / green is only ever Cancel" rule that the code never followed):
 *
 *   RED       — the button that carries out something destructive or hard to
 *               take back (Delete Repo, Delete File, Disconnect, Storage Clear,
 *               Trash's Delete Forever, bulk delete, and the Admin Dashboard's
 *               ban / delete / purge / lockdown actions), and also the
 *               "abandon this" button in several multi-step flows (Cancel in
 *               Create Repo, Upload, Rename, Edit, Fork, License, Sync).
 *   GREEN     — the safe way out on confirmation prompts (most "Cancel" /
 *               "Keep" buttons on a destructive confirm), and the single
 *               "go ahead and commit" button in a few wizards.
 *   BLUE      — the expected way forward: navigation, and the confirm side of
 *               already-safe actions (Rename, License, Fork, Create Repo,
 *               Upload/Commit).
 *   colorless — anything incidental: pagination, Skip, individual picks inside
 *               a longer flow, minor declines. No style key at all, so
 *               Telegram renders its normal default.
 *
 * Treat these as a visual convention to keep consistent when adding buttons,
 * not as a machine-checked rule.
 */
const { Markup } = require('telegraf');

const RED = 'danger';
const GREEN = 'success';
const BLUE = 'primary';

/**
 * Telegram enforces a hard 64-byte limit on callback_data, and many of this
 * bot's buttons embed a repo name (up to 100 chars) or a file path.
 *
 * v1.1.7-multi: oversized values are no longer logged-and-broken — callback()
 * hands them to lib/callbackRefs.js, which swaps them for a short `~id`
 * reference that the bot expands again before routing (bot.js). Buttons on
 * an older message that need to stay bound to THEIR repo (browse/file
 * buttons) additionally wrap their data with callbackRefs.bindRepo() at the
 * keyboard builder — `ctx.session.currentRepo` alone is not safe for that,
 * since it silently points at whichever repo became "current" later.
 */
const callbackRefs = require('../lib/callbackRefs');

/** Inline callback button. Pass RED/GREEN/BLUE explicitly, or omit the
 * 3rd argument entirely for a deliberately colorless (incidental) button —
 * there is no default color anymore; every button's tier is a conscious
 * choice made at its call site. */
function callback(text, data, colorStyle) {
  const button = Markup.button.callback(text, callbackRefs.shorten(data));
  return colorStyle ? { ...button, style: colorStyle } : button;
}

/** BBTB (reply keyboard) text button, same no-default rule as above. */
function text(label, colorStyle) {
  const button = Markup.button.text(label);
  return colorStyle ? { ...button, style: colorStyle } : button;
}

/** URL button (opens outside Telegram) with a color style applied. */
function url(text, link, colorStyle) {
  const button = Markup.button.url(text, link);
  return colorStyle ? { ...button, style: colorStyle } : button;
}

module.exports = { RED, GREEN, BLUE, callback, text, url };
