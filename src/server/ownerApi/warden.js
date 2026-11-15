/**
 * Owner panel — Warden (v2.3.0-multi): cases, Warden Watch (flagged sensitive actions), held-action approvals,
 * the decision log, settings, exports and emergency lockdown. Same libraries the bot's Warden screens use.
 * Warden only OBSERVES and REPORTS — every decision here is the owner's.
 */
const { pool } = require('../../db/postgres');
const { ok, fail, file, int, idOf, text, truthy, namesFor, label } = require('./util');

const STAGE_FILTERS = new Set(['flag', 'enhanced_monitoring', 'review_candidate']);

function caseRow(c, names) {
  return {
    id: Number(c.id), userId: Number(c.telegram_id), name: c.telegram_first_name || label(names, c.telegram_id), username: c.telegram_username || null,
    stage: c.stage, peak: c.peak_stage, risk: c.risk == null ? null : Number(c.risk), confidence: c.confidence == null ? null : Number(c.confidence),
    summary: c.summary || null, openedAt: c.opened_at, updatedAt: c.updated_at, snoozeUntil: c.snooze_until || null, status: c.status,
  };
}

async function handle(method, parts, ctx) {
  if (parts[0] !== 'warden') return undefined;
  const { owner, bot, body, query, need } = ctx;
  const cases = require('../../lib/wardenBrain/cases');
  const warden = require('../../lib/warden');
  const sens = require('../../lib/sensitiveActions');
  const lockdown = require('../../lib/lockdown');
  const engine = require('../../lib/wardenBrain/engine');
  const sub = parts[1];

  if (method === 'GET') {
    if (!sub) {
      const [config, fleet, recent, counts, locked] = await Promise.all([
        warden.getConfig().catch(() => null), cases.stageCounts().catch(() => ({ stages: {}, openCases: 0 })),
        warden.getRecentSummary().catch(() => ({})), sens.counts().catch(() => ({})), lockdown.getLockedAdmins().catch(() => []),
      ]);
      return ok({
        config: config && { enabled: !!config.enabled, alertsReview: !!config.alerts_review },
        stages: fleet.stages, openCases: fleet.openCases, recent24h: recent,
        flaggedOpen: Number(counts.flagged_open || 0), approvalsPending: Number(counts.approvals_pending || 0), actions24h: Number(counts.actions_24h || 0),
        pauses: Number(counts.pauses || 0), deadAccounts: Number(counts.dead_accounts || 0),
        lockdown: { active: !!lockdown.isFullLockdownActive(), locked: locked.length },
        labels: engine.STAGE_LABEL, order: engine.STAGES, datasets: Object.keys(warden.DATASETS || {}),
      });
    }
    if (sub === 'cases' && parts.length === 2) {
      const limit = int(query.limit, 10, 1, 30); const offset = int(query.offset, 0, 0, 100000);
      const minStage = STAGE_FILTERS.has(query.stage) ? query.stage : 'flag';
      const r = await cases.listOpen({ minStage, page: Math.floor(offset / limit) + 1, perPage: limit });
      const names = await namesFor(pool, r.rows.map((x) => x.telegram_id));
      return ok({ cases: r.rows.map((c) => caseRow(c, names)), total: r.total, limit, offset, stage: minStage });
    }
    if (sub === 'cases' && parts.length === 3) {
      const id = idOf(parts[2]);
      if (!id) return fail(400, 'Bad case id');
      const c = await cases.getCase(id);
      if (!c) return fail(404, 'No such case');
      const [events, evidence, stats, profile, user] = await Promise.all([
        cases.getEvents(id, 25),
        pool.query('SELECT id, type, class, strength, reliability, observed, baseline, window_start, window_end, created_at FROM warden_evidence WHERE case_id = $1 ORDER BY created_at DESC LIMIT 25', [id]).then((r) => r.rows).catch(() => []),
        cases.stats(c.telegram_id).catch(() => ({ priorCases: 0, warnings: 0 })), cases.profileOf(c.telegram_id).catch(() => ({})),
        require('../../lib/users').getUser(c.telegram_id).catch(() => null),
      ]);
      const names = await namesFor(pool, [c.telegram_id, ...events.map((e) => e.actor)]);
      const row = caseRow({ ...c, snooze_until: profile.snooze_until, telegram_username: user && user.telegram_username, telegram_first_name: user && user.telegram_first_name }, names);
      return ok({
        case: row, closedAt: c.closed_at, closeReason: c.close_reason, prior: stats, snoozeUntil: profile.snooze_until || null, dismissedUntil: profile.dismissed_until || null,
        events: events.map((e) => ({ id: Number(e.id), kind: e.kind, detail: e.detail || null, actor: e.actor == null ? null : label(names, e.actor), at: e.created_at })),
        evidence: evidence.map((e) => ({ id: Number(e.id), type: e.type, class: e.class, strength: e.strength == null ? null : Number(e.strength), reliability: e.reliability == null ? null : Number(e.reliability), observed: e.observed || null, baseline: e.baseline || null, at: e.created_at })),
        labels: engine.STAGE_LABEL,
      });
    }
    if (sub === 'watch') {
      const limit = int(query.limit, 10, 1, 30); const offset = int(query.offset, 0, 0, 100000);
      const [flagged, trail] = await Promise.all([sens.listFlagged({ limit, offset }), sens.auditTrail({ onlyChanges: true, limit: 8, offset: 0 })]);
      return ok({
        flagged: flagged.items.map((s) => ({ id: Number(s.id), userId: Number(s.telegram_id), name: s.telegram_first_name || null, username: s.telegram_username || null, account: s.account_login || null, action: s.action, label: sens.LABELS[s.action] || s.action, repo: s.repo_name || null, score: s.score, at: s.created_at })),
        hasNext: flagged.hasNext,
        changes: trail.items.map((a) => ({ userId: Number(a.telegram_id), name: a.telegram_first_name || null, username: a.telegram_username || null, account: a.account_login || null, area: a.area, action: a.action, repo: a.repo_name || null, at: a.created_at })),
      });
    }
    if (sub === 'approvals') {
      const { rows } = await pool.query(
        `SELECT a.id, a.telegram_id, a.action, a.repo_name, a.created_at, u.telegram_username, u.telegram_first_name
           FROM sensitive_approvals a LEFT JOIN users u ON u.telegram_id = a.telegram_id WHERE a.status = 'pending' ORDER BY a.created_at DESC LIMIT 30`);
      return ok({ approvals: rows.map((a) => ({ id: Number(a.id), userId: Number(a.telegram_id), name: a.telegram_first_name || null, username: a.telegram_username || null, action: a.action, label: sens.LABELS[a.action] || a.action, repo: a.repo_name || null, at: a.created_at })) });
    }
    if (sub === 'log') {
      const limit = int(query.limit, 15, 1, 50); const offset = int(query.offset, 0, 0, 100000);
      const r = await warden.getActionLog(Math.floor(offset / limit) + 1, limit);
      return ok({ rows: r.rows.map((l) => ({ id: Number(l.id), userId: Number(l.target_id), name: l.telegram_first_name || null, username: l.telegram_username || null, action: l.action_type, reason: l.reason, dryRun: !!l.dry_run, at: l.created_at })), total: r.total, limit, offset });
    }
    if (sub === 'export' && parts[2]) {
      const blocked = need('export'); if (blocked) return blocked;
      if (!warden.DATASETS[parts[2]]) return fail(400, 'Unknown dataset');
      const out = await warden.exportDataset(parts[2], { days: int(query.days, 90, 1, 365) });
      await ctx.audit(null, 'warden_export', `${parts[2]} (${out.count} records)`);
      return file(out.body, 'application/x-ndjson; charset=utf-8', out.filename);
    }
    return fail(404, 'Not found');
  }

  if (method !== 'POST') return fail(405, 'Method not allowed');

  if (sub === 'cases' && parts.length === 4 && ['dismiss', 'snooze'].includes(parts[3])) {
    const id = idOf(parts[2]); if (!id) return fail(400, 'Bad case id');
    const days = int(body.days, 7, 1, 90);
    const r = parts[3] === 'dismiss' ? await cases.dismiss(id, owner, days) : await cases.snooze(id, owner, days);
    if (!r) return fail(409, 'That case is no longer open.');
    await ctx.audit(Number(r.telegram_id), `warden_${parts[3]}`, `case #${id}, ${days} days`);
    return ok();
  }
  if (sub === 'watch' && parts[3] === 'review') {
    const id = idOf(parts[2]); if (!id) return fail(400, 'Bad id');
    await sens.markReviewed(owner, id);
    return ok();
  }
  if (sub === 'approvals' && parts[3] === 'decide') {
    const id = idOf(parts[2]); if (!id) return fail(400, 'Bad id');
    const allow = truthy(body.allow);
    if (allow) { const blocked = need('approval'); if (blocked) return blocked; }
    if (!bot) return fail(503, 'The bot connection isn\u2019t available.');
    const r = await sens.decide({ from: { id: owner }, telegram: bot.telegram }, id, allow);
    if (!r.ok) return fail(409, 'That request was already decided.');
    await ctx.audit(r.userId, allow ? 'sensitive_approved' : 'sensitive_denied', `request #${id}`);
    return ok();
  }
  if (sub === 'config') {
    const patch = {};
    if ('enabled' in body) patch.enabled = truthy(body.enabled);
    if ('alertsReview' in body) patch.alerts_review = truthy(body.alertsReview);
    if (!Object.keys(patch).length) return fail(400, 'Nothing to change.');
    await warden.updateConfig(owner, patch);
    return ok();
  }
  if (sub === 'lockdown') {
    const blocked = need('lockdown'); if (blocked) return blocked;
    const on = truthy(body.on);
    const ids = on ? await lockdown.lockAll(owner) : await lockdown.unlockAll(owner);
    await ctx.audit(null, on ? 'lockdown_on' : 'lockdown_off', `${ids.length} admins [web]`);
    return ok({ ok: true, affected: ids.length, active: on });
  }
  return fail(404, 'Not found');
}

module.exports = { handle };
