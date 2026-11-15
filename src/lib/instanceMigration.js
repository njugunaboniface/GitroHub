/**
 * 🗄️ INSTANCE EXPORT / IMPORT — v1.1.8
 *
 * Owner-only. Migrates an entire GitroHub deployment from one environment
 * to another, or bootstraps a fresh instance from a snapshot.
 *
 * ── Token security design ──────────────────────────────────────────────
 * GitHub access tokens are stored as AES-256-GCM ciphertext (see
 * lib/crypto.js). A naive db-dump carries that ciphertext — which is
 * useless on a new deployment with a different TOKEN_ENCRYPTION_KEY,
 * and would decrypt to silent garbage rather than a loud error, breaking
 * every user's GitHub connection with no clear signal.
 *
 * Fix: at EXPORT time, each token is decrypted under the SOURCE
 * deployment's real key, then re-encrypted under a fresh single-use
 * TRANSPORT KEY (not the production key — a throwaway that exists only
 * for this migration). The transport key is shown to the Owner ONCE in
 * the bot chat, never written to the export file. At IMPORT time, the
 * Owner pastes that key in; tokens are decrypted from the transport
 * wrapping and immediately re-encrypted under the TARGET deployment's
 * own real key — so production secrets never leave either environment,
 * and the portability of the data doesn't depend on the two deployments
 * having the same key. If the transport key is wrong, GCM's auth tag
 * makes decryption fail deterministically (never silently corrupt), and
 * import stops cleanly.
 *
 * Safety net for unguided restores (e.g. a manual pg_dump/psql):
 * GCM's auth-tag failure is binary and reliable — the wrong key doesn't
 * produce garbled tokens, it throws. lib/users.js's getDecryptedToken()
 * already has a try/catch that treats any decrypt error as "disconnected"
 * and returns null, which causes the normal "reconnect your GitHub"
 * flow. So even a bare pg_restore on a different key just shows users
 * a reconnect prompt — nothing breaks or corrupts.
 */

const crypto = require('crypto');
const { pool } = require('../db/postgres');
const { decrypt, encrypt } = require('./crypto');
const logger = require('./logger');
const zlib = require('zlib');
const { promisify } = require('util');
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);
// Ceiling for what an import may inflate to (the snapshot is JSON; this just stops a bomb).
const MAX_IMPORT_BYTES = Number(process.env.MIGRATION_MAX_IMPORT_BYTES) || 256 * 1024 * 1024;

// ─── Transport key ────────────────────────────────────────────────────
const ALGO = 'aes-256-gcm';

function generateTransportKey() {
  return crypto.randomBytes(32).toString('hex'); // 64-char hex, same shape as TOKEN_ENCRYPTION_KEY
}

