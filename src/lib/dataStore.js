const { pool } = require('../db/postgres');
const users = require('./users');
const pins = require('./pins');
const tags = require('./tags');
const activity = require('./activity');

async function getCounts(telegramId) {
  const [pinCount, tagCount, activityStats, trashCount, user] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM pinned_repos WHERE telegram_id = $1', [telegramId]),
    pool.query('SELECT COUNT(*)::int AS c FROM tags WHERE telegram_id = $1', [telegramId]),
    pool.query(
      `SELECT COUNT(*)::int AS c, MIN(created_at) AS oldest FROM activity_log WHERE telegram_id = $1`,
      [telegramId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS c FROM trashed_repos WHERE telegram_id = $1 AND restored_at IS NULL AND expires_at > now()`,
      [telegramId]
    ),
    users.getUser(telegramId),
  ]);

  const oldest = activityStats.rows[0].oldest;
  const days = oldest ? Math.ceil((Date.now() - new Date(oldest).getTime()) / 86400000) : 0;

  return {
    pinnedRepos: pinCount.rows[0].c,
    tags: tagCount.rows[0].c,
    activityEntries: activityStats.rows[0].c,
    activityDays: days,
    trashedRepos: trashCount.rows[0].c,
    hasToken: !!(user && user.github_token_enc),
  };
}

async function clearActivityLog(telegramId) {
  await pool.query('DELETE FROM activity_log WHERE telegram_id = $1', [telegramId]);
}

async function clearPins(telegramId) {
  await pins.clearAll(telegramId);
}

async function clearDefaults(telegramId) {
  await pool.query(
    `UPDATE users SET
       default_visibility = 'private',
       default_commit_message = 'Update via GitroHub',
       default_upload_path = '',
       default_sort = 'updated',
       default_filter = 'all'
     WHERE telegram_id = $1`,
    [telegramId]
  );
}

/**
 * Full reset: pins (and their sections), tags (with colours, nesting and per-tag defaults), defaults,
 * activity history, automation rules and saved upload-path memory.
 * NOT touched: the GitHub connection, Trash, and anything scheduled.
 */
async function fullReset(telegramId) {
  await Promise.all([
    pool.query('DELETE FROM pinned_repos WHERE telegram_id = $1', [telegramId]),
    pool.query('DELETE FROM tags WHERE telegram_id = $1', [telegramId]), // cascades repo_tags
    pool.query('DELETE FROM activity_log WHERE telegram_id = $1', [telegramId]),
    pool.query('DELETE FROM repo_path_memory WHERE telegram_id = $1', [telegramId]),
    pool.query('DELETE FROM automation_mute_rules WHERE telegram_id = $1', [telegramId]),
    pool.query('DELETE FROM automation_backup_rules WHERE telegram_id = $1', [telegramId]),
    // Pending scheduled repos and uploads are deliberately NOT cleared (v1.2.3-multi): they are
    // commitments the person made, not preferences, and "reset my settings" must not silently
    // cancel something that was set to run later. They are managed from their own screens.
    clearDefaults(telegramId),
  ]);
  // Deliberately NOT touched: trashed_repos. Full Reset clears preferences
  // and clutter, not the one remaining safety net for something someone
  // may have deleted five minutes ago — wiping backups as a side effect of
  // "reset my settings" would turn a convenience action into a data-loss
  // trap. Trash still expires on its own normal schedule regardless.
}

/** Prunes activity_log entries older than the user's configured retention window */
async function pruneOldActivity(telegramId) {
  const user = await users.getUser(telegramId);
  if (!user) return;
  await pool.query(
    `DELETE FROM activity_log WHERE telegram_id = $1 AND created_at < now() - ($2 || ' days')::interval`,
    [telegramId, user.activity_retention_days]
  );
}

/** Same as pruneOldActivity but for every user at once, each against their
 * own activity_retention_days — this is what the daily scheduler in
 * index.js calls, so retention stays correct for everyone even if they
 * never happen to open 📜 Activity themselves (which is the only other
 * place pruneOldActivity gets triggered, lazily, per-user, on-demand).
 * Two different triggers, same underlying rule — not two competing ones. */
async function pruneAllUsersActivity() {
  // v1.2.1-multi: batched, and grouped by the (few) distinct retention settings instead of one
  // query per user — the old loop issued N sub-selects and one unbounded DELETE per user. With
  // the cutoff on created_at alone, idx_activity_log_created can drive each batch.
  const { pruneBatched } = require('./retention');
  const { rows: settings } = await pool.query('SELECT DISTINCT activity_retention_days AS d FROM users WHERE activity_retention_days IS NOT NULL');
  let total = 0;
  for (const { d } of settings) {
    const days = Number(d);
    if (!Number.isFinite(days) || days < 1) continue;
    const r = await pruneBatched(
      'activity_log',
      "created_at < now() - ($2 || ' days')::interval AND telegram_id IN (SELECT telegram_id FROM users WHERE activity_retention_days = $3)",
      [String(days), days]
    );
    total += r.deleted;
  }
  return total;
}

async function exportData(telegramId, format) {
  const [user, pinList, tagList, activityRows] = await Promise.all([
    users.getUser(telegramId),
    pins.list(telegramId),
    tags.listTags(telegramId),
    activity.recent(telegramId, { limit: 500 }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    account: {
      githubUsername: user ? user.github_username : null,
      connectedSince: user ? user.connected_at : null,
    },
    pinnedRepos: pinList.map((p) => p.repo_name),
    tags: tagList.map((t) => ({ name: t.name, emoji: t.emoji, repoCount: t.repo_count })),
    defaults: user
      ? {
          visibility: user.default_visibility,
          commitMessage: user.default_commit_message,
          uploadPath: user.default_upload_path,
          sort: user.default_sort,
          filter: user.default_filter,
        }
      : null,
    activityLog: activityRows.rows.map((r) => ({
      time: r.created_at,
      icon: r.icon,
      summary: r.summary,
      isError: r.is_error,
    })),
  };

  if (format === 'json') {
    return JSON.stringify(payload, null, 2);
  }

  // Readable .txt summary
  let text = `GitroHub — Your Data Export\nGenerated: ${payload.exportedAt}\n\n`;
  text += `ACCOUNT\nGitHub: ${payload.account.githubUsername || 'Not connected'}\nConnected since: ${payload.account.connectedSince || '—'}\n\n`;
  text += `PINNED REPOS (${payload.pinnedRepos.length})\n${payload.pinnedRepos.join(', ') || 'None'}\n\n`;
  text += `TAGS (${payload.tags.length})\n${payload.tags.map((t) => `${t.emoji} ${t.name} (${t.repoCount} repos)`).join('\n') || 'None'}\n\n`;
  text += `DEFAULTS\n${payload.defaults ? Object.entries(payload.defaults).map(([k, v]) => `${k}: ${v}`).join('\n') : 'None'}\n\n`;
  text += `ACTIVITY LOG (${payload.activityLog.length} entries)\n`;
  text += payload.activityLog.map((e) => `[${e.time}] ${e.icon} ${e.summary}`).join('\n');

  return text;
}

module.exports = { getCounts, clearActivityLog, clearPins, clearDefaults, fullReset, pruneOldActivity, pruneAllUsersActivity, exportData };
