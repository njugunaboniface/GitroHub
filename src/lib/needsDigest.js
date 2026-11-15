/**
 * Optional once-a-day "while you were away" summary (v1.2.5-multi). Off by default; turned on under
 * 📬 Needs attention → ⚙️ What to count. Sent around 8:00 on the person's own clock, never during their quiet
 * hours, never when there is nothing to say, at most once per day (a Redis marker, so a restart or a second
 * instance cannot double-send). Uses the same cached counts as the start card.
 */
const { pool } = require('../db/postgres');
const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const users = require('./users');
const accounts = require('./accounts');
const needs = require('./needsYou');
const userPrefs = require('./userPrefs');
const timezone = require('./timezone');
const quietHours = require('./quietHours');
const logger = require('./logger');

const SEND_HOUR = 8;

/** Plain-text summary for the given visible counts, or '' when there is nothing. */
function compose(v, other = { sum: 0 }) {
  if (!v || !v.total) return '';
  const parts = [];
  if (v.prs) parts.push(`🔀 ${v.prs} pull request${v.prs === 1 ? '' : 's'} need${v.prs === 1 ? 's' : ''} you`);
  if (v.issues) parts.push(`🐞 ${v.issues} issue${v.issues === 1 ? '' : 's'} assigned to you`);
  if (v.notifs) parts.push(`🔔 ${v.notifs >= 50 ? '50+' : v.notifs} unread notification${v.notifs === 1 ? '' : 's'}`);
  if (v.failing) parts.push(`❌ ${v.failing} of your PRs ${v.failing === 1 ? 'has' : 'have'} failing checks`);
  return `☀️ Good morning — while you were away:\n${parts.map((p) => `• ${p}`).join('\n')}${other.sum ? `\n(+${other.sum} more on your other accounts)` : ''}`;
}

/** One sweep. `redis` is injectable for tests. Returns how many summaries were sent. */
async function runOnce(bot, { now = new Date(), redis = require('../db/redis').client, limit = 300 } = {}) {
  const { rows } = await pool.query(`SELECT telegram_id FROM user_prefs WHERE pref_key = 'digest_daily' AND pref_value = 'on' LIMIT $1`, [limit]);
  let sent = 0;
  for (const { telegram_id: raw } of rows) {
    const id = Number(raw);
    try {
      const user = await users.getUser(id);
      if (!user || !user.github_token_enc) continue;
      if (timezone.getHourInZone(now, user.timezone || 'UTC') !== SEND_HOUR) continue;
      if (quietHours.isQuietNow(user, now)) continue;
      const marker = `needs-digest:${id}:${timezone.getDateKeyInZone(now, user.timezone || 'UTC')}`;
      if (await redis.get(marker)) continue;
      const [account, token] = await Promise.all([accounts.activeLoginOf(id), users.getDecryptedToken(id)]);
      if (!account || !token) continue;
      const prefs = await userPrefs.getAll(id);
      const counts = await needs.counts(id, account, token, { force: true }).catch(() => null);
      const v = needs.visible(counts, prefs);
      await redis.set(marker, '1', { EX: 36 * 60 * 60 }); // set even when empty: one look per day
      const text = compose(v, await needs.elsewhere(id, account));
      if (!text) continue;
      const row = needs.jumpRows(v, style);
      await bot.telegram.sendMessage(id, text, row ? Markup.inlineKeyboard(row) : undefined);
      sent++;
    } catch (err) {
      logger.debug('needs digest skipped one person', { error: err && err.message });
    }
  }
  return sent;
}

module.exports = { compose, runOnce, SEND_HOUR };
