/** Owner panel — charts, feeds, badges and search (v2.3.0-multi). Read-only. */
const { pool } = require('../../db/postgres');
const { ok, fail, int, text, likeEscape, namesFor, label } = require('./util');

const RANGES = [14, 30, 90];

async function series(days) {
  const base = (sub) => `SELECT to_char(d.day, 'Mon DD') AS label, to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS count
     FROM generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, '1 day') AS d(day)
     LEFT JOIN (${sub}) c ON c.day = d.day ORDER BY d.day ASC`;
  const run = (sub) => pool.query(base(sub), [days]).then((r) => r.rows).catch(() => []);
  const since = "CURRENT_DATE - ($1::int - 1)";
  const [signups, active, actions, errors, commits, caps] = await Promise.all([
    run(`SELECT created_at::date AS day, COUNT(*) AS n FROM users WHERE created_at >= ${since} GROUP BY 1`),
    run(`SELECT created_at::date AS day, COUNT(DISTINCT telegram_id) AS n FROM activity_log WHERE created_at >= ${since} GROUP BY 1`),
    run(`SELECT bucket_start::date AS day, SUM(actions) AS n FROM warden_activity_buckets WHERE bucket_start >= ${since} GROUP BY 1`),
    run(`SELECT created_at::date AS day, COUNT(*) AS n FROM activity_log WHERE is_error = TRUE AND created_at >= ${since} GROUP BY 1`),
    run(`SELECT created_at::date AS day, COUNT(*) AS n FROM activity_log WHERE is_commit = TRUE AND created_at >= ${since} GROUP BY 1`),
    run(`SELECT bucket_start::date AS day, SUM(cap_hits) AS n FROM warden_activity_buckets WHERE bucket_start >= ${since} GROUP BY 1`),
  ]);
  return { signups, active, actions, errors, commits, rateLimited: caps };
}

async function handle(method, parts, ctx) {
  const { query } = ctx;
  if (method !== 'GET') return undefined;

  if (parts[0] === 'charts') {
    const days = RANGES.includes(Number(query.days)) ? Number(query.days) : 14;
    return ok({ days, ...(await series(days)) });
  }

  if (parts[0] === 'feed') {
    const stats = require('../../lib/adminStats');
    const limit = int(query.limit, 15, 1, 50); const offset = int(query.offset, 0, 0, 100000);
    if (parts[1] === 'errors') {
      const r = await stats.globalErrorFeed({ limit, offset });
      return ok({ rows: r.rows.map((e) => ({ userId: Number(e.telegram_id), username: e.telegram_username || null, summary: e.summary, detail: e.detail || null, at: e.created_at })), total: r.total, limit, offset });
    }
    if (parts[1] === 'anomalies') {
      const r = await stats.anomalyFeed({ limit, offset });
      return ok({ rows: r.rows.map((e) => ({ userId: Number(e.telegram_id), username: e.telegram_username || null, event: e.event, reason: e.anomaly_reason || null, at: e.created_at })), total: r.total, limit, offset });
    }
    if (parts[1] === 'jobs') {
      const rows = await stats.scheduledJobsOverview();
      return ok({ rows: rows.slice(0, 60).map((j) => ({ userId: Number(j.telegram_id), kind: j.kind, label: j.label, status: j.status, at: j.scheduled_for, error: j.error_message || null })) });
    }
    return fail(404, 'Not found');
  }

  if (parts[0] === 'badges') {
    const q = (sql) => pool.query(sql).then((r) => Number(r.rows[0].n)).catch(() => 0);
    const [reports, errors, scheduled, undo] = await Promise.all([
      require('../../lib/reports').openCount().catch(() => 0),
      q("SELECT COUNT(*)::int AS n FROM activity_log WHERE is_error = TRUE AND created_at > now() - interval '24 hours'"),
      q("SELECT COUNT(*)::int AS n FROM scheduled_broadcasts WHERE status = 'pending'"),
      q('SELECT COUNT(*)::int AS n FROM admin_undo_log WHERE undone_at IS NULL AND expires_at > now()'),
    ]);
    let warden = 0;
    try { const c = await require('../../lib/sensitiveActions').counts(); const s = await require('../../lib/wardenBrain/cases').stageCounts(); warden = Number(s.openCases || 0) + Number(c.flagged_open || 0) + Number(c.approvals_pending || 0); } catch (_) { warden = 0; }
    return ok({ reports: Number(reports) || 0, warden, errors, scheduled, undo });
  }

  if (parts[0] === 'search') {
    const q = text(query.q, 64).replace(/^@/, '');
    if (q.length < 2) return ok({ users: [], reports: [], cases: [] });
    const like = `%${likeEscape(q)}%`;
    const [users, reports, cases] = await Promise.all([
      pool.query("SELECT telegram_id, telegram_username, telegram_first_name, github_username, is_blocked FROM users WHERE telegram_id::text = $1 OR telegram_username ILIKE $2 ESCAPE '\\' OR github_username ILIKE $2 ESCAPE '\\' OR telegram_first_name ILIKE $2 ESCAPE '\\' ORDER BY COALESCE(last_active_at, created_at) DESC LIMIT 6", [q, like]).then((r) => r.rows).catch(() => []),
      pool.query("SELECT r.id, r.message, r.status, r.telegram_id, u.telegram_username FROM user_reports r LEFT JOIN users u ON u.telegram_id = r.telegram_id WHERE r.message ILIKE $1 ESCAPE '\\' OR r.telegram_id::text = $2 ORDER BY r.created_at DESC LIMIT 4", [like, q]).then((r) => r.rows).catch(() => []),
      pool.query("SELECT c.id, c.stage, c.telegram_id, u.telegram_username, u.telegram_first_name FROM warden_cases c LEFT JOIN users u ON u.telegram_id = c.telegram_id WHERE c.status = 'open' AND (c.telegram_id::text = $1 OR u.telegram_username ILIKE $2 ESCAPE '\\' OR u.telegram_first_name ILIKE $2 ESCAPE '\\') ORDER BY c.updated_at DESC LIMIT 4", [q, like]).then((r) => r.rows).catch(() => []),
    ]);
    return ok({
      users: users.map((u) => ({ id: Number(u.telegram_id), name: u.telegram_first_name || null, username: u.telegram_username || null, github: u.github_username || null, blocked: !!u.is_blocked })),
      reports: reports.map((r) => ({ id: Number(r.id), userId: Number(r.telegram_id), username: r.telegram_username || null, message: String(r.message || '').slice(0, 90), status: r.status })),
      cases: cases.map((c) => ({ id: Number(c.id), userId: Number(c.telegram_id), stage: c.stage, name: c.telegram_first_name || (c.telegram_username ? `@${c.telegram_username}` : String(c.telegram_id)) })),
    });
  }
  void namesFor; void label;
  return undefined;
}

module.exports = { handle, series };
