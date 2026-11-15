/**
 * Warden Brain — evaluation loop (database side).
 *
 *   hourly buckets ─▶ baseline ─▶ evidence ─▶ benign checks ─▶ confidence/decision
 *        ─▶ progressive stage ─▶ profile + evidence + case + timeline ─▶ (owner alert)
 *
 * The ONLY thing this module can do to the outside world is message the owner.
 * It has no way to restrict, suspend, ban, delete or disconnect anyone — that
 * is enforced by a test that scans this directory for such calls.
 */
const { HOUR, DAY, ms } = require('./stats');
const { computeBaseline, buildCohortPrior } = require('./baseline');
const { reliabilityMultipliers } = require('./feedback');
const { githubFleetState, githubEvidenceFor } = require('./githubSignals');
const { extractEvidence, recentRateAbnormal, benignChecks } = require('./evidence');
const { evaluate, progress, fleetState, stageIndex, STAGES } = require('./engine');
const cases = require('./cases');
const warnings = require('./warnings');

const BASELINE_REFRESH_MS = 6 * HOUR;
const EVIDENCE_REPEAT_MS = 6 * HOUR;
const ALERT_COOLDOWN_MS = 24 * HOUR;

function getPool() { return require('../../db/postgres').pool; }
function ownerId() { return require('../../config').OWNER_ID; }

const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = Number(r[key]); (m.get(k) || m.set(k, []).get(k)).push(r); } return m; };

async function loadInputs(now, maxUsers) {
  const pool = getPool();
  // v1.2.3-multi: when more people are active than one run can evaluate, the LEAST recently
  // evaluated go first (never-evaluated first), so every account is reached in turn. The old
  // query had a LIMIT with no ORDER BY — the same arbitrary subset got picked every run and
  // everyone else was never watched.
  const { rows: users } = await pool.query(
    `SELECT u.telegram_id, u.created_at, u.is_trusted, u.is_admin, u.repos_protected
       FROM users u
       LEFT JOIN warden_profiles p ON p.telegram_id = u.telegram_id
      WHERE u.is_admin = false AND COALESCE(u.is_blocked, false) = false
        AND EXISTS (SELECT 1 FROM warden_activity_buckets b WHERE b.telegram_id = u.telegram_id AND b.bucket_start > $2)
      ORDER BY p.last_eval_at ASC NULLS FIRST, u.telegram_id
      LIMIT $1`,
    [maxUsers, new Date(now - 72 * HOUR)]
  );
  if (users.length >= maxUsers) {
    require('../logger').warn('Warden evaluation cap reached — evaluating the least recently checked accounts first', { maxUsers });
  }
  const ids = users.map((u) => u.telegram_id);
  if (!ids.length) return { users, ids };
  const [recent, profiles, identity, bulk, priors, lastEv] = await Promise.all([
    pool.query('SELECT * FROM warden_activity_buckets WHERE telegram_id = ANY($1::bigint[]) AND bucket_start > $2', [ids, new Date(now - 72 * HOUR)]),
    pool.query('SELECT * FROM warden_profiles WHERE telegram_id = ANY($1::bigint[])', [ids]),
    pool.query(
      `SELECT telegram_id, COUNT(*) FILTER (WHERE is_anomalous) AS anomalies, COUNT(*) FILTER (WHERE event = 'token_rejected') AS rejected
         FROM access_log WHERE telegram_id = ANY($1::bigint[]) AND created_at > $2 GROUP BY telegram_id`, [ids, new Date(now - 24 * HOUR)]),
    pool.query('SELECT telegram_id, COUNT(*)::int AS c FROM bulk_action_log WHERE telegram_id = ANY($1::bigint[]) AND created_at > $2 GROUP BY telegram_id', [ids, new Date(now - 6 * HOUR)]).catch(() => ({ rows: [] })),
    pool.query("SELECT telegram_id, COUNT(*)::int AS c FROM warden_cases WHERE telegram_id = ANY($1::bigint[]) AND status <> 'open' GROUP BY telegram_id", [ids]),
    pool.query('SELECT DISTINCT ON (telegram_id, type) telegram_id, type, strength, created_at FROM warden_evidence WHERE telegram_id = ANY($1::bigint[]) ORDER BY telegram_id, type, created_at DESC', [ids]),
  ]);
  return {
    users, ids,
    buckets: groupBy(recent.rows, 'telegram_id'),
    profiles: new Map(profiles.rows.map((r) => [Number(r.telegram_id), r])),
    identity: new Map(identity.rows.map((r) => [Number(r.telegram_id), { anomalies24h: Number(r.anomalies), tokenRejected24h: Number(r.rejected) }])),
    bulk: new Map(bulk.rows.map((r) => [Number(r.telegram_id), r.c])),
    priors: new Map(priors.rows.map((r) => [Number(r.telegram_id), r.c])),
    lastEvidence: new Map(lastEv.rows.map((r) => [`${r.telegram_id}|${r.type}`, r])),
  };
}

