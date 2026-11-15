/** Which kinds of live alert a person wants (v1.2.4-multi). A missing row means that event type's default. */
const { pool } = require('../db/postgres');
const { EVENT_DEFS, KEYS, defaultFor } = require('./webhookEvents');

/** { push: true, star: false, … } with defaults filled in. */
async function getAll(telegramId) {
  const { rows } = await pool.query('SELECT event_key, enabled FROM alert_event_prefs WHERE telegram_id = $1', [telegramId]);
  const stored = new Map(rows.map((r) => [r.event_key, !!r.enabled]));
  return Object.fromEntries(EVENT_DEFS.map((d) => [d.key, stored.has(d.key) ? stored.get(d.key) : d.defaultOn]));
}

async function isEnabled(telegramId, key) {
  if (!KEYS.has(key)) return false;
  const { rows } = await pool.query('SELECT enabled FROM alert_event_prefs WHERE telegram_id = $1 AND event_key = $2', [telegramId, key]);
  return rows[0] ? !!rows[0].enabled : defaultFor(key);
}

async function set(telegramId, key, enabled) {
  if (!KEYS.has(key)) throw new Error('Unknown alert type');
  await pool.query(
    `INSERT INTO alert_event_prefs (telegram_id, event_key, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id, event_key) DO UPDATE SET enabled = $3`,
    [telegramId, key, !!enabled]
  );
}

module.exports = { getAll, isEnabled, set };
