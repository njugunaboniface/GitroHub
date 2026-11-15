const { pool } = require('../db/postgres');
const { encrypt, tryDecrypt } = require('./crypto');
const logger = require('./logger');

async function getUser(telegramId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return rows[0] || null;
}

async function isConnected(telegramId) {
  const user = await getUser(telegramId);
  return !!(user && user.github_token_enc && !user.disconnected_at);
}

async function getDecryptedToken(telegramId) {
  const user = await getUser(telegramId);
  if (!user || !user.github_token_enc) return null;
  // null when the stored token can't be opened (e.g. the encryption key was
  // changed): every caller already treats null as "not connected".
  return tryDecrypt(user.github_token_enc);
}

/** Called by the OAuth /callback route once the token exchange succeeds */
async function saveConnection(telegramId, { accessToken, scope, githubUsername }) {
  const encToken = encrypt(accessToken);
  // v1.2.4-multi: the account joins the person's list first (throws ACCOUNT_LIMIT before anything
  // changes), then becomes the ACTIVE one by being mirrored into the users row below.
  await require('./accounts').upsert(telegramId, { login: githubUsername, token: accessToken, scope });
  await pool.query(
    `INSERT INTO users (telegram_id, github_username, github_token_enc, github_scope, connected_at, disconnected_at)
     VALUES ($1, $2, $3, $4, now(), NULL)
     ON CONFLICT (telegram_id) DO UPDATE
       SET github_username = $2,
           github_token_enc = $3,
           github_scope = $4,
           connected_at = now(),
           disconnected_at = NULL,
           active_owner = NULL`,
    [telegramId, githubUsername, encToken, scope]
  );
  require('./accounts').forgetOwner(telegramId);
}

/**
 * Keep the stored GitHub login in step with GitHub (v1.2.3-multi). The login was
 * only ever written when the person connected, so after a GitHub username change the
 * webhook lookup — which joins on it — stopped matching and live alerts silently
 * died. Called whenever the authenticated user is freshly fetched; a no-op (and no
 * write) when nothing changed. Returns true if the stored value was updated.
 */
async function syncGithubUsername(telegramId, login) {
  if (!login) return false;
  const { rowCount } = await pool.query(
    `UPDATE users SET github_username = $2
     WHERE telegram_id = $1 AND github_token_enc IS NOT NULL AND github_username IS DISTINCT FROM $2`,
    [telegramId, login]
  );
  return rowCount > 0;
}

async function disconnect(telegramId) {
  await pool.query(
    `UPDATE users SET github_token_enc = NULL, disconnected_at = now(), active_owner = NULL WHERE telegram_id = $1`,
    [telegramId]
  );
  require('./accounts').forgetOwner(telegramId);
}

/**
 * Other Telegram accounts currently holding a live connection to the SAME
 * GitHub account — GitHub's OAuth model has no concept of "one device", so
 * nothing stops two different people (or the same person's two Telegram
 * accounts) from each authorizing GitroHub against the same GitHub login;
 * each gets its own independent row/token here. That's not a bug in
 * itself, but it was previously completely invisible — a person had no
 * way to know someone else was also connected as their account. Surfaced
 * read-only in Settings; actually revoking a specific one has to happen
 * from GitHub's own side (Settings → Applications → Authorized OAuth
 * Apps), since that's the only place that can invalidate one specific
 * token without touching the others sharing the same login.
 */
async function getSiblingConnections(telegramId, githubUsername) {
  if (!githubUsername) return [];
  const { rows } = await pool.query(
    `SELECT telegram_id, telegram_first_name, telegram_username, connected_at
     FROM users
     WHERE github_username = $1
       AND telegram_id != $2
       AND github_token_enc IS NOT NULL
       AND disconnected_at IS NULL
     ORDER BY connected_at ASC`,
    [githubUsername, telegramId]
  );
  return rows;
}

async function getNotificationPrefs(telegramId) {
  const user = await getUser(telegramId);
  if (!user) return null;
  return {
    githubActivity: user.notif_github_activity,
    systemAlerts: user.notif_system_alerts,
    longOps: user.notif_long_ops,
    tokenHealth: user.notif_token_health,
    staleNudge: user.notif_stale_nudge,
    rollup: user.notif_rollup,
    quietStart: user.quiet_hours_start,
    quietEnd: user.quiet_hours_end,
  };
}

