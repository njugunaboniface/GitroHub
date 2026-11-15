require('dotenv').config();
const crypto = require('crypto');
const pkg = require('../package.json');

function required(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ Missing required environment variable: ${name}`);
    console.error('   Check your .env file against .env.example');
    process.exit(1);
  }
  return val;
}

// v1.1.0-multi: GitroHub is no longer owner-only — anyone can /start and
// connect their own GitHub account freely. ADMIN_ID(S) now names who sees
// the 🛡️ Admin button, not the only people the bot will talk to.
//
// Multi-admin support: set ADMIN_IDS to a comma-separated list
// (e.g. "111111,222222") to give more than one person admin access.
// OWNER_ID (and the older ADMIN_ID) are ALWAYS admins too — the roster is the
// union of all three, so nobody has to be repeated in ADMIN_IDS.
function parseIdList(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n !== 0);
}
const uniq = (arr) => Array.from(new Set(arr));

// 👑 Owner — the one account nobody, not even another super_admin, can
// touch via 👑 Admins role management (see lib/roles.js's isOwner and
// handlers/admin.js's executeSetRole). Explicit OWNER_ID wins if set;
// otherwise ADMIN_ID (the older single-admin var); otherwise the first
// entry in ADMIN_IDS — so every deployment has exactly one Owner.
function resolveOwnerId() {
  const explicit = parseIdList(process.env.OWNER_ID)[0];
  if (explicit) return explicit;
  const single = parseIdList(process.env.ADMIN_ID)[0];
  if (single) return single;
  return parseIdList(process.env.ADMIN_IDS)[0];
}

// v1.2.4-multi: the admin roster is the UNION of OWNER_ID, ADMIN_ID and
// ADMIN_IDS. Before, setting ADMIN_IDS made the roster ONLY that list, so an
// Owner who wasn't repeated inside it silently lost the Admin button and
// dashboard access (and vice versa) — they must all work at the same time,
// with no need to duplicate anyone. Owner always comes first.
function requiredAdminIds(ownerId) {
  const ids = uniq([ownerId, ...parseIdList(process.env.ADMIN_ID), ...parseIdList(process.env.ADMIN_IDS)].filter(Boolean));
  if (ids.length === 0) {
    console.error('❌ Missing required environment variable: OWNER_ID (or ADMIN_IDS / ADMIN_ID)');
    console.error('   Check your .env file against .env.example');
    process.exit(1);
  }
  return ids;
}

// Super-admin tier: a subset of the admin roster with exclusive access to the
// highest-blast-radius Dashboard actions (fleet Broadcast, permanent Delete
// User, Global Config edits, every 🗂️ Bulk hub action). Falls back to "every
// admin is a super admin" when SUPER_ADMIN_IDS isn't set. Anything in
// SUPER_ADMIN_IDS that isn't an admin is dropped (super-admin is a tier
// WITHIN admin). v1.2.4-multi: the Owner is ALWAYS a super admin, even if
// SUPER_ADMIN_IDS was configured without them.
function superAdminIds(adminIds, ownerId) {
  const listed = parseIdList(process.env.SUPER_ADMIN_IDS);
  if (listed.length === 0) return adminIds;
  const scoped = listed.filter((id) => adminIds.includes(id));
  return uniq([ownerId, ...scoped].filter(Boolean));
}

const resolvedOwnerId = resolveOwnerId();
const resolvedAdminIds = requiredAdminIds(resolvedOwnerId);

module.exports = {
  BOT_TOKEN: required('BOT_TOKEN'),
  // The @username of YOUR bot (no @, no t.me/ prefix — just e.g. "MyReposBot").
  // Used to build the "◀️ Return to Telegram" deep link shown after a
  // GitHub OAuth connection completes. This used to be hardcoded to the
  // original author's bot username, which silently sent every fork's
  // users back to the WRONG bot after connecting — required now so that
  // mistake can't happen again.
  BOT_USERNAME: required('BOT_USERNAME'),
  // Array of every admin's telegram_id. Use this for any "is this person
  // an admin" check going forward.
  ADMIN_IDS: resolvedAdminIds,
  // Back-compat alias — the first configured admin. Nothing in the
  // codebase treats this ID as special beyond "first in the list"; any
  // admin-only check should use ADMIN_IDS.includes(...), not this.
  get ADMIN_ID() { return this.ADMIN_IDS[0]; },
  // Subset of ADMIN_IDS cleared for fleet-wide/destructive actions — see
  // comment above superAdminIds(). Any admin-only check that ISN'T tiered
  // should still use ADMIN_IDS, not this.
  SUPER_ADMIN_IDS: superAdminIds(resolvedAdminIds, resolvedOwnerId),
  // See resolvedOwnerId above — the one account role management can
  // never touch, regardless of who's acting.
  OWNER_ID: resolvedOwnerId,

  GITHUB_CLIENT_ID: required('GITHUB_CLIENT_ID'),
  GITHUB_CLIENT_SECRET: required('GITHUB_CLIENT_SECRET'),

  BASE_URL: required('BASE_URL').replace(/\/$/, ''),
  PORT: Number(process.env.PORT || 3000),

  SESSION_JWT_SECRET: required('SESSION_JWT_SECRET'),
  TOKEN_ENCRYPTION_KEY: required('TOKEN_ENCRYPTION_KEY'),

  DATABASE_URL: required('DATABASE_URL'),
  REDIS_URL: required('REDIS_URL'),

  // Single source of truth is package.json's "version" field — never
  // hardcode a copy of it here, that's exactly how this drifted before
  // (see .env.example and CHANGELOG). BOT_VERSION env var can still
  // override for a hotfix/canary build, but the default always tracks
  // whatever's actually in package.json.
  BOT_VERSION: process.env.BOT_VERSION || pkg.version,

  // Hard limits (from design spec)
  MAX_ZIP_SIZE_BYTES: 1 * 1024 * 1024, // 1MB
  MAX_ZIP_UNCOMPRESSED_BYTES: 15 * 1024 * 1024, // 15MB decompressed — enforced on ACTUAL output bytes (lib/archive.js), never on archive-declared sizes
  MAX_ARCHIVE_FILES: 2000, // max files in one extracted archive — bounds the per-file Redis/CPU work a tiny archive full of empty files could trigger
  MAX_RESTORE_UNCOMPRESSED_BYTES: 60 * 1024 * 1024, // Trash restore reads GitHub's own zipball (compressed size is capped by TELEGRAM_DOWNLOAD_LIMIT_BYTES), so it gets a larger — but still hard — decompression ceiling
  MAX_SINGLE_FILE_BYTES: 5 * 1024 * 1024, // 5MB — single-file uploads (not zips)
  // Default bot-side actions/hour cap, separate from GitHub's own rate limit —
  // this throttles how much of the shared per-process update queue one person
  // can occupy, not how many GitHub API calls they've used. NULL/0 = unlimited.
  // Admin can override this per-user (users.hourly_action_cap_override).
  DEFAULT_HOURLY_ACTION_CAP: Number(process.env.DEFAULT_HOURLY_ACTION_CAP || 0),
  LOG_RETENTION_DAYS: 90, // default access_log retention (admins can change it in Global Config); activity_log keeps each person's own setting
  // v1.1.8 — default for a BRAND NEW user's trash_retention_days column
  // (schema.sql's own DEFAULT 30 on that column is now just the
  // fallback-of-the-fallback; ensureUser in lib/users.js sets this
  // explicitly on INSERT so a Global Config override actually takes
  // effect for new signups, not just as decoration).
  DEFAULT_TRASH_RETENTION_DAYS: 30,
  // Telegram Bot API limits: a bot may SEND files up to 50MB, but can only DOWNLOAD
  // (getFile) files up to 20MB. Mixing the two up is how a 20-50MB Trash backup
  // could be created yet never restored (v1.2.3-multi: one place, correct meaning).
  TELEGRAM_UPLOAD_LIMIT_BYTES: 50 * 1024 * 1024,
  TELEGRAM_DOWNLOAD_LIMIT_BYTES: 20 * 1024 * 1024,
  REPOS_PER_PAGE: 5, // inline repo buttons: five per page
  FILES_PER_PAGE: 8,
  ACTIVITY_PER_PAGE: 6,
  // WIZARD_SESSION_TTL_SECONDS and SESSION_TTL_SECONDS are deliberately
  // separate constants, not one shared value. WIZARD_SESSION_TTL_SECONDS
  // governs only abandoned-upload file buffers (in-process memory,
  // correctly short-lived). SESSION_TTL_SECONDS is the actual Redis TTL on
  // the GLOBAL Telegraf session store — every ctx.session field, bot-wide
  // (ctx.session.currentRepo, bulk selections, etc.), not just active
  // wizards. A single shared short value would mean things like "which
  // repo you're currently viewing" silently vanishing after a short idle
  // gap, even with Repo View's own buttons still on screen. Kept separate,
  // with the general one long enough to survive normal gaps in checking
  // the bot throughout a day.
  WIZARD_SESSION_TTL_SECONDS: 30 * 60, // 30 min — abandoned upload file buffers only
  SESSION_TTL_SECONDS: Number(process.env.SESSION_TTL_SECONDS || 24 * 60 * 60), // 24h — general ctx.session state

  // Memory management — tuned for Railway's 512MB free-tier ceiling.
  // See README "Memory & stability" section for the full explanation.
  PG_POOL_MAX: Number(process.env.PG_POOL_MAX || 3),
  MEMORY_WATCHDOG_MB: Number(process.env.MEMORY_WATCHDOG_MB || 400),
  MEMORY_WATCHDOG_CHECK_INTERVAL_MS: 30 * 1000,

  // Verifies incoming webhook requests actually came from Telegram. Falls
  // back to a value derived from SESSION_JWT_SECRET if not explicitly set,
  // so the bot still works without extra setup — but a dedicated secret
  // (openssl rand -hex 24) is strongly recommended for a public URL.
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET ||
    crypto.createHash('sha256').update(process.env.SESSION_JWT_SECRET || 'fallback').digest('hex').slice(0, 32),
};
