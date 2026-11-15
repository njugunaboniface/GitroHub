/**
 * Guards against a "stale confirm/cancel button" class of problem across
 * every confirm/cancel flow (Delete Repo, Delete File, Bulk Actions,
 * Toggle Visibility, Disconnect, Fork, Storage Clear).
 *
 * The risk this avoids: if a confirm/cancel handler sent a brand-new
 * "Cancelled." message instead of touching the original confirmation
 * message, Telegram inline buttons would stay live until THAT message is
 * edited — so tapping Cancel, then going back and tapping the original
 * Confirm, could still fire the action.
 *
 * The design is structural, not a per-flow patch: every confirm/cancel
 * screen goes through `resolveConfirmation`, which edits the SAME message
 * that held the buttons — stripping the keyboard and replacing the text
 * with the outcome — the instant either button is tapped. Once a message
 * is resolved, its buttons are gone; there is no message left for a stale
 * tap to land on. Any confirm/cancel flow that calls this helper gets
 * that guarantee automatically, with no per-flow work needed.
 */

const { safeEditMessageText } = require('./safeEdit');
const crypto = require('crypto');
const redisDb = require('../db/redis');

// Long enough to swallow a double-tap (Telegram can deliver both updates even
// after the first handler removed the keyboard), short enough that a handler
// that failed before finishing doesn't leave the button dead for minutes.
const CLAIM_TTL_SECONDS = 30;

/**
 * Confirmation/action callbacks are allowed to arrive more than once when a
 * person double-taps quickly. Telegram can deliver both updates even though
 * the first handler has already removed the keyboard. Claim the message
 * itself (not the callback data) so a second button from the same confirmation
 * screen cannot perform another write.
 *
 * Fail-open if Redis is unavailable: availability of Redis must not make all
 * confirmation actions unusable. Existing action locks still protect the
 * longer-running critical operations that have them.
 */
async function claimCallback(ctx) {
  const cb = ctx.callbackQuery;
  const message = cb && cb.message;
  if (!cb || !message || !message.chat || message.message_id == null) return true;

  const data = String(cb.data || '');
  if (!isActionCallback(data)) return true;

  const raw = `gitrohub:confirm-claim:${message.chat.id}:${message.message_id}`;
  const key = crypto.createHash('sha256').update(raw).digest('hex');

  try {
    if (!redisDb.client.isReady) await redisDb.connect();
    const claimed = await redisDb.client.set(key, '1', { NX: true, EX: CLAIM_TTL_SECONDS });
    return claimed === 'OK';
  } catch (_) {
    return true;
  }
}

// Only callbacks that EXECUTE a write. Every alternative is anchored so it can't
// also match a screen-opening callback that merely starts with the same words:
// an unanchored `admin:user:\d+:(ban|delete)` also matched `…:banduration:7`,
// which would claim the message on the duration step and then block the real
// Ban confirmation on that same message.
const ACTION_CALLBACK_RE = new RegExp(
  '^(?:' + [
    'repo:(?:license|delete|visibility):confirm:.+',
    'file:delete:confirm(?::.*)?',
    'external:fork:confirm(?::.*)?',
    'exportimport:import:confirm(?::.*)?',
    'settings:disconnect:confirm',
    'trash:deleteforever:confirm:\\d+',
    'bulk:execute:(?:delete|private|public)',
    'admin:nudge:execute',
    'admin:broadcast:send',
    'admin:bulkdeleteban:execute',
    'admin:purge:.*:execute',
    'admin:bulksuspend:.*:execute',
    'admin:bulkmute:.*:execute',
    'admin:user:\\d+:(?:ban|delete)',
    'admin:repos:\\d+:.*:execute',
    'admin:roles:\\d+:(?:set|revoke)(?::.*)?',
    'warden:case:\\d+:warnsend',
    'warden:shield:do:[a-z]+:[pu]',
    'warden:shield:undo',
  ].join('|') + ')$'
);

function isActionCallback(data) {
  return ACTION_CALLBACK_RE.test(String(data || ''));
}

/**
 * @param {object} ctx - Telegraf context (must be a callback_query update)
 * @param {'confirmed'|'cancelled'} outcome
 * @param {string} resolvedText - what the message becomes once resolved
 * @param {object} [opts]
 * @param {string} [opts.parse_mode] - defaults to none (plain text)
 */
async function resolveConfirmation(ctx, outcome, resolvedText, opts = {}) {
  const extra = { parse_mode: opts.parse_mode }; // no reply_markup at all — this is what actually removes the buttons
  if (await safeEditMessageText(ctx, resolvedText, extra)) return;
  // Message too old to edit (Telegram's ~48h window) or already edited by
  // a race — fall back to a plain reply so the person still sees the
  // outcome, even though we couldn't retroactively disarm the old buttons.
  await ctx.reply(resolvedText, extra);
}

module.exports = { resolveConfirmation, claimCallback, isActionCallback };