function encryptWithKey(plaintext, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decryptWithKey(payload, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const [ivHex, tagHex, dataHex] = payload.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return out.toString('utf8');
}

const WEBHOOK_SECRET_PREFIX = 'enc1:'; // lib/repoWebhooks.js: `enc1:` + AES-GCM payload

// ─── Schema introspection ─────────────────────────────────────────────
/**
 * Discovers all non-system tables in public schema from the DB's own
 * catalog — deliberately not a hard-coded list, so a new migration's
 * table is automatically included without touching this file.
 */
async function discoverTables() {
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  return rows.map((r) => r.tablename);
}

async function dumpTable(tableName) {
  const { rows } = await pool.query(`SELECT * FROM ${tableName}`);
  return rows;
}

// ─── Progress reporting ───────────────────────────────────────────────
/**
 * All progress goes through this callback — the caller (wardenAdmin or
 * admin handler) drives the Telegram message-edit loop, keeping this
 * library free of bot/ctx references.
 */
function makeProgressBar(done, total) {
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  const filled = Math.round(pct / 5);
  return `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${pct}%`;
}

// ─── EXPORT ───────────────────────────────────────────────────────────
/**
 * @param {function(string): Promise<void>} onProgress - called with status text
 * @returns {{ buffer: Buffer, transportKey: string, summary: object }}
 */
async function exportInstance(onProgress) {
  const transportKey = generateTransportKey();
  const tables = await discoverTables();
  const snapshot = { version: 1, exportedAt: new Date().toISOString(), tables: {} };
  const summary = { tableCount: 0, rowCounts: {}, tokenCount: 0 };

  // Phase 1 — Dump all tables
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    await onProgress(`📦 Dumping tables\n${makeProgressBar(i, tables.length)} — ${t}`);
    const rows = await dumpTable(t);
    snapshot.tables[t] = rows;
    summary.rowCounts[t] = rows.length;
    summary.tableCount++;
  }

  // Phase 2 — Re-encrypt tokens under the transport key
  await onProgress(`🔐 Re-encrypting tokens under transport key…`);
  let tokenCount = 0;
  const userRows = snapshot.tables['users'] || [];
  for (const row of userRows) {
    if (row.github_token_enc) {
      try {
        const plaintext = decrypt(row.github_token_enc); // decrypt with SOURCE key
        row.github_token_enc = encryptWithKey(plaintext, transportKey); // re-encrypt for transport
        tokenCount++;
      } catch (e) {
        // Token already broken/stale in source — leave as null so it
        // triggers the clean reconnect flow on import, same as a normal
        // disconnect.
        row.github_token_enc = null;
        logger.warn({ telegramId: row.telegram_id }, 'Export: skipped stale/undecryptable token');
      }
    }
  }
  // v1.2.4-multi: additional GitHub accounts (github_accounts.token_enc) travel the same way.
  for (const row of snapshot.tables['github_accounts'] || []) {
    try {
      row.token_enc = encryptWithKey(decrypt(row.token_enc), transportKey);
      tokenCount++;
    } catch (e) {
      row.token_enc = null; // dropped on import (NOT NULL) — that account simply has to be added again
    }
  }
  snapshot.tables['github_accounts'] = (snapshot.tables['github_accounts'] || []).filter((r) => r.token_enc);
  // v1.2.5-multi: webhook signing secrets are encrypted at rest with this deployment's key too (since 1.2.1),
  // so they must be re-keyed exactly like tokens — otherwise, on a deployment with a different key, every
  // delivery fails signature verification and live alerts silently stop. Secrets that were never encrypted
  // (very old plaintext rows) travel as they are; one that can't be opened is left out (alerts are re-enabled).
  if (snapshot.tables['repo_webhooks']) {
    const kept = [];
    for (const row of snapshot.tables['repo_webhooks']) {
      if (String(row.secret || '').startsWith(WEBHOOK_SECRET_PREFIX)) {
        try {
          row.secret = WEBHOOK_SECRET_PREFIX + encryptWithKey(decrypt(row.secret.slice(WEBHOOK_SECRET_PREFIX.length)), transportKey);
        } catch (e) { continue; }
      }
      kept.push(row);
    }
    snapshot.tables['repo_webhooks'] = kept;
  }
  summary.tokenCount = tokenCount;

  // Phase 3 — Compress
  await onProgress(`🗜️ Compressing…`);
  const json = JSON.stringify(snapshot);
  // Async (libuv threadpool) — a big snapshot must not freeze every other user's taps.
  const buffer = await gzipAsync(Buffer.from(json, 'utf8'));

  await onProgress(`✅ Done — ${tables.length} tables, ${tokenCount} tokens re-keyed.`);
  return { buffer, transportKey, summary };
}

// ─── IMPORT: schema tolerance (v1.2.1-multi) ──────────────────────────
// A snapshot can come from a deployment running a DIFFERENT version of the schema (an older or newer
// build, or a column that was later renamed). Importing used to INSERT every column found in the
// snapshot, so one column this deployment doesn't have ("admin_moderation_protected") aborted the whole
// import and rolled it back. Now the import is matched against THIS database's real columns:
//   • columns the target doesn't have are skipped (and reported),
//   • tables the target doesn't have are skipped, not truncated (and reported),
//   • columns the snapshot doesn't have simply take their defaults,
//   • IMPORT_COLUMN_ALIASES="users.old_name=new_name,..." maps a renamed column across instead of dropping it.
// Skipped columns that look safety-related (protection, trust, ban, suspension…) are called out
// explicitly, because silently dropping one could leave an account less protected than before.
const SAFETY_COLUMN = /protect|shield|trust|block|ban|suspend|lock|admin|role|disconnect/i;

