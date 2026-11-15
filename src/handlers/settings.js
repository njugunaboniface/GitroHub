const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const github = require('../lib/github');
const users = require('../lib/users');
const format = require('../lib/format');
const ephemeral = require('../lib/ephemeral');
const inline = require('../keyboards/inline');
const bbtb = require('../keyboards/bbtb');
const config = require('../config');
const activity = require('../lib/activity');
const { safeEditMessageText } = require('../lib/safeEdit');
const limits = require('../lib/limits');

async function showSettings(ctx, { skipBbtb = false, edit = false } = {}) {
  const telegramId = ctx.from.id;
  const user = await users.getUser(telegramId);
  const connected = !!(user && user.github_token_enc);

  // Decrypted once, reused for both the rate-limit check and the repo
  // count below — getDecryptedToken() is a real DB round trip, and
  // there's no reason to pay it twice on one screen.
  let token = null;
  if (connected) {
    try {
      token = await users.getDecryptedToken(telegramId);
    } catch (_) { /* handled below — rateLimitLine/storageLine fall back to their own "unable to fetch" */ }
  }

  // 🔐 Sibling connections — other Telegram accounts also linked to this
  // same GitHub login (see lib/users.js's getSiblingConnections for why
  // this is possible at all). Best-effort, same pattern as every other
  // block on this screen: a query hiccup here should never take down the
  // rest of Settings.
  let siblingLine = '';
  if (connected) {
    try {
      const siblings = await users.getSiblingConnections(telegramId, user.github_username);
      if (siblings.length > 0) {
        const names = siblings
          .slice(0, 5)
          .map((s) => format.escapeMd(s.telegram_first_name || s.telegram_username || `#${s.telegram_id}`))
          .join(', ');
        const more = siblings.length > 5 ? ` \\+${siblings.length - 5} more` : '';
        siblingLine =
          `\n\n⚠️ *ALSO CONNECTED AS THIS ACCOUNT*\n` +
          `${siblings.length} other Telegram account\\(s\\): ${names}${more}\n` +
          `Didn\u2019t expect this? Revoke it from GitHub → Settings → Applications → Authorized OAuth Apps \\(this removes just that one, not yours\\)\\.`;
      }
    } catch (_) { /* best-effort — see comment above */ }
  }

  let rateLimitLine = 'Not connected — connect GitHub to see live usage';
  if (connected) {
    try {
      // Prefer the passively-captured value (from headers on
      // whatever GitHub calls already happened this session) over spending
      // a live request just to display a number. Falls back to an actual
      // getRateLimit() call only if nothing's been captured yet (e.g.
      // right after a fresh bot restart, before any other GitHub call).
      let rl = github.getLastKnownRateLimit(token);
      if (!rl) {
        const fresh = await github.getRateLimit(token);
        rl = { remaining: fresh.remaining, limit: fresh.limit, resetAt: fresh.reset * 1000 };
      }
      const resetMins = Math.max(0, Math.round((rl.resetAt - Date.now()) / 60000));
      const pct = rl.limit ? rl.remaining / rl.limit : 1;
      const dot = pct > 0.5 ? '🟢' : pct > 0.2 ? '🟡' : '🔴';
      rateLimitLine = `${dot} ${rl.remaining} / ${rl.limit} remaining \\(resets in ${resetMins}m\\)`;
    } catch (_) {
      rateLimitLine = 'Unable to fetch';
    }
  }

  const scopeLine = connected ? format.escapeMd((user.github_scope || 'repo').split(',').join(', ')) : '—';

  // 🎚️ Your Limits — what actually applies to THIS person right now
  // (their own admin-set override if they have one, otherwise whatever
  // the global default currently is) — replaces the old
  // hosting/infrastructure block below, which showed operational detail
  // (DB status, host, memory, Node version) that belongs to running the
  // bot, not to any individual user's account. That detail didn't
  // disappear — it moved to the 🛡️ Admin Dashboard's 🖥️ System Health
  // screen, which is where it was always meant to be seen from.
  const effectiveLimits = limits.getEffectiveLimits(user);
  const limitsLine =
    `├ 📦 Zip upload: ${format.escapeMd(format.formatBytes(effectiveLimits.maxZipBytes))}\n` +
    `├ 📄 File upload: ${format.escapeMd(format.formatBytes(effectiveLimits.maxFileBytes))}\n` +
    `└ ⏱️ Hourly actions: ${effectiveLimits.hourlyActionCap ? `${effectiveLimits.hourlyActionCap}/hr` : 'unlimited'}`;

  // 📜 Last activity — a quick "is anything actually happening on this
  // account" signal, independent of whether it was automated or manual
  // (compare to Automation's "Last rules run" below, which is scoped to
  // automated actions only).
  let lastActivityLine = '—';
  if (connected) {
    try {
      const recentResult = await activity.recent(telegramId, { limit: 1 });
      lastActivityLine = recentResult.rows[0] ? format.escapeMd(format.relativeTime(recentResult.rows[0].created_at)) : 'none yet';
    } catch (_) {
      lastActivityLine = 'Unable to fetch';
    }
  }

  // 📦 Storage & 🗂️ Organization — best-effort, same reasoning as
  // Automation below: a hiccup in any one of these newer subsystems
  // should never take down the whole status screen.
  let storageLine = '⚙️ Not connected';
  let organizationLine = '⚙️ Not connected';
  if (connected) {
    try {
      const trash = require('../lib/trash');
      const scheduledRepos = require('../lib/scheduledRepos');
      const repoCache = require('../lib/repoCache');
      const [allRepos, trashList, scheduledList] = await Promise.all([
        repoCache.getRepos(telegramId, token),
        trash.list(telegramId),
        scheduledRepos.listPending(telegramId),
      ]);
      storageLine =
        `├ Repos: ${allRepos.length}\n` +
        `├ Trash: ${trashList.length} item${trashList.length === 1 ? '' : 's'}\n` +
        `└ Scheduled: ${scheduledList.length} pending`;
    } catch (_) {
      storageLine = '└ Unable to fetch';
    }

    try {
      const tags = require('../lib/tags');
      const pins = require('../lib/pins');
      const savedViews = require('../lib/savedViews');
      const [userTags, pinsList, viewsList] = await Promise.all([
        tags.listTags(telegramId),
        pins.list(telegramId),
        savedViews.list(telegramId),
      ]);
      organizationLine =
        `├ Tags: ${userTags.length}\n` +
        `├ Pinned: ${pinsList.length}\n` +
        `└ Smart Folders: ${viewsList.length}`;
    } catch (_) {
      organizationLine = '└ Unable to fetch';
    }
  }

  // 🔔 Notifications — same on/total categories count already shown in My
  // Defaults, reused here rather than recomputed differently so the two
  // screens never disagree with each other.
  let notifLine = '—';
  if (connected) {
    try {
      notifLine = format.escapeMd(users.describeNotificationSummary(await users.getNotificationPrefs(telegramId)));
    } catch (_) {
      notifLine = 'Unable to fetch';
    }
  }

  // 🤖 Automation stats — best-effort, a hiccup here should never block the
  // rest of this screen (system status has to stay reliable even if one
  // of the newer subsystems is having a bad moment).
  let automationLine = '⚙️ Not connected';
  if (connected) {
    try {
      const tags = require('../lib/tags');
      const muteRules = require('../lib/automationMuteRules');
      const [userTags, muteRulesList, lastRunResult] = await Promise.all([
        tags.listTags(telegramId),
        muteRules.listMuteRules(telegramId),
        activity.recent(telegramId, { limit: 1, automatedOnly: true }),
      ]);
      const activeTagRules = userTags.filter((t) => t.auto_rule_json).length;
      const activeMuteRules = muteRulesList.length;
      const lastRun = lastRunResult.rows[0] ? format.relativeTime(lastRunResult.rows[0].created_at) : 'never';
      automationLine =
        `├ Auto\\-Tag rules: ${activeTagRules} active\n` +
        `├ Auto\\-Mute rules: ${activeMuteRules} active\n` +
        `└ Last rules run: ${format.escapeMd(lastRun)}`;
    } catch (_) {
      automationLine = '└ Unable to fetch';
    }
  }

  const text =
    `📊 *Status & usage*\n\n` +
    `👤 *ACCOUNT*\n` +
    `├ GitHub: ${connected ? format.escapeMd(user.github_username) : 'Not connected'}\n` +
    `├ Scope: ${scopeLine}\n` +
    `├ Linked since: ${connected ? format.escapeMd(format.relativeTime(user.connected_at)) : '—'}\n` +
    `└ Last activity: ${lastActivityLine}${siblingLine}\n\n` +
    `📡 *GITHUB API*\n` +
    `└ Rate limit: ${rateLimitLine}\n\n` +
    `🎚️ *YOUR LIMITS*\n` +
    `${limitsLine}\n\n` +
    `📦 *STORAGE*\n` +
    `${storageLine}\n\n` +
    `🗂️ *ORGANIZATION*\n` +
    `${organizationLine}\n\n` +
    `🔔 *NOTIFICATIONS*\n` +
    `└ ${notifLine}\n\n` +
    `🤖 *AUTOMATION*\n` +
    `${automationLine}\n\n` +
    `🔧 Bot version: v${format.escapeMd(config.BOT_VERSION)} · ❓ /help · 📜 /legal`;

  // System Alerts notification (opt-in, see 🔔 Notifications): a quiet,
  // generic heads-up when the bot's underlying storage is having a bad
  // moment — deliberately never names which system (Postgres/Redis/etc.)
  // to a regular user; that operational detail lives on the 🛡️ Admin
  // Dashboard's 🖥️ System Health screen, not here. Debounced to at most
  // once per 10 minutes. Checked BEFORE writing this check's own log
  // entry below, so the very first occurrence isn't mistaken for
  // "already alerted recently".
  const { pgStatus, redisStatus } = await require('../lib/healthCheck').getHealthStatus();
  const anyDown = !pgStatus.ok || !redisStatus.ok;
  await maybePushSystemAlert(telegramId, anyDown, ctx);

  if (anyDown) {
    await activity.log(telegramId, '⚠️', 'GitroHub had a brief technical issue', { isError: true }).catch(() => {});
  }

  // BBTB reply keyboard persists on screen once shown — only send the
  // marker message on first open, not on every chained refresh tap (#48),
  // or every refresh would needlessly resend it too (the exact clutter
  // this whole redesign pass was about avoiding elsewhere).
  // v1.3.0-multi: no bottom-keyboard marker any more — Settings is an inline hub (handlers/hub.js) and this screen is its
  // 📊 Status & usage page.

  const keyboard = {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([
      [style.callback('🔄 Refresh Status', 'settings:refresh')],
      [style.callback('🚩 Report a Problem', 'settings:report')],
      [style.callback('⬅️ Settings', 'hub:settings', style.BLUE)],
    ]),
  };
  if (edit && await safeEditMessageText(ctx, text, keyboard)) return;
  await ctx.reply(text, keyboard);
}