/** Cycles off -> daily -> weekly -> off, single-tap in the menu rather
 * than a separate picker screen for a 3-way choice. */
async function cycleRollup(telegramId) {
  const user = await getUser(telegramId);
  const next = { off: 'daily', daily: 'weekly', weekly: 'off' }[user.notif_rollup] || 'daily';
  await pool.query('UPDATE users SET notif_rollup = $1 WHERE telegram_id = $2', [next, telegramId]);
  return next;
}

const ALERT_TOGGLE_KEYS = ['githubActivity', 'systemAlerts', 'longOps', 'tokenHealth', 'staleNudge'];

/**
 * One-line notification summary shared by Settings and My Defaults (so they can never
 * disagree). v1.2.3-multi: this used to count every value in the prefs object that was
 * truthy — which included the rollup mode ('off' is a truthy string) and the quiet-hour
 * numbers — and divide by 8. Now it counts only the five on/off alert types, and
 * mentions the rollup and quiet hours separately when they are set. Plain text.
 */
function describeNotificationSummary(prefs) {
  if (!prefs) return `0/${ALERT_TOGGLE_KEYS.length} alert types on`;
  const on = ALERT_TOGGLE_KEYS.filter((k) => prefs[k] === true).length;
  const parts = [`${on}/${ALERT_TOGGLE_KEYS.length} alert types on`];
  if (prefs.rollup && prefs.rollup !== 'off') parts.push(`${prefs.rollup} rollup`);
  if (prefs.quietStart != null && prefs.quietEnd != null) {
    parts.push(`quiet ${String(prefs.quietStart).padStart(2, '0')}:00–${String(prefs.quietEnd).padStart(2, '0')}:00`);
  }
  return parts.join(' · ');
}

/** Sets or clears quiet hours (both null = disabled). The hours are in the person's own
 * timezone (users.timezone) — the same clock the digest and rollup pollers read. */
async function setQuietHours(telegramId, start, end) {
  await pool.query('UPDATE users SET quiet_hours_start = $1, quiet_hours_end = $2 WHERE telegram_id = $3', [start, end, telegramId]);
}

async function toggleNotification(telegramId, key) {
  const columnMap = {
    githubActivity: 'notif_github_activity',
    systemAlerts: 'notif_system_alerts',
    longOps: 'notif_long_ops',
    tokenHealth: 'notif_token_health',
    staleNudge: 'notif_stale_nudge',
  };
  const column = columnMap[key];
  if (!column) throw new Error(`Unknown notification key: ${key}`);
  await pool.query(
    `UPDATE users SET ${column} = NOT ${column} WHERE telegram_id = $1`,
    [telegramId]
  );
  const user = await getUser(telegramId);
  return user[column];
}

// ── v1.1.0-multi — open access, click tracking, admin actions ────────
const config = require('../config');

/** Called by the access-control middleware on every update. Creates the
 * row on first-ever contact (open access — no approval step), or just
 * refreshes the cheap display fields (username/first name can change on
 * Telegram's side at any time) if the row already exists. is_admin is
 * set here too — computed from BOTH config.ADMIN_IDS (the env-seeded
 * admins) AND admin_roles (anyone a super_admin has promoted since —
 * see lib/roles.js). There is no code path anywhere that lets a user
 * set it on themselves or on anyone else.
 *
 * The admin_roles check is a single EXISTS subquery embedded directly in
 * this statement rather than a separate query before/after it — this
 * function already runs on every single message from every user (it's
 * the self-heal gate itself), so adding a second round-trip here would
 * double a cost that sits on the hottest path in the whole bot. An
 * EXISTS against admin_roles' primary key, evaluated server-side inside
 * the query Postgres is already running, costs nothing extra over the
 * network — this is also what lets middleware/accessControl.js read
 * `user.is_admin` straight off this function's result instead of making
 * its own extra query, which is exactly the fix for a real bug found
 * during a v1.1.2 audit: the old version of this self-heal reset
 * is_admin back to config-only truth on every message, which would have
 * silently undone a promotion the very next time the promoted user
 * texted the bot.
 *
 * Returns the resulting row so the gate can make its block/suspend
 * decision off a single fresh read. */
