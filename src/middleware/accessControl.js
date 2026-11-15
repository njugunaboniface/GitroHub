const users = require('../lib/users');
const limits = require('../lib/limits');
const collector = require('../lib/wardenBrain/collector');
const maintenance = require('../lib/maintenance');

/**
 * ACCESS-CONTROL GATE (v1.1.0-multi)
 *
 * Replaces the old single-owner gate. Per the explicit design decision:
 * anyone can /start and connect their OWN GitHub account freely — there
 * is no approval step. This must still be the FIRST middleware
 * registered, before logging, before session lookup, before command
 * parsing — anything, for the same reasons as before: banned/suspended
 * senders get silently ignored (no reply, no log spam, no downstream
 * processing), keeping cost and attack surface at zero for them.
 *
 * What changed from single-owner:
 *   - Everyone gets a `users` row and passes through, not just one ID.
 *   - is_admin is set automatically for config.ADMIN_ID and nobody else —
 *     see lib/users.ensureUser, there's no other code path that can set it.
 *   - Banned (is_blocked) or currently-suspended senders are silently
 *     dropped, same zero-reply posture the old gate used for "anyone who
 *     isn't the owner."
 *   - Every accepted update increments the click counter and stamps
 *     last_active_at (lib/users.recordActivity) — the Admin Dashboard's
 *     "clicks" and "most active"/"stale" views read straight off this.
 *   - A per-user hourly action cap (config default, admin-overridable)
 *     throttles the shared per-process update queue — separate from
 *     GitHub's own rate limit, this is about fairness inside THIS bot's
 *     single event loop, not about GitHub API budget.
 */

// In-memory sliding-hour counters, keyed by telegram_id. Deliberately not
// persisted — a process restart resetting everyone's hourly counter to
// zero is a fine trade-off for not adding a write on every single message
// just to track a soft fairness throttle. warned flags so a capped user
// gets told ONCE per window instead of once per tap.
const actionWindows = new (require('../lib/boundedMap').BoundedMap)({ max: 50000, name: 'actionWindows' }); // telegramId -> { windowStart, count, warned }
const ACTION_WINDOW_MS = 60 * 60 * 1000;
// v1.2.1-multi: a window is dead weight once its hour is over — sweep them instead of keeping every user ever seen.
actionWindows.startSweeper((w) => Date.now() - w.windowStart >= ACTION_WINDOW_MS, 10 * 60 * 1000);

function checkAndBumpActionCap(telegramId, cap) {
  if (!cap || cap <= 0) return { allowed: true }; // 0/unset = unlimited
  const now = Date.now();
  let w = actionWindows.get(telegramId);
  if (!w || now - w.windowStart >= ACTION_WINDOW_MS) {
    w = { windowStart: now, count: 0, warned: false, lastNoticeAt: 0 };
    actionWindows.set(telegramId, w);
  }
  w.count += 1;
  if (w.count > cap) {
    const alreadyWarned = w.warned;
    w.warned = true;
    // v1.1.24-multi: previously the person was told ONCE and then every later
    // tap was dropped without a word until the hour rolled over — to them the
    // bot had simply gone dead. Now they get a short notice (at most once a
    // minute, so a tap-storm can't turn into a reply-storm) that says how long
    // the wait is, and button taps get an instant toast instead of a spinner.
    const retryInMs = Math.max(0, w.windowStart + ACTION_WINDOW_MS - now);
    const notice = now - w.lastNoticeAt >= 60 * 1000;
    if (notice) w.lastNoticeAt = now;
    return { allowed: false, alreadyWarned, retryInMs, notice, cap };
  }
  return { allowed: true };
}

function waitText(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  return mins === 1 ? 'about a minute' : `about ${mins} minutes`;
}