async function maybePushSystemAlert(telegramId, anyDown, ctx) {
  if (!anyDown) return;

  try {
    const prefs = await users.getNotificationPrefs(telegramId);
    if (!prefs || !prefs.systemAlerts) return;

    const { rows } = await activity.recent(telegramId, { limit: 5, errorsOnly: true });
    const recentlyAlerted = rows.some((r) =>
      r.summary.includes('technical issue') &&
      Date.now() - new Date(r.created_at).getTime() < 10 * 60 * 1000
    );
    if (recentlyAlerted) return;

    await ctx.reply('⚠️ System Alert: GitroHub is experiencing a brief technical issue. Some features may fail until this recovers.');
  } catch (_) { /* best-effort — never let alerting itself crash Settings */ }
}

async function askDisconnect(ctx) {
  const connected = await users.isConnected(ctx.from.id);
  if (!connected) return; // defensive — BBTB shouldn't offer this while disconnected anyway

  // v1.2.4-multi: with several accounts connected, Disconnect removes only the ACTIVE one.
  // v1.2.5-multi: say exactly which one becomes active next, and offer "disconnect everything".
  let multiNote = '';
  let multi = false;
  let activeLogin = null;
  try {
    const list = await require('../lib/accounts').list(ctx.from.id); // most recently used first
    const active = list.find((a) => a.active);
    if (active && list.length > 1) {
      multi = true;
      activeLogin = active.login;
      const next = list.find((a) => !a.active);
      multiNote = `\n*Only @${format.escapeMd(active.login)} is disconnected* \\- @${format.escapeMd(next.login)} becomes your active account` +
        `${list.length > 2 ? `, and your other ${list.length - 2} account${list.length > 3 ? 's stay' : ' stays'} linked` : ''}\\. ` +
        `Choose *Disconnect ALL accounts* to end every connection instead\\.\n`;
    }
  } catch (_) { /* note is optional */ }

  await ctx.reply(
    `⚠️ Disconnect GitHub account\\?\n${multiNote}\n` +
    `This will:\n` +
    `• Remove the live alerts \\(webhooks\\) GitroHub added to your repos\n` +
    `• Revoke GitroHub's access token on GitHub and delete the copy we stored\n` +
    `• Require reconnecting before using any repo features again\n` +
    `• NOT delete or change any of your repos, files or settings on GitHub`,
    { parse_mode: 'MarkdownV2', ...inline.disconnectConfirm({ multi, activeLogin }) }
  );
}