async function ensureUser(telegramId, { username = null, firstName = null } = {}) {
  const isAdminByConfig = config.ADMIN_IDS.includes(Number(telegramId));

  // v1.1.7-multi: read first, write only when something actually changed.
  // This runs on every update from every user; it used to issue an UPSERT
  // (a real row write + WAL + a dead tuple) every single time even when
  // nothing differed. The read computes the effective admin flag with the
  // same EXISTS subquery in the same statement, so it is still one round
  // trip, and the write below only happens for a brand-new user or when the
  // username / first name / admin flag drifted, or an admin needs their
  // ban self-healed.
  const { rows: existing } = await pool.query(
    `SELECT u.*, ($2::boolean OR EXISTS(SELECT 1 FROM admin_roles WHERE telegram_id = $1)) AS _effective_admin
     FROM users u WHERE u.telegram_id = $1`,
    [telegramId, isAdminByConfig]
  );
  if (existing[0]) {
    const row = existing[0];
    const effectiveAdmin = row._effective_admin === true;
    const needsWrite =
      row.telegram_username !== username ||
      row.telegram_first_name !== firstName ||
      row.is_admin !== effectiveAdmin ||
      (effectiveAdmin && (row.is_blocked || row.blocked_at || row.blocked_reason || row.blocked_until || row.suspended_until));
    if (!needsWrite) {
      delete row._effective_admin;
      return row;
    }
  }

  // v1.1.8: trash_retention_days is set explicitly here from the live
  // Global Config default (falling back to config.js's own constant)
  // rather than relying on the column's static schema DEFAULT — so an
  // admin's override in ⚙️ Global Config actually takes effect for
  // brand-new signups, not just decorate a screen with no real effect.
  // Existing users' own per-user setting (My Defaults) is untouched by
  // this — it only applies at first-ever INSERT.
  const globalConfig = require('./globalConfig');
  const defaultTrashRetention = globalConfig.getTrashRetentionDaysDefault();

  const { rows } = await pool.query(
    `INSERT INTO users (telegram_id, telegram_username, telegram_first_name, is_admin, trash_retention_days)
     VALUES ($1, $2, $3, $4 OR EXISTS(SELECT 1 FROM admin_roles WHERE telegram_id = $1), $5)
     ON CONFLICT (telegram_id) DO UPDATE
       SET telegram_username = $2,
           telegram_first_name = $3,
           is_admin = ($4 OR EXISTS(SELECT 1 FROM admin_roles WHERE telegram_id = $1)),
           -- Self-heal: an admin ID can never remain locked out of their
           -- own bot. If someone was banned/suspended before being (or
           -- while being) an admin — including by mistakenly banning
           -- themselves from their own Admin Dashboard — this clears it
           -- the next time they message the bot at all, no manual DB fix
           -- required. Only applies when the effective is_admin (config
           -- OR admin_roles) is true; a non-admin's ban/suspension is
           -- untouched.
           is_blocked = CASE WHEN ($4 OR EXISTS(SELECT 1 FROM admin_roles WHERE telegram_id = $1)) THEN FALSE ELSE users.is_blocked END,
           blocked_at = CASE WHEN ($4 OR EXISTS(SELECT 1 FROM admin_roles WHERE telegram_id = $1)) THEN NULL ELSE users.blocked_at END,
           blocked_reason = CASE WHEN ($4 OR EXISTS(SELECT 1 FROM admin_roles WHERE telegram_id = $1)) THEN NULL ELSE users.blocked_reason END,
           blocked_until = CASE WHEN ($4 OR EXISTS(SELECT 1 FROM admin_roles WHERE telegram_id = $1)) THEN NULL ELSE users.blocked_until END,
           suspended_until = CASE WHEN ($4 OR EXISTS(SELECT 1 FROM admin_roles WHERE telegram_id = $1)) THEN NULL ELSE users.suspended_until END
     RETURNING *`,
    [telegramId, username, firstName, isAdminByConfig, defaultTrashRetention]
  );
  return rows[0];
}

// ── Click counter (batched) ───────────────────────────────────────────
// v1.1.7-multi: recordActivity used to be one UPDATE per accepted update.
// Counts are now accumulated in memory and flushed as ONE statement every
// few seconds (and on shutdown), so a burst of taps costs a single write.
// total_actions / last_active_at only feed admin stats and the "stale" /
// "most active" sorts, so a few seconds of lag is irrelevant; a hard crash
// can lose at most one flush window of increments.
const ACTIVITY_FLUSH_MS = 5000;
const ACTIVITY_MAX_PENDING_USERS = 20000; // safety valve if the DB is down for a long time
const pendingActivity = new Map(); // telegramId -> unflushed click count
let activityTimer = null;

