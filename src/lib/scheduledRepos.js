const { pool } = require('../db/postgres');

/**
 * 🆕 Scheduled Repos — a repo's full configuration (name, visibility,
 * description, license, gitignore, starter template, README choice) collected up front through the normal
 * Create Repo wizard, but with the actual GitHub creation deferred to a
 * future time. "Committed" here in the sense the person used it: the
 * point at which the repo (and its initial commit — GitHub's auto_init)
 * actually appears.
 */
async function create(telegramId, { name, description, visibility, license, gitignore, includeReadme, template, scheduledFor }) {
  // v1.2.5-multi: the job remembers the GitHub account it was scheduled under and runs as THAT account,
  // even if the person switches accounts before it fires.
  const { account } = await require('./ownerScope').scope(telegramId);
  const org = await require('./accounts').getActiveOwner(telegramId).catch(() => null);
  const { rows } = await pool.query(
    `INSERT INTO scheduled_repos (telegram_id, name, description, visibility, license, gitignore, include_readme, template, scheduled_for, account_login, owner_login)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [telegramId, name, description || null, visibility, license || null, gitignore || null, includeReadme !== false, template || null, scheduledFor, account, org || null]
  );
  return rows[0];
}

async function listPending(telegramId) {
  const { rows } = await pool.query(
    `SELECT * FROM scheduled_repos WHERE telegram_id = $1 AND status = 'pending' ORDER BY scheduled_for ASC`,
    [telegramId]
  );
  return rows;
}

async function get(telegramId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM scheduled_repos WHERE telegram_id = $1 AND id = $2`,
    [telegramId, id]
  );
  return rows[0] || null;
}

async function cancel(telegramId, id) {
  const { rows, rowCount } = await pool.query(
    `UPDATE scheduled_repos SET status = 'cancelled' WHERE telegram_id = $1 AND id = $2 AND status = 'pending' RETURNING name, owner_login`,
    [telegramId, id]
  );
  // v1.3.0-multi: a cancelled schedule can be brought back (while its time is still ahead) from 🧯 Restore center.
  if (rowCount > 0 && rows && rows[0]) require('./softDelete').stash(telegramId, 'schedule', `Scheduled repo: ${rows[0].name}`, { type: 'schedule', table: 'scheduled_repos', id: Number(id) }, { ownerLogin: rows[0].owner_login });
  return rowCount > 0;
}

/** Edits one field of a still-pending scheduled repo — the "✏️ Edit" flow
 * in handlers/scheduledRepos.js. Whitelisted column map (not raw string
 * interpolation of the field name) so this can never be pointed at an
 * arbitrary column. */
const EDITABLE_FIELDS = {
  name: 'name', description: 'description', visibility: 'visibility',
  license: 'license', gitignore: 'gitignore', scheduledFor: 'scheduled_for',
};
async function updateField(telegramId, id, field, value) {
  const col = EDITABLE_FIELDS[field];
  if (!col) throw new Error(`Unknown scheduled_repos field: ${field}`);
  await pool.query(
    `UPDATE scheduled_repos SET ${col} = $1 WHERE telegram_id = $2 AND id = $3 AND status = 'pending'`,
    [value, telegramId, id]
  );
}

/** Atomically claims one pending row by id (used by "Run now"); null if it isn't pending. */
async function claimById(telegramId, id) {
  const { rows } = await pool.query(
    `UPDATE scheduled_repos SET status = 'processing', processing_at = now()
     WHERE telegram_id = $1 AND id = $2 AND status = 'pending'
     RETURNING *`,
    [telegramId, id]
  );
  return rows[0] || null;
}

/** Claims everything due right now, across every user — polled every minute by index.js
 * (a schedule implies timing precision the hourly automation scheduler doesn't give, so it
 * has its own faster loop). Claiming flips each row to 'processing' in the same statement, which
 * is why the poller calls it `getDue` (an alias, kept for readability at the call site) —
 * despite that name it MUTATES the rows it returns. A row stuck in 'processing' for more than
 * 10 minutes (a crash mid-run) is claimed again. */
async function claimDue() {
  const { rows } = await pool.query(`UPDATE scheduled_repos SET status = 'processing', processing_at = now() WHERE id IN (SELECT id FROM scheduled_repos WHERE (status = 'pending' AND scheduled_for <= now()) OR (status = 'processing' AND processing_at < now() - interval '10 minutes') ORDER BY scheduled_for ASC FOR UPDATE SKIP LOCKED) RETURNING *`);
  return rows;
}

async function touchProcessing(id) {
  await pool.query(`UPDATE scheduled_repos SET processing_at = now() WHERE id = $1 AND status = 'processing'`, [id]);
}

async function returnToPending(id, errorMessage = null) {
  await pool.query(
    `UPDATE scheduled_repos SET status = 'pending', processing_at = NULL, error_message = $2
     WHERE id = $1 AND status = 'processing'`,
    [id, errorMessage]
  );
}

async function markCompleted(id) {
  await pool.query(`UPDATE scheduled_repos SET status = 'completed', processing_at = NULL WHERE id = $1 AND status = 'processing'`, [id]);
}

async function markFailed(id, errorMessage) {
  await pool.query(`UPDATE scheduled_repos SET status = 'failed', error_message = $2, processing_at = NULL WHERE id = $1 AND status = 'processing'`, [id, errorMessage]);
}

module.exports = { create, listPending, get, cancel, updateField, claimById, claimDue, getDue: claimDue, touchProcessing, returnToPending, markCompleted, markFailed };