/** v1.2.5-multi: the second, explicit step for ending EVERY connection at once. */
async function askDisconnectAll(ctx) {
  const connected = await users.isConnected(ctx.from.id);
  if (!connected) return;
  let count = 1;
  try { count = (await require('../lib/accounts').list(ctx.from.id)).length || 1; } catch (_) { /* default 1 */ }
  await ctx.reply(
    `⚠️ Disconnect *all ${count} GitHub accounts*\\?\n\n` +
    `Every account is disconnected, all live alerts GitroHub added are removed, and you'll need to connect again before using any repo features\\. ` +
    `Your repos, files and settings on GitHub are not touched\\.`,
    { parse_mode: 'MarkdownV2', ...inline.disconnectAllConfirm() }
  );
}

async function executeDisconnect(ctx, { all = false } = {}) {
  const actionLock = require('../lib/actionLock');
  const { skipped } = await actionLock.withLock(ctx.from.id, 'disconnect', () => _executeDisconnect(ctx, { all }));
  if (skipped) await ctx.reply('⏳ Already processing — please wait a moment.');
}

async function _executeDisconnect(ctx, { all = false } = {}) {
  // Everything that needs the live token (removing our webhooks, revoking
  // GitroHub's access on GitHub) runs inside the shared teardown BEFORE the
  // token is wiped. It never throws because of GitHub, so Disconnect always
  // completes — even for a token that can no longer be decrypted.
  const { teardownGithubConnection } = require('../lib/connectionTeardown');
  const teardown = await teardownGithubConnection(ctx.from.id, { revokeGrant: false, all });
  const repoCache = require('../lib/repoCache');
  repoCache.invalidateUser(ctx.from.id);
  await activity.log(ctx.from.id, '🚪', all ? 'Disconnected ALL GitHub accounts' : 'Disconnected GitHub account', {
    detail: `webhooks removed: ${teardown.webhooksRemoved}${teardown.webhooksFailed ? `, failed: ${teardown.webhooksFailed}` : ''}; GitHub access ${teardown.revoked ? 'revoked' : 'not revoked (' + (teardown.revokeReason || 'no token') + ')'}`,
  });
  const accessLog = require('../lib/accessLog');
  await accessLog.record(ctx.from.id, 'disconnected');

  // v1.2.4-multi: another connected account takes over instead of dropping the person to the connect screen.
  if (teardown.switchedTo) {
    await ctx.reply(`✅ Disconnected @${teardown.removedLogin || 'that account'}. Switched to @${teardown.switchedTo}.`);
    return;
  }

  const { sendConnectPrompt } = require('./start');
  await sendConnectPrompt(ctx, {
    intro: '✅ Disconnected. Your GitHub account is no longer linked.',
  });
}

