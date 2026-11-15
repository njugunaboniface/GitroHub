const { pool } = require('../db/postgres');

/**
 * Everything here is cross-user by design — the ONE place in the codebase
 * that deliberately queries across every telegram_id at once, gated
 * entirely behind the Admin Dashboard (handlers/admin.js), which itself is
 * only ever reachable by config.ADMIN_ID. Per the explicit privacy line
 * drawn during design: counts and metadata only — nothing here ever
 * touches repo contents, file paths, or commit messages.
 */

/**
 * v1.2.1-multi: opening the dashboard used to fire NINE simultaneous COUNT queries (each needing its own
 * pooled connection — the pool is small), one of them an unbounded all-time scan of activity_log, every
 * time ANY admin opened the screen. Now: one `users` aggregate (single pass, FILTER clauses), one query
 * for the two activity counters (served by partial indexes), run on one connection, and the result is
 * cached for a short TTL with single-flight — N admins tapping Refresh share one computation.
 * Counts only; same fields and meaning as before.
 */
const OVERVIEW_TTL_MS = Number(process.env.ADMIN_STATS_TTL_MS) || 30000;
let overviewCache = null; // { at, value }
let overviewInflight = null;

async function computeFleetOverview() {
  const { rows: [u] } = await pool.query(
    `SELECT COUNT(*)::int AS users,
            COUNT(*) FILTER (WHERE last_active_at > now() - interval '1 day')::int AS active_today,
            COUNT(*) FILTER (WHERE github_token_enc IS NOT NULL)::int AS connected,
            COUNT(*) FILTER (WHERE is_blocked = TRUE)::int AS blocked,
            COUNT(*) FILTER (WHERE suspended_until > now())::int AS suspended,
            COUNT(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS new_today,
            COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_week
       FROM users`
  );
  const { rows: [a] } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM activity_log WHERE is_commit = TRUE)::int AS commits,
            (SELECT COUNT(*) FROM activity_log WHERE is_error = TRUE AND created_at > now() - interval '1 day')::int AS errors_today`
  );
  const activeCount = u.active_today;
  // v1.2.5-multi: how many GitHub accounts are connected in total, how many people use more than one, and how
  // many extra accounts the daily health check has flagged as revoked (and will remove).
  const { rows: [m] } = await pool.query(
    `SELECT COUNT(*)::int AS accounts,
            COUNT(DISTINCT telegram_id) FILTER (WHERE telegram_id IN (SELECT telegram_id FROM github_accounts GROUP BY telegram_id HAVING COUNT(*) > 1))::int AS multi_users,
            COUNT(*) FILTER (WHERE health_status = 'revoked')::int AS revoked_accounts
       FROM github_accounts`
  ).catch(() => ({ rows: [{ accounts: 0, multi_users: 0, revoked_accounts: 0 }] }));
  // Average commits per user who was active today — "how much is each
  // currently-engaged person actually doing", not diluted by the whole
  // fleet including accounts that signed up once and vanished.
  const avgCommitsResult = activeCount > 0
    ? await pool.query(
        `SELECT ROUND(COUNT(a.id)::numeric / $1, 1) AS avg
         FROM activity_log a JOIN users u ON u.telegram_id = a.telegram_id
         WHERE a.is_commit = TRUE AND u.last_active_at > now() - interval '1 day'`,
        [activeCount]
      )
    : { rows: [{ avg: 0 }] };
  return {
    totalUsers: u.users,
    activeToday: activeCount,
    connected: u.connected,
    blocked: u.blocked,
    suspended: u.suspended,
    totalCommits: a.commits,
    errorsToday: a.errors_today,
    newToday: u.new_today,
    newThisWeek: u.new_week,
    avgCommitsPerActiveUser: Number(avgCommitsResult.rows[0].avg) || 0,
    githubAccounts: m.accounts,
    multiAccountUsers: m.multi_users,
    revokedAccounts: m.revoked_accounts,
  };
}

async function fleetOverview() {
  if (overviewCache && Date.now() - overviewCache.at < OVERVIEW_TTL_MS) return overviewCache.value;
  if (!overviewInflight) {
    overviewInflight = computeFleetOverview()
      .then((value) => { overviewCache = { at: Date.now(), value }; return value; })
      .finally(() => { overviewInflight = null; });
  }
  return overviewInflight;
}

/** Daily signup counts for the last N days — oldest first, so a reader
 * scans it left-to-right as a timeline rather than newest-first like
 * everything else in the dashboard (this is the one screen where
 * chronological order reads more naturally than recency order). */
async function growthByDay(days = 14) {
  const { rows } = await pool.query(
    `SELECT to_char(d.day, 'Mon DD') AS label, COALESCE(c.cnt, 0)::int AS count
     FROM generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, '1 day') AS d(day)
     LEFT JOIN (
       SELECT created_at::date AS day, COUNT(*) AS cnt FROM users GROUP BY created_at::date
     ) c ON c.day = d.day
     ORDER BY d.day ASC`,
    [days]
  );
  return rows;
}

async function newestMembers(limit = 5) {
  const { rows } = await pool.query(
    'SELECT telegram_id, telegram_username, telegram_first_name, created_at FROM users ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}

/** Powers the Admin Dashboard's 🔍 Search — matches on Telegram ID
 * (exact), @username, or ANY connected GitHub login (both partial, case-insensitive — v1.2.5-multi: not just the active account).
 * Same row shape as listUsers() so the UI can render both with the exact
 * same function. */
async function searchUsers(query, limit = 8) {
  const asId = /^\d+$/.test(query) ? Number(query) : null;
  const { rows } = await pool.query(
    `SELECT * FROM users
     WHERE telegram_id = $2
        OR telegram_username ILIKE '%' || $1 || '%'
        OR github_username ILIKE '%' || $1 || '%'
        OR telegram_id IN (SELECT telegram_id FROM github_accounts WHERE github_login ILIKE '%' || $1 || '%')
     ORDER BY COALESCE(last_active_at, created_at) DESC LIMIT $3`,
    [query, asId, limit]
  );
  return rows;
}

/** Fleet-wide admin_action_log reader — see lib/adminActions.js for what
 * gets written here. `targetTelegramId` narrows to one user's history
 * (the User Detail card's 📜 History button) instead of the fleet-wide
 * 📜 Audit Log screen. `actionType`/`adminId` narrow the fleet-wide screen
 * further (🔍 Filter) — mutually compatible with each other but not
 * normally combined with `targetTelegramId` (the per-user History view
 * doesn't expose the filter UI, so it never sends them). */
async function auditLog({ limit = 8, offset = 0, targetTelegramId = null, actionType = null, adminId = null } = {}) {
  const conditions = [];
  const params = [];
  if (targetTelegramId) { params.push(targetTelegramId); conditions.push(`target_telegram_id = $${params.length}`); }
  if (actionType) { params.push(actionType); conditions.push(`action = $${params.length}`); }
  if (adminId) { params.push(adminId); conditions.push(`admin_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM admin_action_log ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM admin_action_log ${where}`,
    params
  );
  return { rows, total: countRows[0].total };
}

/** Distinct action strings actually seen in the log — powers 🔍 Filter's
 * action-type row without hardcoding a list that would drift from
 * whatever adminActions.auditLog() calls actually get written (ban,
 * suspend, bulk_mute, undo_ban, delete_repo, etc.) */
async function distinctAuditActions() {
  const { rows } = await pool.query('SELECT DISTINCT action FROM admin_action_log ORDER BY action ASC');
  return rows.map((r) => r.action);
}

/** Distinct admins who've actually taken a logged action, with display
 * names joined in — powers 🔍 Filter's "by admin" row. An admin who's
 * never touched the Dashboard's write actions simply won't appear, which
 * is correct: there's nothing of theirs to filter down to. */
async function distinctAuditAdmins() {
  const { rows } = await pool.query(
    `SELECT DISTINCT a.admin_id, u.telegram_username, u.telegram_first_name
     FROM admin_action_log a LEFT JOIN users u ON u.telegram_id = a.admin_id
     ORDER BY a.admin_id ASC`
  );
  return rows;
}

/** Top N by total_actions ("clicks") — the raw interaction-volume leaderboard. */
async function mostActiveByClicks(limit = 5) {
  const { rows } = await pool.query(
    `SELECT telegram_id, telegram_username, telegram_first_name, total_actions, last_active_at
     FROM users WHERE total_actions > 0 ORDER BY total_actions DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Top N by actual commit count — a different signal than raw clicks
 * (someone can tap around a lot without ever committing anything). */
