const { pool } = require('../db/postgres');
const config = require('../config');

/**
 * 👑 Admin Roles — four tiers, no longer confined to config.ADMIN_IDS.
 * ADMIN_IDS/.env is still how an existing deployment's initial admins get
 * seeded (see seedFromConfig, idempotent at every boot), but a
 * super_admin can now promote ANY user who has ever /start'd the bot
 * straight from their 👤 User Detail card — admin_roles is the actual
 * source of truth for Dashboard access, config.ADMIN_IDS is just its
 * initial seed data. This is what makes "promote a user directly to a
 * role" possible without editing .env and redeploying.
 *
 *   guest       — view Dashboard/Stats/Audit Log/Users only, no actions
 *   moderator   — + ban/suspend/message/notes/trust
 *   admin       — + repo moderation, limits override, resolve reports
 *   super_admin — + permanent Delete User, broadcast, bulk hub, global config,
 *                   role management
 *
 * 👑 Owner (config.OWNER_ID) sits above all four tiers as a fixed point,
 * not a fifth role — see isOwner() and handlers/admin.js's executeSetRole,
 * which refuses to change the Owner's role no matter who's asking,
 * including other super_admins. The Owner is always also a super_admin
 * (seedFromConfig forces this), so isOwner is a targeting check on top
 * of the normal rank system, not a separate permission tier of its own.
 */
const ROLES = ['guest', 'moderator', 'admin', 'super_admin'];
const RANK = { guest: 0, moderator: 1, admin: 2, super_admin: 3 };

function rank(role) {
  return Object.prototype.hasOwnProperty.call(RANK, role) ? RANK[role] : -1;
}

function atLeast(role, min) {
  return rank(role) >= rank(min);
}

function isOwner(telegramId) {
  return Number(telegramId) === config.OWNER_ID;
}

/** Live lookup, not cached — role checks aren't on a hot enough path
 * (one query per admin action, not per message like accessControl's
 * suspension check) to justify the staleness tradeoff globalConfig's
 * cache accepts for its much-hotter-path reads.
 *
 * Fallback only applies to people actually IN config.ADMIN_IDS — anyone
 * else with no admin_roles row is a completely ordinary user and
 * defaults to 'guest' (meaning: no Dashboard access at all, since
 * requireAdmin/accessControl both gate on the ADMIN_IDS/hasRole checks,
 * not on getRole alone). This is what makes it safe to call getRole() on
 * an arbitrary user being considered for promotion — it never silently
 * reports someone as already 'admin'. */
async function getRole(telegramId) {
  const id = Number(telegramId);
  const { rows } = await pool.query('SELECT role FROM admin_roles WHERE telegram_id = $1', [id]);
  if (rows[0]) return rows[0].role;
  if (config.ADMIN_IDS.includes(id)) {
    return config.SUPER_ADMIN_IDS.includes(id) ? 'super_admin' : 'admin';
  }
  return 'guest';
}

/** Does this person have ANY admin_roles row at all, regardless of what
 * role it says? Used by accessControl.js to decide base Dashboard access
 * for someone NOT in config.ADMIN_IDS — a super_admin promoting them to
 * even 'guest' explicitly is what grants that base access; getRole()
 * alone can't answer this because its fallback for a random non-admin
 * user is also 'guest', which would be indistinguishable from "actually
 * promoted to guest" without checking row existence directly. */
async function hasRole(telegramId) {
  const { rows } = await pool.query('SELECT 1 FROM admin_roles WHERE telegram_id = $1', [telegramId]);
  return !!rows[0];
}

/** Seeds every current config.ADMIN_IDS member with their role at
 * boot — idempotent (ON CONFLICT DO NOTHING), so this runs every startup
 * and only ever fills in rows that don't exist yet. This is what makes
 * upgrading to roles a no-op for an existing deployment: everyone keeps
 * exactly the access they had (admin, or super_admin if they were in
 * SUPER_ADMIN_IDS) until a super_admin explicitly changes someone's role.
 * config.OWNER_ID is always force-seeded as 'super_admin' regardless of
 * SUPER_ADMIN_IDS, so the Owner never starts at a lower tier even if
 * SUPER_ADMIN_IDS was configured without them explicitly listed. */
async function seedFromConfig() {
  for (const id of config.ADMIN_IDS) {
    const role = id === config.OWNER_ID || config.SUPER_ADMIN_IDS.includes(id) ? 'super_admin' : 'admin';
    await pool.query(
      `INSERT INTO admin_roles (telegram_id, role, granted_by, granted_at) VALUES ($1, $2, NULL, now())
       ON CONFLICT (telegram_id) DO NOTHING`,
      [id, role]
    );
  }
  // Defensive: if a users row already existed for someone before they
  // were added to ADMIN_IDS, and they haven't messaged the bot since
  // (so lib/users.js's ensureUser self-heal hasn't had a chance to run),
  // their is_admin could still be FALSE. Only touches rows that already
  // exist — someone who has genuinely never /start'd isn't created here.
  if (config.ADMIN_IDS.length) {
    await pool.query('UPDATE users SET is_admin = TRUE WHERE telegram_id = ANY($1::bigint[]) AND is_admin = FALSE', [config.ADMIN_IDS]);
  }
}

