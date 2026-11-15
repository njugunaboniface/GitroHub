const { pool } = require('../db/postgres');

/**
 * 📤 Scheduled Uploads — commits/uploads to an EXISTING repo at a future
 * time, as opposed to 🆕 Scheduled Repos (which creates a new one).
 *
 * Two shapes share this one table, distinguished by `file_count`:
 *   - Single file (file_count = 1, the original/default shape): held as
 *     a Telegram file_id and re-downloaded fresh at execution time —
 *     same proven approach as 🗑️ Trash's backup snapshots. file_id/
 *     file_name are set, no scheduled_upload_files rows exist.
 *   - Multi-file (file_count > 1 — an extracted zip/tar with more than
 *     one changed file): file_id/file_name are NULL; the actual bytes
 *     for every file live in scheduled_upload_files instead, stored
 *     once at schedule-creation time rather than re-derived by
 *     re-downloading and re-extracting the original archive later — see
 *     schema.sql's comment on that table for why re-extraction wasn't
 *     the safer choice here.
 */
async function create(telegramId, { repoName, targetPath, commitMessage, fileId, fileName, isArchive, archiveAction, scheduledFor, files }) {
  // v1.2.5-multi: remember the GitHub account (and the owner — person or organisation) the repo was picked
  // under, so the upload commits to that exact repo with that account's token, whatever is active by then.
  const { owner, account } = await require('./ownerScope').scope(telegramId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO scheduled_uploads
         (telegram_id, repo_name, target_path, commit_message, file_id, file_name, file_count, is_archive, archive_action, scheduled_for, account_login, owner_login)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        telegramId, repoName, targetPath || null, commitMessage || null,
        files && files.length ? null : fileId,
        files && files.length ? null : fileName,
        files && files.length ? files.length : 1,
        !!isArchive, archiveAction || null, scheduledFor, account, owner,
      ]
    );
    const row = rows[0];
    if (files && files.length) {
      for (const f of files) {
        await client.query(
          'INSERT INTO scheduled_upload_files (scheduled_upload_id, path, content) VALUES ($1, $2, $3)',
          [row.id, f.path, f.content]
        );
      }
    }
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Reads back every file for a multi-file schedule — the poller's
 * execution-time counterpart to the `files` array passed into create().
 * Empty array for a single-file schedule (nothing was ever inserted). */
async function getFiles(scheduledUploadId) {
  const { rows } = await pool.query(
    'SELECT path, content FROM scheduled_upload_files WHERE scheduled_upload_id = $1 ORDER BY id ASC',
    [scheduledUploadId]
  );
  return rows;
}

async function listPending(telegramId) {
  const { rows } = await pool.query(
    `SELECT * FROM scheduled_uploads WHERE telegram_id = $1 AND status = 'pending' ORDER BY scheduled_for ASC`,
    [telegramId]
  );
  return rows;
}

