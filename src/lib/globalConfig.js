const { pool } = require('../db/postgres');
const logger = require('./logger');

/**
 * v1.2.0-multi — lets an admin change the bot's global upload/rate
 * defaults from the ⚙️ Global Config screen, live, without a redeploy.
 * Falls back to config.js's env-var defaults when no override has ever
 * been set for a key.
 *
 * Reads are served from an in-memory cache refreshed on a timer (see
 * startRefreshLoop, called once from index.js at boot) rather than
 * hitting Postgres on every single limit check — this sits on the same
 * hot path as every upload-size check and every accessControl gate call,
 * so a DB round-trip per read would be a real cost for no benefit; a few
 * seconds of staleness after an admin changes a value is a fine trade.
 */
// v1.3.0-multi — maintenance_* keys added: the same live-cached
// admin_config store now also backs 🩺 Maintenance Mode (lib/maintenance.js)
// instead of standing up a second table/cache for what is, mechanically,
// the exact same "admin-editable key/value, cheap to read on every
// update" shape.
const KNOWN_KEYS = [
  'default_max_zip_bytes', 'default_max_file_bytes', 'default_hourly_action_cap',
  'maintenance_enabled', 'maintenance_message', 'maintenance_auto_on', 'maintenance_auto_off',
  'notify_users_on_repo_mod',
  // v1.1.8 — new Global Config knobs. Each backed by a getter below that
  // falls back to config.js's own constant, same pattern the three
  // original keys above already established via lib/limits.js.
  'default_trash_retention_days', 'session_ttl_seconds', 'log_retention_days',
  'max_zip_uncompressed_bytes', 'max_archive_files', 'webhook_digest_window_ms',
  'signups_paused',
  // v1.1.8 — 🔒 Lockdown Mode display/convenience flags (see lib/lockdown.js;
  // the actual access gate never reads these, it checks each admin's own
  // users.dashboard_locked_at directly, so these can never drift out of
  // sync with reality).
  'lockdown_active', 'lockdown_keep_warden',
  // v1.2.5-multi — Warden Watch (lib/sensitiveActions.js)
  'sens_notify_admins', 'sens_hold', 'sens_burst', 'warden_briefing',
];
// v1.2.4-multi: `feature_<name>` switches (lib/features.js) are a pattern, not a fixed list.
const isKnownKey = (key) => KNOWN_KEYS.includes(key) || /^feature_[a-z][a-z_]{1,29}$/.test(String(key));
let cache = {};

async function refresh() {
  try {
    const { rows } = await pool.query('SELECT key, value FROM admin_config');
    const next = {};
    for (const row of rows) next[row.key] = row.value;
    cache = next;
  } catch (err) {
    logger.warn('Global config refresh failed — serving last known values', { message: err.message });
  }
}

function startRefreshLoop(intervalMs = 30000) {
  refresh(); // populate immediately at boot rather than waiting for the first interval
  setInterval(refresh, intervalMs);
}

/** Synchronous — reads whatever's currently cached. Returns `null` if no
 * override has ever been set (caller should fall back to config.js). */
function get(key) {
  return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
}

function getAllOverrides() {
  return { ...cache };
}

async function set(adminId, key, value) {
  if (!isKnownKey(key)) throw new Error(`Unknown global config key: ${key}`);
  await pool.query(
    `INSERT INTO admin_config (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, String(value)]
  );
  cache[key] = String(value); // update local cache immediately — don't wait for the next refresh tick
  const adminActions = require('./adminActions');
  await adminActions.auditLog(adminId, null, 'global_config', `${key} = ${value}`);
}

async function clear(adminId, key) {
  await pool.query('DELETE FROM admin_config WHERE key = $1', [key]);
  delete cache[key];
  const adminActions = require('./adminActions');
  await adminActions.auditLog(adminId, null, 'global_config', `${key} cleared (back to default)`);
}

module.exports = {
  KNOWN_KEYS, startRefreshLoop, refresh, get, getAllOverrides, set, clear,
  // v1.1.8 convenience getters — one place holding the "override, else
  // config.js default" fallback for each new knob, instead of every call
  // site repeating `globalConfig.get('x') || config.X` by hand.
  getTrashRetentionDaysDefault() {
    const v = get('default_trash_retention_days');
    return v != null ? Number(v) : require('../config').DEFAULT_TRASH_RETENTION_DAYS;
  },
  getSessionTtlSeconds() {
    const v = get('session_ttl_seconds');
    return v != null ? Number(v) : require('../config').SESSION_TTL_SECONDS;
  },
  getLogRetentionDays() {
    const v = get('log_retention_days');
    return v != null ? Number(v) : require('../config').LOG_RETENTION_DAYS;
  },
  getMaxZipUncompressedBytes() {
    const v = get('max_zip_uncompressed_bytes');
    return v != null ? Number(v) : require('../config').MAX_ZIP_UNCOMPRESSED_BYTES;
  },
  getMaxArchiveFiles() {
    const v = get('max_archive_files');
    return v != null ? Number(v) : require('../config').MAX_ARCHIVE_FILES;
  },
  getWebhookDigestWindowMs() {
    const v = get('webhook_digest_window_ms');
    return v != null ? Number(v) : require('./webhookDigest').DEFAULT_DIGEST_WINDOW_MS;
  },
  isSignupsPaused() {
    return get('signups_paused') === 'true';
  },
};
