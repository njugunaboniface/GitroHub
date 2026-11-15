const config = require('../config');
const globalConfig = require('./globalConfig');

/**
 * v1.1.0-multi — resolves the limits that actually apply to ONE user:
 * their admin-set PER-USER override if they have one, otherwise the
 * GLOBAL default — which is itself either an admin-set live override
 * (v1.2.0-multi's ⚙️ Global Config) or config.js's env-var default if no
 * global override has ever been set. Centralized here so "what's this
 * person's actual ceiling right now" is answered the same way everywhere
 * (upload validation, the Admin Dashboard's display of it, etc.) instead
 * of each call site re-deriving it slightly differently.
 *
 * `user` is a full row from lib/users.js (getUser/ensureUser) — pass
 * null/undefined to get the plain global defaults back.
 */
function getEffectiveLimits(user) {
  const globalZip = globalConfig.get('default_max_zip_bytes');
  const globalFile = globalConfig.get('default_max_file_bytes');
  const globalCap = globalConfig.get('default_hourly_action_cap');
  return {
    maxZipBytes: (user && user.max_zip_bytes_override) || (globalZip != null ? Number(globalZip) : config.MAX_ZIP_SIZE_BYTES),
    maxFileBytes: (user && user.max_file_bytes_override) || (globalFile != null ? Number(globalFile) : config.MAX_SINGLE_FILE_BYTES),
    // NOT `||` here — 0 is a deliberate, valid override meaning "unlimited"
    // (see handlers/admin.js's CAP_PRESETS), and `0 || fallback` would
    // silently discard that override since 0 is falsy in JS. Only NULL
    // (never set / explicitly cleared) should fall through to the default.
    // v1.1.24-multi: the owner and every dashboard admin are exempt from the
    // hourly cap entirely (0 = unlimited) — a fairness throttle for the shared
    // update queue was never meant to apply to the people running the bot, and
    // it locked the owner out of their own dashboard. Any stored override on an
    // admin is ignored rather than trusted.
    // ⭐ Trusted people are never throttled either (they remain fully observed and logged
    // by Warden — trust protects from action, not from being monitored).
    hourlyActionCap: (user && (user.is_admin || user.is_trusted))
      ? 0
      : (user && user.hourly_action_cap_override != null)
        ? user.hourly_action_cap_override
        : (globalCap != null ? Number(globalCap) : (config.DEFAULT_HOURLY_ACTION_CAP || 0)),
  };
}

module.exports = { getEffectiveLimits };