function parseAliases(raw = process.env.IMPORT_COLUMN_ALIASES || '') {
  const map = {};
  for (const part of String(raw).split(',')) {
    const m = /^\s*([a-z0-9_]+)\.([a-z0-9_]+)\s*=\s*([a-z0-9_]+)\s*$/i.exec(part);
    if (m) map[`${m[1]}.${m[2]}`] = m[3];
  }
  return map;
}

/** @returns {Promise<Map<string,string>>} the target's column name → data type for `table` (empty = table doesn't exist) */
async function targetColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return new Map(rows.map((r) => [r.column_name, r.data_type]));
}

/**
 * v1.2.5-multi: a snapshot is plain JSON, so some column types need turning back into what the driver expects:
 *   • bytea  — a Buffer is exported as { type: 'Buffer', data: [...] }
 *   • json/jsonb — must be sent as JSON text (the driver would turn a JS array into a Postgres array literal)
 */
function typedValue(dataType, value) {
  if (value === undefined || value === null) return null;
  if (dataType === 'bytea') {
    if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    return value;
  }
  if (dataType === 'jsonb' || dataType === 'json') return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  return value;
}

/**
 * Foreign keys among the target's tables, so rows can be written parents-first. Alphabetical order (what the
 * import used before) put repo_tags ahead of tags, so ANY instance with a tagged repo failed to import.
 * @returns {Promise<Array<{child:string,parent:string,childCols:string[],parentCols:string[]}>>}
 */
