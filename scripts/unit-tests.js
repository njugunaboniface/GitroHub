#!/usr/bin/env node
/**
 * unit-tests.js — real assertions for the logic that can be tested without a
 * live Telegram / Postgres / Redis / GitHub (added in v1.1.7-multi).
 *
 * smoke-test.js proves code paths don't throw ReferenceErrors; this file
 * proves specific behaviours are RIGHT — decompression bombs are stopped,
 * BIGINT strings can't break admin checks, OAuth states are single-use, and
 * so on. Every external module (pg, redis, telegraf…) is replaced with an
 * in-memory stand-in, so this runs offline with only Node's standard library.
 *
 * Run via `npm test` (also part of `npm run verify`). Exits non-zero on any
 * failure.
 */

Object.assign(process.env, {
  BOT_TOKEN: 'unit-test-token',
  BOT_USERNAME: 'UnitTestBot',
  ADMIN_IDS: '1,2',
  OWNER_ID: '1',
  GITHUB_CLIENT_ID: 'unit-test',
  GITHUB_CLIENT_SECRET: 'unit-test',
  BASE_URL: 'https://example.com',
  SESSION_JWT_SECRET: 'unit-test-secret',
  TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
  DATABASE_URL: 'postgres://fake:fake@localhost:5432/fake',
  REDIS_URL: 'redis://localhost:6379',
});

const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const Module = require('module');
const path = require('path');
const fs = require('fs');

// ── In-memory stand-ins for external packages ────────────────────────
const queries = []; // every pool.query() call: { sql, params }
let queryHandler = () => ({ rows: [], rowCount: 0 });
const typeParsers = {};

const fakeRedisStore = new Map();
const fakeRedisClient = {
  isReady: true,
  on() { return this; },
  async connect() {},
  async set(key, value, opts = {}) {
    if (opts.NX && fakeRedisStore.has(key)) return null;
    fakeRedisStore.set(key, value);
    return 'OK';
  },
  async get(key) { return fakeRedisStore.has(key) ? fakeRedisStore.get(key) : null; },
  async del(key) { return fakeRedisStore.delete(key) ? 1 : 0; },
  async eval(script, { keys, arguments: args }) {
    if (fakeRedisStore.get(keys[0]) === args[0]) { fakeRedisStore.delete(keys[0]); return 1; }
    return 0;
  },
  async quit() {},
};

function fakeJwt() {
  // Minimal HS256-shaped stand-in used only when the real package isn't installed.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return {
    sign(payload, secret, { expiresIn } = {}) {
      const body = { ...payload, exp: Math.floor(Date.now() / 1000) + Number(expiresIn || 600) };
      const head = b64({ alg: 'HS256', typ: 'JWT' });
      const data = `${head}.${b64(body)}`;
      return `${data}.${mac(data, secret)}`;
    },
    verify(token, secret) {
      const [h, p, sig] = String(token).split('.');
      if (!h || !p || !sig || mac(`${h}.${p}`, secret) !== sig) throw new Error('invalid signature');
      const body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      if (body.exp * 1000 < Date.now()) throw new Error('jwt expired');
      return body;
    },
  };
}

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') {
    class Pool {
      on() {}
      async query(sql, params) { queries.push({ sql, params }); return queryHandler(sql, params); }
      async connect() {
        const self = this;
        return { query: (sql, params) => self.query(sql, params), release() {} };
      }
      async end() {}
    }
    return { Pool, types: { setTypeParser(oid, fn) { typeParsers[oid] = fn; } } };
  }
  if (request === 'redis') return { createClient: () => fakeRedisClient };
  if (request === '@octokit/rest') return { Octokit: class { constructor() { this.rest = {}; } } };
  if (request === 'telegraf') {
    // Just enough of Markup to render keyboards as plain data.
    const btn = (text, extra) => ({ text, ...extra });
    const kb = (rows) => ({ reply_markup: { inline_keyboard: rows }, resize() { return this; } });
    return {
      Markup: {
        inlineKeyboard: kb, keyboard: kb, removeKeyboard: () => ({}),
        button: { callback: (text, data) => btn(text, { callback_data: data }), text: (text) => btn(text), url: (text, url) => btn(text, { url }) },
      },
    };
  }
  if (request === 'dotenv') return { config() { return {}; } }; // keep tests hermetic: never read a real .env
  if (request === 'pino') {
    const noop = () => {};
    const p = () => ({ info: noop, warn: noop, error: noop });
    p.stdTimeFunctions = { isoTime: () => '' };
    return p;
  }
  if (request === 'jsonwebtoken') {
    try { return realLoad.call(this, request, parent, isMain); } catch (_) { return fakeJwt(); }
  }
  return realLoad.call(this, request, parent, isMain);
};

const SRC = path.join(__dirname, '..', 'src');
const req = (p) => require(path.join(SRC, p));

