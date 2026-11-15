/**
 * 🛡 Repo Shield — the OWNER decides whose repositories other admins may not
 * view, download, delete or change from the Dashboard. Set per account or in
 * bulk; every bulk change is recorded so it can be undone in one tap.
 *
 * Enforcement lives in adminActions.assertRepoModerationAllowed (the action
 * layer), so a stale or hand-crafted button can't get around it. The owner is
 * never blocked, and blocked attempts are written to the audit log.
 */
const { pool } = require('../db/postgres');
const roles = require('./roles');
const adminActions = require('./adminActions');

const SCOPES = {
  connected: { label: 'every connected user', where: 'github_token_enc IS NOT NULL' },
  trusted: { label: 'every ⭐ Trusted user', where: 'is_trusted = TRUE' },
  everyone: { label: 'every non-admin user', where: 'TRUE' },
};

function assertOwner(actorId) {
  if (!roles.isOwner(actorId)) {
    const err = new Error('Only the owner can change Repo Shield.');
    err.code = 'OWNER_ONLY';
    throw err;
  }
}

/** Protect/unprotect ONE account. */
async function setOne(actorId, targetId, protect) {
  assertOwner(actorId);
  if (roles.isOwner(targetId)) return false; // the owner's own repos are always private already
  const { rowCount } = await pool.query(
    `UPDATE users SET repos_protected = $2, repos_protected_by = $3, repos_protected_at = now()
      WHERE telegram_id = $1 AND repos_protected IS DISTINCT FROM $2`,
    [targetId, !!protect, actorId]
  );
  await adminActions.auditLog(actorId, targetId, protect ? 'repo_shield_on' : 'repo_shield_off');
  dropStats();
  return rowCount > 0;
}

/** How many accounts a bulk change WOULD touch (shown before confirming). */
async function preview(scope, protect) {
  const sc = SCOPES[scope];
  if (!sc) throw new Error(`unknown scope: ${scope}`);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM users WHERE is_admin = FALSE AND (${sc.where}) AND repos_protected IS DISTINCT FROM $1`, [!!protect]
  );
  return { scope, label: sc.label, willChange: rows[0].c };
}

/** Apply a bulk change; remembers exactly which accounts changed so it can be undone. */
async function bulk(actorId, scope, protect) {
  assertOwner(actorId);
  const sc = SCOPES[scope];
  if (!sc) throw new Error(`unknown scope: ${scope}`);
  const { rows } = await pool.query(
    `UPDATE users SET repos_protected = $1, repos_protected_by = $2, repos_protected_at = now()
      WHERE is_admin = FALSE AND (${sc.where}) AND repos_protected IS DISTINCT FROM $1
      RETURNING telegram_id`,
    [!!protect, actorId]
  );
  const affected = rows.map((r) => r.telegram_id);
  const { rows: b } = await pool.query(
    'INSERT INTO repo_shield_batches (actor, action, scope, affected) VALUES ($1, $2, $3, $4::bigint[]) RETURNING id',
    [actorId, protect ? 'protect' : 'unprotect', scope, affected]
  );
  await adminActions.auditLog(actorId, null, protect ? 'repo_shield_bulk_on' : 'repo_shield_bulk_off', `${sc.label}: ${affected.length} account(s)`);
  dropStats();
  return { batchId: b[0].id, changed: affected.length };
}

/** Reverse the most recent bulk change that hasn't been undone. */
async function undoLast(actorId) {
  assertOwner(actorId);
  const { rows } = await pool.query('SELECT * FROM repo_shield_batches WHERE undone_at IS NULL ORDER BY created_at DESC LIMIT 1');
  if (!rows.length) return { ok: false, reason: 'nothing_to_undo' };
  const batch = rows[0];
  const restoreTo = batch.action !== 'protect'; // undoing an "unprotect" re-protects them, and vice versa
  // v1.2.3-multi: only accounts still in the state this batch left them in are restored. An
  // account the owner changed individually AFTER the batch keeps that newer decision instead
  // of being silently overwritten by the undo.
  const { rowCount } = await pool.query(
    `UPDATE users SET repos_protected = $2, repos_protected_by = $3, repos_protected_at = now()
      WHERE telegram_id = ANY($1::bigint[]) AND repos_protected = $4`,
    [batch.affected, restoreTo, actorId, !restoreTo]
  );
  await pool.query('UPDATE repo_shield_batches SET undone_at = now() WHERE id = $1', [batch.id]);
  await adminActions.auditLog(actorId, null, 'repo_shield_undo', `batch #${batch.id}: ${rowCount} account(s)`);
  dropStats();
  return { ok: true, restored: rowCount, action: batch.action };
}

// v1.2.1-multi: the counts below scan the users table, and the Warden menu now
// shows them — so they're cached for a few seconds and dropped on every change,
// instead of re-counting the whole fleet each time an owner opens a screen.
const STATS_TTL_MS = 15000;
let statsCache = null;
const dropStats = () => { statsCache = null; };

async function stats() {
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const value = await computeStats();
  statsCache = { at: Date.now(), value };
  return value;
}

async function computeStats() {
  const [{ rows: s }, { rows: last }] = await Promise.all([
    pool.query(`SELECT COUNT(*) FILTER (WHERE repos_protected)::int AS protected,
                       COUNT(*) FILTER (WHERE github_token_enc IS NOT NULL)::int AS connected,
                       COUNT(*) FILTER (WHERE github_token_enc IS NOT NULL AND repos_protected)::int AS connected_protected,
                       COUNT(*) FILTER (WHERE is_trusted)::int AS trusted,
                       COUNT(*) FILTER (WHERE is_trusted AND repos_protected)::int AS trusted_protected,
                       COUNT(*)::int AS total
                  FROM users WHERE is_admin = FALSE`),
    pool.query('SELECT id, action, scope, cardinality(affected)::int AS n FROM repo_shield_batches WHERE undone_at IS NULL ORDER BY created_at DESC LIMIT 1'),
  ]);
  const c = s[0];
  // Per-scope "how many of how many" — what the three Repo Shield status buttons show.
  const scopes = {
    connected: { total: c.connected, protected: c.connected_protected },
    trusted: { total: c.trusted, protected: c.trusted_protected },
    everyone: { total: c.total, protected: c.protected },
  };
  return { ...c, scopes, lastBatch: last[0] || null };
}

module.exports = { SCOPES, setOne, preview, bulk, undoLast, stats, dropStats };
