const fs = require('fs');
const path = require('path');
const { pool } = require('./postgres');

/**
 * Repairs any serial/bigserial id sequence that has fallen behind the
 * table's actual max(id) — e.g. after an Instance Migration import (see
 * lib/instanceMigration.js), which inserts rows with their original
 * explicit ids after a RESTART IDENTITY. Left unrepaired, the *next*
 * plain INSERT (activity log entries, a new pinned repo, etc. — every
 * normal write the app does) reuses an id that's already taken and dies
 * with "duplicate key value violates unique constraint ..._pkey", even
 * though the action it was logging (disconnect, commit, connect…)
 * already succeeded. Safe to run every boot: it only ever moves a
 * sequence forward, never back, and does nothing on a healthy DB.
 */
async function repairSequences() {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'id'`
  );
  for (const { table_name: t } of tables) {
    const { rows } = await pool.query(`SELECT pg_get_serial_sequence($1, 'id') AS seq`, [t]);
    const seq = rows[0] && rows[0].seq;
    if (!seq) continue; // id isn't a serial/identity column on this table
    await pool.query(
      `SELECT setval($1, COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`,
      [seq]
    );
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  await repairSequences();
  console.log('✅ Database schema is up to date');
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Migration failed:', err);
      process.exit(1);
    });
}

module.exports = { migrate };
