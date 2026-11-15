/**
 * Real-PostgreSQL query handler for offline tests (v1.2.5-multi).
 *
 * scripts/lib/testEnv.js swaps the `pg` package for an in-memory stand-in whose answers come from
 * `setQueryHandler`. Most tests script those answers by hand. This module is the other option: it sends
 * the SQL to a REAL local PostgreSQL through the `psql` binary, so a test can prove that a query, a
 * constraint or a migration actually works — not just that the code produced a string.
 *
 *   const realPg = require('./lib/realPg');
 *   if (!realPg.available()) { skip… }
 *   const db = realPg.createDb('gh_test');           // fresh database with src/db/schema.sql applied
 *   t.setQueryHandler(db.handler);                   // every pool.query now runs on real Postgres
 *
 * Parameters ($1, $2…) are substituted client-side as escaped literals, which is safe here because the
 * values come from the tests themselves. Transactions are no-ops (each statement is its own psql run).
 */
const { spawnSync, execFile, spawn } = require('child_process');
const path = require('path');

const HOST = process.env.TEST_PGHOST || '/tmp';
const PORT = process.env.TEST_PGPORT || '5544';
const USER = process.env.TEST_PGUSER || 'postgres';
const SCHEMA = path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql');

function baseArgs(db) {
  return ['-X', '-A', '-t', '-h', HOST, '-p', String(PORT), '-U', USER, '-d', db];
}

