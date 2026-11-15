const { pool } = require('../db/postgres');

/**
 * 📢 Scheduled Broadcasts — see schema.sql's comment: one table serves
 * both the future-send queue AND the sent-history log. handlers/admin.js
 * inserts a row for EVERY broadcast, immediate or scheduled, then either
 * sends it inline and marks it 'sent' right away (immediate) or leaves it
 * 'pending' for index.js's poller (scheduled) — same code path either
 * way, so History always reflects exactly what actually went out, not an
 * approximation reconstructed from admin_action_log's truncated detail
 * string.
 */
async function create(adminId, text, entities, sendAt, opts = {}) {
  const { recurrenceType = null, recurrenceIntervalDays = null, recurrenceEndAt = null, viaWarden = false, claimed = false } = opts;
  // `claimed: true` is for IMMEDIATE sends (handlers/admin.js executeBroadcast):
  // the caller sends the broadcast itself within the same request, so the row
  // is born 'processing' instead of 'pending'. Otherwise the every-minute
  // poller could pick a row whose send_at is "now" up while the caller is
  // still mid-send and deliver the same broadcast to everyone a second time
  // (v1.1.23-multi — this window existed before claims too).
  const { rows } = await pool.query(
    `INSERT INTO scheduled_broadcasts
       (admin_id, text, entities, send_at, recurrence_type, recurrence_interval_days, recurrence_end_at, via_warden, status, processing_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${claimed ? 'now()' : 'NULL'}) RETURNING *`,
    [viaWarden ? null : adminId, text, entities && entities.length ? JSON.stringify(entities) : null, sendAt,
      recurrenceType, recurrenceIntervalDays, recurrenceEndAt, viaWarden, claimed ? 'processing' : 'pending']
  );
  return rows[0];
}

/** 🔁 v1.1.8 — repost an already-sent broadcast: clones its text/entities
 * into a brand-new row (own id, own history entry) rather than mutating
 * the original, so the original's history stays an accurate record of
 * what actually happened when it first went out. */
async function repost(sourceId, adminId, sendAt, { claimed = true } = {}) {
  const source = await get(sourceId);
  if (!source) throw new Error('source_not_found');
  // Reposts are always sent immediately by the caller (see claimed note on
  // create()), so the new row is born 'processing' by default.
  const { rows } = await pool.query(
    `INSERT INTO scheduled_broadcasts (admin_id, text, entities, send_at, reposted_from_id, status, processing_at)
     VALUES ($1, $2, $3, $4, $5, $6, ${claimed ? 'now()' : 'NULL'}) RETURNING *`,
    [adminId, source.text, source.entities, sendAt, sourceId, claimed ? 'processing' : 'pending']
  );
  return rows[0];
}

/** Everything due right now — polled every minute by index.js, same
 * cadence Scheduled Repos/Uploads already use. */
async function claimDue() {
  const { rows } = await pool.query(
    `UPDATE scheduled_broadcasts
        SET status = 'processing', processing_at = now()
      WHERE id IN (
        SELECT id FROM scheduled_broadcasts
        WHERE (status = 'pending' AND send_at <= now())
           OR (status = 'processing' AND processing_at < now() - interval '10 minutes')
        ORDER BY send_at ASC
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`
  );
  return rows;
}

/** v1.1.8: recurrence-aware. A one-shot broadcast (recurrence_type NULL)
 * behaves exactly as before — finalized to 'sent'. A recurring one
 * instead has its send_at pushed to the next occurrence and STAYS
 * 'pending', so index.js's poller picks it up again next time it's due
 * — same table, same status field, no separate "recurring queue" to
 * keep in sync with the regular one. Stops re-arming once
 * recurrence_end_at has passed, at which point it finalizes to 'sent'
 * like a normal one-shot on its last firing. */
async function markSent(id, sentCount, totalCount) {
  const row = await get(id);
  if (row && row.recurrence_type) {
    const nextSendAt = new Date(row.send_at.getTime ? row.send_at.getTime() : new Date(row.send_at).getTime());
    const days = row.recurrence_type === 'daily' ? 1 : row.recurrence_type === 'weekly' ? 7 : (row.recurrence_interval_days || 1);
    nextSendAt.setUTCDate(nextSendAt.getUTCDate() + days);
    const expired = row.recurrence_end_at && nextSendAt > new Date(row.recurrence_end_at);
    if (!expired) {
      await pool.query(
        `UPDATE scheduled_broadcasts
           SET status = 'pending', processing_at = NULL, send_at = $2, sent_count = $3, total_count = $4, sent_at = now(), recurrence_fired_count = recurrence_fired_count + 1
         WHERE id = $1 AND status = 'processing'`,
        [id, nextSendAt, sentCount, totalCount]
      );
      return;
    }
  }
  await pool.query(
    `UPDATE scheduled_broadcasts SET status = 'sent', processing_at = NULL, sent_count = $2, total_count = $3, sent_at = now(), recurrence_fired_count = recurrence_fired_count + 1 WHERE id = $1 AND status = 'processing'`,
    [id, sentCount, totalCount]
  );
}

async function touchProcessing(id) {
  await pool.query(`UPDATE scheduled_broadcasts SET processing_at = now() WHERE id = $1 AND status = 'processing'`, [id]);
}

async function markFailed(id, errorMessage) {
  await pool.query(`UPDATE scheduled_broadcasts SET status = 'failed', error_message = $2, processing_at = NULL WHERE id = $1 AND status = 'processing'`, [id, errorMessage]);
}

async function cancel(id) {
  const { rows } = await pool.query(
    `UPDATE scheduled_broadcasts SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id]
  );
  return rows[0] || null; // null means it wasn't pending anymore (already sent/cancelled) — caller should say so, not assume success
}

async function get(id) {
  const { rows } = await pool.query('SELECT * FROM scheduled_broadcasts WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listPending() {
  const { rows } = await pool.query(`SELECT * FROM scheduled_broadcasts WHERE status = 'pending' ORDER BY send_at ASC`);
  return rows;
}

/** 📜 Broadcast History — everything that actually ran (sent/failed) or
 * was cancelled before it could, newest-first. Deliberately excludes
 * still-'pending' rows so a queued-but-not-yet-sent broadcast never gets
 * mistaken here for one that already went out — see listPending() for
 * those. Note: a RECURRING broadcast that has already fired at least
 * once goes back to 'pending' for its next occurrence (see markSent
 * above), so its past firings won't individually appear here — its
 * running total lives on recurrence_fired_count on the row itself,
 * which listPending()'s own display surfaces instead. */
async function history(limit = 8, offset = 0) {
  const { rows } = await pool.query(
    `SELECT * FROM scheduled_broadcasts WHERE status IN ('sent', 'failed', 'cancelled')
     ORDER BY COALESCE(sent_at, created_at) DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM scheduled_broadcasts WHERE status IN ('sent', 'failed', 'cancelled')`
  );
  return { rows, total: countRows[0].c };
}

module.exports = { create, repost, claimDue, getDue: claimDue, markSent, markFailed, touchProcessing, cancel, get, listPending, history };