async function flushActivity() {
  if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
  if (pendingActivity.size === 0) return;
  const batch = [...pendingActivity];
  pendingActivity.clear();
  try {
    await pool.query(
      `UPDATE users u
         SET total_actions = u.total_actions + d.cnt, last_active_at = now()
        FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::int[]) AS cnt) d
       WHERE u.telegram_id = d.id`,
      [batch.map(([id]) => id), batch.map(([, n]) => n)]
    );
  } catch (err) {
    // Put the counts back (merged with anything recorded meanwhile) and
    // retry on the next window rather than losing them.
    if (pendingActivity.size < ACTIVITY_MAX_PENDING_USERS) {
      for (const [id, n] of batch) pendingActivity.set(id, (pendingActivity.get(id) || 0) + n);
    }
    logger.warn('Activity counter flush failed — will retry', { message: err.message });
  }
}

/** The one and only click counter — called from the access-control gate
 * right after the block/suspend check passes. Also stamps last_active_at,
 * which is what "stale"/"most active" in the Admin Dashboard sort on.
 * Returns a promise (callers .catch() it) but never touches the DB itself —
 * see the batching note above. */
async function recordActivity(telegramId) {
  const id = Number(telegramId);
  pendingActivity.set(id, (pendingActivity.get(id) || 0) + 1);
  if (!activityTimer) {
    activityTimer = setTimeout(() => { flushActivity().catch(() => {}); }, ACTIVITY_FLUSH_MS);
    if (activityTimer.unref) activityTimer.unref();
  }
}

/** Persisted counterpart to the in-memory cap check in
 * middleware/accessControl.js — that in-memory window resets on
 * restart and exists only to do the actual throttling; this survives
 * and feeds the Admin Dashboard's 🚩 Suspicious filter. */
async function incrementRateLimitHits(telegramId) {
  await pool.query('UPDATE users SET rate_limit_hits = rate_limit_hits + 1 WHERE telegram_id = $1', [telegramId]);
}

async function isAdmin(telegramId) {
  const user = await getUser(telegramId);
  return !!(user && user.is_admin);
}

/** Suspension auto-expires by simply being in the past — no separate
 * poller needed, this just tells the gate whether NOW counts as
 * suspended, and clears the flag the moment it's found to have lapsed so
 * it doesn't need re-checking on every future message once it's expired. */
async function isCurrentlySuspended(user) {
  if (!user || !user.suspended_until) return false;
  if (new Date(user.suspended_until) > new Date()) return true;
  await pool.query('UPDATE users SET suspended_until = NULL WHERE telegram_id = $1', [user.telegram_id]);
  return false;
}

/** 🚫 Ban — per explicit design decision this ALWAYS revokes the GitHub
 * connection too (webhook teardown + token wipe), same as a self-serve
 * Disconnect. The actual GitHub-side teardown (needs the token + Octokit)
 * lives in lib/adminActions.js, which calls this for the DB half. */
async function setBlocked(telegramId, blocked, reason = null, until = null) {
  await pool.query(
    `UPDATE users SET is_blocked = $2, blocked_at = CASE WHEN $2 THEN now() ELSE NULL END,
       blocked_reason = CASE WHEN $2 THEN $3 ELSE NULL END,
       blocked_until = CASE WHEN $2 THEN $4 ELSE NULL END
     WHERE telegram_id = $1`,
    [telegramId, blocked, reason, until]
  );
}

/** ⏳ Timed bans auto-expire the exact same way suspension already does
 * (see isCurrentlySuspended just above) — a live check on `blocked_until`
 * rather than a separate poller, self-healing the row the moment it's
 * found to have lapsed. A permanent ban (blocked_until IS NULL) never
 * matches the "already past" branch, so it stays banned indefinitely,
 * same as before timed bans existed. */
async function isCurrentlyBanned(user) {
  if (!user || !user.is_blocked) return false;
  if (!user.blocked_until) return true; // permanent
  if (new Date(user.blocked_until) > new Date()) return true;
  await pool.query(
    `UPDATE users SET is_blocked = FALSE, blocked_at = NULL, blocked_reason = NULL, blocked_until = NULL
     WHERE telegram_id = $1`,
    [user.telegram_id]
  );
  return false;
}

