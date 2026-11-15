/**
 * Batched retention (v1.2.1-multi). Deleting a large backlog in ONE statement
 * holds locks, bloats WAL and can stall the connection pool for everyone —
 * cleanup must not become the biggest database load. This deletes in small
 * batches with a short pause between them, and caps the work per run (the
 * remainder is picked up by the next scheduled run), so pruning stays a
 * steady trickle.
 *
 *   DELETE FROM t WHERE ctid = ANY(ARRAY(SELECT ctid FROM t WHERE <cond> LIMIT $n))
 *
 * `cond` is a trusted constant from this codebase (never user input).
 */
const { pool } = require('../db/postgres');
const logger = require('./logger');
const metrics = require('./metrics');

const M = {
  deleted: metrics.counter('retention_rows_deleted', 'Rows removed by retention jobs, by table'),
  ms: metrics.histogram('retention_duration_ms', 'Duration of a retention run, by table', [10, 100, 500, 1000, 5000, 15000, 60000, 300000]),
};

const BATCH_SIZE = Number(process.env.RETENTION_BATCH_SIZE) || 5000;
const MAX_BATCHES = Number(process.env.RETENTION_MAX_BATCHES) || 200;
const PAUSE_MS = Number(process.env.RETENTION_PAUSE_MS) || 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} table  trusted table name
 * @param {string} cond   trusted SQL condition; may use $2.. for `params`
 * @param {any[]} params  values for $2.. (the batch size is always $1)
 * @returns {Promise<{deleted:number, batches:number, capped:boolean}>}
 */
async function pruneBatched(table, cond, params = [], { batchSize = BATCH_SIZE, maxBatches = MAX_BATCHES, pauseMs = PAUSE_MS, db = pool } = {}) {
  const t0 = Date.now();
  let deleted = 0; let batches = 0; let capped = false;
  for (;;) {
    const { rowCount } = await db.query(`DELETE FROM ${table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${table} WHERE ${cond} LIMIT $1))`, [batchSize, ...params]);
    deleted += rowCount; batches++;
    if (rowCount < batchSize) break;
    if (batches >= maxBatches) { capped = true; break; }
    if (pauseMs) await sleep(pauseMs);
  }
  if (deleted) M.deleted.inc({ table }, deleted);
  M.ms.observe({ table }, Date.now() - t0);
  if (capped) logger.warn('Retention run capped — the rest will be removed on the next run', { table, deleted });
  return { deleted, batches, capped };
}

module.exports = { pruneBatched, BATCH_SIZE, MAX_BATCHES };