async function showNotifications(ctx) {
  const connected = await users.isConnected(ctx.from.id);
  if (!connected) return;

  const prefs = await users.getNotificationPrefs(ctx.from.id);
  await ctx.reply(
    `🔔 *Notifications*\n\nChoose what GitroHub should alert you about:`,
    { parse_mode: 'MarkdownV2', ...inline.notificationsMenu(prefs) }
  );
}

async function toggleNotification(ctx, key) {
  await users.toggleNotification(ctx.from.id, key);
  const prefs = await users.getNotificationPrefs(ctx.from.id);
  await ctx.editMessageReplyMarkup(inline.notificationsMenu(prefs).reply_markup);
}

/** Rollup cycles in place (off -> daily -> weekly -> off). */
async function cycleRollup(ctx) {
  await users.cycleRollup(ctx.from.id);
  const prefs = await users.getNotificationPrefs(ctx.from.id);
  await ctx.editMessageReplyMarkup(inline.notificationsMenu(prefs).reply_markup);
}

/** Prompts for quiet hours as "start-end" (e.g. "22-7"), simplest input
 * that covers the wrap-past-midnight case without a full time-picker UI.
 * Hours are in the person's own timezone (🤖 Automation → 🌍 Timezone),
 * not UTC — shown here so "22-7" means what they'd expect it to mean. */