async function setSuspended(telegramId, until, reason = null) {
  await pool.query(
    'UPDATE users SET suspended_until = $2, suspended_reason = $3 WHERE telegram_id = $1',
    [telegramId, until, until ? reason : null] // clear the reason whenever a suspension is lifted (until = null)
  );
}

async function setTrusted(telegramId, trusted) {
  await pool.query('UPDATE users SET is_trusted = $2 WHERE telegram_id = $1', [telegramId, trusted]);
}

/** 📝 Admin Notes — freeform, admin-only. NULL/'' both mean "cleared";
 * stored as NULL either way so the detail card's "no notes yet" branch
 * is a single simple falsy check. */
async function setAdminNotes(telegramId, notes) {
  const clean = notes && notes.trim() ? notes.trim().slice(0, 1000) : null;
  await pool.query('UPDATE users SET admin_notes = $2 WHERE telegram_id = $1', [telegramId, clean]);
  return clean;
}

/** NULL clears an override back to the global default — see config.js's
 * MAX_ZIP_SIZE_BYTES / MAX_SINGLE_FILE_BYTES / DEFAULT_HOURLY_ACTION_CAP. */
async function setLimitOverrides(telegramId, { maxZipBytes, maxFileBytes, hourlyActionCap }) {
  await pool.query(
    `UPDATE users SET
       max_zip_bytes_override = COALESCE($2, max_zip_bytes_override),
       max_file_bytes_override = COALESCE($3, max_file_bytes_override),
       hourly_action_cap_override = COALESCE($4, hourly_action_cap_override)
     WHERE telegram_id = $1`,
    [telegramId, maxZipBytes, maxFileBytes, hourlyActionCap]
  );
}

async function clearLimitOverrides(telegramId) {
  await pool.query(
    `UPDATE users SET max_zip_bytes_override = NULL, max_file_bytes_override = NULL, hourly_action_cap_override = NULL
     WHERE telegram_id = $1`,
    [telegramId]
  );
}

// ─── 🚩 Suspicious heuristic ───────────────────────────────────────────
// Single source of truth for "should this account get flagged", shared by
// the Users list badges, the per-user detail card, and the SQL WHERE
// clause below (which has to express the same rules directly in SQL,
// since it's what actually paginates the 'suspicious' filter — the two
// are kept in sync by hand; if you change one, change the other).
//
// v1.0.0-multi widened this from two signals to four. Still rule-based
// heuristics, not real ML/behavioral analysis — appropriate for this
// bot's scale, and each signal is independent (any ONE trips the flag)
// rather than a weighted score, so an admin reviewing a 🚩 always sees
// exactly which signal(s) fired (suspiciousReasons below) instead of an
// opaque yes/no:
//  1. Repeatedly hit their own hourly action cap — sustained hammering,
//     not a one-off burst (a single window over the cap only warns once,
//     see accessControl.js; this counts how many separate windows that's
//     happened in across the account's whole lifetime).
//  2. Never connected GitHub but racked up a lot of clicks anyway —
//     probing the bot's menus without ever doing the one thing
//     (connecting) actually required to use it for anything.
//  3. A flagged anomalous access event — accessLog.detectAnomaly's
//     reconnect-after-disconnect / scope-change / connection-churn /
//     suspiciously-fast-first-connect checks. Same detection that powers
//     the Admin Dashboard's 🕵️ Anomaly Feed, folded in here too so it's
//     not a separate thing an admin has to remember to cross-check.
//  4. A spike of errors in the last 24h — repeated failed
//     uploads/actions can mean genuine confusion, but a sustained spike
//     also looks like probing for exploitable edge cases.
const SUSPICIOUS_RATE_LIMIT_HITS = 3;
const SUSPICIOUS_NEVER_CONNECTED_ACTIONS = 20;
const SUSPICIOUS_RECENT_ERRORS = 5; // in the last 24h

/** `user` must carry `has_anomaly` and `recent_error_count` — both
 * present on every row listUsers() returns, and added onto the plain
 * users-table row by adminStats.userDetail() for the single-user card. */
function isSuspicious(user) {
  if (!user || user.is_admin) return false;
  return (
    (user.rate_limit_hits || 0) >= SUSPICIOUS_RATE_LIMIT_HITS
    || (!user.github_token_enc && (user.total_actions || 0) > SUSPICIOUS_NEVER_CONNECTED_ACTIONS)
    || !!user.has_anomaly
    || (Number(user.recent_error_count) || 0) >= SUSPICIOUS_RECENT_ERRORS
  );
}