/** Everyone with an actual admin_roles row — this is now the real
 * roster (promoted users included, not just config.ADMIN_IDS members) —
 * unioned with any config.ADMIN_IDS entry not yet seeded (before the
 * next boot's seedFromConfig runs), so a freshly-added env admin still
 * shows up here even one request before they're formally seeded. */
async function listAdmins() {
  const { rows } = await pool.query(
    `SELECT r.telegram_id, r.role, r.granted_by, r.granted_at, u.telegram_username, u.telegram_first_name
     FROM admin_roles r LEFT JOIN users u ON u.telegram_id = r.telegram_id
     ORDER BY CASE r.role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, r.telegram_id`
  );
  // Normalise to numbers so the Set/=== comparisons below (and in the
  // callers that compare against config.OWNER_ID) can never be tripped by a
  // string-typed BIGINT.
  for (const r of rows) {
    r.telegram_id = Number(r.telegram_id);
    if (r.granted_by !== null && r.granted_by !== undefined) r.granted_by = Number(r.granted_by);
  }
  const known = new Set(rows.map((r) => r.telegram_id));
  const missing = config.ADMIN_IDS.filter((id) => !known.has(id));
  for (const id of missing) {
    rows.push({
      telegram_id: id,
      role: id === config.OWNER_ID || config.SUPER_ADMIN_IDS.includes(id) ? 'super_admin' : 'admin',
      granted_by: null, granted_at: null, telegram_username: null, telegram_first_name: null,
    });
  }
  return rows;
}

async function countSuperAdmins() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM admin_roles WHERE role = 'super_admin'`);
  return rows[0].c;
}

/** Grants (or changes) a role for ANY telegram_id — the person doesn't
 * need to already be in config.ADMIN_IDS. Caller (handlers/admin.js's
 * executeSetRole) is responsible for the isOwner()/self/last-super_admin
 * guardrails; this function itself has no opinion on who SHOULD be
 * promotable, only on how the row gets written once that's decided.
 *
 * Also stamps users.is_admin = TRUE directly, rather than waiting for
 * the target's next message to reach lib/users.js's ensureUser self-heal
 * (which computes the same thing correctly, just lazily). Belt-and-
 * suspenders, same philosophy as accessControl.js's own admin check:
 * a promotion should take effect immediately everywhere that reads
 * users.is_admin (Bulk hub exclusions, 🚩 Suspicious flagging, the OAuth
 * callback's post-connect menu), not just the next time they happen to
 * text the bot. */
async function setRole(grantedBy, targetId, role) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  await pool.query(
    `INSERT INTO admin_roles (telegram_id, role, granted_by, granted_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (telegram_id) DO UPDATE SET role = $2, granted_by = $3, granted_at = now()`,
    [targetId, role, grantedBy]
  );
  await pool.query('UPDATE users SET is_admin = TRUE WHERE telegram_id = $1', [targetId]);
}

/** 🗑️ Full revoke — deletes the admin_roles row entirely, not just sets
 * it to 'guest'. This is the actual difference between the two: 'guest'
 * is still a role (still shows up in 👑 Admins, still gets Dashboard
 * view access, still counts as "protected" for isProtectedAdmin's
 * ban/suspend/delete immunity) — revoke removes every trace of Dashboard
 * standing, making the person a completely ordinary user again, same as
 * someone who never had a role at all. Only meaningful for someone NOT
 * in config.ADMIN_IDS: an env-configured admin always has at least
 * 'admin' as getRole()'s fallback the moment their row is gone, so
 * revoking one of them just re-seeds them right back (handlers/admin.js's
 * executeRevokeRole blocks this case with a clear message rather than
 * silently no-op'ing).
 *
 * Stamps users.is_admin = FALSE immediately for the same
 * immediate-effect reason setRole() stamps it TRUE — safe to do
 * unconditionally here because executeRevokeRole already refuses this
 * call entirely for anyone in config.ADMIN_IDS, so by the time this
 * runs the target is guaranteed to not need is_admin = TRUE from that
 * side. */
async function revokeRole(targetId) {
  await pool.query('DELETE FROM admin_roles WHERE telegram_id = $1', [targetId]);
  await pool.query('UPDATE users SET is_admin = FALSE WHERE telegram_id = $1', [targetId]);
}

module.exports = { ROLES, RANK, rank, atLeast, isOwner, getRole, hasRole, seedFromConfig, listAdmins, countSuperAdmins, setRole, revokeRole };