async function get(telegramId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM scheduled_uploads WHERE telegram_id = $1 AND id = $2`,
    [telegramId, id]
  );
  return rows[0] || null;
}

/** Deletes the stored file bytes of a schedule. Called for every terminal
 * state (completed / cancelled / failed) — once a schedule can no longer run
 * its bytes are dead weight, and (v1.1.7-multi) the Privacy Policy promises
 * GitroHub doesn't keep copies of file contents beyond what a pending
 * schedule needs. Idempotent; the metadata row stays for history. */
async function purgeFiles(scheduledUploadId) {
  await pool.query('DELETE FROM scheduled_upload_files WHERE scheduled_upload_id = $1', [scheduledUploadId]);
}

/** Sweeps bytes left behind by schedules that finished BEFORE purgeFiles
 * existed (or whose purge failed). Run from the daily prune. Returns the
 * number of file rows removed. */
async function purgeFinishedFiles() {
  const { rowCount } = await pool.query(
    `DELETE FROM scheduled_upload_files f
       USING scheduled_uploads s
      WHERE s.id = f.scheduled_upload_id AND s.status <> 'pending'`
  );
  return rowCount || 0;
}

async function cancel(telegramId, id) {
  const { rows, rowCount } = await pool.query(
    `UPDATE scheduled_uploads SET status = 'cancelled' WHERE telegram_id = $1 AND id = $2 AND status = 'pending' RETURNING repo_name, file_name, file_id, owner_login`,
    [telegramId, id]
  );
  if (rowCount) await purgeFiles(id);
  // v1.3.0-multi: a cancelled single-file upload can be brought back (while its time is still ahead). Multi-file ones
  // lose their stored bytes on cancel, so they are not offered.
  if (rowCount && rows && rows[0] && rows[0].file_id) require('./softDelete').stash(telegramId, 'schedule', `Scheduled upload: ${rows[0].file_name || 'file'} → ${rows[0].repo_name}`, { type: 'schedule', table: 'scheduled_uploads', id: Number(id) }, { ownerLogin: rows[0].owner_login });
  return rowCount > 0;
}

/** Cancels every still-pending scheduled upload aimed at one repo (used when that repo is deleted,
 * since they could only fail later). Returns how many were cancelled. */
async function cancelForRepo(telegramId, repoName) {
  const { rows } = await pool.query(
    `UPDATE scheduled_uploads SET status = 'cancelled'
     WHERE telegram_id = $1 AND repo_name = $2 AND status = 'pending' RETURNING id`,
    [telegramId, repoName]
  );
  for (const r of rows) await purgeFiles(r.id);
  return rows.length;
}

/** Edits one field of a still-pending scheduled upload — the "✏️ Edit"
 * flow in handlers/scheduledUploads.js. Whitelisted column map (not raw
 * string interpolation of the field name), same reasoning as
 * scheduledRepos.js's own updateField. */
const EDITABLE_FIELDS = {
  targetPath: 'target_path', commitMessage: 'commit_message', scheduledFor: 'scheduled_for',
};
async function updateField(telegramId, id, field, value) {
  const col = EDITABLE_FIELDS[field];
  if (!col) throw new Error(`Unknown scheduled_uploads field: ${field}`);
  await pool.query(
    `UPDATE scheduled_uploads SET ${col} = $1 WHERE telegram_id = $2 AND id = $3 AND status = 'pending'`,
    [value, telegramId, id]
  );
}

/** Everything due right now, across every user — polled every minute by
 * index.js, same cadence as Scheduled Repos for the same reason (a
 * schedule implies real timing precision). */
async function claimById(telegramId, id) {
  const { rows } = await pool.query(
    `UPDATE scheduled_uploads SET status = 'processing', processing_at = now()
     WHERE telegram_id = $1 AND id = $2 AND status = 'pending'
     RETURNING *`,
    [telegramId, id]
  );
  return rows[0] || null;
}

async function claimDue() {
  const { rows } = await pool.query(`UPDATE scheduled_uploads SET status = 'processing', processing_at = now() WHERE id IN (SELECT id FROM scheduled_uploads WHERE (status = 'pending' AND scheduled_for <= now()) OR (status = 'processing' AND processing_at < now() - interval '10 minutes') ORDER BY scheduled_for ASC FOR UPDATE SKIP LOCKED) RETURNING *`);
  return rows;
}

async function touchProcessing(id) {
  await pool.query(`UPDATE scheduled_uploads SET processing_at = now() WHERE id = $1 AND status = 'processing'`, [id]);
}

async function returnToPending(id, errorMessage = null) {
  await pool.query(
    `UPDATE scheduled_uploads SET status = 'pending', processing_at = NULL, error_message = $2
     WHERE id = $1 AND status = 'processing'`,
    [id, errorMessage]
  );
}

async function markCompleted(id) {
  await pool.query(`UPDATE scheduled_uploads SET status = 'completed', processing_at = NULL WHERE id = $1 AND status = 'processing'`, [id]);
  await purgeFiles(id);
}

async function markFailed(id, errorMessage) {
  await pool.query(`UPDATE scheduled_uploads SET status = 'failed', error_message = $2, processing_at = NULL WHERE id = $1 AND status = 'processing'`, [id, errorMessage]);
  await purgeFiles(id);
}

module.exports = { create, getFiles, listPending, get, cancel, cancelForRepo, updateField, claimById, claimDue, getDue: claimDue, touchProcessing, returnToPending, markCompleted, markFailed, purgeFiles, purgeFinishedFiles };