async function foreignKeys(client) {
  const { rows } = await client.query(
    `SELECT cl.relname AS child, pl.relname AS parent,
            (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols,
            (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_cols
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_class pl ON pl.oid = c.confrelid
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`
  );
  const parse = (v) => (Array.isArray(v) ? v : String(v || '').replace(/[{}"]/g, '').split(',').filter(Boolean));
  return rows.map((r) => ({ child: r.child, parent: r.parent, childCols: parse(r.child_cols), parentCols: parse(r.parent_cols) }));
}

/** Tables sorted so every table comes after the tables it references (cycles fall back to name order). */
function orderTables(names, edges) {
  const set = new Set(names);
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const e of edges) if (e.child !== e.parent && set.has(e.child) && set.has(e.parent)) deps.get(e.child).add(e.parent);
  const out = []; const done = new Set();
  const remaining = [...names].sort();
  while (remaining.length) {
    const idx = remaining.findIndex((n) => [...deps.get(n)].every((d) => done.has(d)));
    const pick = idx >= 0 ? idx : 0; // a cycle: take the next one rather than loop forever
    const [n] = remaining.splice(pick, 1);
    out.push(n); done.add(n);
  }
  return out;
}

/** Rows of a self-referencing table (tags.parent_id → tags.id), parents before children; dangling parents become NULL. */
function orderSelfReferencing(rows, col, refCol) {
  const ids = new Set(rows.map((r) => String(r[refCol])));
  const placed = new Set(); const out = []; let pending = rows.map((r) => ({ ...r }));
  for (const r of pending) if (r[col] != null && !ids.has(String(r[col]))) r[col] = null; // parent not in the snapshot
  while (pending.length) {
    const next = [];
    let progressed = false;
    for (const r of pending) {
      if (r[col] == null || placed.has(String(r[col]))) { out.push(r); placed.add(String(r[refCol])); progressed = true; } else next.push(r);
    }
    if (!progressed) { for (const r of next) { r[col] = null; out.push(r); } break; } // a cycle: break it
    pending = next;
  }
  return out;
}

/**
 * After every table is written, make the multi-account data agree with the users that were imported — whatever
 * version the snapshot came from. A pre-1.2.4 snapshot has no github_accounts table at all (so every connected
 * person would have been left with NO account row), and a pre-1.2.4 webhook row has no owner/account.
 * @returns {Promise<{accountsRebuilt:number, accountsDropped:number, webhooksStamped:number}>}
 */
async function reconcileMultiAccount(client) {
  const out = { accountsRebuilt: 0, accountsDropped: 0, webhooksStamped: 0 };
  const has = async (t) => (await targetColumns(client, t)).size > 0;
  if (!(await has('github_accounts'))) return out;
  const added = await client.query(
    `INSERT INTO github_accounts (telegram_id, github_login, token_enc, scope, added_at)
     SELECT telegram_id, github_username, github_token_enc, github_scope, COALESCE(connected_at, now())
       FROM users WHERE github_token_enc IS NOT NULL AND github_username IS NOT NULL
     ON CONFLICT (telegram_id, github_login) DO NOTHING`
  );
  out.accountsRebuilt = added.rowCount || 0;
  const dropped = await client.query('DELETE FROM github_accounts WHERE telegram_id NOT IN (SELECT telegram_id FROM users)');
  out.accountsDropped = dropped.rowCount || 0;
  if (await has('repo_webhooks')) {
    const cols = await targetColumns(client, 'repo_webhooks');
    if (cols.has('owner_login') && cols.has('account_login')) {
      const stamped = await client.query(
        `UPDATE repo_webhooks rw
            SET owner_login = COALESCE(rw.owner_login, fa.github_login), account_login = COALESCE(rw.account_login, fa.github_login)
           FROM (SELECT DISTINCT ON (telegram_id) telegram_id, github_login FROM github_accounts ORDER BY telegram_id, added_at ASC, id ASC) fa
          WHERE fa.telegram_id = rw.telegram_id AND (rw.owner_login IS NULL OR rw.account_login IS NULL)`
      );
      out.webhooksStamped = stamped.rowCount || 0;
    }
  }
  return out;
}

/**
 * Decides which snapshot columns to write for one table.
 * @returns {{ cols: string[], source: Object<string,string>, skipped: string[] }}
 *   cols = target column names to insert; source[col] = the snapshot key to read each from.
 */
function planColumns(table, snapshotKeys, targetCols, aliases) {
  const cols = []; const source = {}; const skipped = [];
  for (const key of snapshotKeys) {
    const mapped = aliases[`${table}.${key}`];
    const dest = targetCols.has(key) ? key : (mapped && targetCols.has(mapped) ? mapped : null);
    if (!dest) { skipped.push(key); continue; }
    if (source[dest] && dest !== key) continue; // an exact-name column always wins over an alias onto the same target
    if (!source[dest]) cols.push(dest);
    source[dest] = key;
  }
  return { cols, source, skipped };
}

// ─── IMPORT ───────────────────────────────────────────────────────────
/**
 * @param {Buffer} gzippedData
 * @param {string} transportKey - the hex key shown at export time
 * @param {function(string): Promise<void>} onProgress
 * @returns {{ tokenResult: 'carried'|'mismatch_cleared', summary: object }}
 */
async function importInstance(gzippedData, transportKey, onProgress) {
  // Phase 1 — Decompress + parse
  await onProgress(`📥 Decompressing snapshot…`);
  let snapshot;
  try {
    const json = (await gunzipAsync(gzippedData, { maxOutputLength: MAX_IMPORT_BYTES })).toString('utf8');
    snapshot = JSON.parse(json);
  } catch (e) {
    throw new Error('Failed to decompress or parse snapshot — is this a valid export file?');
  }
  if (!snapshot.version || !snapshot.tables) {
    throw new Error('Snapshot format not recognised — was this exported by a different tool?');
  }

  // Phase 2 — Validate transport key on a sample token BEFORE writing anything
  await onProgress(`🔓 Validating transport key…`);
  const sampleUsers = (snapshot.tables['users'] || []).filter((u) => u.github_token_enc);
  let tokenResult = 'carried';
  if (sampleUsers.length > 0) {
    try {
      decryptWithKey(sampleUsers[0].github_token_enc, transportKey);
    } catch (e) {
      // Key doesn't match — clear all tokens so no one hits a broken state.
      // They'll see the normal "reconnect GitHub" prompt. Import still
      // proceeds with everything else.
      tokenResult = 'mismatch_cleared';
      await onProgress(`⚠️ Transport key mismatch — tokens will be cleared (users will be asked to reconnect). Proceeding with all other data…`);
      for (const row of snapshot.tables['users'] || []) {
        row.github_token_enc = null;
        row.disconnected_at = new Date().toISOString();
      }
      if (snapshot.tables['github_accounts']) snapshot.tables['github_accounts'] = [];
      // Webhook secrets are sealed with the same key — they can't be opened either, so those alerts are re-enabled by hand.
      if (snapshot.tables['repo_webhooks']) {
        snapshot.tables['repo_webhooks'] = snapshot.tables['repo_webhooks'].filter((r) => !String(r.secret || '').startsWith(WEBHOOK_SECRET_PREFIX));
      }
    }
  }

  // Phase 3 — Re-encrypt with TARGET key (if key matched)
  if (tokenResult === 'carried') {
    await onProgress(`🔑 Re-encrypting tokens under this deployment's key…`);
    let reKeyed = 0;
    for (const row of snapshot.tables['users'] || []) {
      if (row.github_token_enc) {
        try {
          const plaintext = decryptWithKey(row.github_token_enc, transportKey);
          row.github_token_enc = encrypt(plaintext); // TARGET key via lib/crypto.js
          reKeyed++;
        } catch (e) {
          row.github_token_enc = null;
          row.disconnected_at = new Date().toISOString();
        }
      }
    }
    // v1.2.4-multi: additional GitHub accounts; one that can't be re-keyed is dropped (the person adds it again).
    if (snapshot.tables['github_accounts']) {
      const keptAccounts = [];
      for (const row of snapshot.tables['github_accounts']) {
        try {
          row.token_enc = encrypt(decryptWithKey(row.token_enc, transportKey));
          keptAccounts.push(row);
          reKeyed++;
        } catch (e) { /* dropped */ }
      }
      snapshot.tables['github_accounts'] = keptAccounts;
    }
    if (snapshot.tables['repo_webhooks']) {
      const keptHooks = [];
      for (const row of snapshot.tables['repo_webhooks']) {
        if (String(row.secret || '').startsWith(WEBHOOK_SECRET_PREFIX)) {
          try {
            row.secret = WEBHOOK_SECRET_PREFIX + encrypt(decryptWithKey(row.secret.slice(WEBHOOK_SECRET_PREFIX.length), transportKey));
            reKeyed++;
          } catch (e) { continue; }
        }
        keptHooks.push(row);
      }
      snapshot.tables['repo_webhooks'] = keptHooks;
    }
    await onProgress(`🔑 ${reKeyed} token(s) re-encrypted under this deployment's key.`);
  }

  // Phase 4 — Write tables inside a single transaction so a mid-import
  // crash never leaves a half-imported DB.
  const summary = { tableCount: 0, rowCounts: {}, skippedTables: [], skippedColumns: {}, aliased: {}, safetyColumnsSkipped: [], cleared: [], reconciled: null };
  const aliases = parseAliases();

  await onProgress(`✍️ Writing ${Object.keys(snapshot.tables).length} table(s)…`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Plan every table first (what exists here, which columns map) — nothing is written yet.
    const plans = {};
    for (const t of Object.keys(snapshot.tables)) {
      const rows = snapshot.tables[t];
      // The table name is interpolated into SQL below — only ever write to a table that really exists
      // in THIS database (also stops a crafted snapshot from naming an arbitrary identifier).
      const targetCols = await targetColumns(client, t);
      if (!targetCols.size) { summary.skippedTables.push(t); summary.rowCounts[t] = 0; continue; }
      if (!rows.length) { plans[t] = { empty: true, targetCols }; continue; }
      const plan = planColumns(t, Object.keys(rows[0]), targetCols, aliases);
      if (plan.skipped.length) {
        summary.skippedColumns[t] = plan.skipped;
        for (const c of plan.skipped) if (SAFETY_COLUMN.test(c)) summary.safetyColumnsSkipped.push(`${t}.${c}`);
      }
      for (const dest of plan.cols) if (plan.source[dest] !== dest) (summary.aliased[t] = summary.aliased[t] || []).push(`${plan.source[dest]}→${dest}`);
      if (!plan.cols.length) { summary.skippedTables.push(t); summary.rowCounts[t] = 0; continue; }
      plans[t] = { ...plan, targetCols };
    }
    const planned = Object.keys(plans);

    // 2. Parents before children. Alphabetical order (the old behaviour) wrote repo_tags before tags, so any
    //    instance with a tagged repo failed with a foreign-key error. Cleared in ONE statement for the same reason.
    const edges = await foreignKeys(client);
    const order = orderTables(planned, edges);

    // v1.2.5-multi: a per-person table that exists here but is absent from the snapshot (older export, or a
    // feature the source never had) would otherwise keep the OLD instance's rows next to the imported people.
    const { rows: perUser } = await client.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'telegram_id'`
    );
    const strays = perUser.map((r) => r.table_name).filter((n) => !(n in snapshot.tables) && n !== 'users' && !planned.includes(n));
    const toClear = [...new Set([...order, ...strays])];
    if (toClear.length) await client.query(`TRUNCATE TABLE ${toClear.map((n) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`);
    summary.cleared = strays;

    // 3. Insert.
    for (let i = 0; i < order.length; i++) {
      const t = order[i];
      const plan = plans[t];
      let rows = snapshot.tables[t];
      await onProgress(`✍️ Writing tables\n${makeProgressBar(i, order.length)} — ${t} (${rows.length} rows)`);
      if (plan.empty) { summary.rowCounts[t] = 0; continue; }
      const selfFk = edges.find((e) => e.child === t && e.parent === t && e.childCols.length === 1);
      if (selfFk && plan.cols.includes(selfFk.childCols[0]) && plan.cols.includes(selfFk.parentCols[0])) {
        rows = orderSelfReferencing(rows, selfFk.childCols[0], selfFk.parentCols[0]);
      }
      const cols = plan.cols;
      // Batch-insert in chunks of 100 rows to stay under Postgres's
      // parameter limit and avoid one enormous query.
      const CHUNK = 100;
      for (let c = 0; c < rows.length; c += CHUNK) {
        const chunk = rows.slice(c, c + CHUNK);
        const vals = [];
        const placeholders = chunk.map((row, ri) => {
          return `(${cols.map((dest, ci) => { vals.push(typedValue(plan.targetCols.get(dest), row[plan.source[dest]])); return `$${ri * cols.length + ci + 1}`; }).join(',')})`;
        }).join(',');
        await client.query(
          `INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(',')}) VALUES ${placeholders}`,
          vals
        );
      }
      // Re-sync the id sequence with the explicit ids we just inserted: the rows carry their original
      // source-instance ids, so without this every later INSERT that omits an id collides with an imported row.
      if (cols.includes('id')) {
        const { rows: seqRows } = await client.query(
          `SELECT pg_get_serial_sequence($1, 'id') AS seq`,
          [t]
        );
        const seq = seqRows[0] && seqRows[0].seq;
        if (seq) {
          await client.query(
            `SELECT setval($1, COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`,
            [seq]
          );
        }
      }
      summary.rowCounts[t] = rows.length;
      summary.tableCount++;
    }
    summary.reconciled = await reconcileMultiAccount(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw new Error(`Import failed mid-write (rolled back — your data is intact): ${e.message}`);
  } finally {
    client.release();
  }

  const notes = [];
  if (summary.skippedTables.length) notes.push(`skipped tables this version doesn't have: ${summary.skippedTables.join(', ')}`);
  const colNotes = Object.entries(summary.skippedColumns).map(([t, c]) => `${t}.{${c.join(', ')}}`);
  if (colNotes.length) notes.push(`skipped columns this version doesn't have: ${colNotes.join('; ')}`);
  if (summary.cleared.length) notes.push(`cleared tables the snapshot had no data for: ${summary.cleared.join(', ')}`);
  const rc = summary.reconciled;
  if (rc && (rc.accountsRebuilt || rc.accountsDropped || rc.webhooksStamped)) notes.push(`accounts re-linked: ${rc.accountsRebuilt}, orphan accounts dropped: ${rc.accountsDropped}, alerts tied to an account: ${rc.webhooksStamped}`);
  if (summary.safetyColumnsSkipped.length) notes.push(`⚠️ safety-related columns were NOT imported (${summary.safetyColumnsSkipped.join(', ')}) — check protection/trust/ban settings, or re-run with IMPORT_COLUMN_ALIASES to map a renamed column`);
  await onProgress(`✅ Done — ${summary.tableCount} tables written, tokens: ${tokenResult === 'carried' ? '✅ carried over' : '⚠️ cleared (users will reconnect)'}.${notes.length ? `\n${notes.join('\n')}` : ''}`);
  return { tokenResult, summary };
}

module.exports = { exportInstance, importInstance, generateTransportKey, makeProgressBar, planColumns, parseAliases };