async function refreshBaselines(inp, now) {
  const baselines = new Map(); const refreshed = new Set();
  const stale = [];
  for (const u of inp.users) {
    const pr = inp.profiles.get(Number(u.telegram_id));
    if (pr && pr.baseline && pr.baseline_updated_at && now - ms(pr.baseline_updated_at) < BASELINE_REFRESH_MS) baselines.set(Number(u.telegram_id), pr.baseline);
    else stale.push(Number(u.telegram_id));
  }
  if (stale.length) {
    const { rows } = await getPool().query('SELECT * FROM warden_activity_buckets WHERE telegram_id = ANY($1::bigint[]) AND bucket_start > $2', [stale, new Date(now - 30 * DAY)]);
    const by = groupBy(rows, 'telegram_id');
    for (const id of stale) {
      const u = inp.users.find((x) => Number(x.telegram_id) === id);
      baselines.set(id, computeBaseline(by.get(id) || [], now, { accountCreatedAt: u.created_at }));
      refreshed.add(id);
    }
  }
  return { baselines, refreshed };
}

async function persistProfile(id, pr, baseline, refreshed, decision, prog, now) {
  const stageChanged = !pr || pr.stage !== prog.stage;
  const material = !pr || stageChanged || refreshed || Math.abs(Number(pr.risk) - decision.risk) >= 3
    || (pr.pending_stage || null) !== (prog.pendingStage || null) || now - ms(pr.last_eval_at || 0) > 30 * 60000;
  if (!material) return false;
  await getPool().query(
    `INSERT INTO warden_profiles (telegram_id, baseline, baseline_updated_at, stage, stage_since, pending_stage, pending_since, risk, confidence, last_eval_at, last_decision)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, now(), $10::jsonb)
     ON CONFLICT (telegram_id) DO UPDATE SET
       baseline = EXCLUDED.baseline, baseline_updated_at = EXCLUDED.baseline_updated_at,
       stage = EXCLUDED.stage, stage_since = EXCLUDED.stage_since, pending_stage = EXCLUDED.pending_stage, pending_since = EXCLUDED.pending_since,
       risk = EXCLUDED.risk, confidence = EXCLUDED.confidence, last_eval_at = now(), last_decision = EXCLUDED.last_decision`,
    [id, JSON.stringify(baseline), new Date(refreshed || !pr || !pr.baseline_updated_at ? now : ms(pr.baseline_updated_at)),
      prog.stage, new Date(prog.stageSince), prog.pendingStage, prog.pendingSince ? new Date(prog.pendingSince) : null,
      decision.risk, decision.confidence,
      JSON.stringify({ stage: decision.stage, uncapped: decision.uncapped, reasons: decision.reasons, blockers: decision.blockers, doNothing: decision.doNothing, doNothingReason: decision.doNothingReason })]
  );
  return true;
}

