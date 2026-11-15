/** Small per-person switches (v1.2.5-multi). A missing row means the key's default. Booleans only, on purpose. */
const { pool } = require('../db/postgres');

const DEFS = {
  needs_line: { def: true, label: 'Show the “needs you” line on the start card' },
  needs_prs: { def: true, label: '🔀 Pull requests (to review, and the ones I opened)' },
  needs_notifs: { def: true, label: '🔔 Unread GitHub notifications' },
  needs_issues: { def: true, label: '🐞 Issues assigned to me' },
  needs_failing: { def: true, label: '❌ My PRs with failing checks' },
  digest_daily: { def: false, label: '☀️ Daily “while you were away” summary' },
};
const KEYS = Object.keys(DEFS);

async function getAll(telegramId) {
  const { rows } = await pool.query('SELECT pref_key, pref_value FROM user_prefs WHERE telegram_id = $1', [telegramId]);
  const stored = new Map(rows.map((r) => [r.pref_key, r.pref_value === 'on']));
  return Object.fromEntries(KEYS.map((k) => [k, stored.has(k) ? stored.get(k) : DEFS[k].def]));
}

async function get(telegramId, key) {
  if (!DEFS[key]) return false;
  const { rows } = await pool.query('SELECT pref_value FROM user_prefs WHERE telegram_id = $1 AND pref_key = $2', [telegramId, key]);
  return rows[0] ? rows[0].pref_value === 'on' : DEFS[key].def;
}

async function set(telegramId, key, on) {
  if (!DEFS[key]) throw new Error('Unknown setting');
  await pool.query(
    `INSERT INTO user_prefs (telegram_id, pref_key, pref_value) VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id, pref_key) DO UPDATE SET pref_value = $3, updated_at = now()`,
    [telegramId, key, on ? 'on' : 'off']
  );
}

module.exports = { DEFS, KEYS, get, getAll, set };