/** Human-readable breakdown of exactly which signal(s) tripped
 * isSuspicious() for this user — powers the 🚩 detail line on the
 * per-user card so "flagged as suspicious" is never an opaque verdict. */
function suspiciousReasons(user) {
  if (!user || user.is_admin) return [];
  const reasons = [];
  if ((user.rate_limit_hits || 0) >= SUSPICIOUS_RATE_LIMIT_HITS) {
    reasons.push(`⏳ Hit its hourly rate cap in ${user.rate_limit_hits} separate window(s)`);
  }
  if (!user.github_token_enc && (user.total_actions || 0) > SUSPICIOUS_NEVER_CONNECTED_ACTIONS) {
    reasons.push(`🖱️ ${user.total_actions} actions logged without ever connecting GitHub`);
  }
  if (user.has_anomaly) {
    reasons.push('🔌 A flagged anomalous GitHub connection event — see 🕵️ Anomaly Feed');
  }
  const recentErrors = Number(user.recent_error_count) || 0;
  if (recentErrors >= SUSPICIOUS_RECENT_ERRORS) {
    reasons.push(`⚠️ ${recentErrors} errors logged in the last 24h`);
  }
  return reasons;
}

/** Paginated user list for the Admin Dashboard's 👥 Users screen.
 * filter: 'all' | 'blocked' | 'suspended' | 'connected' | 'never_connected' | 'suspicious'.
 * See isSuspicious() above for what 'suspicious' means and why. Every
 * row, regardless of filter, carries has_anomaly + recent_error_count so
 * callers can run isSuspicious()/suspiciousReasons() on any row without a
 * further query — not just ones fetched via the 'suspicious' filter
 * itself. */
async function listUsers({ filter = 'all', limit = 6, offset = 0 } = {}) {
  const where = {
    all: '',
    blocked: 'WHERE is_blocked = TRUE',
    suspended: 'WHERE suspended_until > now()',
    connected: 'WHERE github_token_enc IS NOT NULL',
    never_connected: 'WHERE connected_at IS NULL',
    suspicious: `WHERE is_admin = FALSE AND (
      rate_limit_hits >= ${SUSPICIOUS_RATE_LIMIT_HITS}
      OR (github_token_enc IS NULL AND total_actions > ${SUSPICIOUS_NEVER_CONNECTED_ACTIONS})
      OR telegram_id IN (SELECT DISTINCT telegram_id FROM access_log WHERE is_anomalous = TRUE)
      OR telegram_id IN (
        SELECT telegram_id FROM activity_log
        WHERE is_error = TRUE AND created_at > now() - interval '24 hours'
        GROUP BY telegram_id HAVING COUNT(*) >= ${SUSPICIOUS_RECENT_ERRORS}
      )
    )`,
  }[filter] || '';
  const { rows } = await pool.query(
    `SELECT u.*,
        EXISTS(
          SELECT 1 FROM access_log al WHERE al.telegram_id = u.telegram_id AND al.is_anomalous = TRUE
        ) AS has_anomaly,
        (
          SELECT COUNT(*)::int FROM activity_log a
          WHERE a.telegram_id = u.telegram_id AND a.is_error = TRUE
            AND a.created_at > now() - interval '24 hours'
        ) AS recent_error_count
     FROM users u ${where}
     ORDER BY COALESCE(u.last_active_at, u.created_at) DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM users u ${where}`);
  return { rows, total: countRows[0].total };
}

/** Full account wipe for the Admin Dashboard's 🗑️ Delete User — mirrors
 * dataStore.fullReset()'s table list plus everything fullReset
 * deliberately leaves alone (trash, access log, search/view history,
 * webhooks) since an admin delete is permanent, not a "reset my
 * preferences" — there's no lingering account left to preserve anything
 * FOR. GitHub-side teardown (webhooks) must already be done by the
 * caller before this runs, same ordering constraint as Disconnect. */