async function promptQuietHours(ctx) {
  ctx.session.awaitingQuietHours = true;
  const user = await users.getUser(ctx.from.id);
  const tz = user.timezone || 'UTC';
  await ctx.reply(
    `🌙 Send quiet hours as \`start-end\` in 24h, in your timezone \\(${format.escapeMd(tz)}\\) — e\\.g\\. \`22-7\`, or \`off\` to disable\\.`,
    { parse_mode: 'MarkdownV2', ...bbtb.cancelOnly }
  );
}

async function handleQuietHoursInput(ctx, text) {
  // The flag stays armed on invalid input (below) so the corrected value is
  // actually read — it's only cleared once something valid was accepted.
  const trimmed = text.trim().toLowerCase();
  if (trimmed === 'off') {
    ctx.session.awaitingQuietHours = false;
    await users.setQuietHours(ctx.from.id, null, null);
    await ephemeral.sendEphemeral(ctx, '🌙 Quiet hours disabled.');
    return showNotifications(ctx);
  }
  const match = trimmed.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return ctx.reply('Didn\u2019t understand that — use `start-end`, e.g. `22-7`, or `off`.');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 0 || start > 23 || end < 0 || end > 23) return ctx.reply('Hours must be 0–23.');
  ctx.session.awaitingQuietHours = false;
  await users.setQuietHours(ctx.from.id, start, end);
  const user = await users.getUser(ctx.from.id);
  await ephemeral.sendEphemeral(ctx, `🌙 Quiet hours set: ${String(start).padStart(2, '0')}:00–${String(end).padStart(2, '0')}:00 (${user.timezone || 'UTC'}).`);
  return showNotifications(ctx);
}

module.exports = {
  showSettings, askDisconnect, askDisconnectAll, executeDisconnect, showNotifications, toggleNotification,
  cycleRollup, promptQuietHours, handleQuietHoursInput,
};
