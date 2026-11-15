/**
 * Admin attention counts (v1.3.0-multi) — the little badge on the 🛡️ Admin tile and the first lines of the Admin
 * dashboard's 📥 Attention screen. Cheap (a few COUNT queries, cached for 20 seconds) and never throws.
 *
 *   reports   open reports in the queue                 (everyone who can see Reports)
 *   flagged   open Warden cases + flagged sensitive actions
 *   held      actions waiting for the Owner's approval  (Owner only)
 */
const { pool } = require('../db/postgres');

const TTL_MS = 20000;
let cache = { at: 0, value: null };

async function raw() {
  const [reports, cases, flagged, held] = await Promise.all([
    require('./reports').openCount().catch(() => 0),
    pool.query(`SELECT COUNT(*)::int AS c FROM warden_cases WHERE status = 'open'`).then((r) => (r.rows[0] && r.rows[0].c) || 0).catch(() => 0),
    pool.query(`SELECT COUNT(*)::int AS c FROM sensitive_actions WHERE flagged = TRUE AND reviewed_at IS NULL AND created_at > now() - interval '3 days'`).then((r) => (r.rows[0] && r.rows[0].c) || 0).catch(() => 0),
    pool.query(`SELECT COUNT(*)::int AS c FROM sensitive_approvals WHERE status = 'pending'`).then((r) => (r.rows[0] && r.rows[0].c) || 0).catch(() => 0),
  ]);
  return { reports, flagged: cases + flagged, held };
}

async function counts(telegramId) {
  if (!cache.value || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), value: await raw() };
  const v = cache.value;
  const held = require('./roles').isOwner(telegramId) ? v.held : 0;
  return { reports: v.reports, flagged: v.flagged, held, total: v.reports + v.flagged + held };
}

/** The few newest items behind each count, for one-tap actions on the Attention screen. Never throws. */
async function items(telegramId, { limit = 3 } = {}) {
  const owner = require('./roles').isOwner(telegramId);
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows).catch(() => []);
  const [reports, flagged, approvals, cases] = await Promise.all([
    q(`SELECT r.id, r.category, r.message, r.telegram_id, u.telegram_username, u.telegram_first_name FROM user_reports r LEFT JOIN users u ON u.telegram_id = r.telegram_id WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT $1`, [limit]),
    q(`SELECT s.id, s.action, s.score, s.telegram_id, u.telegram_username, u.telegram_first_name FROM sensitive_actions s LEFT JOIN users u ON u.telegram_id = s.telegram_id WHERE s.flagged = TRUE AND s.reviewed_at IS NULL AND s.created_at > now() - interval '3 days' ORDER BY s.created_at DESC LIMIT $1`, [limit]),
    owner ? q(`SELECT a.id, a.action, a.repo_name, a.telegram_id, u.telegram_username, u.telegram_first_name FROM sensitive_approvals a LEFT JOIN users u ON u.telegram_id = a.telegram_id WHERE a.status = 'pending' ORDER BY a.created_at DESC LIMIT $1`, [limit]) : [],
    q(`SELECT COUNT(*)::int AS c FROM warden_cases WHERE status = 'open'`, []),
  ]);
  return { reports, flagged, approvals, openCases: (cases[0] && cases[0].c) || 0 };
}

function _reset() { cache = { at: 0, value: null }; }

module.exports = { counts, items, _reset };
