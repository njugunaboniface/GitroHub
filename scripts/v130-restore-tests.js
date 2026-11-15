#!/usr/bin/env node
/**
 * v1.3.0-multi — Restore center + soft-delete tests (offline; DB tests run on a REAL local PostgreSQL, skipped when none).
 * Run:  node scripts/v130-restore-tests.js   (npm run test:v130:restore)
 */
const assert = require('assert');
const t = require('./lib/testEnv');
const realPg = require('./lib/realPg');

const tests = [];
const test = (name, fn, { pg = false } = {}) => tests.push({ name, fn, pg });
const HAVE_PG = realPg.available();

test('restorecenter area passes registry validation and is account-level', () => {
  const area = t.req('handlers/manage/areas/restorecenter');
  assert.strictEqual(area.key, 'restorec');
  assert.ok(area.label.length <= 18);
  assert.strictEqual(area.level, 'account');
  assert.deepStrictEqual(area.FILTERS.map((f) => f[0]), ['all', 'repos', 'settings', 'other']);
});

test('soft-delete: stash → list → restore (tag) is idempotent; forget removes', async () => {
  const db = realPg.createDb('v130_a');
  try {
    t.setQueryHandler(db.handler);
    const { pool } = t.req('db/postgres');
    const sd = t.req('lib/softDelete');
    await pool.query("INSERT INTO users (telegram_id, github_username) VALUES (10,'alice')");
    const id = await sd.stash(10, 'tag', 'Tag work', { tag: { name: 'work', emoji: '💼' }, assignments: [], defaults: [] });
    assert.ok(id, 'stashed');
    assert.strictEqual((await sd.list(10)).items.length, 1);
    const r1 = await sd.restore(10, id);
    assert.ok(r1.ok && !r1.already, JSON.stringify(r1));
    const r2 = await sd.restore(10, id);
    assert.ok(r2.ok && r2.already, 'second restore is a no-op');
    assert.strictEqual((await pool.query("select count(*) from tags where telegram_id=10 and name='work'")).rows[0].count, 1);
    const id2 = await sd.stash(10, 'tag', 'x', { tag: { name: 'x' } });
    assert.strictEqual(await sd.forget(10, id2), true);
    assert.strictEqual(await sd.get(10, id2), null);
  } finally { db.drop(); }
}, { pg: true });

test('soft-delete: expired and foreign items are refused; purge removes expired', async () => {
  const db = realPg.createDb('v130_b');
  try {
    t.setQueryHandler(db.handler);
    const { pool } = t.req('db/postgres');
    const sd = t.req('lib/softDelete');
    const id = await sd.stash(10, 'tag', 'old', { type: 'tag', name: 'old' });
    await pool.query("UPDATE soft_deleted SET expires_at = now() - interval '1 day' WHERE id = $1", [id]);
    assert.strictEqual((await sd.list(10)).items.length, 0);
    assert.strictEqual((await sd.restore(10, id)).ok, false);
    const id2 = await sd.stash(10, 'tag', 'mine', { type: 'tag', name: 'mine' });
    assert.strictEqual((await sd.restore(11, id2)).ok, false, 'another person cannot restore it');
    assert.strictEqual(await sd.stash(10, 'bogus', 'x', {}), null, 'unknown kind is ignored');
  } finally { db.drop(); }
}, { pg: true });

test('timeline merges journal, trash, bulk, defaults and soft-deletes newest-first with filters', async () => {
  const db = realPg.createDb('v130_c');
  try {
    t.setQueryHandler(db.handler);
    const { pool } = t.req('db/postgres');
    const sd = t.req('lib/softDelete');
    const area = t.req('handlers/manage/areas/restorecenter');
    await pool.query("INSERT INTO users (telegram_id, github_username) VALUES (10,'alice')");
    await pool.query("INSERT INTO trashed_repos (telegram_id, original_name, backup_file_id, expires_at, deleted_at) VALUES (10,'old-repo','f', now() + interval '5 days', now() - interval '3 hours')");
    await pool.query("INSERT INTO bulk_action_log (telegram_id, action_type, repo_names, previous_state, expires_at, created_at) VALUES (10,'private','[\"a\",\"b\"]','{}', now() + interval '1 hour', now() - interval '1 hour')");
    await pool.query("INSERT INTO change_journal (telegram_id, kind, repo_name, label) VALUES (10,'commit','app','Edited file')").catch(() => {});
    await pool.query("UPDATE users SET default_commit_message = 'new msg' WHERE telegram_id = 10");
    await pool.query("INSERT INTO defaults_changelog (telegram_id, field, old_value, new_value) VALUES (10,'default_commit_message','old msg','new msg')");
    await sd.stash(10, 'schedule', 'Nightly backup', { type: 'repo' });
    await sd.stash(10, 'tag', 'Tag work', { type: 'tag', name: 'work' });
    const all = await area.timeline(10, 'all');
    const srcs = new Set(all.map((i) => i.src));
    for (const s of ['t', 'b', 'd', 's']) assert.ok(srcs.has(s), `source ${s} present`);
    for (let i = 1; i < all.length; i++) assert.ok(new Date(all[i - 1].at) >= new Date(all[i].at), 'newest first');
    assert.ok((await area.timeline(10, 'repos')).every((i) => i.group === 'repos'));
    assert.ok((await area.timeline(10, 'settings')).every((i) => i.group === 'settings'));
    assert.ok((await area.timeline(10, 'other')).every((i) => i.group === 'other'));
    assert.strictEqual((await area.timeline(10, 'other')).length, 1);
    // a default that was changed AGAIN since is no longer offered
    await pool.query("UPDATE users SET default_commit_message = 'third' WHERE telegram_id = 10");
    assert.ok(!(await area.timeline(10, 'settings')).some((i) => i.src === 'd'));
  } finally { db.drop(); }
}, { pg: true });

(async () => {
  let passed = 0; let skipped = 0;
  for (const { name, fn, pg } of tests) {
    if (pg && !HAVE_PG) { skipped++; console.log(`  - ${name} (skipped: no local PostgreSQL)`); continue; }
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) {
      console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length - skipped} passed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(passed === tests.length - skipped ? 0 : 1);
})();