async function persistEvidence(id, items, caseId, inp, now) {
  for (const it of items) {
    const last = inp.lastEvidence.get(`${id}|${it.type}`);
    if (last && now - ms(last.created_at) < EVIDENCE_REPEAT_MS && Math.abs(Number(last.strength) - it.strength) < 0.15) continue;
    await getPool().query(
      `INSERT INTO warden_evidence (telegram_id, case_id, type, class, strength, reliability, observed, baseline, window_start, window_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [id, caseId, it.type, it.class, it.strength, it.reliability, JSON.stringify({ ...it.observed, fact: it.fact }), JSON.stringify(it.baseline),
        it.observed && it.observed.hour ? new Date(it.observed.hour) : null, it.observed && it.observed.hour ? new Date(ms(it.observed.hour) + HOUR) : null]
    );
  }
}

async function logStage(id, from, to, decision) {
  await getPool().query(
    'INSERT INTO warden_action_log (target_id, action_type, reason, dry_run) VALUES ($1, $2, $3, false)',
    [id, `stage:${to}`, `${from} → ${to}. ${(decision.reasons[0] || decision.doNothingReason || 'No evidence above the noise floor.').slice(0, 300)}`]
  );
}

async function alertOwner(bot, caseRow, id, decision) {
  const to = ownerId();
  if (!bot || !to) return false;
  const { rows } = await getPool().query('SELECT telegram_username, telegram_first_name FROM users WHERE telegram_id = $1', [id]);
  const text = warnings.ownerAlert({ caseRow, user: rows[0], summary: { reasons: decision.reasons, confidenceLabel: decision.confidenceLabel } });
  try {
    await bot.telegram.sendMessage(to, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔎 Open case', callback_data: `warden:case:${caseRow.id}` }]] } });
    await getPool().query('UPDATE warden_cases SET alerted_at = now() WHERE id = $1', [caseRow.id]);
    return true;
  } catch (_) { return false; }
}

/** Users who went quiet: step their stage back down so stale flags don't linger. */
async function settleIdle(inp, now) {
  const pool = getPool();
  const { rows } = await pool.query(
    // Only accounts that are genuinely idle (no activity bucket in the evidence window) settle back to
    // normal. One that is merely beyond this run's evaluation cap is still active, not "quiet".
    `SELECT * FROM warden_profiles p WHERE stage <> 'normal' AND last_eval_at < $1 AND NOT (telegram_id = ANY($2::bigint[]))
       AND NOT EXISTS (SELECT 1 FROM warden_activity_buckets b WHERE b.telegram_id = p.telegram_id AND b.bucket_start > $3)`,
    [new Date(now - 6 * HOUR), inp.ids, new Date(now - 72 * HOUR)]
  );
  let settled = 0;
  for (const pr of rows) {
    const prog = progress({ stage: pr.stage, stageSince: ms(pr.stage_since) }, 'normal', now);
    if (prog.changed) {
      await pool.query('UPDATE warden_profiles SET stage = $2, stage_since = $3, pending_stage = NULL, pending_since = NULL, last_eval_at = now() WHERE telegram_id = $1', [pr.telegram_id, prog.stage, new Date(prog.stageSince)]);
      settled += 1;
    }
    const open = await cases.getOpen(pr.telegram_id);
    if (open && stageIndex(prog.stage) < stageIndex('flag') && now - ms(open.updated_at) >= 24 * HOUR) {
      await pool.query("UPDATE warden_cases SET status = 'resolved', closed_at = now(), close_reason = 'returned_to_normal' WHERE id = $1", [open.id]);
      await cases.addEvent(open.id, pr.telegram_id, 'resolved', { reason: 'returned_to_normal' });
    }
  }
  return settled;
}

/**
 * Per-class outcome history of CLOSED cases: how often cases that contained a
 * class of evidence were dismissed as false positives (see feedback.js).
 * One grouped query over closed cases; fails soft (no adjustment) on error.
 */
async function loadFeedback() {
  try {
    const { rows } = await getPool().query(
      `SELECT e.class,
              COUNT(DISTINCT c.id)::int AS closed,
              COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'dismissed')::int AS dismissed
         FROM warden_cases c JOIN warden_evidence e ON e.case_id = c.id
        WHERE c.status <> 'open' AND c.closed_at > now() - interval '180 days'
        GROUP BY e.class`
    );
    return reliabilityMultipliers(rows);
  } catch (_) { return {}; }
}

/** Read-only snapshot of the GitHub traffic layer. Warden OBSERVES this; it never changes it. */
function readGithubSnapshot() {
  try { return require('../githubTraffic').getTraffic().manager.getSnapshot(); } catch (_) { return null; }
}

async function runEvaluation({ bot = null, now = Date.now(), maxUsers = Number(process.env.WARDEN_MAX_USERS) || 500 } = {}) {
  const warden = require('../warden');
  const cfg = await warden.getConfig();
  if (!cfg || !cfg.enabled) return { skipped: true, reason: 'disabled' };

  const inp = await loadInputs(now, maxUsers);
  const settled = await settleIdle(inp, now);
  if (!inp.users.length) return { evaluated: 0, settled };

  const { baselines, refreshed } = await refreshBaselines(inp, now);

  // v1.2.1-multi inputs: a cohort prior learned from mature users, the owner's past dismissals
  // (reliability feedback), and an observe-only view of GitHub traffic.
  const prior = buildCohortPrior([...baselines.values()]);
  const reliabilityAdj = await loadFeedback();
  const ghSnap = readGithubSnapshot();
  const ghFleet = githubFleetState(ghSnap);

  // pass 1 — is this a fleet-wide event (ours), rather than one user's behaviour?
  const recentOf = (id) => inp.buckets.get(id) || [];
  const last3h = (rows) => rows.filter((b) => ms(b.bucket_start) >= now - 3 * HOUR);
  const perUser = inp.users.map((u) => {
    const id = Number(u.telegram_id); const rb = recentOf(id);
    return { id, active: sum(last3h(rb), 'actions') >= 10, recentRateAbnormal: recentRateAbnormal(rb, baselines.get(id), now, 3, prior) };
  });
  const own = new Map(inp.users.map((u) => {
    const rows = last3h(recentOf(Number(u.telegram_id)));
    return [Number(u.telegram_id), { actions: sum(rows, 'actions'), errors: sum(rows, 'errors') }];
  }));
  const grand = { actions: 0, errors: 0 };
  for (const o of own.values()) { grand.actions += o.actions; grand.errors += o.errors; }
  // Each user is judged against the fleet WITHOUT themselves: their own spike or
  // failures must never be what makes the "fleet" look abnormal and excuse them.
  const fleetExcluding = (id) => {
    const o = own.get(id) || { actions: 0, errors: 0 };
    return fleetState(perUser.filter((x) => x.id !== id), { actions: grand.actions - o.actions, errors: grand.errors - o.errors }, ghFleet);
  };
  const fleet = fleetState(perUser, grand, ghFleet); // overall picture, for the log line only

  // pass 2 — evaluate each user
  const out = { evaluated: 0, settled, opened: 0, alerts: 0, fleet, byStage: Object.fromEntries(STAGES.map((s) => [s, 0])) };
  for (const u of inp.users) {
    const id = Number(u.telegram_id);
    try {
      const pr = inp.profiles.get(id); const baseline = baselines.get(id); const rb = recentOf(id);
      const ageDays = (now - ms(u.created_at)) / DAY;
      const evidence = extractEvidence({ buckets: rb, baseline, now, identity: inp.identity.get(id) || {}, prior, reliabilityAdj, extraItems: [githubEvidenceFor(id, ghSnap)] });
      const earliestRecent = rb.length ? Math.min(...rb.map((b) => ms(b.bucket_start))) : now;
      const idleDays = baseline && baseline.last_older_t ? Math.max(0, (earliestRecent - baseline.last_older_t) / DAY) : 0;
      const fleetForUser = fleetExcluding(id);
      const benign = benignChecks({ ageDays, bulkOps6h: inp.bulk.get(id) || 0, idleDaysBefore: idleDays, fleet: fleetForUser });
      const decision = evaluate({ isTrusted: !!u.is_trusted, isAdmin: !!u.is_admin, ageDays, baseline, evidence, benign, fleet: fleetForUser, history: { priorCases: inp.priors.get(id) || 0 } });
      const prevStage = pr ? pr.stage : 'normal';
      const prog = progress({ stage: prevStage, stageSince: pr ? ms(pr.stage_since) : now, pendingStage: pr && pr.pending_stage, pendingSince: pr && pr.pending_since ? ms(pr.pending_since) : null }, decision.stage, now);

      await persistProfile(id, pr, baseline, refreshed.has(id), decision, prog, now);
      if (prog.changed) await logStage(id, prevStage, prog.stage, decision);

      let caseRow = null;
      if (stageIndex(prog.stage) >= stageIndex('flag') || (await cases.getOpen(id))) {
        const sync = await cases.syncCase({ telegramId: id, stage: prog.stage, prevStage, decision: { ...decision, stage: prog.stage }, dismissedUntil: pr && pr.dismissed_until, now });
        caseRow = sync.case;
        if (sync.opened) out.opened += 1;
        const snoozed = pr && pr.snooze_until && ms(pr.snooze_until) > now;
        if (caseRow && prog.stage === 'review_candidate' && sync.stageChanged && cfg.alerts_review && !snoozed
          && (!caseRow.alerted_at || now - ms(caseRow.alerted_at) > ALERT_COOLDOWN_MS)) {
          if (await alertOwner(bot, caseRow, id, decision)) out.alerts += 1;
        }
      }
      if (stageIndex(prog.stage) >= stageIndex('observe')) await persistEvidence(id, evidence.items, caseRow && caseRow.id, inp, now);
      out.byStage[prog.stage] += 1; out.evaluated += 1;
    } catch (err) {
      require('../logger').warn('Warden evaluation failed for one user', { telegramId: id, message: err.message });
    }
  }
  return out;
}

module.exports = { runEvaluation, loadInputs };