function accessControl() {
  return async (ctx, next) => {
    const senderId = ctx.from && ctx.from.id;
    if (!senderId) return; // non-user updates (channel posts, etc.) — ignore

    // GitroHub is built for 1:1 GitHub management only — it was never
    // meant to run in groups, supergroups, or channels. Before this
    // guard existed, ANY update the bot happened to receive (e.g. from
    // being added to a group, or a group linked as a channel's
    // discussion group) created a real `users` row for whoever sent it —
    // including other bots. Telegram's official @Channel_Bot posting
    // linked-channel content into a discussion group, and even this
    // bot's own echoed messages in that setup, both got recorded as
    // "users" and cluttered the Admin Dashboard's Users list. Fixed at
    // the source: reject non-private chats and any bot sender (the
    // User object's own is_bot flag) before ensureUser ever runs, so no
    // row is created and nothing downstream even sees the update.
    if (ctx.chat && ctx.chat.type !== 'private') return;
    if (ctx.from.is_bot) return;

    const user = await users.ensureUser(senderId, {
      username: ctx.from.username || null,
      firstName: ctx.from.first_name || null,
    });

    // Belt-and-suspenders on top of ensureUser's DB-level self-heal: an
    // admin is checked against config.ADMIN_IDS directly here too, so a
    // lockout can never happen even if the self-heal UPDATE above somehow
    // didn't apply. This is what actually happened once already — an
    // admin banned themselves via their own Dashboard and the block was
    // enforced with no way back in except a manual DB edit. That gap is
    // now closed at two independent layers.
    // 👑 Dashboard access is no longer purely config.ADMIN_IDS: a
    // super_admin can now promote any user straight from their User
    // Detail card (lib/roles.js's setRole). `user.is_admin` already
    // reflects that — see lib/users.js's ensureUser, which computes it
    // from config.ADMIN_IDS OR admin_roles in the SAME query that just
    // ran above, so reading it here costs nothing extra. (A v1.1.2 audit
    // found this used to run its own separate roles.hasRole() query on
    // every message from every non-admin user — the single hottest path
    // in the bot — for no benefit ensureUser's result didn't already
    // provide; removed.)
    const isAdmin = user.is_admin;
    if (!isAdmin) {
      if (await users.isCurrentlyBanned(user)) return; // banned — full stop, no reply, no log
      if (await users.isCurrentlySuspended(user)) return; // suspended — same silent stop

      // 🩺 Maintenance Mode — admins always pass straight through (both to
      // actually run the bot while it's "closed", and so this can never
      // lock an admin out the way a bad Ban/Suspend once could). Checked
      // AFTER ban/suspend (a banned person gets the silent drop either
      // way, not a maintenance notice) but BEFORE the hourly action cap —
      // there's no reason to burn someone's action-cap budget on a tap
      // that was never going anywhere.
      if (maintenance.isEnabled()) {
        await ctx.reply(maintenance.getMessage()).catch(() => {});
        return;
      }
    }

    const effective = limits.getEffectiveLimits(user);
    const capResult = checkAndBumpActionCap(senderId, effective.hourlyActionCap);
    if (!capResult.allowed) {
      const msg = `⏳ You\u2019re sending actions faster than this bot allows (${capResult.cap} per hour) \u2014 please try again in ${waitText(capResult.retryInMs)}.`;
      if (ctx.callbackQuery) {
        // Tapping a button must always get an answer, or Telegram shows a
        // spinner on it until it times out.
        await ctx.answerCbQuery(msg.replace(/^⏳ /, ''), { show_alert: false }).catch(() => {});
      } else if (capResult.notice) {
        await ctx.reply(msg).catch(() => {});
      }
      collector.recordCapHit(senderId);
      if (!capResult.alreadyWarned) {
        // Persisted once per window (not once per denied tap while
        // capped) — feeds the Admin Dashboard's 🚩 Suspicious filter.
        // Fire-and-forget for the same reason click tracking below is.
        users.incrementRateLimitHits(senderId).catch(() => {});
      }
      return;
    }

    ctx.state = ctx.state || {};
    ctx.state.isAdmin = isAdmin;
    ctx.state.user = user;

    // Fire-and-forget — click tracking must never delay or break the
    // actual response to the person waiting on the other end.
    users.recordActivity(senderId).catch(() => {});
    // 🧠 Warden observes (counts only — see lib/wardenBrain/collector.js).
    collector.recordAction(senderId, collector.kindOf(ctx), { lastActiveAt: user.last_active_at });

    return next();
  };
}

module.exports = accessControl;
module.exports._checkAndBumpActionCap = checkAndBumpActionCap; // exposed for unit tests