function available() {
  const r = spawnSync('psql', [...baseArgs('postgres'), '-c', 'select 1'], { encoding: 'utf8' });
  return r.status === 0;
}

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map(literal).join(',')}]` : "'{}'";
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function bind(sql, params) {
  if (!params || !params.length) return sql;
  return sql.replace(/\$(\d+)/g, (m, n) => {
    const i = Number(n) - 1;
    return i < params.length ? literal(params[i]) : m;
  });
}

function run(db, sql) {
  return new Promise((resolve, reject) => {
    const child = execFile('psql', [...baseArgs(db), '-v', 'ON_ERROR_STOP=1'], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || err.message || '').trim().split('\n')[0].replace(/^psql:.*?ERROR:\s*/, ''));
        e.code = (/\(SQLSTATE (\w+)\)/.exec(stderr || '') || [])[1];
        const m = /ERROR:\s+(.*)/.exec(stderr || '');
        if (m) e.message = m[1];
        e.detail = stderr;
        return reject(e);
      }
      resolve(stdout);
    });
    child.stdin.end(sql);
  });
}

/**
 * A persistent psql session (one real connection), so BEGIN / COMMIT / ROLLBACK genuinely span statements —
 * what `pool.connect()` clients are used for (the instance import runs inside one transaction).
 * Protocol: each statement is followed by a marker line on BOTH stdout and stderr; we read until we see it.
 */
function makeSession(db) {
  const child = spawn('psql', [...baseArgs(db), '-q'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let outBuf = ''; let errBuf = '';
  const waiters = [];
  child.stdout.on('data', (d) => { outBuf += d; pump(); });
  child.stderr.on('data', (d) => { errBuf += d; pump(); });
  let seq = 0;
  function pump() {
    while (waiters.length) {
      const w = waiters[0];
      const oi = outBuf.indexOf(w.marker); const ei = errBuf.indexOf(w.marker);
      if (oi < 0 || ei < 0) return;
      const out = outBuf.slice(0, oi); const err = errBuf.slice(0, ei);
      outBuf = outBuf.slice(oi + w.marker.length).replace(/^\r?\n/, '');
      errBuf = errBuf.slice(ei + w.marker.length).replace(/^\r?\n/, '');
      waiters.shift();
      w.done(out, err);
    }
  }
  function exec(sqlText) {
    return new Promise((resolve) => {
      const marker = `@@DONE${++seq}@@`;
      waiters.push({ marker, done: (out, err) => resolve({ out, err }) });
      child.stdin.write(`${sqlText};\n\\echo ${marker}\n\\warn ${marker}\n`);
    });
  }
  const client = {
    async query(sqlText, params) {
      const trimmed = String(sqlText).trim().replace(/;+\s*$/, '');
      const sql = bind(trimmed, params);
      const returnsRows = /^(SELECT|WITH|VALUES)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
      const stmt = returnsRows ? `WITH q AS (${sql}) SELECT COALESCE(jsonb_agg(to_jsonb(q)), '[]'::jsonb)::text FROM q` : sql;
      const { out, err } = await exec(stmt);
      if (/ERROR:/.test(err)) {
        const e = new Error((/ERROR:\s+(.*)/.exec(err) || [])[1] || err.trim());
        e.detail = err;
        throw e;
      }
      if (returnsRows) { const rows = JSON.parse(out.trim() || '[]'); return { rows, rowCount: rows.length }; }
      const tag = /^(?:INSERT \d+|UPDATE|DELETE|MERGE|COPY)\s+(\d+)\s*$/m.exec(out);
      return { rows: [], rowCount: tag ? Number(tag[1]) : 0 };
    },
    release() { try { child.stdin.end(); } catch (_) { /* gone */ } },
  };
  return client;
}

function makeHandler(db) {
  const handler = async function handler(sqlText, params) {
    const trimmed = String(sqlText).trim().replace(/;+\s*$/, '');
    if (/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/i.test(trimmed)) return { rows: [], rowCount: 0 };
    const sql = bind(trimmed, params);
    const returnsRows = /^(SELECT|WITH|VALUES)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    if (returnsRows) {
      const wrapped = `WITH q AS (${sql}) SELECT COALESCE(jsonb_agg(to_jsonb(q)), '[]'::jsonb)::text FROM q`;
      const out = await run(db, wrapped);
      const rows = JSON.parse(out.trim() || '[]');
      return { rows, rowCount: rows.length };
    }
    // DML/DDL without RETURNING: psql prints the command tag ("UPDATE 3") because -q is not set.
    const out = await run(db, sql + ';');
    const tag = /^(?:INSERT \d+|UPDATE|DELETE|MERGE|COPY|SELECT)\s+(\d+)\s*$/m.exec(out);
    return { rows: [], rowCount: tag ? Number(tag[1]) : 0 };
  };
  // pool.connect() → a real, persistent session (transactions work for real).
  handler.connect = async () => makeSession(db);
  return handler;
}

/** Drops and recreates `name`, applies the schema, returns { name, handler, query, drop }. */
function createDb(name, { applySchema = true } = {}) {
  spawnSync('dropdb', ['-h', HOST, '-p', String(PORT), '-U', USER, '--if-exists', name]);
  const c = spawnSync('createdb', ['-h', HOST, '-p', String(PORT), '-U', USER, name], { encoding: 'utf8' });
  if (c.status !== 0) throw new Error(`createdb failed: ${c.stderr}`);
  if (applySchema) {
    const s = spawnSync('psql', [...baseArgs(name), '-q', '-v', 'ON_ERROR_STOP=1', '-f', SCHEMA], { encoding: 'utf8' });
    if (s.status !== 0) throw new Error(`schema failed: ${s.stderr}`);
  }
  const handler = makeHandler(name);
  return {
    name,
    handler,
    query: handler,
    applySchemaAgain() {
      const s = spawnSync('psql', [...baseArgs(name), '-q', '-v', 'ON_ERROR_STOP=1', '-f', SCHEMA], { encoding: 'utf8' });
      if (s.status !== 0) throw new Error(`schema (2nd run) failed: ${s.stderr}`);
    },
    drop() { spawnSync('dropdb', ['-h', HOST, '-p', String(PORT), '-U', USER, '--if-exists', name]); },
  };
}

module.exports = { available, createDb, makeHandler, bind, literal };