// ── Tiny test runner ─────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const throwsCode = (fn, code) => {
  try { fn(); } catch (err) { assert.strictEqual(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`); return; }
  assert.fail(`expected ArchiveError ${code}, nothing thrown`);
};

// ── Helper: build a zip in memory (methods 0/8, optional forged size) ─
function makeZip(files) {
  const { crc32 } = req('lib/archive');
  const locals = []; const centrals = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const method = f.method === 0 ? 0 : 8;
    const comp = method === 0 ? f.data : zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const size = f.forgedSize !== undefined ? f.forgedSize : f.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp); centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const MB = 1024 * 1024;

// ═════════════════════ archive: zip ═════════════════════
test('zip: reads deflated + stored entries, strips the shared top folder', () => {
  const { readZip } = req('lib/archive');
  const zip = makeZip([
    { name: 'proj/a.txt', data: Buffer.from('hello\n') },
    { name: 'proj/sub/b.bin', data: crypto.randomBytes(5000), method: 0 },
    { name: 'proj/empty.txt', data: Buffer.alloc(0), method: 0 },
  ]);
  const r = readZip(zip, { maxTotalBytes: MB });
  assert.deepStrictEqual(r.entries.map((e) => e.path).sort(), ['a.txt', 'empty.txt', 'sub/b.bin']);
  assert.strictEqual(r.entries.find((e) => e.path === 'a.txt').data.toString(), 'hello\n');
});

test('zip: forged header size cannot bypass the limit (actual bytes are counted)', () => {
  const { readZip } = req('lib/archive');
  const zip = makeZip([{ name: 'big.bin', data: Buffer.alloc(40 * MB), forgedSize: 10 }]);
  assert.ok(zip.length < 100 * 1024, 'the bomb itself must be tiny');
  throwsCode(() => readZip(zip, { maxTotalBytes: MB }), 'TOO_LARGE');
});

test('zip: an honest oversized archive is rejected early', () => {
  const { readZip } = req('lib/archive');
  const zip = makeZip([{ name: 'big.bin', data: Buffer.alloc(3 * MB) }]);
  throwsCode(() => readZip(zip, { maxTotalBytes: MB }), 'TOO_LARGE');
});

test('zip: limit applies across entries combined (honest and forged)', () => {
  const { readZip } = req('lib/archive');
  const honest = makeZip([1, 2, 3].map((i) => ({ name: `f${i}.bin`, data: Buffer.alloc(400 * 1024, i) })));
  throwsCode(() => readZip(honest, { maxTotalBytes: MB }), 'TOO_LARGE');
  // forged sizes that add up to under the limit while the real data doesn't:
  // whatever the exact code, it must be rejected, never returned.
  const forged = makeZip([1, 2, 3].map((i) => ({ name: `f${i}.bin`, data: Buffer.alloc(400 * 1024, i), forgedSize: 1 })));
  assert.throws(() => readZip(forged, { maxTotalBytes: MB }), (err) => err.name === 'ArchiveError');
});

test('zip: too many entries', () => {
  const { readZip } = req('lib/archive');
  const zip = makeZip(Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') })));
  throwsCode(() => readZip(zip, { maxTotalBytes: MB, maxEntries: 10 }), 'TOO_MANY');
});

test('zip: corrupted data / bad CRC / garbage input', () => {
  const { readZip } = req('lib/archive');
  const zip = makeZip([{ name: 'a.txt', data: Buffer.from('hello world'), method: 0 }]);
  const bad = Buffer.from(zip); bad[30 + 5] ^= 0xff; // flip a byte of the stored content
  throwsCode(() => readZip(bad, { maxTotalBytes: MB }), 'CORRUPT');
  throwsCode(() => readZip(Buffer.from('definitely not a zip file at all'), { maxTotalBytes: MB }), 'CORRUPT');
});

test('zip: drops macOS junk and unsafe paths, keeps the rest', () => {
  const { readZip } = req('lib/archive');
  const zip = makeZip([
    { name: 'folder/hello.txt', data: Buffer.from('hi') },
    { name: '__MACOSX/folder/._hello.txt', data: Buffer.from('x') },
    { name: 'folder/.DS_Store', data: Buffer.from('x') },
    { name: 'folder/._hello.txt', data: Buffer.from('x') },
    { name: '../evil.txt', data: Buffer.from('x') },
    { name: '/abs.txt', data: Buffer.from('x') },
    { name: 'folder/.git/config', data: Buffer.from('x') },
  ]);
  const r = readZip(zip, { maxTotalBytes: MB });
  assert.deepStrictEqual(r.entries.map((e) => e.path), ['hello.txt']);
  assert.strictEqual(r.junkSkipped, 3);
  assert.strictEqual(r.unsafeSkipped, 3);
});

test('zip: password-protected (real `zip -P secret` fixture)', () => {
  const { readZip } = req('lib/archive');
  const fixture = Buffer.from(
    'UEsDBAoACQAAAKuhNV0gMDo2EgAAAAYAAAAFABwAYS50eHRVVAkAA+GPsWrhj7FqdXgLAAEEAAAAAAQAAAAAsgJ+Hsu6RIf0+pCyim5ZBnLSUEsHCCAwOjYSAAAABgAAAFBLAwQKAAkAAACroTVdgv9y5BgAAAAMAAAABQAcAGIudHh0VVQJAAPhj7Fq4Y+xanV4CwABBAAAAAAEAAAAAIusWrOg02Xcp3U/HEAew3J/FRrk1B+9WVBLBwiC/3LkGAAAAAwAAABQSwECHgMKAAkAAACroTVdIDA6NhIAAAAGAAAABQAYAAAAAAABAAAApIEAAAAAYS50eHRVVAUAA+GPsWp1eAsAAQQAAAAABAAAAABQSwECHgMKAAkAAACroTVdgv9y5BgAAAAMAAAABQAYAAAAAAABAAAApIFhAAAAYi50eHRVVAUAA+GPsWp1eAsAAQQAAAAABAAAAABQSwUGAAAAAAIAAgCWAAAAyAAAAAAA',
    'base64'
  );
  throwsCode(() => readZip(fixture, { maxTotalBytes: MB }), 'NEEDS_PASSWORD');
  throwsCode(() => readZip(fixture, { password: 'wrong', maxTotalBytes: MB }), 'BAD_PASSWORD');
  const r = readZip(fixture, { password: 'secret', maxTotalBytes: MB });
  assert.strictEqual(r.encrypted, true);
  assert.strictEqual(r.entries.find((e) => e.path === 'a.txt').data.toString(), 'hello\n');
  assert.strictEqual(r.entries.find((e) => e.path === 'b.txt').data.toString(), 'second file\n');
});

// ═════════════════════ archive: gzip / paths ═════════════════════
test('gzip: bomb is rejected at the cap, valid data passes, junk is CORRUPT', () => {
  const { gunzipBounded } = req('lib/archive');
  const bomb = zlib.gzipSync(Buffer.alloc(64 * MB), { level: 9 });
  assert.ok(bomb.length < 200 * 1024);
  throwsCode(() => gunzipBounded(bomb, MB), 'TOO_LARGE');
  assert.strictEqual(gunzipBounded(zlib.gzipSync(Buffer.from('ok')), MB).toString(), 'ok');
  assert.strictEqual(gunzipBounded(zlib.gzipSync(Buffer.alloc(MB)), MB).length, MB); // exactly at the limit is allowed
  throwsCode(() => gunzipBounded(Buffer.from('not gzip'), MB), 'CORRUPT');
});

test('paths: sanitizeArchivePath', () => {
  const { sanitizeArchivePath: s } = req('lib/archive');
  assert.strictEqual(s('a/b/c.txt'), 'a/b/c.txt');
  assert.strictEqual(s('./a//b\\c.txt'), 'a/b/c.txt');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\win', 'a/.git/config', '.GIT/x', '', '.', 'a\0b']) {
    assert.strictEqual(s(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('paths: prepareEntries de-dupes (last wins), keeps a lone ._file, strips one shared folder', () => {
  const { prepareEntries } = req('lib/archive');
  const r = prepareEntries([
    { name: 'top/a.txt', data: Buffer.from('1') },
    { name: 'top/a.txt', data: Buffer.from('2') },
    { name: 'top/._lonely', data: Buffer.from('3') },
    { name: 'top/x/y.txt', data: Buffer.from('4') },
  ]);
  assert.deepStrictEqual(r.entries.map((e) => e.path).sort(), ['._lonely', 'a.txt', 'x/y.txt']);
  assert.strictEqual(r.entries.find((e) => e.path === 'a.txt').data.toString(), '2');
  // two different top-level names → nothing stripped
  const r2 = prepareEntries([{ name: 'a/1.txt', data: Buffer.alloc(0) }, { name: 'b/2.txt', data: Buffer.alloc(0) }]);
  assert.deepStrictEqual(r2.entries.map((e) => e.path), ['a/1.txt', 'b/2.txt']);
});

// ═════════════════════ pool ═════════════════════
test('pool.mapLimit: bounded concurrency, ordered results, error propagation', async () => {
  const { mapLimit } = req('lib/pool');
  let inFlight = 0; let peak = 0;
  const out = await mapLimit([...Array(20).keys()], 3, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--; return n * 2;
  });
  assert.deepStrictEqual(out, [...Array(20).keys()].map((n) => n * 2));
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  await assert.rejects(mapLimit([1, 2, 3, 4], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; }), /boom/);
  assert.deepStrictEqual(await mapLimit([], 4, async (x) => x), []);
});

// ═════════════════════ callback refs ═════════════════════
test('callbackRefs: long data round-trips through a ≤64-byte reference', async () => {
  const cr = req('lib/callbackRefs');
  const long = `repo:delete:confirm:${'x'.repeat(100)}`;
  const packed = cr.shorten(long);
  assert.ok(Buffer.byteLength(packed) <= 64 && packed.startsWith('~'));
  assert.strictEqual(cr.shorten(long), packed, 'content-derived → stable');
  assert.deepStrictEqual(await cr.resolve(packed), { data: long, repo: null });
  assert.strictEqual(cr.shorten('short:data'), 'short:data');
  assert.strictEqual(await cr.resolve('~doesnotexist0000'), null);
});

test('callbackRefs: repo binding survives shortening and unwraps on resolve', async () => {
  const cr = req('lib/callbackRefs');
  const data = cr.bindRepo('my-repo', `browse:file:${'dir/'.repeat(20)}file.js`);
  const packed = cr.shorten(data);
  assert.ok(Buffer.byteLength(packed) <= 64);
  const r = await cr.resolve(packed);
  assert.strictEqual(r.repo, 'my-repo');
  assert.ok(r.data.startsWith('browse:file:dir/'));
  const small = cr.bindRepo('r', 'file:view:a.js');
  assert.deepStrictEqual(await cr.resolve(cr.shorten(small)), { data: 'file:view:a.js', repo: 'r' });
  assert.strictEqual(cr.bindRepo(null, 'x'), 'x');
  assert.ok(!cr.needsResolve('repo:foo') && cr.needsResolve('~abc') && cr.needsResolve('@r|x'));
});

// ═════════════════════ postgres BIGINT + admin comparisons ═════════════════════
test('postgres: BIGINT parser registered and yields numbers', () => {
  req('db/postgres');
  assert.strictEqual(typeof typeParsers[20], 'function');
  assert.strictEqual(typeParsers[20]('5306461845'), 5306461845);
  assert.strictEqual(typeParsers[20](null), null);
});

test('roles: string ids (pg BIGINT) no longer break Owner / admin roster', async () => {
  const roles = req('lib/roles');
  assert.strictEqual(roles.isOwner('1'), true);
  assert.strictEqual(roles.isOwner(1), true);
  assert.strictEqual(roles.isOwner('2'), false);
  // roster rows come back with STRING ids (what pg returned before the parser fix)
  queryHandler = () => ({ rows: [{ telegram_id: '1', role: 'super_admin', granted_by: null }, { telegram_id: '2', role: 'admin', granted_by: '1' }] });
  const admins = await roles.listAdmins();
  assert.strictEqual(admins.length, 2, 'env-seeded admins must not be listed twice');
  assert.ok(admins.every((a) => typeof a.telegram_id === 'number'));
  queryHandler = () => ({ rows: [] });
  assert.notStrictEqual(await roles.getRole('2'), 'guest'); // env admin with no row, looked up by a STRING id
  assert.strictEqual(await roles.getRole('999'), 'guest');
});

// ═════════════════════ users: ensureUser / recordActivity ═════════════════════
test('ensureUser: no write when nothing changed; upsert when something did', async () => {
  const users = req('lib/users');
  const row = { telegram_id: 77, telegram_username: 'bob', telegram_first_name: 'Bob', is_admin: false, is_blocked: false, blocked_at: null, blocked_reason: null, blocked_until: null, suspended_until: null, _effective_admin: false };
  queries.length = 0;
  queryHandler = () => ({ rows: [{ ...row }] });
  const same = await users.ensureUser(77, { username: 'bob', firstName: 'Bob' });
  assert.strictEqual(queries.length, 1, 'unchanged user → single read, no write');
  assert.ok(/^\s*SELECT/i.test(queries[0].sql) && !('_effective_admin' in same));

  queries.length = 0;
  await users.ensureUser(77, { username: 'bobby', firstName: 'Bob' });
  assert.strictEqual(queries.length, 2);
  assert.ok(/INSERT INTO users/i.test(queries[1].sql));

  queries.length = 0; // brand-new user
  queryHandler = (sql) => (/^\s*SELECT/i.test(sql) ? { rows: [] } : { rows: [{ telegram_id: 78 }] });
  await users.ensureUser(78, { username: 'new', firstName: 'New' });
  assert.ok(/INSERT INTO users/i.test(queries[1].sql));
});

test('recordActivity: clicks are batched into one UPDATE', async () => {
  const users = req('lib/users');
  queries.length = 0;
  queryHandler = () => ({ rows: [], rowCount: 1 });
  await users.recordActivity(5); await users.recordActivity(5); await users.recordActivity('6');
  assert.strictEqual(queries.length, 0, 'nothing is written per click');
  await users.flushActivity();
  assert.strictEqual(queries.length, 1);
  assert.deepStrictEqual(queries[0].params, [[5, 6], [2, 1]]);
  await users.flushActivity();
  assert.strictEqual(queries.length, 1, 'nothing pending → no query');
});

test('deleteUserAndData: covers the previously-missed tables, is ONE transaction, and clears Redis', async () => {
  const users = req('lib/users');
  queries.length = 0;
  queryHandler = () => ({ rows: [], rowCount: 0 });
  fakeRedisStore.set('tg-session:9:9', '{}');
  await users.deleteUserAndData(9);
  const sql = queries.map((q) => q.sql).join('\n');
  for (const t of ['saved_views', 'defaults_changelog', 'bulk_action_log', 'user_reports', 'scheduled_uploads', 'users']) {
    assert.ok(new RegExp(`DELETE FROM ${t}\\b`).test(sql), `missing DELETE FROM ${t}`);
  }
  assert.strictEqual(queries[0].sql, 'BEGIN');
  assert.strictEqual(queries[queries.length - 1].sql, 'COMMIT');
  assert.ok(queries.findIndex((q) => /DELETE FROM users\b/.test(q.sql)) > queries.findIndex((q) => /DELETE FROM pinned_repos/.test(q.sql)), 'users row goes last');
  assert.strictEqual(fakeRedisStore.has('tg-session:9:9'), false);

  // A failure part-way rolls EVERYTHING back and never touches Redis.
  queries.length = 0;
  fakeRedisStore.set('tg-session:9:9', '{}');
  queryHandler = (q) => { if (/DELETE FROM saved_views/.test(q)) throw new Error('db down'); return { rows: [], rowCount: 0 }; };
  await assert.rejects(() => users.deleteUserAndData(9), /db down/);
  assert.strictEqual(queries[queries.length - 1].sql, 'ROLLBACK');
  assert.ok(!queries.some((q) => q.sql === 'COMMIT'));
  assert.strictEqual(fakeRedisStore.has('tg-session:9:9'), true, 'Redis footprint kept so the erase can be retried');
  queryHandler = () => ({ rows: [], rowCount: 0 });
});

// ═════════════════════ scheduled uploads ═════════════════════
test('scheduledUploads: bytes are purged on completed/failed/cancelled', async () => {
  const su = req('lib/scheduledUploads');
  queries.length = 0; queryHandler = () => ({ rows: [], rowCount: 1 });
  await su.markCompleted(4); await su.markFailed(5, 'x'); await su.cancel(1, 6);
  const purges = queries.filter((q) => /DELETE FROM scheduled_upload_files/.test(q.sql)).map((q) => q.params[0]);
  assert.deepStrictEqual(purges, [4, 5, 6]);
  queries.length = 0; queryHandler = () => ({ rows: [], rowCount: 0 }); // cancel of a non-pending row
  await su.cancel(1, 7);
  assert.strictEqual(queries.filter((q) => /DELETE FROM scheduled_upload_files/.test(q.sql)).length, 0);
});

// ═════════════════════ OAuth state ═════════════════════
test('oauth: state carries a one-time id + purpose, is verified, and is single-use', async () => {
  const oauth = req('lib/oauth');
  const jwt = require('jsonwebtoken');
  const url = new URL(oauth.buildAuthorizeUrl(4242));
  const state = url.searchParams.get('state');
  const { telegramId, jti } = oauth.inspectState(state);
  assert.strictEqual(telegramId, 4242);
  assert.ok(jti && jti.length >= 16);
  assert.strictEqual(oauth.verifyState(state), 4242);
  assert.notStrictEqual(new URL(oauth.buildAuthorizeUrl(4242)).searchParams.get('state'), state, 'each link is unique');
  // a JWT signed with the same secret but for another purpose is rejected
  const foreign = jwt.sign({ telegramId: 4242 }, process.env.SESSION_JWT_SECRET, { expiresIn: 600 });
  assert.throws(() => oauth.inspectState(foreign));
  assert.throws(() => oauth.inspectState('garbage'));
  assert.throws(() => oauth.inspectState(undefined));
  assert.strictEqual(await oauth.consumeState(jti), true);
  assert.strictEqual(await oauth.consumeState(jti), false, 'second use is refused');
});

// ═════════════════════ poller lease ═════════════════════
test('pollerLease: one owner per tick, release frees it, Redis failure fails open', async () => {
  const lease = req('lib/pollerLease');
  const store = new Map();
  const redis = {
    async set(k, v, o) { if (o.NX && store.has(k)) return null; store.set(k, v); return 'OK'; },
    async eval(_s, { keys, arguments: a }) { if (store.get(keys[0]) === a[0]) { store.delete(keys[0]); return 1; } return 0; },
  };
  const a = await lease.acquire('t', 60, redis);
  assert.ok(a);
  assert.strictEqual(await lease.acquire('t', 60, redis), null, 'second instance is refused');
  await a.release();
  assert.ok(await lease.acquire('t', 60, redis), 'free again after release');
  const broken = { async set() { throw new Error('redis down'); } };
  const failOpen = await lease.acquire('t', 60, broken);
  assert.ok(failOpen && typeof failOpen.release === 'function');
});

// ═════════════════════ list-screen tree stats (v1.1.21-multi) ═════════════════════
test('repoCache.getTreeStatsBatch: a slow repo cannot hold the page hostage; it finishes in the background', async () => {
  const githubPath = require.resolve(path.join(SRC, 'lib/github'));
  const cachePath = require.resolve(path.join(SRC, 'lib/repoCache'));
  const savedGithub = require.cache[githubPath];
  const savedCache = require.cache[cachePath];
  const calls = [];
  const fakeGithub = {
    async getTreeStats(_token, _owner, repo, branch) {
      calls.push({ repo, branch });
      if (repo === 'huge') await new Promise((r) => setTimeout(r, 400));
      if (repo === 'broken') throw new Error('boom');
      return { sizeBytes: 1000, fileCount: 1, folderCount: 0, sizeIncomplete: false, treeTruncated: false };
    },
  };
  require.cache[githubPath] = { id: githubPath, filename: githubPath, loaded: true, exports: fakeGithub };
  delete require.cache[cachePath];
  try {
    const repoCache = require(cachePath);
    const mk = (name) => ({ name, owner: { login: 'me' }, default_branch: 'trunk' });
    const started = Date.now();
    const out = await repoCache.getTreeStatsBatch(777, 'tok', [mk('small'), mk('huge'), mk('broken'), null], { budgetMs: 100 });
    assert.ok(Date.now() - started < 300, 'returned at the budget, not after the slow repo');
    assert.strictEqual(out[0].sizeBytes, 1000, 'fast repo resolved');
    assert.strictEqual(out[1], null, 'slow repo falls back (caller uses repo.size)');
    assert.strictEqual(out[2], null, 'failing repo falls back instead of throwing');
    assert.strictEqual(out[3], null, 'missing repo slot stays null');
    assert.ok(calls.every((c) => c.branch === 'trunk'), 'default_branch is passed so the tree fetch skips its own get-repo call');
    await new Promise((r) => setTimeout(r, 450)); // slow fetch completes in the background and warms the cache
    const before = calls.length;
    const warm = await repoCache.getTreeStats(777, 'me', 'huge', 'tok', 'trunk');
    assert.strictEqual(warm.sizeBytes, 1000);
    assert.strictEqual(calls.length, before, 'served from the warmed cache, no new fetch');
    assert.deepStrictEqual(await repoCache.getTreeStatsBatch(777, 'tok', []), []);
  } finally {
    if (savedGithub) require.cache[githubPath] = savedGithub; else delete require.cache[githubPath];
    if (savedCache) require.cache[cachePath] = savedCache; else delete require.cache[cachePath];
  }
});

// ═════════════════════ typed-input dead-ends (v1.1.22-multi) ═════════════════════
test('tags: emoji validation accepts multi-codepoint emoji and rejects text', () => {
  const src = fs.readFileSync(path.join(SRC, 'handlers/tags.js'), 'utf8');
  const fnSrc = src.slice(src.indexOf('function looksLikeSingleEmoji'), src.indexOf('async function handleCreateTagInput'));
  const looksLikeSingleEmoji = new Function(fnSrc + '; return looksLikeSingleEmoji;')();
  for (const ok of ['🤖', '👨‍💻', '🏳️‍🌈', '👍🏽', '❤️', '🇳🇬', '1️⃣']) assert.ok(looksLikeSingleEmoji(ok), ok);
  for (const bad of ['', 'a', 'abc', 'hi 🤖', '🤖🤖']) assert.ok(!looksLikeSingleEmoji(bad), JSON.stringify(bad));
});

test('typed-input handlers keep the prompt armed after a rejected value', () => {
  const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
  // description save failure re-arms (non-auth errors)
  assert.ok(/ctx\.session\.editingDescription = repoName;/.test(read('handlers/repoView.js')));
  // RESET typo re-arms instead of bouncing back to Storage & Data
  assert.ok(/ctx\.session\.awaitingFullReset = true;/.test(read('handlers/storageData.js')));
  // scheduled-upload path is validated and re-armed
  assert.ok(/ctx\.session\.editingUploadField = state;/.test(read('handlers/scheduledUploads.js')));
  // the router-level safety net exists and covers the flows that clear their flag first
  const bot = read('bot.js');
  assert.ok(bot.includes("bot.on('text', guardedTextInput)"));
  for (const k of ['editingDescription', 'awaitingSaveViewName', 'automationRuleInput', 'editingScheduledTime']) {
    assert.ok(bot.includes(`'${k}'`), k);
  }
});

// ═════════════════════ merged from the GPT branch (v1.1.23-multi) ═════════════════════
test('confirmFlow: only EXECUTE callbacks are claimed; a double-tap is blocked, a different message is not', async () => {
  const cf = req('lib/confirmFlow');
  for (const y of ['repo:delete:confirm:r', 'admin:broadcast:send', 'admin:user:5:ban', 'admin:user:5:delete', 'admin:roles:5:set:admin', 'bulk:execute:delete']) {
    assert.ok(cf.isActionCallback(y), `should claim ${y}`);
  }
  // screen-opening callbacks must NOT be claimed (an unanchored ban|delete pattern once matched these)
  for (const n of ['admin:user:5:banduration:7', 'admin:user:5:askban', 'admin:user:5:askdelete', 'admin:roles:5', 'repos:page:2', 'repo:delete:cancel:r']) {
    assert.ok(!cf.isActionCallback(n), `must not claim ${n}`);
  }
  const mk = (id) => ({ callbackQuery: { data: 'admin:broadcast:send', message: { chat: { id: 1 }, message_id: id } } });
  assert.strictEqual(await cf.claimCallback(mk(100)), true, 'first tap wins');
  assert.strictEqual(await cf.claimCallback(mk(100)), false, 'double-tap on the same message is refused');
  assert.strictEqual(await cf.claimCallback(mk(101)), true, 'a different message is unaffected');
});

test('scheduledBroadcasts: immediate sends are born claimed, so the poller can never re-send them', async () => {
  const sb = req('lib/scheduledBroadcasts');
  queries.length = 0; queryHandler = () => ({ rows: [{ id: 1 }], rowCount: 1 });
  await sb.create(1, 'hi', [], new Date(), { claimed: true });
  assert.ok(queries[0].params.includes('processing'), 'immediate row inserted as processing');
  queries.length = 0;
  await sb.create(1, 'hi', [], new Date());
  assert.ok(queries[0].params.includes('pending'), 'scheduled row inserted as pending');
  queries.length = 0;
  await sb.markSent(1, 3, 3);
  const finalise = queries.find((q) => /UPDATE scheduled_broadcasts/.test(q.sql));
  assert.ok(finalise && /status = 'processing'/.test(finalise.sql), 'markSent only finalises a claimed row');
  // getDue is the claim: it must flip rows to processing atomically
  queries.length = 0; queryHandler = () => ({ rows: [], rowCount: 0 });
  await sb.getDue();
  assert.ok(/SET status = 'processing'/.test(queries[0].sql) && /SKIP LOCKED/.test(queries[0].sql));
});

test('scheduledRepos/Uploads: claim only takes pending rows; completion only applies to claimed rows', async () => {
  for (const mod of ['lib/scheduledRepos', 'lib/scheduledUploads']) {
    const m = req(mod);
    queries.length = 0; queryHandler = () => ({ rows: [], rowCount: 0 });
    await m.claimById(1, 2);
    assert.ok(/status = 'pending'/.test(queries[0].sql) && /SET status = 'processing'/.test(queries[0].sql), mod);
    queries.length = 0;
    await m.markCompleted(2);
    assert.ok(/status = 'processing'/.test(queries[0].sql), `${mod} markCompleted`);
    queries.length = 0;
    await m.returnToPending(2, 'x');
    assert.ok(/SET status = 'pending'/.test(queries[0].sql), `${mod} returnToPending`);
  }
});

test('webhookDigest: loads (no duplicate declarations) and acknowledges delivered events from the HEAD of the list', () => {
  const digest = req('lib/webhookDigest');
  assert.strictEqual(typeof digest.ack, 'function');
  assert.strictEqual(typeof digest.release, 'function');
  const src = fs.readFileSync(path.join(SRC, 'lib/webhookDigest.js'), 'utf8');
  assert.strictEqual((src.match(/const RELEASE_SCRIPT/g) || []).length, 1, 'RELEASE_SCRIPT declared exactly once');
  assert.ok(/rPush/.test(src), 'push appends to the tail...');
  assert.ok(/ltrim', KEYS\[2\], count, -1/.test(src), '...so delivered events are the first `count`, trimmed from the head');
  assert.ok(!/KEYS`|\.keys\(`\$\{DUE_KEY_PREFIX/.test(src), 'never uses blocking KEYS');
});

test('tarReader: bogus or oversized entry sizes throw instead of looping or reading past the buffer', () => {
  const { extractTar } = req('lib/tarReader');
  const header = (name, sizeOctal) => {
    const b = Buffer.alloc(512);
    b.write(name, 0); b.write(sizeOctal.padStart(11, '0') + '\0', 124, 'ascii'); b[156] = '0'.charCodeAt(0);
    return b;
  };
  // claims 1 GB of data in a 512-byte buffer
  assert.throws(() => extractTar(Buffer.concat([header('a.txt', '7777777777'), Buffer.alloc(1024)])), /truncated tar entry/);
  // non-octal size field
  const bad = header('b.txt', '0'); bad.write('zzzzzzzzzzz\0', 124, 'ascii');
  assert.throws(() => extractTar(Buffer.concat([bad, Buffer.alloc(1024)])), /invalid tar entry size/);
  // a normal empty file still parses
  const ok = extractTar(Buffer.concat([header('ok.txt', '0'), Buffer.alloc(1024)]));
  assert.strictEqual(ok.entries.length, 1);
});

test('chatAction: a started loop is always stoppable and never leaks a timer', async () => {
  const chatAction = req('lib/chatAction');
  const sent = [];
  const ctx = { chat: { id: 5 }, telegram: { sendChatAction: async (id, a) => { sent.push([id, a]); } } };
  const stop = chatAction.startChatAction(ctx, 'typing', 2500);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(sent[0], [5, 'typing']);
  stop(); stop(); // idempotent
  const before = sent.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(sent.length, before, 'no further pings after stop');
  assert.strictEqual(await chatAction.withChatAction(ctx, 'typing', async () => 'done'), 'done');
});

test('no handler starts a chat-action loop it does not stop', () => {
  // Guards against the leak found while reviewing the GPT branch: a bare
  // startChatAction() with no matching stop pings Telegram every 4s forever.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(SRC).filter((x) => x.endsWith('.js') && !x.endsWith('lib/chatAction.js'))) {
    const src = fs.readFileSync(f, 'utf8');
    const starts = (src.match(/=\s*chatAction\.startChatAction\(/g) || []).length;
    const stops = (src.match(/stopChatAction\(\)/g) || []).length;
    assert.ok(stops >= starts, `${path.relative(SRC, f)}: ${starts} start(s) but only ${stops} stop(s)`);
  }
});

// ═════════════════════ false restrictions + owner protection + Warden menu (v1.1.24-multi) ═════════════════════
test('hourly cap: admins/owner are exempt whatever an override says; everyone else keeps theirs', () => {
  const limits = req('lib/limits');
  assert.strictEqual(limits.getEffectiveLimits({ is_admin: true, hourly_action_cap_override: 10 }).hourlyActionCap, 0);
  assert.strictEqual(limits.getEffectiveLimits({ is_admin: false, hourly_action_cap_override: 10 }).hourlyActionCap, 10);
});

test('hourly cap: a capped person gets a notice with the wait, at most once a minute, and other users are unaffected', () => {
  const { _checkAndBumpActionCap: check } = req('middleware/accessControl');
  for (let i = 0; i < 3; i++) assert.strictEqual(check(9001, 3).allowed, true);
  const first = check(9001, 3);
  assert.strictEqual(first.allowed, false);
  assert.strictEqual(first.notice, true);
  assert.ok(first.retryInMs > 0 && first.retryInMs <= 3600 * 1000, 'reports how long until the window resets');
  assert.strictEqual(check(9001, 3).notice, false, 'no reply-storm within the same minute');
  assert.strictEqual(check(9002, 3).allowed, true, 'a different user is not affected');
});

test('Warden poller: lease uses SECONDS and is released via the lease object (it used to hold it for ~2.8 days)', async () => {
  const leasePath = require.resolve(path.join(SRC, 'lib/pollerLease'));
  const wardenPath = require.resolve(path.join(SRC, 'lib/warden'));
  const pollerPath = require.resolve(path.join(SRC, 'lib/pollers/warden'));
  const saved = [leasePath, wardenPath, pollerPath].map((p) => [p, require.cache[p]]);
  let ttl = null; let released = false;
  require.cache[leasePath] = { id: leasePath, filename: leasePath, loaded: true, exports: {
    acquire: async (name, ttlSeconds) => { ttl = ttlSeconds; return { release: async () => { released = true; } }; },
  } };
  require.cache[wardenPath] = { id: wardenPath, filename: wardenPath, loaded: true, exports: { runTick: async () => ({ skipped: true, reason: 'disabled' }) } };
  delete require.cache[pollerPath];
  try {
    await require(pollerPath).tick({}, {});
    assert.ok(ttl > 0 && ttl <= 600, `lease TTL must be seconds, got ${ttl}`);
    assert.strictEqual(released, true, 'lease released after the tick');
  } finally {
    for (const [p, m] of saved) { if (m) require.cache[p] = m; else delete require.cache[p]; }
  }
});

test('owner protection: other admins cannot touch the owner\u2019s repos, data or limits; the owner (and other users) are unaffected', async () => {
  const aa = req('lib/adminActions');
  const OWNER = 1; const MOD = 999; const NORMAL = 777;
  const blocked = (fn) => assert.rejects(fn, (e) => e.code === 'OWNER_PROTECTED');
  await blocked(() => aa.listUserRepos(OWNER, MOD));
  await blocked(() => aa.deleteUserRepo(MOD, OWNER, 'r', null));
  await blocked(() => aa.downloadUserRepoZip(MOD, OWNER, 'r', 'main'));
  await blocked(() => aa.setUserRepoVisibility(MOD, OWNER, 'r', true, null));
  await blocked(() => aa.setUserRepoLicense(MOD, OWNER, 'r', 'mit', 'MIT', null));
  await blocked(() => aa.exportUserData(MOD, OWNER));
  await blocked(() => aa.setLimitOverrides(MOD, OWNER, { hourlyActionCap: 5 }));
  // the guard is not in the way for the owner acting on themselves, or for anyone else's account:
  queryHandler = () => ({ rows: [], rowCount: 0 });
  await assert.rejects(() => aa.deleteUserRepo(OWNER, OWNER, 'r', null), (e) => e.code !== 'OWNER_PROTECTED');
  await assert.rejects(() => aa.deleteUserRepo(MOD, NORMAL, 'r', null), (e) => e.code !== 'OWNER_PROTECTED');
});


test('no source file is empty or truncated (node --check happily passes an empty file)', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(SRC).filter((x) => x.endsWith('.js'))) {
    assert.ok(fs.statSync(f).size > 60, `${path.relative(SRC, f)} is empty or truncated`);
  }
});

// ═════════════════════ 🧠 Warden Brain (v1.2.0-multi) ═════════════════════
// Synthetic timelines → baseline → evidence → decision. These scenarios are the
// guard against ever drifting back to "+15 points and restrict": the innocent
// ones must NEVER reach review, and only genuinely sustained, corroborated,
// recurring behaviour may.
const brain = {
  stats: () => req('lib/wardenBrain/stats'),
  baseline: () => req('lib/wardenBrain/baseline'),
  evidence: () => req('lib/wardenBrain/evidence'),
  engine: () => req('lib/wardenBrain/engine'),
};
const BNOW = Date.UTC(2026, 8, 30, 12, 0, 0);
function bHistory(days, { median = 10 } = {}) {
  const { HOUR, DAY } = brain.stats(); const out = []; let seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let d = days; d >= 0; d--) for (let h = 9; h < 15; h++) {
    const t = BNOW - d * DAY - (12 - h) * HOUR; if (t > BNOW) continue;
    const a = Math.max(1, Math.round(median * (0.5 + rnd())));
    out.push({ bucket_start: t, actions: a, errors: Math.round(a * 0.02), repeats: Math.round(a * 0.05), cap_hits: 0, sessions: rnd() < 0.3 ? 1 : 0, active_minutes: 20, max_burst: Math.round(a / 3) });
  }
  return out;
}
const bB = (ago, o = {}) => ({ bucket_start: BNOW - ago * 3600e3, actions: 10, errors: 0, repeats: 0, cap_hits: 0, sessions: 0, active_minutes: 30, max_burst: 5, ...o });
const bEpisode = (start, extra = {}) => [0, 1, 2, 3].map((i) => bB(start + i, { actions: 90 + i, errors: 42, repeats: 57, max_burst: 70, sessions: 1, ...extra }));
function bRun({ buckets, ageDays = 60, trusted = false, admin = false, fleet = {}, benignIn = {}, identity = {}, prior = 0 }) {
  const { DAY } = brain.stats();
  const baseline = brain.baseline().computeBaseline(buckets, BNOW, { accountCreatedAt: BNOW - ageDays * DAY });
  const evidence = brain.evidence().extractEvidence({ buckets, baseline, now: BNOW, identity });
  const benign = brain.evidence().benignChecks({ ageDays, fleet, ...benignIn });
  return brain.engine().evaluate({ isTrusted: trusted, isAdmin: admin, ageDays, baseline, evidence, benign, fleet, history: { priorCases: prior } });
}
const atMost = (d, stage) => assert.ok(brain.engine().stageIndex(d.stage) <= brain.engine().stageIndex(stage), `expected ≤ ${stage}, got ${d.stage} (risk ${d.risk}, conf ${d.confidence})`);

test('brain scenarios: innocent behaviour never escalates beyond what the evidence supports', () => {
  const H = bHistory(60);
  assert.strictEqual(bRun({ buckets: H }).stage, 'normal', 'quiet user');
  atMost(bRun({ buckets: [...H, bB(1, { actions: 70, max_burst: 40, sessions: 1 })] }), 'observe');                       // one unusual morning
  atMost(bRun({ ageDays: 1, buckets: [bB(2, { actions: 100, max_burst: 30, sessions: 1 }), bB(1, { actions: 100, max_burst: 30 })] }), 'observe'); // brand-new user tapping around
  atMost(bRun({ buckets: [...H, bB(1, { actions: 120, max_burst: 60, sessions: 1 })], benignIn: { bulkOps6h: 2 } }), 'observe');           // bulk upload
  atMost(bRun({ buckets: H, identity: { anomalies24h: 3 } }), 'observe');                                                // three reconnects
  atMost(bRun({ buckets: [...H, ...bEpisode(1)], fleet: { systemic: true, errorsHigh: true } }), 'observe');             // deploy retry storm
  atMost(bRun({ buckets: [...H, bB(1, { actions: 80, errors: 30, repeats: 45, max_burst: 60, sessions: 1 })] }), 'observe'); // single-hour burst + errors
  assert.strictEqual(bRun({ buckets: [...bHistory(40, { median: 80 }), bB(1, { actions: 120, max_burst: 40, sessions: 1 })] }).stage, 'normal', 'heavy legitimate power user');
  assert.strictEqual(bRun({ admin: true, buckets: [...H, ...bEpisode(1), ...bEpisode(30), ...bEpisode(54)] }).stage, 'normal', 'admins are not evaluated');
});

test('brain scenarios: one kind of evidence, or a young baseline, can never reach review', () => {
  const H = bHistory(60);
  const paceOnly = [1, 2, 3, 4].map((i) => bB(i, { actions: 90, max_burst: 70, sessions: i < 3 ? 2 : 0 }));
  atMost(bRun({ buckets: [...H, ...paceOnly] }), 'flag');                                                                 // pace without corroboration
  atMost(bRun({ ageDays: 5, buckets: [...bHistory(5), ...bEpisode(1)] }), 'flag');                                        // 5-day baseline
  const young = bRun({ ageDays: 10, buckets: [...bHistory(10), ...bEpisode(1), ...bEpisode(30), ...bEpisode(54)] });
  atMost(young, 'flag');                                                                                                  // 10-day baseline, even with 3 episodes
  assert.ok(young.risk >= 30, 'but the evidence is still SEEN (baseline contamination regression): risk ' + young.risk);
  assert.ok(young.blockers.length > 0, 'and the reason it was held back is recorded');
});

test('brain scenarios: a single corroborated episode is enhanced monitoring; recurrence earns review; trust caps it', () => {
  const H = bHistory(60);
  const one = bRun({ buckets: [...H, ...bEpisode(1)] });
  assert.strictEqual(one.stage, 'enhanced_monitoring', 'one sustained corroborated episode → watch closely, not review');
  const rec = bRun({ buckets: [...H, ...bEpisode(1), ...bEpisode(30), ...bEpisode(54)] });
  assert.strictEqual(rec.stage, 'review_candidate', 'same pattern on 3 occasions');
  assert.ok(rec.witnesses >= 3 && rec.confidence >= 0.7 && rec.risk >= 70);
  const trusted = bRun({ buckets: [...H, ...bEpisode(1), ...bEpisode(30), ...bEpisode(54)], trusted: true });
  assert.strictEqual(trusted.stage, 'enhanced_monitoring', 'Trusted is still evaluated, but never raised to review');
  assert.strictEqual(trusted.trustCapped, true);
  assert.ok(trusted.risk === rec.risk, 'trust changes the ceiling, not the observation');
});

test('brain: evidence decays with age and a stale episode outside the window carries nothing', () => {
  const H = bHistory(60);
  const fresh = bRun({ buckets: [...H, ...bEpisode(1)] });
  const older = bRun({ buckets: [...H, ...bEpisode(58)] });
  assert.ok(older.risk < fresh.risk, `older episode weighs less (${older.risk} < ${fresh.risk})`);
  assert.strictEqual(bRun({ buckets: [...H, ...bEpisode(100)] }).stage, 'normal', 'outside the 72h window');
});

test('brain progression: one rung at a time, each rung must hold; demotion is not instant', () => {
  const { progress, STAGES } = brain.engine();
  let p = { stage: 'normal', stageSince: 0 }; let t = 1e12; const seen = [];
  for (let i = 0; i < 40; i++) {
    const r = progress(p, 'review_candidate', t);
    if (!seen.length || seen[seen.length - 1][1] !== r.stage) seen.push([(t - 1e12) / 60000, r.stage]);
    p = { stage: r.stage, stageSince: r.stageSince, pendingStage: r.pendingStage, pendingSince: r.pendingSince }; t += 10 * 60000;
  }
  assert.deepStrictEqual(seen.map((x) => x[1]), STAGES.slice(1), 'climbs every rung in order, skipping none');
  assert.ok(seen[seen.length - 1][0] >= 190, `normal → review takes ≥ 190 min (took ${seen[seen.length - 1][0]})`);
  // coming down: a fresh calm must last 30 min before the stage drops, then one rung at a time
  const down1 = progress({ stage: 'review_candidate', stageSince: t - 5 * 60000 }, 'normal', t);
  assert.strictEqual(down1.stage, 'review_candidate', 'not yet');
  const down2 = progress({ stage: 'review_candidate', stageSince: t - 40 * 60000 }, 'normal', t);
  assert.strictEqual(down2.stage, 'enhanced_monitoring', 'one rung down, not straight to normal');
});

test('brain invariants (property test): thin, ambiguous or systemic evidence can never produce a high stage', () => {
  const { stageIndex } = brain.engine(); const { DAY } = brain.stats();
  let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let reviews = 0;
  for (let i = 0; i < 1500; i++) {
    const ageDays = Math.floor(rnd() * 90) + 1;
    const buckets = bHistory(Math.min(ageDays, 40), { median: 3 + Math.floor(rnd() * 40) });
    const eps = Math.floor(rnd() * 4);
    for (let e = 0; e < eps; e++) buckets.push(...bEpisode(1 + Math.floor(rnd() * 60), { errors: rnd() < 0.5 ? 0 : 42, repeats: rnd() < 0.5 ? 0 : 57, sessions: Math.floor(rnd() * 3) }));
    const fleet = { systemic: rnd() < 0.15, errorsHigh: rnd() < 0.15 };
    const trusted = rnd() < 0.2;
    const baseline = brain.baseline().computeBaseline(buckets, BNOW, { accountCreatedAt: BNOW - ageDays * DAY });
    const d = bRun({ buckets, ageDays, trusted, fleet, benignIn: { bulkOps6h: rnd() < 0.2 ? 1 : 0 } });
    if (d.stage === 'review_candidate') {
      reviews += 1;
      assert.strictEqual(baseline.maturity, 'mature', 'review needs a mature baseline');
      assert.ok(d.witnesses >= 2 && d.classes.some((c) => ['failures', 'repetition', 'throttle'].includes(c.class)), 'review needs 2+ independent kinds incl. a behavioural one');
      assert.ok(!fleet.systemic && !trusted && d.confidence >= 0.7 && d.benignTotal < 0.3);
    }
    if (baseline.maturity === 'none') assert.ok(stageIndex(d.stage) <= stageIndex('observe'), 'no history → at most observe');
    if (baseline.maturity === 'low') assert.ok(stageIndex(d.stage) <= stageIndex('flag'), 'forming baseline → at most flag');
    if (fleet.systemic) assert.ok(stageIndex(d.stage) <= stageIndex('observe'), 'fleet-wide event → at most observe');
    if (trusted) assert.ok(stageIndex(d.stage) <= stageIndex('enhanced_monitoring'), 'trusted → never review');
    assert.ok(d.risk >= 0 && d.risk <= 100 && d.confidence >= 0 && d.confidence <= 1);
  }
  assert.ok(reviews > 0, 'the generator does produce some genuine review cases (the test is not vacuous)');
});

test('brain: fleet-wide spikes are recognised as OUR event, not any one user', () => {
  const { fleetState } = brain.engine();
  const many = Array.from({ length: 10 }, (_, i) => ({ active: true, recentRateAbnormal: i < 4 }));
  assert.strictEqual(fleetState(many, { actions: 500, errors: 10 }).systemic, true, '40% of active users spiking at once');
  const few = Array.from({ length: 10 }, (_, i) => ({ active: true, recentRateAbnormal: i < 1 }));
  assert.strictEqual(fleetState(few, { actions: 500, errors: 10 }).systemic, false);
  assert.strictEqual(fleetState([{ active: true, recentRateAbnormal: true }], { actions: 10, errors: 0 }).systemic, false, 'a tiny fleet is never "systemic"');
  assert.strictEqual(fleetState(few, { actions: 400, errors: 120 }).errorsHigh, true);
});


// ── collector: counts only ─────────────────────────────────────────────
test('collector: counts sessions, repeats, bursts, errors and cap hits — and stores nothing textual', async () => {
  const c = req('lib/wardenBrain/collector'); c._reset();
  const t0 = Date.UTC(2026, 8, 30, 10, 0, 0);
  c.recordAction(5, c.kindOf({ update: { callback_query: { data: 'repos:page:2' } } }), { now: t0 });
  c.recordAction(5, c.kindOf({ update: { callback_query: { data: 'repos:page:2' } } }), { now: t0 + 2000 });            // same control within 5s → repeat
  c.recordAction(5, c.kindOf({ update: { callback_query: { data: 'repo:my-secret-private-repo' } } }), { now: t0 + 4000 });
  c.recordAction(5, c.kindOf({ update: { message: { text: 'the-secret-file-name.txt' } } }), { now: t0 + 40 * 60000 }); // 40 min later → new session
  c.recordError(5, { now: t0 + 41 * 60000 });
  c.recordCapHit(5, { now: t0 + 42 * 60000 });
  queries.length = 0; queryHandler = () => ({ rows: [], rowCount: 1 });
  assert.strictEqual(await c.flush(t0 + 43 * 60000), 1);
  const q = queries.find((x) => /warden_activity_buckets/.test(x.sql));
  const [ids, , actions, errors, repeats, caps, sessions, minutes, burst] = q.params;
  assert.deepStrictEqual([ids[0], actions[0], errors[0], repeats[0], caps[0], sessions[0], minutes[0], burst[0]], [5, 4, 1, 1, 1, 2, 2, 3]);
  assert.ok(!/secret|\.txt|repos:page/.test(JSON.stringify(q.params)), 'no control names, repo names or file names are ever written');
  queries.length = 0;
  assert.strictEqual(await c.flush(t0 + 44 * 60000), 0, 'a second flush with nothing new writes nothing (no double counting)');
  assert.strictEqual(queries.length, 0);
  c.recordAction(5, 'x', { now: t0 + 45 * 60000 });
  c.forget(5);
  assert.strictEqual(await c.flush(t0 + 46 * 60000), 0, 'forget() drops pending counters (used when a user is erased)');
  c._reset(); queryHandler = () => ({ rows: [], rowCount: 0 });
});

test('erasing a user also erases Warden Brain data and pending counters', async () => {
  const users = req('lib/users'); const c = req('lib/wardenBrain/collector'); c._reset();
  c.recordAction(9, 'x', { now: Date.now() });
  queries.length = 0; queryHandler = () => ({ rows: [], rowCount: 0 });
  await users.deleteUserAndData(9);
  const sql = queries.map((q) => q.sql).join('\n');
  for (const t of ['warden_activity_buckets', 'warden_profiles', 'warden_cases', 'warden_case_events', 'warden_evidence']) assert.ok(new RegExp(`DELETE FROM ${t}\\b`).test(sql), t);
  queries.length = 0;
  assert.strictEqual(await c.flush(), 0, 'nothing left in memory to resurrect the erased user');
  c._reset();
});

// ── the structural guarantee ───────────────────────────────────────────
test('Warden has NO way to touch an account: no enforcement calls, and its only outgoing message goes to the owner', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = [path.join(SRC, 'lib/warden.js'), path.join(SRC, 'lib/pollers/warden.js'), ...walk(path.join(SRC, 'lib/wardenBrain')).filter((f) => f.endsWith('.js'))];
  assert.ok(files.length >= 8);
  const forbidden = /\b(suspendUser|unsuspendUser|banUser|unbanUser|deleteUser|deleteUserAndData|setBlocked|setSuspended|setLimitOverrides|revokeGithubConnection|hourly_action_cap_override|setTrusted|deleteUserRepo|setUserRepoVisibility)\b/;
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!forbidden.test(code), `${path.relative(SRC, f)} must not be able to act on accounts`);
    for (const m of code.matchAll(/sendMessage\(([^,)]+)/g)) assert.strictEqual(m[1].trim(), 'to', `${path.relative(SRC, f)}: sendMessage must only target the owner (got ${m[1]})`);
  }
  // …and the only code that can send a user-facing warning is the owner's confirm button
  assert.ok(req('lib/confirmFlow').isActionCallback('warden:case:7:warnsend'), 'warning send is double-tap protected');
  assert.ok(!/sendMessage/.test(fs.readFileSync(path.join(SRC, 'lib/wardenBrain/cases.js'), 'utf8')));
});

// ── menus ──────────────────────────────────────────────────────────────
const wardenCfg = (o = {}) => ({ id: 1, enabled: true, alerts_review: true, ...o });
const labelsOf = (x) => x.reply_markup.inline_keyboard.flat().map((b) => b.text);
const dataOf = (x) => x.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

test('Warden menus: every control states its value; no enforcement controls remain; labels fit two per row', () => {
  const inline = req('keyboards/inline');
  const main = labelsOf(inline.wardenMainMenu(wardenCfg(), 3));
  assert.ok(main.includes('🟢 Warden: ON') && main.includes('🔔 Alerts: ON') && main.includes('🗂 Board (3)'));
  const off = labelsOf(inline.wardenMainMenu(wardenCfg({ enabled: false, alerts_review: false })));
  assert.ok(off.includes('⚫ Warden: OFF') && off.includes('🔕 Alerts: OFF'));
  const card = labelsOf(inline.wardenCaseCard(7, { trusted: true, shielded: false }));
  assert.ok(card.includes('⭐ Trusted: YES') && card.includes('🛡 Repo shield: OFF'));
  assert.ok(labelsOf(inline.wardenCaseCard(7, { trusted: false, shielded: true })).includes('🛡 Repo shield: ON'));
  const everything = [...main, ...card, ...labelsOf(inline.wardenShieldMenu({ lastBatch: { n: 4 } })), ...labelsOf(inline.wardenExportMenu()), ...labelsOf(inline.wardenEnforcementGate(7, false))];
  for (const gone of ['Restrict', 'Suspend', 'Mute', 'Nudge', 'Stop Now', 'Allow', 'Unlock', 'LIVE', 'DRY', 'Template', 'Cooldown', 'Max per run']) {
    assert.ok(!main.join('|').includes(gone), `main menu must not offer: ${gone}`);
  }
  for (const l of everything) assert.ok([...l].length <= 24, `label too long for a half-width button: ${l}`);
  for (const m of [inline.wardenMainMenu(wardenCfg(), 1), inline.wardenCaseCard(7, {}), inline.wardenShieldMenu(null)]) {
    const d = dataOf(m); assert.strictEqual(new Set(d).size, d.length, 'no two buttons share an action');
  }
  assert.ok(labelsOf(inline.wardenShieldMenu({ lastBatch: { n: 4 } })).includes('↩️ Undo last (4 users)'));
});

test('Warden menus: every button they can emit is routed in bot.js (no dead buttons) and the generic fallback is not what catches them', () => {
  const inline = req('keyboards/inline');
  const botSrc = fs.readFileSync(path.join(SRC, 'bot.js'), 'utf8');
  const block = botSrc.slice(botSrc.indexOf('// ─── 🤖 Warden (Owner-only)'), botSrc.indexOf('// ─── 🗄️ Export/Import'));
  const exact = [...block.matchAll(/data === '([^']+)'/g)].map((m) => m[1]);
  const prefixes = [...block.matchAll(/data\.startsWith\('([^']+)'\)/g)].map((m) => m[1]).filter((p) => p !== 'warden:');
  const regexes = [...block.matchAll(/data\.match\((\/[^\n]*?\/)\)/g)].map((m) => eval(m[1])); // eslint-disable-line no-eval
  const routed = (d) => exact.includes(d) || prefixes.some((p) => d.startsWith(p)) || regexes.some((r) => r.test(d));
  const rows = [{ id: 7, telegram_id: 1, telegram_username: 'a', stage: 'flag', risk: 40 }];
  const emitted = [
    ...dataOf(inline.wardenMainMenu(wardenCfg(), 2)), ...dataOf(inline.wardenBoardList(rows, 2, 3, 'all')), ...dataOf(inline.wardenCaseCard(7, {})),
    ...dataOf(inline.wardenWarnPreview(7)), ...dataOf(inline.wardenEnforcementGate(7, false)), ...dataOf(inline.wardenEnforcementGate(7, true)),
    ...dataOf(inline.wardenBackToCase(7)), ...dataOf(inline.wardenActionLogPagination(2, 3)), ...dataOf(inline.wardenExportMenu()),
    ...dataOf(inline.wardenShieldMenu({ lastBatch: { n: 1 } })), ...dataOf(inline.wardenShieldConfirm('connected', true)),
  ].filter((d) => d.startsWith('warden:'));
  assert.ok(emitted.length > 25);
  for (const d of emitted) assert.ok(routed(d), `no specific route for ${d}`);
  // the double-tap claim covers every button that sends something or changes many accounts
  const cf = req('lib/confirmFlow');
  for (const d of ['warden:case:7:warnsend', 'warden:shield:do:connected:p', 'warden:shield:undo']) assert.ok(cf.isActionCallback(d), d);
  for (const d of ['warden:case:7:warn', 'warden:shield:ask:connected:p', 'warden:case:7']) assert.ok(!cf.isActionCallback(d), `${d} only opens a screen`);
});

// ── handlers, driven against a fake database ───────────────────────────
function wardenHarness({ cfg = wardenCfg(), cases: caseRows = [], user = { telegram_id: 42, telegram_username: 'bob', created_at: new Date(Date.now() - 100 * 86400000), is_trusted: false, repos_protected: false }, events = [], warned = false } = {}) {
  const state = { cfg: { ...cfg }, sent: [], edits: [], toasts: [], replies: [], events: [], docs: [], queries };
  state.ctx = {
    from: { id: 1 }, session: {}, callbackQuery: { data: 'x' },
    answerCbQuery: async (t) => { state.toasts.push(t); },
    editMessageText: async (text, extra) => { state.edits.push({ text, extra }); },
    reply: async (text, extra) => { state.replies.push({ text, extra }); },
    replyWithDocument: async (doc, extra) => { state.docs.push({ doc, extra }); },
    telegram: { sendMessage: async (...a) => { state.sent.push(a); } },
  };
  state.adminFn = { requireOwner: async () => true, showUserDetail: async (c, id) => { state.openedUser = id; } };
  queries.length = 0;
  queryHandler = (sql, params) => {
    if (/SELECT \* FROM warden_config/.test(sql)) return { rows: [{ ...state.cfg }], rowCount: 1 };
    const u = sql.match(/UPDATE warden_config SET (.+?), updated_at/);
    if (u) { u[1].split(',').forEach((pair, i) => { state.cfg[pair.split('=')[0].trim()] = params[i]; }); return { rows: [], rowCount: 1 }; }
    if (/FROM warden_profiles GROUP BY stage/.test(sql)) return { rows: [{ stage: 'normal', c: 5 }, { stage: 'flag', c: 1 }], rowCount: 2 };
    if (/FROM warden_cases WHERE status = 'open'$/.test(sql.trim()) || /SELECT COUNT\(\*\)::int AS c FROM warden_cases WHERE status = 'open'$/.test(sql.trim())) return { rows: [{ c: 2 }], rowCount: 1 };
    if (/action_type LIKE 'stage:%'/.test(sql)) return { rows: [{ action_type: 'stage:flag', c: 1 }], rowCount: 1 };
    if (/SELECT c\.\*, u\.telegram_username/.test(sql)) return { rows: caseRows, rowCount: caseRows.length };
    if (/COUNT\(\*\)::int AS c FROM warden_cases WHERE status = 'open' AND stage/.test(sql)) return { rows: [{ c: caseRows.length }], rowCount: 1 };
    if (/SELECT \* FROM warden_cases WHERE id/.test(sql)) return { rows: caseRows.filter((c) => c.id === params[0]), rowCount: 1 };
    if (/FROM users WHERE telegram_id/.test(sql)) return { rows: [{ ...user }], rowCount: 1 };
    if (/prior_cases/.test(sql)) return { rows: [{ prior_cases: 0, warnings: warned ? 1 : 0 }], rowCount: 1 };
    if (/FROM warden_case_events WHERE telegram_id = \$1 AND kind = 'warning_sent'/.test(sql)) return { rows: warned ? [{ created_at: new Date('2026-09-01T10:00:00Z'), detail: { summary: '90 actions in a single hour' } }] : [], rowCount: warned ? 1 : 0 };
    if (/FROM warden_case_events WHERE case_id/.test(sql)) return { rows: events, rowCount: events.length };
    if (/INSERT INTO warden_case_events/.test(sql)) { state.events.push({ kind: params[2], detail: JSON.parse(params[3]), actor: params[4] }); return { rows: [], rowCount: 1 }; }
    if (/SELECT snooze_until, dismissed_until/.test(sql)) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  return state;
}
const sampleCase = (o = {}) => ({
  id: 7, telegram_id: 42, status: 'open', stage: 'enhanced_monitoring', peak_stage: 'enhanced_monitoring', risk: '64', confidence: '0.73',
  telegram_username: 'bob', opened_at: new Date(), updated_at: new Date(), alerted_at: null,
  summary: { risk: 64, confidence: 0.73, confidenceLabel: 'high', maturity: 'mature', witnesses: 3, benign: [], blockers: ['Not yet persistent across enough separate sessions or days'],
    reasons: ['90 actions in one hour (9.0× this user\'s usual ~10/hour)'], persistence: { longest_run_hours: 4, sessions_abnormal: 6, episodes: 1, distinct_days: 1 },
    classes: [{ class: 'rate', strength: 0.77, observed: { actions: 90, max_burst: 70 }, baseline: { source: 'personal', rate_median: 10 } },
      { class: 'failures', strength: 0.8, observed: { errors: 42, actions: 90 }, baseline: {} }, { class: 'repetition', strength: 0.7, observed: { repeats: 57, actions: 90 }, baseline: {} }] },
  ...o,
});

test('Warden main screen: toggles flip exactly one setting and edit the same message in place', async () => {
  const wardenAdmin = req('handlers/wardenAdmin'); const inline = req('keyboards/inline');
  const h = wardenHarness();
  await wardenAdmin.toggleEnabled(h.ctx, { adminFn: h.adminFn });
  assert.strictEqual(h.state, undefined);
  assert.strictEqual(h.cfgAfter, undefined);
  assert.strictEqual(h.edits.at(-1).extra.reply_markup.inline_keyboard.flat().some((b) => b.text === '⚫ Warden: OFF'), true);
  assert.ok(/Off/.test(h.edits.at(-1).text) && /observation only/.test(h.edits.at(-1).text));
  await wardenAdmin.toggleAlerts(h.ctx, { adminFn: h.adminFn });
  assert.ok(labelsOf(h.edits.at(-1).extra).includes('🔕 Alerts: OFF'));
  assert.ok(/Where people are right now/.test(h.edits.at(-1).text) && /🚩 1/.test(h.edits.at(-1).text), 'stage counts are shown');
  assert.ok(labelsOf(h.edits.at(-1).extra).includes('🗂 Board (2)'));
  // a button from an older menu is answered and the menu redrawn, never silently ignored
  const before = h.edits.length;
  await wardenAdmin.refreshRemoved(h.ctx, { adminFn: h.adminFn });
  assert.ok(/no longer takes actions/i.test(h.toasts.at(-1)) && h.edits.length === before + 1);
  void inline; queryHandler = () => ({ rows: [], rowCount: 0 });
});

test('Owner Board: preview never sends; Send delivers ONE plain-language message and records it; Dismiss records a false positive', async () => {
  const board = req('handlers/wardenBoard');
  const h = wardenHarness({ cases: [sampleCase()] });
  await board.previewWarning(h.ctx, 7, { adminFn: h.adminFn });
  assert.strictEqual(h.sent.length, 0, 'previewing sends nothing');
  const preview = h.edits.at(-1).text;
  assert.ok(/<pre>/.test(preview) && /Unusual activity noticed/.test(preview) && /90 actions in a single hour/.test(preview));
  assert.ok(!/risk|score|threshold|confidence|baseline/i.test(preview.replace(/<i>[\s\S]*?<\/i>/g, '')), 'the user sees none of the internal numbers or logic');
  await board.sendWarning(h.ctx, 7, { adminFn: h.adminFn });
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0][0], 42);
  assert.strictEqual(h.sent[0].length, 2, 'plain text, no parse mode to break on user data');
  assert.ok(/Monitoring only/.test(h.sent[0][1]) && /no restriction has been applied/.test(h.sent[0][1]));
  assert.deepStrictEqual(h.events.map((e) => e.kind), ['warning_sent']);
  assert.strictEqual(h.events[0].actor, 1);
  await board.dismissCase(h.ctx, 7, { adminFn: h.adminFn });
  assert.ok(h.events.some((e) => e.kind === 'dismissed' && e.detail.label === 'false_positive'));
  queryHandler = () => ({ rows: [], rowCount: 0 });
});

test('Owner Board: the case card is the technical version; the enforcement gate asks for a warning first', async () => {
  const board = req('handlers/wardenBoard');
  const h = wardenHarness({ cases: [sampleCase()] });
  await board.showCase(h.ctx, 7, { adminFn: h.adminFn });
  const card = h.edits.at(-1).text;
  for (const must of ['Warden case #7', 'Enhanced monitoring', 'Risk:</b> 64/100', 'Confidence:</b> high', 'Action:</b> none', 'Evidence', 'Historical context', 'Legitimate-use check', 'Why not higher', 'Interpretation', 'Warden decision']) {
    assert.ok(card.includes(must), `case card missing: ${must}`);
  }
  assert.ok(labelsOf(h.edits.at(-1).extra).includes('⚠️ Send warning'));
  await board.showEnforcementGate(h.ctx, 7, { adminFn: h.adminFn });
  assert.ok(/No warning has been sent/.test(h.edits.at(-1).text));
  assert.ok(labelsOf(h.edits.at(-1).extra).includes('⚠️ Send warning first'));
  const w = wardenHarness({ cases: [sampleCase()], warned: true });
  await board.showEnforcementGate(w.ctx, 7, { adminFn: w.adminFn });
  assert.ok(/was warned/.test(w.edits.at(-1).text) && !labelsOf(w.edits.at(-1).extra).includes('⚠️ Send warning first'));
  await board.enforcementContinue(w.ctx, 7, { adminFn: w.adminFn });
  assert.strictEqual(w.openedUser, 42, 'continues to the normal user-actions screen');
  queryHandler = () => ({ rows: [], rowCount: 0 });
});

test('Owner Board: a stale button for a case that no longer exists is answered, not ignored', async () => {
  const board = req('handlers/wardenBoard');
  const h = wardenHarness({ cases: [] });
  await board.showCase(h.ctx, 999, { adminFn: h.adminFn });
  assert.ok(/no longer exists/.test(h.toasts[0]) && /Warden Board/.test(h.edits.at(-1).text));
  queryHandler = () => ({ rows: [], rowCount: 0 });
});

// ── Repo Shield ─────────────────────────────────────────────────────────
test('Repo Shield: other admins are blocked (and it is audit-logged); the owner is not; unprotected users are unaffected', async () => {
  const aa = req('lib/adminActions');
  const asUser = (extra) => (sql) => (/FROM users WHERE telegram_id/.test(sql) ? { rows: [{ telegram_id: 77, ...extra }], rowCount: 1 } : { rows: [], rowCount: 1 });
  queries.length = 0; queryHandler = asUser({ repos_protected: true });
  await assert.rejects(() => aa.assertRepoModerationAllowed(999, 77), (e) => e.code === 'REPOS_PROTECTED');
  assert.ok(queries.some((q) => /INSERT INTO admin_audit_log|audit/.test(q.sql) || (q.params || []).includes('repo_access_blocked')), 'blocked attempt is audit-logged');
  await assert.rejects(() => aa.listUserRepos(77, 999), (e) => e.code === 'REPOS_PROTECTED');
  await assert.rejects(() => aa.deleteUserRepo(999, 77, 'r', null), (e) => e.code === 'REPOS_PROTECTED');
  await aa.assertRepoModerationAllowed(1, 77);                       // the owner acts freely
  queryHandler = asUser({ repos_protected: false });
  await aa.assertRepoModerationAllowed(999, 77);                     // not protected → allowed through the guard
  queryHandler = () => ({ rows: [], rowCount: 0 });
});

test('Repo Shield: bulk changes are owner-only, skip accounts already in that state, record what changed, and undo exactly that', async () => {
  const shield = req('lib/repoShield');
  await assert.rejects(() => shield.bulk(999, 'connected', true), (e) => e.code === 'OWNER_ONLY');
  await assert.rejects(() => shield.setOne(999, 5, true), (e) => e.code === 'OWNER_ONLY');
  queries.length = 0;
  queryHandler = (sql) => {
    if (/UPDATE users SET repos_protected = \$1/.test(sql)) return { rows: [{ telegram_id: 10 }, { telegram_id: 11 }], rowCount: 2 };
    if (/INSERT INTO repo_shield_batches/.test(sql)) return { rows: [{ id: 5 }], rowCount: 1 };
    if (/SELECT \* FROM repo_shield_batches/.test(sql)) return { rows: [{ id: 5, action: 'protect', affected: [10, 11] }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const r = await shield.bulk(1, 'connected', true);
  assert.deepStrictEqual(r, { batchId: 5, changed: 2 });
  const upd = queries.find((q) => /UPDATE users SET repos_protected = \$1/.test(q.sql));
  assert.ok(/IS DISTINCT FROM \$1/.test(upd.sql) && /is_admin = FALSE/.test(upd.sql), 'skips accounts already in that state and never touches admins');
  assert.deepStrictEqual(queries.find((q) => /INSERT INTO repo_shield_batches/.test(q.sql)).params.slice(1, 4), ['protect', 'connected', [10, 11]]);
  queries.length = 0;
  const u = await shield.undoLast(1);
  assert.strictEqual(u.ok, true);
  const undo = queries.find((q) => /UPDATE users SET repos_protected = \$2/.test(q.sql));
  assert.deepStrictEqual([undo.params[0], undo.params[1]], [[10, 11], false], 'undoing a protect un-protects exactly those accounts');
  assert.strictEqual(await shield.setOne(1, 1, true), false, "the owner's own repos need no shield");
  queryHandler = () => ({ rows: [], rowCount: 0 });
});

test('user card: Repo shield is the owner\u2019s switch; other admins see protection but cannot open the repos', () => {
  const inline = req('keyboards/inline');
  const user = { telegram_id: 77, github_username: 'x', is_trusted: false, repos_protected: false };
  const owner = labelsOf(inline.adminUserDetail(user, false, false, false, false, { viewerIsOwner: true }));
  assert.ok(owner.includes('🛡 Repo shield: OFF') && owner.includes('⭐ Trusted: NO') && owner.includes('📂 Repos'));
  const prot = labelsOf(inline.adminUserDetail({ ...user, repos_protected: true }, false, false, false, false, { viewerIsOwner: true }));
  assert.ok(prot.includes('🛡 Repo shield: ON'));
  const mod = labelsOf(inline.adminUserDetail({ ...user, repos_protected: true }, false, false, false, false, { viewerIsOwner: false, reposShielded: true }));
  assert.ok(!mod.includes('📂 Repos') && mod.includes('🛡 Repos protected by owner') && !mod.some((l) => l.includes('Repo shield')));
  const open = labelsOf(inline.adminUserDetail(user, false, false, false, false, { viewerIsOwner: false, reposShielded: false }));
  assert.ok(open.includes('📂 Repos') && !open.some((l) => l.includes('Repo shield')), 'non-owners never get the switch');
});

test('⭐ Trusted: never throttled by the hourly cap (still observed by Warden)', () => {
  const limits = req('lib/limits');
  assert.strictEqual(limits.getEffectiveLimits({ is_trusted: true, hourly_action_cap_override: 10 }).hourlyActionCap, 0);
  assert.strictEqual(limits.getEffectiveLimits({ is_trusted: false, hourly_action_cap_override: 10 }).hourlyActionCap, 10);
});

// ── warnings ────────────────────────────────────────────────────────────
test('Warning engine: enforcement notices are specific; user notices reveal no internals', () => {
  const w = req('lib/wardenBrain/warnings');
  const ban = w.enforcementNotice({ action: 'ban', reason: 'Repeatedly scripting the bot to create hundreds of repositories after being warned.', priorWarning: { at: new Date('2026-09-01T00:00:00Z'), summary: '90 actions in a single hour' } });
  for (const must of ['permanently revoked', 'Why', 'Repeatedly scripting the bot', 'Earlier warning', '2026-09-01', 'What this means', 'disconnected', 'Contact Admin']) assert.ok(ban.includes(must), `ban notice missing: ${must}`);
  const temp = w.enforcementNotice({ action: 'ban', reason: 'Abuse of the bulk tools.', durationText: '7 days', untilText: 'until 2026-10-08 12:00 UTC' });
  assert.ok(/revoked for 7 days/.test(temp) && /returns automatically/.test(temp) && /reconnect/.test(temp));
  const sus = w.enforcementNotice({ action: 'suspend', reason: 'Testing', durationText: '24 hours', untilText: 'until x' });
  assert.ok(/paused for 24 hours/.test(sus) && /untouched/.test(sus));
  assert.ok(/No specific reason was recorded/.test(w.enforcementNotice({ action: 'suspend', reason: '  ', durationText: '1 hour' })), 'a missing reason is stated, never hidden');
  const un = w.userNotice([{ class: 'rate', observed: { actions: 90 }, baseline: { source: 'personal', rate_median: 10 } }, { class: 'failures', observed: { errors: 42 } }]);
  assert.ok(/90 actions in a single hour \(your usual is around 10 an hour\)/.test(un) && /42 operations failed/.test(un) && /Monitoring only/.test(un));
  assert.ok(!/risk|score|threshold|confidence|baseline|restrict(ed)? to/i.test(un.replace('no restriction has been applied', '')), 'no internals leak to the user');
  const src = fs.readFileSync(path.join(SRC, 'handlers/admin.js'), 'utf8');
  assert.ok(/MIN_REASON_LENGTH = 15/.test(src));
  const skipBan = src.slice(src.indexOf('async function skipBanReason'), src.indexOf('async function askBanDuration'));
  assert.ok(!/askBanDuration\(/.test(skipBan), 'Skip no longer bypasses the reason for a ban');
  const skipSus = src.slice(src.indexOf('async function skipSuspendReason'), src.indexOf('async function executeUnsuspend'));
  assert.ok(!/executeSuspend\(/.test(skipSus), 'Skip no longer bypasses the reason for a suspension');
});

// ── JSONL ───────────────────────────────────────────────────────────────
test('JSONL: one valid, typed, versioned record per line; datasets export; empty exports are reported as empty', async () => {
  const jsonl = req('lib/jsonl'); const warden = req('lib/warden');
  const body = jsonl.toJsonl([jsonl.record('decision_log', { a: 1, text: 'line1\nline2, "quoted"' }), jsonl.record('case', { b: [1, 2] })]);
  const lines = body.trim().split('\n');
  assert.strictEqual(lines.length, 2, 'embedded newlines are escaped, so a record never spans lines');
  const first = JSON.parse(lines[0]);
  assert.deepStrictEqual([first.schema, first.record_type, first.text], ['gitrohub.warden/1', 'decision_log', 'line1\nline2, "quoted"']);
  assert.strictEqual(jsonl.toJsonl([]), '');
  assert.ok(/^warden_all_20260930T120000Z\.jsonl$/.test(jsonl.filename('all', new Date('2026-09-30T12:00:00Z'))));
  queries.length = 0;
  queryHandler = (sql) => {
    if (/FROM warden_action_log l/.test(sql)) return { rows: [{ id: 1, created_at: new Date('2026-09-30T00:00:00Z'), action_type: 'stage:flag', target_id: 42, telegram_username: 'bob', reason: 'r', dry_run: false }], rowCount: 1 };
    if (/FROM warden_cases WHERE opened_at/.test(sql)) return { rows: [{ id: 7, telegram_id: 42, status: 'open', stage: 'flag', peak_stage: 'flag', risk: '40', confidence: '0.5', opened_at: new Date(), updated_at: new Date(), summary: {} }], rowCount: 1 };
    if (/FROM warden_profiles/.test(sql)) return { rows: [{ telegram_id: 42, stage: 'flag', risk: '40', confidence: '0.5', baseline: {}, last_decision: {} }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const all = await warden.exportDataset('all');
  const types = all.body.trim().split('\n').map((l) => JSON.parse(l).record_type);
  assert.deepStrictEqual([...new Set(types)].sort(), ['case', 'decision_log', 'profile']);
  assert.strictEqual(all.count, 3);
  queryHandler = () => ({ rows: [], rowCount: 0 });
  assert.deepStrictEqual(await warden.exportDataset('evidence').then((r) => [r.count, r.body]), [0, '']);
  await assert.rejects(() => warden.exportDataset('csv'), /unknown dataset/);
});

// ── recovery (moved out of Warden) ──────────────────────────────────────
test('one-time recovery lifts false restrictions once, notifies only ordinary users, and never runs twice', async () => {
  const { releaseFalseRestrictions } = req('lib/wardenRecovery');
  const sent = []; const bot = { telegram: { sendMessage: async (id) => { sent.push(id); } } };
  let markerPresent = false;
  queries.length = 0;
  queryHandler = (sql) => {
    if (/SELECT 1 FROM warden_action_log WHERE action_type/.test(sql)) return { rows: markerPresent ? [{ x: 1 }] : [], rowCount: 0 };
    if (/UPDATE users u SET hourly_action_cap_override = NULL/.test(sql)) return { rows: [{ telegram_id: 7, is_admin: false }, { telegram_id: 1, is_admin: true }], rowCount: 2 };
    if (/INSERT INTO warden_action_log/.test(sql)) markerPresent = true;
    return { rows: [], rowCount: 0 };
  };
  const r1 = await releaseFalseRestrictions(bot);
  assert.strictEqual(r1.released, 2);
  assert.deepStrictEqual(sent, [7], 'only the ordinary user is told; the admin is not');
  assert.ok(/hourly_action_cap_override = 10/.test(queries.find((q) => /UPDATE users u SET/.test(q.sql)).sql), 'only touches the cap Warden itself set');
  assert.strictEqual((await releaseFalseRestrictions(bot)).skipped, true);
  queryHandler = () => ({ rows: [], rowCount: 0 });
});

// ── end to end: runner against a fake database ──────────────────────────
function runnerDb({ buckets, profile = null, userAgeDays = 100 }) {
  const log = { profileUpserts: [], caseInserts: 0, evidence: 0, stageLogs: [], sent: [] };
  const { computeBaseline } = brain.baseline(); const { DAY } = brain.stats();
  queries.length = 0;
  queryHandler = (sql, params) => {
    if (/SELECT \* FROM warden_config/.test(sql)) return { rows: [{ enabled: true, alerts_review: true }], rowCount: 1 };
    if (/FROM users u\s+LEFT JOIN warden_profiles p ON p\.telegram_id = u\.telegram_id\s+WHERE u\.is_admin = false/.test(sql)) return { rows: [{ telegram_id: 42, created_at: new Date(BNOW - userAgeDays * DAY), is_trusted: false, is_admin: false }], rowCount: 1 };
    if (/FROM warden_activity_buckets WHERE telegram_id = ANY/.test(sql)) return { rows: buckets.filter((b) => new Date(b.bucket_start) > params[1]).map((b) => ({ telegram_id: 42, ...b, bucket_start: new Date(b.bucket_start) })), rowCount: 1 };
    if (/SELECT \* FROM warden_profiles WHERE telegram_id = ANY/.test(sql)) return { rows: profile ? [profile] : [], rowCount: profile ? 1 : 0 };
    if (/SELECT \* FROM warden_profiles p WHERE stage <> 'normal'/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT \* FROM warden_cases WHERE telegram_id = \$1 AND status = 'open'/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO warden_profiles/.test(sql)) { log.profileUpserts.push(params); return { rows: [], rowCount: 1 }; }
    if (/INSERT INTO warden_cases/.test(sql)) { log.caseInserts += 1; return { rows: [{ id: 9, telegram_id: 42, stage: params[1], risk: params[2], confidence: params[3], alerted_at: null, updated_at: new Date() }], rowCount: 1 }; }
    if (/INSERT INTO warden_evidence/.test(sql)) { log.evidence += 1; return { rows: [], rowCount: 1 }; }
    if (/INSERT INTO warden_action_log/.test(sql)) { log.stageLogs.push(params[1]); return { rows: [], rowCount: 1 }; }
    if (/SELECT telegram_username, telegram_first_name FROM users/.test(sql)) return { rows: [{ telegram_username: 'bob' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  log.baselineFor = (b) => computeBaseline(b, BNOW, { accountCreatedAt: BNOW - userAgeDays * DAY });
  return log;
}

test('runner end to end: the first pass only OBSERVES (one rung, no case, nobody messaged) even on a recurring pattern', async () => {
  const runner = req('lib/wardenBrain/runner');
  const buckets = [...bHistory(60), ...bEpisode(1), ...bEpisode(30), ...bEpisode(54)];
  const db = runnerDb({ buckets });
  const sent = []; const bot = { telegram: { sendMessage: async (...a) => { sent.push(a); } } };
  const out = await runner.runEvaluation({ bot, now: BNOW });
  assert.strictEqual(out.evaluated, 1);
  assert.strictEqual(db.profileUpserts[0][3], 'observe', 'normal → observe only; every higher rung must hold first');
  assert.strictEqual(db.caseInserts, 0, 'no case below Flagged');
  assert.deepStrictEqual(db.stageLogs, ['stage:observe']);
  assert.ok(db.evidence >= 1, 'but the evidence is recorded');
  assert.strictEqual(sent.length, 0, 'and nobody — user or owner — is messaged');
  queryHandler = () => ({ rows: [], rowCount: 0 });
});

test('runner end to end: when review has held long enough, a case opens and ONLY the owner is pinged — never the user', async () => {
  const runner = req('lib/wardenBrain/runner');
  const buckets = [...bHistory(60), ...bEpisode(1), ...bEpisode(30), ...bEpisode(54)];
  const { DAY } = brain.stats();
  const baseline = brain.baseline().computeBaseline(buckets, BNOW, { accountCreatedAt: BNOW - 100 * DAY });
  const profile = { telegram_id: 42, baseline, baseline_updated_at: new Date(BNOW - 3600e3), stage: 'enhanced_monitoring', stage_since: new Date(BNOW - 3 * 3600e3),
    pending_stage: 'review_candidate', pending_since: new Date(BNOW - 100 * 60000), risk: '74', confidence: '0.8', last_eval_at: new Date(BNOW - 300000), dismissed_until: null, snooze_until: null };
  const db = runnerDb({ buckets, profile });
  const sent = []; const bot = { telegram: { sendMessage: async (...a) => { sent.push(a); } } };
  const out = await runner.runEvaluation({ bot, now: BNOW });
  assert.strictEqual(out.alerts, 1);
  assert.strictEqual(db.caseInserts, 1);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0][0], 1, 'the message goes to the OWNER (id 1), not to user 42');
  assert.ok(/ready for review/.test(sent[0][1]) && /Nothing has been done to the account/.test(sent[0][1]));
  assert.strictEqual(sent[0][2].reply_markup.inline_keyboard[0][0].callback_data, 'warden:case:9');
  queryHandler = () => ({ rows: [], rowCount: 0 });
});

test('runner: disabled means disabled; an admin or a quiet fleet produces nothing', async () => {
  const runner = req('lib/wardenBrain/runner');
  queryHandler = (sql) => (/SELECT \* FROM warden_config/.test(sql) ? { rows: [{ enabled: false }], rowCount: 1 } : { rows: [], rowCount: 0 });
  assert.deepStrictEqual(await runner.runEvaluation({ now: BNOW }), { skipped: true, reason: 'disabled' });
  queryHandler = (sql) => (/SELECT \* FROM warden_config/.test(sql) ? { rows: [{ enabled: true }], rowCount: 1 } : { rows: [], rowCount: 0 });
  const out = await runner.runEvaluation({ now: BNOW });
  assert.strictEqual(out.evaluated, 0);
  queryHandler = () => ({ rows: [], rowCount: 0 });
});

test('hooks: the access gate and the activity log feed the collector', () => {
  assert.ok(/collector\.recordAction\(senderId, collector\.kindOf\(ctx\)/.test(fs.readFileSync(path.join(SRC, 'middleware/accessControl.js'), 'utf8')));
  assert.ok(/collector\.recordCapHit\(senderId\)/.test(fs.readFileSync(path.join(SRC, 'middleware/accessControl.js'), 'utf8')));
  assert.ok(/recordError\(telegramId\)/.test(fs.readFileSync(path.join(SRC, 'lib/activity.js'), 'utf8')));
});

// ═════════════════════ run ═════════════════════
(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}\n      ${(err && err.stack ? err.stack : String(err)).split('\n').slice(0, 4).join('\n      ')}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
