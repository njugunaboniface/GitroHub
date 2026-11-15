/**
 * 🤖 WARDEN — Brain edition (v1.2.0-multi)
 *
 * Warden OBSERVES, EVALUATES and REPORTS. It does not restrict, suspend, ban,
 * delete or message users — those are decisions for a human, made from the
 * Owner Board with Warden's evidence in front of them. This module holds only
 * the configuration, the decision log and the JSONL datasets; the thinking
 * lives in lib/wardenBrain/ and runs from lib/pollers/warden.js.
 *
 *   Monitor → Observe → Collect evidence → Correlate → Evaluate
 *           → Analyze → Record → Report        (never: Detect → Ban)
 *
 * A test scans this file and lib/wardenBrain/ to keep it that way.
 */
const { pool } = require('../db/postgres');
const adminActions = require('./adminActions');
const jsonl = require('./jsonl');

// ─── Config ───────────────────────────────────────────────────────────
async function getConfig() {
  const { rows } = await pool.query('SELECT * FROM warden_config WHERE id = 1');
  return rows[0] || null;
}

// Only two switches exist now: whether Warden is watching, and whether the
// owner is pinged when a case reaches review. (Everything that used to grant
// Warden powers over accounts was removed.)
const CONFIG_KEYS = ['enabled', 'alerts_review'];

async function updateConfig(ownerId, patch) {
  const keys = Object.keys(patch).filter((k) => CONFIG_KEYS.includes(k));
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  await pool.query(
    `UPDATE warden_config SET ${sets}, updated_at = now(), updated_by = $${keys.length + 1} WHERE id = 1`,
    [...keys.map((k) => patch[k]), ownerId]
  );
  await adminActions.auditLog(ownerId, null, 'warden_config', keys.map((k) => `${k}=${patch[k]}`).join(', '));
}

// ─── Decision log ─────────────────────────────────────────────────────
async function logAction(targetId, actionType, reason, { dryRun = false, undoLogId = null } = {}) {
  await pool.query(
    `INSERT INTO warden_action_log (target_id, action_type, reason, dry_run, undo_log_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [targetId, actionType, reason, dryRun, undoLogId]
  );
}

// Internal bookkeeping rows aren't decisions.
const NOT_BOOKKEEPING = "l.action_type NOT LIKE 'release_false_restrictions%'";

async function getActionLog(page = 1, perPage = 10) {
  const offset = (page - 1) * perPage;
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT l.*, u.telegram_username, u.telegram_first_name
       FROM warden_action_log l LEFT JOIN users u ON u.telegram_id = l.target_id
       WHERE ${NOT_BOOKKEEPING}
       ORDER BY l.created_at DESC LIMIT $1 OFFSET $2`,
      [perPage, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS c FROM warden_action_log l WHERE ${NOT_BOOKKEEPING}`),
  ]);
  return { rows, total: cnt[0].c };
}

/** Stage movements in the last 24h, for the main screen. */
async function getRecentSummary() {
  const { rows } = await pool.query(
    `SELECT action_type, COUNT(*)::int AS c FROM warden_action_log
      WHERE created_at > now() - interval '24 hours' AND action_type LIKE 'stage:%'
      GROUP BY action_type`
  );
  return Object.fromEntries(rows.map((r) => [r.action_type.replace('stage:', ''), r.c]));
}

// ─── JSONL datasets ───────────────────────────────────────────────────
const DATASETS = {
  log: 'Decision log',
  cases: 'Cases & timelines',
  evidence: 'Evidence',
  all: 'Everything',
};

/** @returns {Promise<{filename: string, body: string, count: number}>} */
async function exportDataset(dataset, { days = 90, limit = 50000, now = new Date() } = {}) {
  if (!DATASETS[dataset]) throw new Error(`unknown dataset: ${dataset}`);
  const since = new Date(now.getTime() - days * 86400000);
  const want = (d) => dataset === 'all' || dataset === d;
  const records = [];
  if (want('log')) {
    const { rows } = await pool.query(
      `SELECT l.id, l.created_at, l.action_type, l.target_id, u.telegram_username, l.reason, l.dry_run
         FROM warden_action_log l LEFT JOIN users u ON u.telegram_id = l.target_id
        WHERE ${NOT_BOOKKEEPING} AND l.created_at >= $1 ORDER BY l.created_at LIMIT $2`, [since, limit]);
    for (const r of rows) records.push(jsonl.record('decision_log', { id: r.id, at: r.created_at, action: r.action_type, user_id: r.target_id, username: r.telegram_username, reason: r.reason, dry_run: r.dry_run }));
  }
  if (want('cases')) {
    const [{ rows: cs }, { rows: ev }] = await Promise.all([
      pool.query('SELECT * FROM warden_cases WHERE opened_at >= $1 ORDER BY opened_at LIMIT $2', [since, limit]),
      pool.query('SELECT * FROM warden_case_events WHERE created_at >= $1 ORDER BY created_at LIMIT $2', [since, limit]),
    ]);
    for (const c of cs) records.push(jsonl.record('case', { case_id: c.id, user_id: c.telegram_id, status: c.status, stage: c.stage, peak_stage: c.peak_stage, risk: c.risk === null ? null : Number(c.risk), confidence: c.confidence === null ? null : Number(c.confidence), opened_at: c.opened_at, updated_at: c.updated_at, closed_at: c.closed_at, close_reason: c.close_reason, summary: c.summary }));
    for (const e of ev) records.push(jsonl.record('case_event', { event_id: e.id, case_id: e.case_id, user_id: e.telegram_id, kind: e.kind, at: e.created_at, actor: e.actor, detail: e.detail }));
  }
  if (want('evidence')) {
    const { rows } = await pool.query('SELECT * FROM warden_evidence WHERE created_at >= $1 ORDER BY created_at LIMIT $2', [since, limit]);
    for (const r of rows) records.push(jsonl.record('evidence', { evidence_id: r.id, case_id: r.case_id, user_id: r.telegram_id, type: r.type, class: r.class, strength: Number(r.strength), reliability: Number(r.reliability), observed: r.observed, baseline: r.baseline, window_start: r.window_start, window_end: r.window_end, at: r.created_at }));
  }
  if (dataset === 'all') {
    const { rows } = await pool.query('SELECT telegram_id, stage, stage_since, risk, confidence, last_eval_at, baseline, last_decision FROM warden_profiles ORDER BY telegram_id LIMIT $1', [limit]);
    for (const r of rows) records.push(jsonl.record('profile', { user_id: r.telegram_id, stage: r.stage, stage_since: r.stage_since, risk: Number(r.risk), confidence: Number(r.confidence), last_eval_at: r.last_eval_at, baseline: r.baseline, last_decision: r.last_decision }));
  }
  return { filename: jsonl.filename(dataset, now), body: jsonl.toJsonl(records), count: records.length };
}

module.exports = {
  getConfig, updateConfig, CONFIG_KEYS,
  logAction, getActionLog, getRecentSummary,
  DATASETS, exportDataset,
};
