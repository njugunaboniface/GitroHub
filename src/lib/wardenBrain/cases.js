/**
 * Owner Board data layer. One OPEN case per user; new evidence merges into it
 * instead of spawning a new case per event. Cases start at "Flagged" — below
 * that, Warden only records (profiles/evidence), it doesn't ask for attention.
 */
const { STAGES, stageIndex } = require('./engine');

function getPool() { return require('../../db/postgres').pool; }
const FLAG = stageIndex('flag');
const CALM_BEFORE_RESOLVE_MS = 24 * 3600 * 1000;

async function addEvent(caseId, telegramId, kind, detail = {}, actor = null) {
  await getPool().query(
    'INSERT INTO warden_case_events (case_id, telegram_id, kind, detail, actor) VALUES ($1, $2, $3, $4, $5)',
    [caseId, telegramId, kind, JSON.stringify(detail), actor]
  );
}

async function getOpen(telegramId) {
  const { rows } = await getPool().query("SELECT * FROM warden_cases WHERE telegram_id = $1 AND status = 'open'", [telegramId]);
  return rows[0] || null;
}

/**
 * Reconcile one user's case with their (already progressed) stage.
 * @returns {{case: object|null, opened: boolean, stageChanged: boolean, resolved: boolean}}
 */
async function syncCase({ telegramId, stage, prevStage, decision, dismissedUntil = null, now = Date.now() }) {
  const pool = getPool();
  const open = await getOpen(telegramId);
  const summary = JSON.stringify({
    risk: decision.risk, confidence: decision.confidence, confidenceLabel: decision.confidenceLabel,
    reasons: decision.reasons, blockers: decision.blockers, benign: decision.benign, persistence: decision.persistence,
    maturity: decision.maturity, classes: decision.classes, trustCapped: decision.trustCapped, witnesses: decision.witnesses,
  });

  if (stageIndex(stage) >= FLAG) {
    if (!open) {
      // Owner dismissed a case recently: stay quiet unless it has become serious.
      if (dismissedUntil && new Date(dismissedUntil).getTime() > now && stageIndex(stage) < stageIndex('enhanced_monitoring')) {
        return { case: null, opened: false, stageChanged: false, resolved: false };
      }
      const { rows } = await pool.query(
        `INSERT INTO warden_cases (telegram_id, stage, peak_stage, risk, confidence, summary)
         VALUES ($1, $2, $2, $3, $4, $5::jsonb) RETURNING *`,
        [telegramId, stage, decision.risk, decision.confidence, summary]
      );
      await addEvent(rows[0].id, telegramId, 'opened', { stage, risk: decision.risk, reasons: decision.reasons });
      return { case: rows[0], opened: true, stageChanged: true, resolved: false };
    }
    const peak = stageIndex(stage) > stageIndex(open.peak_stage) ? stage : open.peak_stage;
    const { rows } = await pool.query(
      `UPDATE warden_cases SET stage = $2, peak_stage = $3, risk = $4, confidence = $5, summary = $6::jsonb, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [open.id, stage, peak, decision.risk, decision.confidence, summary]
    );
    const stageChanged = open.stage !== stage;
    if (stageChanged) await addEvent(open.id, telegramId, 'stage_changed', { from: open.stage, to: stage, risk: decision.risk, confidence: decision.confidence, reasons: decision.reasons });
    return { case: rows[0], opened: false, stageChanged, resolved: false };
  }

  // Below flag: close the case once things have been calm for a full day.
  if (open && now - new Date(open.updated_at).getTime() >= CALM_BEFORE_RESOLVE_MS) {
    const { rows } = await pool.query(
      "UPDATE warden_cases SET status = 'resolved', closed_at = now(), close_reason = 'returned_to_normal' WHERE id = $1 RETURNING *", [open.id]
    );
    await addEvent(open.id, telegramId, 'resolved', { reason: 'returned_to_normal' });
    return { case: rows[0], opened: false, stageChanged: false, resolved: true };
  }
  return { case: open, opened: false, stageChanged: false, resolved: false };
}

async function getCase(id) {
  const { rows } = await getPool().query('SELECT * FROM warden_cases WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Open cases, most serious first. */
async function listOpen({ minStage = 'flag', page = 1, perPage = 5 } = {}) {
  const wanted = STAGES.slice(stageIndex(minStage));
  const [{ rows }, { rows: cnt }] = await Promise.all([
    getPool().query(
      `SELECT c.*, u.telegram_username, u.telegram_first_name, p.snooze_until
         FROM warden_cases c
         LEFT JOIN users u ON u.telegram_id = c.telegram_id
         LEFT JOIN warden_profiles p ON p.telegram_id = c.telegram_id
        WHERE c.status = 'open' AND c.stage = ANY($1::text[])
        ORDER BY array_position(ARRAY['review_candidate','enhanced_monitoring','flag']::text[], c.stage), c.risk DESC NULLS LAST, c.updated_at DESC
        LIMIT $2 OFFSET $3`,
      [wanted, perPage, (page - 1) * perPage]
    ),
    getPool().query("SELECT COUNT(*)::int AS c FROM warden_cases WHERE status = 'open' AND stage = ANY($1::text[])", [wanted]),
  ]);
  return { rows, total: cnt[0].c };
}

/** Counts per stage across ALL users (profiles) plus open cases, for the main screen. */
async function stageCounts() {
  const { rows } = await getPool().query('SELECT stage, COUNT(*)::int AS c FROM warden_profiles GROUP BY stage');
  const out = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of rows) out[r.stage] = r.c;
  const { rows: oc } = await getPool().query("SELECT COUNT(*)::int AS c FROM warden_cases WHERE status = 'open'");
  return { stages: out, openCases: oc[0].c };
}

async function getEvents(caseId, limit = 12) {
  const { rows } = await getPool().query('SELECT * FROM warden_case_events WHERE case_id = $1 ORDER BY created_at DESC LIMIT $2', [caseId, limit]);
  return rows;
}

async function stats(telegramId) {
  const { rows } = await getPool().query(
    `SELECT (SELECT COUNT(*)::int FROM warden_cases WHERE telegram_id = $1 AND status <> 'open') AS prior_cases,
            (SELECT COUNT(*)::int FROM warden_case_events WHERE telegram_id = $1 AND kind = 'warning_sent') AS warnings`,
    [telegramId]
  );
  return { priorCases: rows[0].prior_cases, warnings: rows[0].warnings };
}

/** Most recent warning Warden's owner sent this user (feeds ban/suspend notices). */
async function lastWarning(telegramId) {
  const { rows } = await getPool().query(
    "SELECT created_at, detail FROM warden_case_events WHERE telegram_id = $1 AND kind = 'warning_sent' ORDER BY created_at DESC LIMIT 1", [telegramId]
  );
  if (!rows.length) return null;
  const d = rows[0].detail || {};
  return { at: rows[0].created_at, summary: d.summary || null };
}

async function dismiss(caseId, actor, days = 7) {
  const c = await getCase(caseId);
  if (!c || c.status !== 'open') return null;
  const { rows } = await getPool().query(
    "UPDATE warden_cases SET status = 'dismissed', closed_at = now(), close_reason = 'owner_dismissed' WHERE id = $1 RETURNING *", [caseId]
  );
  await getPool().query(
    `INSERT INTO warden_profiles (telegram_id, dismissed_until) VALUES ($1, now() + ($2 || ' days')::interval)
     ON CONFLICT (telegram_id) DO UPDATE SET dismissed_until = EXCLUDED.dismissed_until`, [c.telegram_id, String(days)]
  );
  // A dismissal is a LABEL: the owner judged this a false positive.
  await addEvent(caseId, c.telegram_id, 'dismissed', { label: 'false_positive', peak_stage: c.peak_stage, risk: c.risk }, actor);
  return rows[0];
}

async function snooze(caseId, actor, days = 7) {
  const c = await getCase(caseId);
  if (!c) return null;
  await getPool().query(
    `INSERT INTO warden_profiles (telegram_id, snooze_until) VALUES ($1, now() + ($2 || ' days')::interval)
     ON CONFLICT (telegram_id) DO UPDATE SET snooze_until = EXCLUDED.snooze_until`, [c.telegram_id, String(days)]
  );
  await addEvent(caseId, c.telegram_id, 'snoozed', { days }, actor);
  return c;
}

async function profileOf(telegramId) {
  const { rows } = await getPool().query('SELECT snooze_until, dismissed_until FROM warden_profiles WHERE telegram_id = $1', [telegramId]);
  return rows[0] || {};
}

module.exports = { profileOf, syncCase, getCase, getOpen, listOpen, stageCounts, getEvents, stats, lastWarning, dismiss, snooze, addEvent };
