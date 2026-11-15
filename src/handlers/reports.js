const reports = require('../lib/reports');
const bbtb = require('../keyboards/bbtb');
const inline = require('../keyboards/inline');
const config = require('../config');

/**
 * 🚩 /report — the one inbound channel a user has to flag something TO an
 * admin, as opposed to every other admin↔user interaction in this bot
 * (ban/suspend/message) which runs admin→user. Two steps: free text,
 * then a category tap (🐛 Bug / 🚨 Abuse / ❓ Other) so the admin-side
 * queue can be scanned at a glance rather than every row needing to be
 * opened to know what kind of problem it is.
 */
const MAX_OPEN_REPORTS_PER_USER = 5;
const REPORT_COOLDOWN_SECONDS = 60;

/** True while this person's last report is under a minute old (fails open if Redis is down). */
async function isCoolingDown(telegramId) {
  try {
    return !!(await require('../db/redis').client.exists(`report-cooldown:${telegramId}`));
  } catch (_) {
    return false;
  }
}

async function askReport(ctx) {
  // v1.2.3-multi: /report used to have no limit at all — every submission DMs every admin, so
  // one person could flood the queue and the admins' chats. One report a minute, five open at a time.
  if (await isCoolingDown(ctx.from.id)) {
    return ctx.reply(`⏳ You sent a report a moment ago — please wait about a minute before sending another.`);
  }
  if ((await reports.countOpenByUser(ctx.from.id)) >= MAX_OPEN_REPORTS_PER_USER) {
    return ctx.reply(`📬 You already have ${MAX_OPEN_REPORTS_PER_USER} reports waiting for an admin. Please let them respond before sending more.`);
  }
  ctx.session.awaitingReportText = true;
  await ctx.reply(
    '🚩 Describe the problem — a bug, abuse from another user, anything you\u2019d want an admin to know about. This goes straight to the admin team.\n\nSend ❌ Cancel to back out.',
    bbtb.cancelOnly
  );
}

async function handleReportText(ctx) {
  ctx.session.awaitingReportText = false;
  const text = ctx.message.text.trim();
  if (!text) {
    // Empty input is invalid, so keep listening for the actual report text.
    ctx.session.awaitingReportText = true;
    await ctx.reply('Please describe the problem, or send ❌ Cancel to back out.');
    return;
  }
  ctx.session.pendingReportText = text.slice(0, 2000);
  await ctx.reply('🏷️ What kind of problem is this?', inline.reportCategoryMenu());
}

/** Category tap finalizes and sends the report — see inline.reportCategoryMenu
 * for the three buttons that call this. */
async function submitReport(ctx, category) {
  const text = ctx.session.pendingReportText;
  ctx.session.pendingReportText = null;
  if (!text) return; // stray tap with nothing pending (e.g. double-tap) — no-op
  await reports.create(ctx.from.id, text, category);
  require('../db/redis').client.set(`report-cooldown:${ctx.from.id}`, '1', { EX: REPORT_COOLDOWN_SECONDS }).catch(() => {});
  await ctx.reply(
    '✅ Sent — an admin will follow up if needed. Thanks for flagging it.'
  );

  // Best-effort admin ping — a report sitting unseen until an admin
  // happens to open the Dashboard on their own defeats the point of a
  // dedicated inbound channel. Wrapped per-admin so one admin having
  // blocked the bot (or any other delivery failure) never affects the
  // others, and never rolls back the report itself, which is already
  // saved above regardless of whether any ping lands.
  const CAT_ICON = { bug: '🐛', abuse: '🚨', other: '❓' };
  const who = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || `#${ctx.from.id}`);
  // Everyone who can actually resolve reports (admin and above) — the live roster from the roles
  // table, so admins promoted in the Dashboard are reached too, not just the .env list.
  const roles = require('../lib/roles');
  let recipients = [];
  try {
    recipients = (await roles.listAdmins()).filter((a) => roles.atLeast(a.role, 'admin')).map((a) => a.telegram_id);
  } catch (_) {
    recipients = config.ADMIN_IDS;
  }
  for (const adminId of recipients) {
    await ctx.telegram.sendMessage(
      adminId,
      `${CAT_ICON[category] || '❓'} New ${category} report from ${who}:\n\n${text.slice(0, 300)}\n\nOpen 🛡️ Admin → 🚩 Reports to respond.`
    ).catch(() => {});
  }
}

module.exports = { askReport, handleReportText, submitReport };
