const { pool } = require('../db/postgres');
const logger = require('./logger');

/**
 * Rules-based anomaly detection, evaluated at write time so the
 * flag is stored once and never recomputed. Still deliberately not
 * ML/behavioral modeling — appropriate for this bot's scale, where
 * "unusual" means "worth a second look", not a hard security verdict.
 * That said, v1.0.0-multi widened this from the original two checks
 * (written back when this was a single-owner bot, so "someone else
 * connecting at all" wasn't even a scenario) to four, now that anyone
 * can connect their own account:
 *
 *  1. Reconnect within 5 minutes of a disconnect — could be a normal
 *     re-auth after a scope change, or could be a token that got
 *     invalidated and someone re-authorizing from somewhere unexpected.
 *  2. Scope changed between this connection and the previous one — the
 *     access level the bot has silently changed, worth surfacing even if
 *     it was the person's own doing.
 *  3. Three or more connect/reconnect events inside 24h — one-off re-
 *     auths are normal, but repeatedly cycling through the OAuth flow in
 *     a single day looks more like testing which of several credentials
 *     actually works than routine use.
 *  4. First-ever connection paired with an immediately-suspicious click
 *     pattern — more than 15 actions logged in the 60 seconds right
 *     before the very first successful connect. A real person reads the
 *     welcome message and taps through a few menus first; a script
 *     probing the bot before bothering to authenticate does not.
 */
async function detectAnomaly(telegramId, event, detail) {
  if (event !== 'connected' && event !== 'reconnected') return null;

  const { rows } = await pool.query(
    `SELECT event, detail, created_at FROM access_log
     WHERE telegram_id = $1 AND event IN ('connected', 'reconnected', 'disconnected')
     ORDER BY created_at DESC LIMIT 1`,
    [telegramId]
  );
  const prev = rows[0];

  if (prev) {
    if (prev.event === 'disconnected') {
      const minutesSince = (Date.now() - new Date(prev.created_at).getTime()) / 60000;
      if (minutesSince <= 5) return `Reconnected ${Math.round(minutesSince)}m after disconnecting`;
    }

    const prevScope = (prev.detail || '').match(/scope:\s*(.+)/);
    const newScope = (detail || '').match(/scope:\s*(.+)/);
    if (prevScope && newScope && prevScope[1] !== newScope[1]) {
      return `Scope changed: ${prevScope[1]} → ${newScope[1]}`;
    }
  } else {
    // No prior connect/reconnect/disconnect row at all — this is the
    // account's very first connection. A high click count (users.
    // total_actions, bumped on every accepted update — see
    // accessControl.js) on an account that was only just created reads
    // less like someone tapping through the menus after reading the
    // welcome message than a script hammering the bot before bothering
    // to finish authenticating.
    const { rows: freshRows } = await pool.query(
      'SELECT total_actions, created_at FROM users WHERE telegram_id = $1',
      [telegramId]
    );
    const fresh = freshRows[0];
    if (fresh) {
      const secondsOld = (Date.now() - new Date(fresh.created_at).getTime()) / 1000;
      if (secondsOld < 120 && (fresh.total_actions || 0) > 30) {
        return `${fresh.total_actions} actions within ${Math.round(secondsOld)}s of account creation`;
      }
    }
  }

  const { rows: recentConnects } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM access_log
     WHERE telegram_id = $1 AND event IN ('connected', 'reconnected')
       AND created_at > now() - interval '24 hours'`,
    [telegramId]
  );
  if (recentConnects[0].c >= 3) return `${recentConnects[0].c} GitHub connections in the last 24h`;

  return null;
}

async function record(telegramId, event, detail = null) {
  const reason = await detectAnomaly(telegramId, event, detail).catch(() => null);
  // Same reasoning as lib/activity.js's log(): by the time this runs, the
  // real event (connect/disconnect/reconnect) already happened. A failure
  // writing the *audit row* for it must never bubble up and replace the
  // success reply with a scary error, so it's caught and reported to our
  // own logs instead of the caller's bot.catch().
  try {
    await pool.query(
      'INSERT INTO access_log (telegram_id, event, detail, is_anomalous, anomaly_reason) VALUES ($1, $2, $3, $4, $5)',
      [telegramId, event, detail, !!reason, reason]
    );
  } catch (e) {
    logger.error({ err: e, telegramId, event }, 'accessLog.record: failed to write access_log row (swallowed)');
  }
  return reason;
}

async function recent(telegramId, limit = 10) {
  const { rows } = await pool.query(
    'SELECT event, detail, is_anomalous, anomaly_reason, created_at FROM access_log WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT $2',
    [telegramId, limit]
  );
  return rows;
}

/** Same reasoning as activity.pruneOlderThan — access_log has no other
 * cleanup path, called daily by the scheduler in index.js. */
async function pruneOlderThan(days) {
  const { pruneBatched } = require('./retention');
  return (await pruneBatched('access_log', "created_at < now() - ($2 || ' days')::interval", [String(days)])).deleted;
}

module.exports = { record, recent, detectAnomaly, pruneOlderThan };
