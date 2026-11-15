const { pool } = require('../db/postgres');
const globalConfig = require('./globalConfig');
const roles = require('./roles');

/** 🔒 v1.1.8 Lockdown Mode — Owner-only. Revokes DASHBOARD access for an
 * admin (or every admin at once), NOT their regular bot access — a
 * locked-out admin keeps using the bot as an ordinary user in the
 * meantime, deliberately, so nothing about their experience looks
 * obviously different pre-tap in a real compromise scenario. This is
 * intentionally a separate mechanism from is_blocked/suspended_until
 * (users.js) — those affect the WHOLE bot for a regular user; this
 * affects ONLY the Dashboard, and only for someone who already has an
 * admin role.
 *
 * "Full" lockdown is not a separate flag — it's just "lock every admin
 * except the Owner at once," using the exact same per-admin columns
 * (users.dashboard_locked_at / dashboard_locked_by) as a Targeted
 * lockdown. One mechanism, two ways to invoke it. `lockdown_active` in
 * admin_config exists only so the UI can show "Full Lockdown is ON" and
 * offer a one-tap "release everyone" — it is a display/convenience
 * flag, never itself checked by the access gate (admin.js's
 * requireAdmin checks each admin's own dashboard_locked_at directly, so
 * it can never drift out of sync with that flag).
 */

async function isLocked(telegramId) {
  if (roles.isOwner(telegramId)) return false; // the Owner can never be locked out, even by themself
  const { rows } = await pool.query('SELECT dashboard_locked_at FROM users WHERE telegram_id = $1', [telegramId]);
  return !!(rows[0] && rows[0].dashboard_locked_at);
}

async function lockAdmin(ownerId, targetId) {
  if (roles.isOwner(targetId)) throw new Error('cannot_lock_owner');
  await pool.query(
    'UPDATE users SET dashboard_locked_at = now(), dashboard_locked_by = $2 WHERE telegram_id = $1',
    [targetId, ownerId]
  );
}

async function unlockAdmin(targetId) {
  await pool.query(
    'UPDATE users SET dashboard_locked_at = NULL, dashboard_locked_by = NULL WHERE telegram_id = $1',
    [targetId]
  );
}

/** Locks every admin/moderator/super_admin EXCEPT the Owner, in one
 * query — this IS "Full Lockdown," not a separate code path from
 * Targeted. */
async function lockAll(ownerId) {
  const { rows } = await pool.query(
    `UPDATE users SET dashboard_locked_at = now(), dashboard_locked_by = $1
     WHERE telegram_id IN (SELECT telegram_id FROM admin_roles) AND telegram_id != $1
     RETURNING telegram_id`,
    [ownerId]
  );
  await globalConfig.set(ownerId, 'lockdown_active', 'true');
  return rows.map((r) => r.telegram_id);
}

async function unlockAll(ownerId) {
  const { rows } = await pool.query(
    `UPDATE users SET dashboard_locked_at = NULL, dashboard_locked_by = NULL
     WHERE dashboard_locked_at IS NOT NULL
     RETURNING telegram_id`
  );
  await globalConfig.set(ownerId, 'lockdown_active', 'false');
  return rows.map((r) => r.telegram_id);
}

async function getLockedAdmins() {
  const { rows } = await pool.query(
    `SELECT telegram_id, telegram_username, telegram_first_name, dashboard_locked_at, dashboard_locked_by
     FROM users WHERE dashboard_locked_at IS NOT NULL ORDER BY dashboard_locked_at DESC`
  );
  return rows;
}

function isFullLockdownActive() {
  return globalConfig.get('lockdown_active') === 'true';
}

/** Whether Warden should keep running while Full/Targeted Lockdown is
 * active — default ON, since Warden isn't gated through the admin
 * Dashboard login path at all and has no reason to stop just because
 * human admins temporarily can't get in. */
function keepWardenActive() {
  const v = globalConfig.get('lockdown_keep_warden');
  return v == null ? true : v === 'true';
}

async function setKeepWardenActive(ownerId, keep) {
  await globalConfig.set(ownerId, 'lockdown_keep_warden', keep ? 'true' : 'false');
}

module.exports = {
  isLocked, lockAdmin, unlockAdmin, lockAll, unlockAll, getLockedAdmins,
  isFullLockdownActive, keepWardenActive, setKeepWardenActive,
};