async function deleteUserAndData(telegramId) {
  // v1.1.23-multi: one transaction — a crash or DB error mid-erase used to leave
  // a half-deleted person (some tables gone, others still holding their data).
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const queries = [
      'DELETE FROM pinned_repos WHERE telegram_id = $1',
      'DELETE FROM tags WHERE telegram_id = $1',
      'DELETE FROM activity_log WHERE telegram_id = $1',
      'DELETE FROM repo_path_memory WHERE telegram_id = $1',
      'DELETE FROM automation_mute_rules WHERE telegram_id = $1',
      'DELETE FROM automation_backup_rules WHERE telegram_id = $1',
      'DELETE FROM scheduled_repos WHERE telegram_id = $1',
      'DELETE FROM scheduled_uploads WHERE telegram_id = $1',
      'DELETE FROM trashed_repos WHERE telegram_id = $1',
      'DELETE FROM access_log WHERE telegram_id = $1',
      'DELETE FROM search_history WHERE telegram_id = $1',
      'DELETE FROM recently_viewed WHERE telegram_id = $1',
      'DELETE FROM notification_mutes WHERE telegram_id = $1',
      'DELETE FROM repo_webhooks WHERE telegram_id = $1',
      'DELETE FROM github_accounts WHERE telegram_id = $1',
      'DELETE FROM alert_event_prefs WHERE telegram_id = $1',
      'DELETE FROM upload_path_frequency WHERE telegram_id = $1',
      'DELETE FROM size_snapshots WHERE telegram_id = $1',
      'DELETE FROM size_snapshot_history WHERE telegram_id = $1',
      'DELETE FROM saved_views WHERE telegram_id = $1',
      'DELETE FROM defaults_changelog WHERE telegram_id = $1',
      'DELETE FROM bulk_action_log WHERE telegram_id = $1',
      'DELETE FROM user_reports WHERE telegram_id = $1',
      // 🧠 Warden Brain (v1.2.0-multi) — observations, evidence and cases about this person
      'DELETE FROM warden_case_events WHERE telegram_id = $1',
      'DELETE FROM warden_evidence WHERE telegram_id = $1',
      'DELETE FROM warden_cases WHERE telegram_id = $1',
      'DELETE FROM warden_profiles WHERE telegram_id = $1',
      'DELETE FROM warden_activity_buckets WHERE telegram_id = $1',
      // v1.2.3-multi: these two were left behind. warden_user_state is the older Warden's
      // per-person state; warden_action_log rows name the person as their target (the
      // one-time recovery marker has target 0 and is unaffected). The admin audit log
      // (admin_action_log) is deliberately kept: it records what ADMINS did, and is
      // described that way in the Privacy Policy.
      'DELETE FROM warden_user_state WHERE telegram_id = $1',
      'DELETE FROM warden_action_log WHERE target_id = $1',
    ];
    for (const sql of queries) await tx.query(sql, [telegramId]);
    await tx.query('DELETE FROM users WHERE telegram_id = $1', [telegramId]);
    await tx.query('COMMIT');
  } catch (err) {
    try { await tx.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    tx.release();
  }
  // Counters still waiting in memory would be flushed later and resurrect rows for a deleted person.
  require('./wardenBrain/collector').forget(telegramId);
  await purgeRedisFootprint(telegramId);
}

/** Best-effort removal of the person's Redis-side state: their wizard
 * session (repo names, in-progress upload state) and any buffered webhook
 * digests. Never throws — the database erase above is the part that must
 * succeed, and everything here also expires on its own TTL. */
async function purgeRedisFootprint(telegramId) {
  try {
    const { client } = require('../db/redis');
    if (!client || !client.isReady) return;
    // Private chats: Telegraf's default session key is `${chatId}:${fromId}`,
    // and chatId === fromId in a private chat.
    await client.del(`tg-session:${telegramId}:${telegramId}`);
    for (const prefix of [`webhook-buffer:${telegramId}:`, `webhook-digest-due:${telegramId}:`]) {
      for await (const key of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
        await client.del(key);
      }
    }
  } catch (err) {
    logger.warn('Redis cleanup after user delete failed', { message: err.message });
  }
}

module.exports = {
  getUser,
  isConnected,
  getDecryptedToken,
  saveConnection,
  syncGithubUsername,
  disconnect,
  getNotificationPrefs,
  describeNotificationSummary,
  toggleNotification,
  cycleRollup,
  setQuietHours,
  ensureUser,
  recordActivity,
  flushActivity,
  incrementRateLimitHits,
  isAdmin,
  isCurrentlySuspended,
  setBlocked,
  isCurrentlyBanned,
  setSuspended,
  setTrusted,
  setAdminNotes,
  setLimitOverrides,
  clearLimitOverrides,
  listUsers,
  deleteUserAndData,
  isSuspicious,
  suspiciousReasons,
  getSiblingConnections,
};
