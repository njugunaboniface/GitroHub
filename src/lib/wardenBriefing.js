/**
 * ☀️ Warden's daily briefing for the owner (v1.2.5-multi) — one short message around 9:00 their time, only when
 * there is something worth knowing, and only when switched on (Monitoring → Alert rules). Counts and names only.
 */
const sens = require('./sensitiveActions');
const globalConfig = require('./globalConfig');
const users = require('./users');
const timezone = require('./timezone');
const quietHours = require('./quietHours');

const SEND_HOUR = 9;

function compose(c) {
  const lines = [];
  if (c.flagged_open) lines.push(`🚩 ${c.flagged_open} flagged action${c.flagged_open === 1 ? '' : 's'} waiting for a look`);
  if (c.approvals_pending) lines.push(`⏳ ${c.approvals_pending} request${c.approvals_pending === 1 ? '' : 's'} waiting for your OK`);
  if (c.dead_accounts) lines.push(`🔌 ${c.dead_accounts} extra GitHub account${c.dead_accounts === 1 ? '' : 's'} found revoked`);
  if (c.actions_24h) lines.push(`⚡ ${c.actions_24h} sensitive action${c.actions_24h === 1 ? '' : 's'} in the last 24h`);
  return lines.length ? `🛡️ Warden briefing\n${lines.map((l) => `• ${l}`).join('\n')}` : '';
}

async function runOnce(bot, { now = new Date(), redis = require('../db/redis').client } = {}) {
  if (globalConfig.get('warden_briefing') !== 'on') return 0;
  const ownerId = require('../config').OWNER_ID;
  const owner = await users.getUser(ownerId).catch(() => null);
  const tz = (owner && owner.timezone) || 'UTC';
  if (timezone.getHourInZone(now, tz) !== SEND_HOUR || quietHours.isQuietNow(owner, now)) return 0;
  const marker = `warden-briefing:${timezone.getDateKeyInZone(now, tz)}`;
  if (await redis.get(marker)) return 0;
  await redis.set(marker, '1', { EX: 36 * 3600 });
  const text = compose(await sens.counts());
  if (!text) return 0;
  await bot.telegram.sendMessage(ownerId, text, { reply_markup: { inline_keyboard: [[{ text: '🛰️ Open Monitoring', callback_data: 'admin:mon' }]] } });
  return 1;
}

module.exports = { compose, runOnce, SEND_HOUR };