async function mostActiveByCommits(limit = 5) {
  const { rows } = await pool.query(
    `SELECT u.telegram_id, u.telegram_username, u.telegram_first_name, COUNT(a.id)::int AS commit_count
     FROM users u JOIN activity_log a ON a.telegram_id = u.telegram_id AND a.is_commit = TRUE
     GROUP BY u.telegram_id ORDER BY commit_count DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Connected accounts that have gone quiet — the "going stale" leaderboard,
 * ordered oldest-last-active first (the ones most worth a nudge or a
 * bulk-purge candidate list, though bulk purge itself only ever targets
 * never-connected accounts — see adminActions.bulkPurgeNeverConnected). */
async function staleAccounts(days = 30, limit = 5) {
  const { rows } = await pool.query(
    `SELECT telegram_id, telegram_username, telegram_first_name, github_username, last_active_at
     FROM users
     WHERE github_token_enc IS NOT NULL
       AND (last_active_at IS NULL OR last_active_at < now() - ($1 || ' days')::interval)
     ORDER BY last_active_at ASC NULLS FIRST LIMIT $2`,
    [days, limit]
  );
  return rows;
}

/** Cross-user error feed — same shape as the existing per-user "Errors
 * Only" filter in Activity, just not scoped to one telegram_id. */
async function globalErrorFeed({ limit = 8, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.telegram_id, u.telegram_username, a.icon, a.summary, a.detail, a.created_at
     FROM activity_log a LEFT JOIN users u ON u.telegram_id = a.telegram_id
     WHERE a.is_error = TRUE ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS total FROM activity_log WHERE is_error = TRUE');
  return { rows, total: countRows[0].total };
}

/** One user's stats for the Admin Dashboard's per-user detail card —
 * counts and metadata only, never repo contents. Also stamps `user` with
 * `has_anomaly` + `recent_error_count` (the same two fields listUsers()
 * attaches to every row it returns) so the caller can run
 * users.isSuspicious()/suspiciousReasons() on it — see lib/users.js for
 * what those mean. */
async function userDetail(telegramId) {
  const activity = require('./activity');
  const [user, commitCount, errorCount, recentResult, anomalyResult, recentErrorResult] = await Promise.all([
    require('./users').getUser(telegramId),
    activity.commitCount(telegramId),
    pool.query('SELECT COUNT(*)::int AS c FROM activity_log WHERE telegram_id = $1 AND is_error = TRUE', [telegramId]),
    activity.recent(telegramId, { limit: 1 }),
    pool.query('SELECT EXISTS(SELECT 1 FROM access_log WHERE telegram_id = $1 AND is_anomalous = TRUE) AS e', [telegramId]),
    pool.query(
      `SELECT COUNT(*)::int AS c FROM activity_log
       WHERE telegram_id = $1 AND is_error = TRUE AND created_at > now() - interval '24 hours'`,
      [telegramId]
    ),
  ]);
  if (user) {
    user.has_anomaly = anomalyResult.rows[0].e;
    user.recent_error_count = recentErrorResult.rows[0].c;
  }
  return {
    user,
    commitCount,
    errorCount: errorCount.rows[0].c,
    lastActivity: recentResult.rows[0] || null,
  };
}

/** Fleet-wide version of the anomaly detection that already existed
 * per-user (lib/accessLog.js's detectAnomaly — reconnect-after-disconnect,
 * GitHub scope changes). This is the real signal behind abuse detection,
 * as opposed to the 🚩 Suspicious filter's cruder rate-cap/no-connection
 * heuristic — an anomalous access event means something about a specific
 * person's GitHub connection behavior looked unusual, not just "used the
 * bot a lot." */
async function anomalyFeed({ limit = 8, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.telegram_id, u.telegram_username, a.event, a.anomaly_reason, a.created_at
     FROM access_log a LEFT JOIN users u ON u.telegram_id = a.telegram_id
     WHERE a.is_anomalous = TRUE ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS total FROM access_log WHERE is_anomalous = TRUE');
  return { rows, total: countRows[0].total };
}

/** Fleet-wide view of scheduled_repos + scheduled_uploads — for support
 * ("why didn't my scheduled job run?") without needing to ask the person
 * for details first. Upcoming (pending) jobs plus recent failures from
 * the last 7 days, merged and sorted by when they were/are due. */
async function scheduledJobsOverview() {
  const { rows: repos } = await pool.query(
    `SELECT telegram_id, name AS label, status, scheduled_for, error_message, 'repo' AS kind
     FROM scheduled_repos WHERE status = 'pending' OR (status = 'failed' AND created_at > now() - interval '7 days')`
  );
  const { rows: uploads } = await pool.query(
    `SELECT telegram_id, repo_name AS label, status, scheduled_for, error_message, 'upload' AS kind
     FROM scheduled_uploads WHERE status = 'pending' OR (status = 'failed' AND created_at > now() - interval '7 days')`
  );
  return [...repos, ...uploads].sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for));
}

module.exports = {
  _resetOverviewCache: () => { overviewCache = null; overviewInflight = null; },
  fleetOverview,
  growthByDay,
  mostActiveByClicks,
  mostActiveByCommits,
  newestMembers,
  staleAccounts,
  globalErrorFeed,
  userDetail,
  searchUsers,
  auditLog,
  distinctAuditActions,
  distinctAuditAdmins,
  anomalyFeed,
  scheduledJobsOverview,
};
