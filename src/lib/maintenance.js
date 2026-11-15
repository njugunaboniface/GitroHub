const globalConfig = require('./globalConfig');

/**
 * 🩺 Maintenance Mode (v1.3.0-multi)
 *
 * Blocks every non-admin update with a friendly "back soon" message —
 * admins always pass straight through, both to actually run the bot
 * while it's "closed" and so an admin can never accidentally lock
 * themselves out the way a bad Ban/Suspend once could (see
 * middleware/accessControl.js's own belt-and-suspenders comment for the
 * same worry, same fix pattern).
 *
 * Two ways to end up "on": a manual toggle, or a schedule (auto_on /
 * auto_off, each "HH:MM" 24h UTC). Both write to the exact same
 * `maintenance_enabled` flag — there's no separate "scheduled" state to
 * drift out of sync with the flag an admin can also flip by hand. The
 * schedule is just something that flips that same flag for you, on a
 * timer (see checkSchedule(), polled once a minute from index.js).
 *
 * Deliberately UTC-only for the schedule times — every admin (there can
 * be more than one, config.ADMIN_IDS) shares one bot-wide switch, so a
 * single unambiguous clock beats guessing whose local time should win.
 */

const DEFAULT_MESSAGE =
  '🛠️ GitroHub is offline for scheduled maintenance right now — back shortly. ' +
  'Nothing about your account, your GitHub connection, or your repos is affected.';

function isEnabled() {
  return globalConfig.get('maintenance_enabled') === 'true';
}

function getMessage() {
  return globalConfig.get('maintenance_message') || DEFAULT_MESSAGE;
}

/** 'HH:MM' (24h, UTC) or null if no auto-on time is set. */
function getAutoOn() {
  return globalConfig.get('maintenance_auto_on') || null;
}

/** 'HH:MM' (24h, UTC) or null if no auto-off time is set. */
function getAutoOff() {
  return globalConfig.get('maintenance_auto_off') || null;
}

async function setEnabled(adminId, enabled) {
  await globalConfig.set(adminId, 'maintenance_enabled', enabled ? 'true' : 'false');
}

async function setMessage(adminId, text) {
  await globalConfig.set(adminId, 'maintenance_message', text);
}

async function clearMessage(adminId) {
  await globalConfig.clear(adminId, 'maintenance_message');
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function isValidTime(str) {
  return TIME_RE.test(str);
}

async function setAutoOn(adminId, hhmm) {
  await globalConfig.set(adminId, 'maintenance_auto_on', hhmm);
}
async function setAutoOff(adminId, hhmm) {
  await globalConfig.set(adminId, 'maintenance_auto_off', hhmm);
}
async function clearAutoOn(adminId) {
  await globalConfig.clear(adminId, 'maintenance_auto_on');
}
async function clearAutoOff(adminId) {
  await globalConfig.clear(adminId, 'maintenance_auto_off');
}

/** Current UTC time as "HH:MM", matching the schedule fields' own format. */
function nowUtcHHMM() {
  const d = new Date();
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// Guards against re-firing the SAME scheduled transition more than once
// inside the same minute if the poller happens to run twice close
// together — deliberately in-memory only (not persisted): the worst case
// of losing this on a restart is one possible duplicate toggle attempt,
// which is harmless (setEnabled is idempotent) and self-corrects on the
// very next poll.
let lastFiredOnMinute = null;
let lastFiredOffMinute = null;

/**
 * Called once a minute from index.js. Compares the current UTC clock
 * against the configured auto_on/auto_off times and flips the manual
 * flag when one matches — logged as a system-initiated change (adminId
 * `null`) in the audit trail, same as any other global_config write, so
 * "why did this turn on/off" is always answerable later.
 */
async function checkSchedule() {
  const hhmm = nowUtcHHMM();
  const autoOn = getAutoOn();
  const autoOff = getAutoOff();

  if (autoOn && autoOn === hhmm && lastFiredOnMinute !== hhmm) {
    lastFiredOnMinute = hhmm;
    if (!isEnabled()) await setEnabled(null, true);
  }
  if (autoOff && autoOff === hhmm && lastFiredOffMinute !== hhmm) {
    lastFiredOffMinute = hhmm;
    if (isEnabled()) await setEnabled(null, false);
  }
}

module.exports = {
  DEFAULT_MESSAGE,
  isEnabled,
  getMessage,
  getAutoOn,
  getAutoOff,
  isValidTime,
  setEnabled,
  setMessage,
  clearMessage,
  setAutoOn,
  setAutoOff,
  clearAutoOn,
  clearAutoOff,
  checkSchedule,
};
