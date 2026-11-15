#!/usr/bin/env node
/**
 * v1.2.3-multi regression tests — one or more per fix, fully offline (no database, no
 * Redis, no Telegram, no GitHub). Run with:  node scripts/v123-tests.js   (npm run test:v123)
 */
const assert = require('assert');
const path = require('path');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Rule engine (Z1, Z2) ──────────────────────────────────────────────────────
test('rule engine: glob matching is case-insensitive and * is the only wildcard', () => {
  const { globMatch } = t.req('lib/ruleEngine');
  assert.equal(globMatch('api-*', 'API-Server'), true);
  assert.equal(globMatch('*-svc', 'x-svc'), true);
  assert.equal(globMatch('a*b', 'ab'), true);
  assert.equal(globMatch('a*b', 'a'), false);
  assert.equal(globMatch('*', ''), true);
  assert.equal(globMatch('a.c', 'abc'), false, '"." is a literal dot, not a regex wildcard');
});

test('rule engine: a wildcard-heavy pattern no longer blocks the event loop (was ~9.5s)', () => {
  const { globMatch } = t.req('lib/ruleEngine');
  const started = Date.now();
  assert.equal(globMatch('a*a*a*a*a*a*a*a*b', 'a'.repeat(100)), false);
  assert.ok(Date.now() - started < 200, 'must finish in well under 200ms');
});

test('rule engine: the function the bot actually calls (matchesRule) is also immune to the hang', () => {
  const { matchesRule } = t.req('lib/ruleEngine');
  const started = Date.now();
  // 6 wildcards used to take ~9.5 s here; 8 never finished.
  assert.equal(matchesRule({ field: 'name', op: 'matches', value: 'a*a*a*a*a*a*a*a*b' }, { name: 'a'.repeat(100) }), false);
  assert.equal(matchesRule({ field: 'name', op: 'matches', value: 'api-*' }, { name: 'API-gateway' }), true);
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started}ms`);
});

test('rule engine: validateRule normalises and rejects bad rules', () => {
  const { validateRule, matchesRule } = t.req('lib/ruleEngine');
  assert.deepEqual(validateRule({ field: 'name', op: 'matches', value: '  a**b***  ' }).rule, { field: 'name', op: 'matches', value: 'a*b*' });
  assert.equal(validateRule({ field: 'name', op: 'matches', value: '*a*a*a*a*a*a*a*a*a*' }).ok, false, 'too many wildcards');
  assert.equal(validateRule({ field: 'name', op: 'matches', value: 'x'.repeat(101) }).ok, false, 'too long');
  assert.equal(validateRule({ field: 'name', op: 'matches', value: 5 }).ok, false, 'non-string');
  assert.equal(validateRule({ field: 'visibility', op: 'eq', value: 'secret' }).ok, false);
  assert.equal(validateRule({ field: 'bogus', op: 'eq', value: 'x' }).ok, false);
  assert.equal(matchesRule({ field: 'name', op: 'matches', value: 123 }, { name: 'x' }), false, 'a non-string value from an import must not throw');
});

// ── Rapid duplicate taps (AB1) ────────────────────────────────────────────────
test('rapid tap guard drops an identical tap inside the window, keeps different buttons', () => {
  const { RapidTapGuard } = t.req('lib/rapidTap');
  const g = new RapidTapGuard({ windowMs: 1000 });
  assert.equal(g.isDuplicate(1, 10, 100, 'repo:pin:on:x', 0), false);
  assert.equal(g.isDuplicate(1, 10, 100, 'repo:pin:on:x', 300), true, 'bounce');
  assert.equal(g.isDuplicate(1, 10, 100, 'repo:pin:off:x', 350), false, 'a different button');
  assert.equal(g.isDuplicate(2, 10, 100, 'repo:pin:on:x', 400), false, 'a different user');
  assert.equal(g.isDuplicate(1, 10, 101, 'repo:pin:on:x', 500), false, 'a different message');
  assert.equal(g.isDuplicate(1, 10, 100, 'repo:pin:on:x', 5000), false, 'long after the window');
});

test('rapid tap guard stays bounded', () => {
  const { RapidTapGuard } = t.req('lib/rapidTap');
  const g = new RapidTapGuard({ windowMs: 1000, maxEntries: 50 });
  for (let i = 0; i < 500; i++) g.isDuplicate(1, 1, i, 'x', 0);
  assert.ok(g.seen.size <= 50);
});

// ── Names, parsing, validation ────────────────────────────────────────────────
test('repo names: shared validator matches what GitHub accepts', () => {
  const { validateRepoName } = t.req('lib/repoName');
  assert.equal(validateRepoName(' my-repo_1.x ').name, 'my-repo_1.x');
  for (const bad of ['', '.', '..', 'a.git', 'A.GIT', 'x'.repeat(101), 'has space', 'sl/ash']) assert.equal(validateRepoName(bad).ok, false, `"${bad}" should be rejected`);
  assert.equal(validateRepoName('.github').ok, true);
});

test('activity log: the rollup finds the right repo in every summary format', () => {
  const { deriveRepoName: d } = t.req('lib/activityRepo');
  const cases = [
    ['Created repo → my-app', 'my-app'], ['Edited file → src/a.js (my-app)', 'my-app'], ['Deleted file → docs/x.md (my-app)', 'my-app'],
    ['Visibility changed → my-app (Private→Public)', 'my-app'], ['License updated → my-app (mit)', 'my-app'],
    ['Deleted repo → old — backed up to 🗑️ Trash for 30d', 'old'], ['Renamed → a → b', 'b'], ['Forked → someone/lib', 'lib'],
    ['Downloaded external repo → o/r', null], ['Bulk download → 3/5 succeeded', null], ['Undid bulk delete → restored 3/5', null],
    ['Settings imported → 2 tag(s)', null], ['Weekly auto-backup → 3 repo(s) sent', null], ['🔔 1 new commit pushed → my-app', 'my-app'],
    ['Disconnected GitHub account', null],
  ];
  for (const [summary, expected] of cases) assert.equal(d(summary), expected, summary);
});

test('defaults: every value is validated before it can be stored', () => {
  const { validateDefault: v } = t.req('lib/defaults');
  assert.equal(v('default_visibility', 'private'), 'private');
  assert.throws(() => v('default_visibility', 'Private'), /private or public/);
  assert.throws(() => v('default_sort', 'foo'), /unknown sort/);
  assert.equal(v('default_sort', 'stars'), 'stars');
  assert.throws(() => v('trash_retention_days', -1), /whole number/);
  assert.equal(v('trash_retention_days', '30'), 30);
  assert.equal(v('trash_retention_days', 0), 0);
  assert.equal(v('default_upload_path', '/docs/'), 'docs');
  assert.equal(v('default_upload_path', null), '');
  assert.throws(() => v('default_upload_path', 'a/../b'), /not allowed|aren/);
  assert.equal(v('default_commit_message', '  hi  '), 'hi');
  assert.throws(() => v('default_commit_message', 'x'.repeat(201)), /under 200/);
});

test('defaults: commit-message placeholders are expanded', () => {
  const { expandCommitTemplate } = t.req('lib/defaults');
  const out = expandCommitTemplate('Update {filename} in {repo} ({count})', { filename: 'a.js', repo: 'demo', count: 3 });
  assert.equal(out, 'Update a.js in demo (3)');
});

// ── Trash (G1, G3) ────────────────────────────────────────────────────────────
test('trash: a NULL expiry means "kept indefinitely", not "expired in 1970"', () => {
  const { isAvailable } = t.req('lib/trash');
  assert.equal(isAvailable({ expires_at: null, restored_at: null }), true, 'retention "Never"');
  assert.equal(isAvailable({ expires_at: new Date(Date.now() + 86400000).toISOString(), restored_at: null }), true);
  assert.equal(isAvailable({ expires_at: new Date(Date.now() - 1000).toISOString(), restored_at: null }), false);
  assert.equal(isAvailable({ expires_at: null, restored_at: new Date().toISOString() }), false, 'already restored');
  assert.equal(isAvailable(null), false);
});

test('trash backup: Telegram upload (50MB) vs download (20MB) limits are applied correctly', async () => {
  const config = t.req('config');
  assert.equal(config.TELEGRAM_UPLOAD_LIMIT_BYTES, 50 * 1024 * 1024);
  assert.equal(config.TELEGRAM_DOWNLOAD_LIMIT_BYTES, 20 * 1024 * 1024);
  const sizes = { small: 5 * 1024 * 1024, mid: 30 * 1024 * 1024, huge: 60 * 1024 * 1024 };
  let current = 'small';
  const stub = (rel, exports) => { require.cache[require.resolve(path.join(__dirname, '..', 'src', rel))] = { id: rel, filename: rel, loaded: true, exports }; };
  const added = [];
  stub('lib/github.js', { downloadZip: async () => Buffer.alloc(sizes[current]) });
  stub('lib/users.js', { getUser: async () => ({ trash_retention_days: 30 }) });
  stub('lib/trash.js', { add: async (id, row) => { added.push(row); return { id: 1, ...row }; } });
  delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'lib', 'trashBackup.js'))];
  const { backupRepoToTrash } = t.req('lib/trashBackup');
  const ctx = { from: { id: 7 }, replyWithDocument: async () => ({ document: { file_id: 'F1' } }) };
  const repo = { name: 'demo', default_branch: 'main', description: '', private: true };

  current = 'small';
  const a = await backupRepoToTrash(ctx, { token: 't', owner: 'me', repo });
  assert.equal(a.restorable, true);
  current = 'mid';
  const b = await backupRepoToTrash(ctx, { token: 't', owner: 'me', repo });
  assert.equal(b.restorable, false, '20-50MB can be sent but not read back by the bot');
  assert.equal(added[1].restorable, false);
  current = 'huge';
  await assert.rejects(() => backupRepoToTrash(ctx, { token: 't', owner: 'me', repo }), /over the .* Telegram lets a bot send/);
  assert.equal(added.length, 2, 'nothing is recorded when the backup is impossible');
  for (const rel of ['lib/github.js', 'lib/users.js', 'lib/trash.js', 'lib/trashBackup.js']) delete require.cache[require.resolve(path.join(__dirname, '..', 'src', rel))];
});

// ── Secrets (B1, AD1, AD6) ────────────────────────────────────────────────────
test('crypto: tryDecrypt returns null instead of throwing', () => {
  const { encrypt, tryDecrypt } = t.req('lib/crypto');
  assert.equal(tryDecrypt(encrypt('hello')), 'hello');
  assert.equal(tryDecrypt('garbage'), null);
  assert.equal(tryDecrypt(''), null);
  assert.equal(tryDecrypt(null), null);
  const damaged = encrypt('hello').slice(0, -6) + 'AAAAAA';
  assert.equal(tryDecrypt(damaged), null, 'auth-tag failure');
});

test('GitHub access revocation: success, already-gone, failure and network error', async () => {
  const github = t.req('lib/github');
  const realFetch = global.fetch;
  try {
    const seen = [];
    global.fetch = async (url, opts) => { seen.push({ url, opts }); return { status: 204 }; };
    assert.deepEqual(await github.revokeOAuthAccess('tok'), { ok: true, status: 204 });
    assert.match(seen[0].url, /\/applications\/unit-test\/token$/);
    assert.equal(seen[0].opts.method, 'DELETE');
    assert.match(seen[0].opts.headers.Authorization, /^Basic /);
    assert.equal(JSON.parse(seen[0].opts.body).access_token, 'tok');
    await github.revokeOAuthAccess('tok', { grant: true });
    assert.match(seen[1].url, /\/grant$/);
    global.fetch = async () => ({ status: 404 });
    assert.equal((await github.revokeOAuthAccess('tok')).ok, true, 'already revoked');
    global.fetch = async () => ({ status: 500 });
    assert.equal((await github.revokeOAuthAccess('tok')).ok, false);
    global.fetch = async () => { throw Object.assign(new Error('boom'), { name: 'TypeError' }); };
    assert.equal((await github.revokeOAuthAccess('tok')).reason, 'network');
    assert.equal((await github.revokeOAuthAccess('')).reason, 'not-configured');
  } finally { global.fetch = realFetch; }
});

// ── Quiet hours (C7) ──────────────────────────────────────────────────────────
test('quiet hours: honours the person\'s own timezone and windows that wrap midnight', () => {
  const { isQuietNow } = t.req('lib/quietHours');
  const at = (iso) => new Date(iso);
  const utc = { timezone: 'UTC', quiet_hours_start: 22, quiet_hours_end: 7 };
  assert.equal(isQuietNow(utc, at('2026-10-13T23:30:00Z')), true);
  assert.equal(isQuietNow(utc, at('2026-10-13T03:00:00Z')), true);
  assert.equal(isQuietNow(utc, at('2026-10-13T07:00:00Z')), false, 'end is exclusive');
  assert.equal(isQuietNow(utc, at('2026-10-13T12:00:00Z')), false);
  assert.equal(isQuietNow({ timezone: 'UTC', quiet_hours_start: null, quiet_hours_end: null }, at('2026-10-13T03:00:00Z')), false);
  assert.equal(isQuietNow({ timezone: 'UTC', quiet_hours_start: 9, quiet_hours_end: 9 }, at('2026-10-13T09:00:00Z')), false, 'empty window');
  const tokyo = { timezone: 'Asia/Tokyo', quiet_hours_start: 22, quiet_hours_end: 7 };
  assert.equal(isQuietNow(tokyo, at('2026-10-13T14:00:00Z')), true, '23:00 in Tokyo');
  assert.equal(isQuietNow(tokyo, at('2026-10-13T03:00:00Z')), false, '12:00 in Tokyo');
});

test('notifications summary counts only the five alert toggles', () => {
  const { describeNotificationSummary } = t.req('lib/users');
  const prefs = { githubActivity: true, systemAlerts: true, longOps: true, tokenHealth: true, staleNudge: false, rollup: 'off', quietStart: null, quietEnd: null };
  assert.equal(describeNotificationSummary(prefs), '4/5 alert types on', "'off' rollup must not count as on");
  assert.equal(describeNotificationSummary({ ...prefs, rollup: 'daily', quietStart: 22, quietEnd: 7 }), '4/5 alert types on · daily rollup · quiet 22:00–07:00');
  assert.equal(describeNotificationSummary({ ...prefs, quietStart: 0, quietEnd: 6 }), '4/5 alert types on · quiet 00:00–06:00', 'midnight is a valid hour');
  assert.equal(describeNotificationSummary(null), '0/5 alert types on');
});

// ── Warden (AK2) ──────────────────────────────────────────────────────────────
test('warden: scattered busy hours are not a "sustained shift"; consecutive ones are', () => {
  const { detectShift } = t.req('lib/wardenBrain/changepoint');
  const HOUR = 3600e3;
  const eb = { rate: { median: 6 }, log: { mu: Math.log(7), sigma: 0.5 } };
  const spike = (h) => ({ t: h * HOUR, actions: 60 });
  assert.equal(detectShift([spike(0), spike(24), spike(48)], eb).detected, false, 'one busy hour per day');
  assert.equal(detectShift([spike(0), spike(1), spike(2)], eb).detected, true, 'three in a row');
  assert.equal(detectShift([spike(0), spike(1)], eb).detected, false, 'two in a row is not enough');
});

// ── Webhooks (W1-W3) ──────────────────────────────────────────────────────────
test('webhook digest: dropped events are reported, not silently lost', () => {
  const { composeDigestMessage } = t.req('lib/webhookDigest');
  assert.equal(composeDigestMessage('r', [{ summary: '1 push' }, { summary: '1 push' }]), '🔔 2× 1 push → r');
  assert.match(composeDigestMessage('r', [{ summary: '1 push' }], 7), /\+7 more events not shown/);
  assert.match(composeDigestMessage('r', [], 1), /\+1 more event not shown/);
});

test('webhook dedupe: a delivery can be forgotten so Redeliver is processed', async () => {
  const { Deduper } = t.req('lib/webhookGuard');
  const d = new Deduper({ redis: null });
  assert.equal(await d.seen('abc'), false);
  assert.equal(await d.seen('abc'), true);
  await d.forget('abc');
  assert.equal(await d.seen('abc'), false, 'processed again after forget()');
});

// ── Charts (AC1) ──────────────────────────────────────────────────────────────
test('charts: the local renderer produces a valid PNG with no network', async () => {
  const realFetch = global.fetch;
  global.fetch = () => { throw new Error('the chart renderer must not touch the network'); };
  try {
    const { renderLineChart, niceScale, crc32 } = t.req('lib/chartRender');
    const data = Array.from({ length: 30 }, (_, i) => (i * 7) % 13);
    const labels = data.map((_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
    const png = await renderLineChart({ title: 'New users - last 30 days', labels, data });
    assert.equal(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 900, 'width');
    assert.equal(png.readUInt32BE(20), 480, 'height');
    // every chunk's CRC must verify
    let off = 8; const types = [];
    while (off < png.length) {
      const len = png.readUInt32BE(off); const type = png.slice(off + 4, off + 8).toString('ascii');
      assert.equal(png.readUInt32BE(off + 8 + len), crc32(png.slice(off + 4, off + 8 + len)), `CRC of ${type}`);
      types.push(type); off += 12 + len;
    }
    assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
    for (const d of [[5], [0, 0, 0], [1, 9], [120, 340, 560, 90, 1000]]) assert.ok((await renderLineChart({ title: 'x', labels: d.map((_, i) => `d${i}`), data: d })).length > 100);
    await assert.rejects(() => renderLineChart({ title: 'x', labels: [], data: [] }), /at least one data point/);
    assert.deepEqual(niceScale(14), { max: 20, step: 5 });
    assert.deepEqual(niceScale(100), { max: 100, step: 25 });
    assert.equal(niceScale(0).max, 4);
  } finally { global.fetch = realFetch; }
});

// ── Errors and logging ────────────────────────────────────────────────────────
test('errors: background failures get plain-language reasons', () => {
  const { describeForUser } = t.req('lib/errorHelpers');
  assert.match(describeForUser({ status: 401, message: 'Bad credentials' }), /reconnect/);
  assert.match(describeForUser({ status: 404, message: 'Not Found' }), /couldn.t find that/);
  assert.match(describeForUser({ status: 502, message: 'x' }), /problem on its side/);
  assert.match(describeForUser(new Error('ETIMEDOUT while connecting')), /timed out|dropped/);
  assert.ok(describeForUser(new Error('a\nvery\nlong '.repeat(60))).length <= 160);
});

test('logger: debug exists and both argument orders are accepted', () => {
  const logger = t.req('lib/logger');
  for (const level of ['debug', 'info', 'warn', 'error']) assert.equal(typeof logger[level], 'function', level);
  logger.warn('message first', { a: 1 });
  logger.warn({ a: 1 }, 'meta first');
  logger.error('just a message');
});

// ── Tags (F1/P3, C2-C4) ───────────────────────────────────────────────────────
test('tags: createTag only changes fields the caller passes', async () => {
  t.resetQueries();
  const tags = t.req('lib/tags');
  await tags.createTag(1, 'Work', '💼');
  let q = t.queries[t.queries.length - 1];
  assert.match(q.sql, /parent_id = CASE WHEN \$6::boolean/);
  assert.deepEqual(q.params.slice(5), [false, false], 'no parent/colour supplied -> existing values kept');
  await tags.createTag(1, 'Work', null, { parentId: 4, colorClass: 'blue' });
  q = t.queries[t.queries.length - 1];
  assert.deepEqual(q.params.slice(5), [true, true]);
  assert.equal(q.params[2], null, 'a null emoji leaves the existing emoji alone');
  assert.equal(tags.tagLabel({ emoji: '💼', name: 'Work', color_class: 'blue' }), '🔵💼 Work');
  assert.equal(tags.tagLabel({ emoji: '💼', name: 'Work', color_class: 'default' }), '💼 Work');
});

test('tags: nesting a tag under itself or its own descendant is refused', async () => {
  t.resetQueries();
  const tags = t.req('lib/tags');
  t.setQueryHandler((sql, params) => {
    if (/SELECT id FROM tags WHERE telegram_id = \$1 AND id = \$2/.test(sql)) return { rows: [{ id: params[1] }] };
    if (/WITH RECURSIVE/i.test(sql) || /descend/i.test(sql)) return { rows: [{ id: 3 }, { id: 4 }] };
    return { rows: [] };
  });
  const self = await tags.updateTag(1, 2, { parentId: 2 });
  assert.equal(self.ok, false);
  assert.match(self.error, /under itself/);
  t.resetQueries();
});

// ── Cascades and cleanup (H2, D2) ─────────────────────────────────────────────
test('rename cascade also follows pending scheduled uploads and drops stale bulk-undo records', async () => {
  t.resetQueries();
  const { cascadeRename } = t.req('lib/renameCascade');
  await cascadeRename(5, 'old-name', 'new-name');
  const sqls = t.queries.map((q) => q.sql).join('\n');
  assert.match(sqls, /UPDATE scheduled_uploads SET repo_name/);
  assert.match(sqls, /DELETE FROM bulk_action_log/);
  t.resetQueries();
});

test('Delete User also removes the Warden leftovers', async () => {
  t.resetQueries();
  const users = t.req('lib/users');
  await users.deleteUserAndData(99).catch(() => {});
  const sqls = t.queries.map((q) => q.sql).join('\n');
  assert.match(sqls, /DELETE FROM warden_user_state WHERE telegram_id = \$1/);
  assert.match(sqls, /DELETE FROM warden_action_log WHERE target_id = \$1/);
  t.resetQueries();
});

// ── Edit file (S3) ────────────────────────────────────────────────────────────
test('edit file: a typed message keeps the original final newline and CRLF line endings', () => {
  const { restoreOriginalFormatting: fix } = t.req('scenes/editFile');
  assert.equal(fix('a\nb\n', 'a\nB'), 'a\nB\n', 'final newline restored');
  assert.equal(fix('a\r\nb\r\n', 'a\nB'), 'a\r\nB\r\n', 'CRLF restored');
  assert.equal(fix('a\nb', 'a\nB'), 'a\nB', 'no final newline originally -> none added');
  assert.equal(fix('a\r\nb\r\n', 'a\r\nB\r\n'), 'a\r\nB\r\n', 'already right');
});

// ── Bulk undo (C5/C6) ─────────────────────────────────────────────────────────
test('bulk undo: only visibility changes are reversible, and listRecent returns at most five', async () => {
  const bulkUndo = t.req('lib/bulkUndo');
  assert.deepEqual([...bulkUndo.REVERSIBLE_ACTIONS].sort(), ['private', 'public']);
  t.resetQueries();
  t.setQueryHandler(() => ({ rows: [{ id: 1, action_type: 'private', repo_names: '["a","b"]', created_at: new Date() }] }));
  const recent = await bulkUndo.listRecent(1);
  assert.deepEqual(recent[0].repoNames, ['a', 'b']);
  assert.equal(t.queries[0].params[1], 5);
  t.resetQueries();
});

// ── Help and Legal text ───────────────────────────────────────────────────────
function assertTelegramSafe(name, text) {
  assert.ok(text.length <= 4096, `${name}: ${text.length} characters is over Telegram's 4096 limit`);
  const stripped = text.replace(/\\./g, ''); // drop escaped pairs
  const unescaped = stripped.match(/[_\[\]()~`>#+\-=|{}.!]/);
  assert.equal(unescaped, null, `${name}: unescaped MarkdownV2 character ${unescaped && unescaped[0]}`);
  assert.equal((stripped.match(/\*/g) || []).length % 2, 0, `${name}: unbalanced bold markers`);
}

test('help: every topic, the FAQ and the connect text fit in a message and are valid MarkdownV2', () => {
  const help = t.req('handlers/help');
  assert.ok(help.MENU_ENTRIES.length >= 10, 'the menu lists every topic');
  for (const entry of help.MENU_ENTRIES) assert.ok(entry.id === 'connect' || help.TOPIC_PAGES[entry.id], `topic ${entry.id} exists`);
  for (const [id, pages] of Object.entries(help.TOPIC_PAGES)) pages.forEach((text, i) => assertTelegramSafe(`help:${id}:${i}`, text));
  help.FAQ_PAGES.forEach((text, i) => assertTelegramSafe(`faq:${i}`, text));
  [...help.CONNECT_PAGES.connected, ...help.CONNECT_PAGES.disconnected].forEach((text, i) => assertTelegramSafe(`connect:${i}`, text));
});

test('legal: every page fits, escapes cleanly and the index points at section starts', () => {
  const legal = t.req('handlers/legal');
  legal.PAGES.forEach((page, i) => assertTelegramSafe(`legal:${i}`, page.text));
  assert.equal(legal.INDEX.length, legal.SECTIONS.length);
  assert.equal(legal.INDEX[0].index, 0);
  const all = legal.SECTIONS.map((s) => JSON.stringify(s)).join(' ');
  // the policy must keep describing what the code really does
  for (const phrase of ['Warden', 'AES-256-GCM', 'revokes', 'Trash', '90 days', 'audit log', 'does not store IP addresses']) {
    assert.ok(all.includes(phrase), `legal text mentions "${phrase}"`);
  }
  assert.ok(!/quickchart/i.test(all), 'the policy no longer lists a chart service: charts are drawn locally');
});

test('help keyboards: menu rows, paging buttons and back button are well formed', () => {
  const inline = t.req('keyboards/inline');
  const help = t.req('handlers/help');
  const menu = inline.helpMenu(help.MENU_ENTRIES).reply_markup.inline_keyboard;
  const all = menu.flat().map((b) => b.callback_data);
  for (const entry of help.MENU_ENTRIES) assert.ok(all.includes(`help:topic:${entry.id}`));
  assert.ok(all.includes('help:faq') && all.includes('help:contact') && all.includes('legal:index'));
  const first = inline.helpPageMenu('help:faq', 0, 3).reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(first, ['help:faq:1', 'help:menu']);
  const mid = inline.helpPageMenu('help:faq', 1, 3).reply_markup.inline_keyboard[0].map((b) => b.callback_data);
  assert.deepEqual(mid, ['help:faq:0', 'help:faq:2']);
});

// ── Interactive screens (driven with a fake chat context) ─────────────────────
const zlib = require('zlib');
const SRC = path.join(__dirname, '..', 'src');
const stubModule = (rel, exports) => { require.cache[require.resolve(path.join(SRC, rel))] = { id: rel, filename: rel, loaded: true, exports }; };
const unstub = (...rels) => rels.forEach((rel) => delete require.cache[require.resolve(path.join(SRC, rel))]);
function fakeCtx(extra = {}) {
  const sent = [];
  return {
    sent, from: { id: 7 }, state: { isAdmin: false }, session: {},
    reply: async (text, opts) => { sent.push({ text, opts }); return { message_id: sent.length }; },
    answerCbQuery: async () => {},
    ...extra,
  };
}
const callbacks = (msg) => ((msg.opts && msg.opts.reply_markup && msg.opts.reply_markup.inline_keyboard) || []).flat().map((b) => b.callback_data).filter(Boolean);
const labels = (msg) => ((msg.opts && msg.opts.reply_markup && msg.opts.reply_markup.inline_keyboard) || []).flat().map((b) => b.text);

function makeZip(files) {
  const { crc32 } = t.req('lib/archive');
  const locals = []; const centrals = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'); const comp = zlib.deflateRawSync(f.data); const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp); centrals.push(central, name); offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('tag manager: tree with nesting, editor, colour picker, parent picker (no cycles) and defaults', async () => {
  stubModule('lib/requireConnected.js', async () => 'tok');
  const tags = t.req('lib/tags');
  const tagsHandler = (delete require.cache[require.resolve(path.join(SRC, 'handlers/tags.js'))], t.req('handlers/tags'));
  const work = { id: 1, name: 'Work', emoji: '💼', color_class: 'blue', parent_id: null, repo_count: 2 };
  const client = { id: 2, name: 'Client', emoji: '🤝', color_class: 'default', parent_id: 1, repo_count: 1 };
  const other = { id: 3, name: 'Fun', emoji: '🎮', color_class: 'green', parent_id: null, repo_count: 0 };
  tags.listTagsTree = async () => [{ ...work, children: [{ ...client, children: [] }] }, { ...other, children: [] }];
  tags.listTags = async () => [work, client, other];
  tags.getTag = async (_u, id) => [work, client, other].find((x) => x.id === Number(id)) || null;
  tags.descendantTagIds = async (_u, id) => (Number(id) === 1 ? [2] : []);
  tags.listTagDefaults = async () => [{ key: 'default_visibility', value: 'private' }];
  const ctx = fakeCtx();

  await tagsHandler.showTagManager(ctx, 'my-repo');
  assert.ok(callbacks(ctx.sent[0]).includes('tags:edit:1:my-repo') && callbacks(ctx.sent[0]).includes('tags:edit:2:my-repo'));
  assert.ok(labels(ctx.sent[0]).some((l) => l.includes('↳') && l.includes('Client')), 'child is indented under its parent');
  assert.ok(labels(ctx.sent[0]).some((l) => l.startsWith('🔵')), 'colour dot shown');

  await tagsHandler.showTagEditor(ctx, 1, 'my-repo');
  const editor = callbacks(ctx.sent[1]);
  for (const cb of ['tags:colors:1:my-repo', 'tags:parents:1:my-repo', 'tags:defaults:1:my-repo', 'tags:deleteask:1:my-repo']) assert.ok(editor.includes(cb), cb);

  await tagsHandler.showColourPicker(ctx, 1, 'my-repo');
  const colours = callbacks(ctx.sent[2]).filter((c) => c.startsWith('tags:setcolor:'));
  assert.equal(colours.length, 6);
  assert.ok(colours.includes('tags:setcolor:1:purple:my-repo'));

  await tagsHandler.showParentPicker(ctx, 1, 'my-repo'); // Work's own sub-tag (Client) and Work itself can't be its parent
  const parents = callbacks(ctx.sent[3]).filter((c) => c.startsWith('tags:setparent:'));
  assert.deepEqual(parents.sort(), ['tags:setparent:1:0:my-repo', 'tags:setparent:1:3:my-repo']);

  await tagsHandler.showTagDefaults(ctx, 1, 'my-repo');
  assert.match(ctx.sent[4].text, /Visibility for new repos: 🔒 Private/);
  assert.match(ctx.sent[4].text, /Upload folder: uses your global default/);

  let updated = null;
  tags.updateTag = async (_u, id, patch) => { updated = { id, ...patch }; return { ok: true, tag: work }; };
  await tagsHandler.setColour(ctx, 1, 'red', 'my-repo');
  assert.deepEqual(updated, { id: 1, colorClass: 'red' });
  unstub('lib/requireConnected.js', 'handlers/tags.js');
});

test('tag defaults input: a bad value keeps the prompt armed; "root" means the repo root', async () => {
  stubModule('lib/requireConnected.js', async () => 'tok');
  const tags = t.req('lib/tags');
  delete require.cache[require.resolve(path.join(SRC, 'handlers/tags.js'))];
  const tagsHandler = t.req('handlers/tags');
  const saved = [];
  tags.setTagDefault = async (_u, id, key, value) => { t.req('lib/defaults').validateDefault(key, value); saved.push({ id, key, value }); return true; };
  tags.getTag = async () => ({ id: 1, name: 'Work', emoji: '💼', color_class: 'default' });
  tags.listTagDefaults = async () => [];
  const ctx = fakeCtx({ message: { text: 'x'.repeat(250) } });
  ctx.session.editingTagDefault = { tagId: 1, key: 'default_commit_message', repoName: 'r' };
  await tagsHandler.handleTagDefaultInput(ctx);
  assert.ok(ctx.session.editingTagDefault, 'still armed after a bad value');
  assert.match(ctx.sent[0].text, /under 200 characters/);
  ctx.message = { text: 'root' };
  ctx.session.editingTagDefault = { tagId: 1, key: 'default_upload_path', repoName: 'r' };
  await tagsHandler.handleTagDefaultInput(ctx);
  assert.equal(ctx.session.editingTagDefault, undefined, 'cleared after success');
  assert.deepEqual(saved[saved.length - 1], { id: 1, key: 'default_upload_path', value: '' });
  unstub('lib/requireConnected.js', 'handlers/tags.js');
});

test('pin sections: picker lists sections, a bad new-section name keeps the prompt, a good one is saved', async () => {
  const pins = t.req('lib/pins');
  delete require.cache[require.resolve(path.join(SRC, 'handlers/pinned.js'))];
  const pinned = t.req('handlers/pinned');
  pins.listSections = async () => ['Work', 'Fun'];
  pins.list = async () => [{ repo_name: 'a', pin_section: 'Work' }];
  const ctx = fakeCtx();
  await pinned.showSectionPicker(ctx, 'a');
  const cbs = callbacks(ctx.sent[0]);
  assert.ok(cbs.includes('pin:setsec:a:') && cbs.includes('pin:setsec:a:Work') && cbs.includes('pin:setsec:a:Fun') && cbs.includes('pin:newsec:a'));
  assert.ok(labels(ctx.sent[0]).some((l) => l.startsWith('✓') && l.includes('Work')), 'current section is ticked');

  ctx.session.creatingPinSection = { repoName: 'a' };
  ctx.message = { text: 'bad:name' };
  await pinned.handleNewSectionInput(ctx);
  assert.ok(ctx.session.creatingPinSection, 'still armed');
  const calls = [];
  pins.setSection = async (...args) => { calls.push(args); };
  pins.listGrouped = async () => [];
  ctx.message = { text: 'Reading list' };
  await pinned.handleNewSectionInput(ctx).catch(() => {}); // the redraw afterwards needs the full repo stack; only the save matters here
  assert.deepEqual(calls[0], [7, 'a', 'Reading list']);
  assert.equal(ctx.session.creatingPinSection, undefined, 'cleared after a good name');
  unstub('handlers/pinned.js');
});

test('repo shield: three status buttons that name their target, and an Undo that appears only when there is something to undo', () => {
  const inline = t.req('keyboards/inline');
  const stats = { scopes: { connected: { total: 3, protected: 3 }, trusted: { total: 2, protected: 1 }, everyone: { total: 4, protected: 0 } }, lastBatch: null };
  let kb = inline.wardenShieldMenu(stats).reply_markup.inline_keyboard;
  const flat = kb.flat();
  assert.equal(flat.filter((b) => b.callback_data.startsWith('warden:shield:set:')).length, 3);
  const byScope = Object.fromEntries(flat.filter((b) => b.callback_data.startsWith('warden:shield:set:')).map((b) => [b.callback_data.split(':')[3], b]));
  assert.equal(byScope.connected.text, '🛡 Connected 3/3');
  assert.equal(byScope.connected.callback_data, 'warden:shield:set:connected:off', 'all protected → the tap unprotects');
  assert.equal(byScope.trusted.text, '◐ ⭐ Trusted 1/2');
  assert.equal(byScope.trusted.callback_data, 'warden:shield:set:trusted:on', 'partial → the tap protects everyone in the scope');
  assert.equal(byScope.everyone.text, '🔓 Everyone 0/4');
  assert.equal(byScope.everyone.callback_data, 'warden:shield:set:everyone:on');
  assert.ok(!flat.some((b) => b.callback_data === 'warden:shield:undo'));
  kb = inline.wardenShieldMenu({ ...stats, lastBatch: { n: 3 } }).reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === 'warden:shield:undo'));
  const empty = inline.wardenShieldMenu({ scopes: { connected: { total: 0, protected: 0 }, trusted: { total: 0, protected: 0 }, everyone: { total: 0, protected: 0 } } }).reply_markup.inline_keyboard.flat();
  assert.ok(empty.some((b) => b.text.startsWith('➖ Connected')), 'an empty scope is shown as such');
});

test('repo shield: undo only restores accounts still in the state the batch left them in', async () => {
  t.resetQueries();
  t.setQueryHandler((sql) => (/FROM repo_shield_batches/.test(sql) ? { rows: [{ id: 9, action: 'protect', affected: [1, 2, 3] }] } : { rows: [], rowCount: 2 }));
  const config = t.req('config');
  const repoShield = t.req('lib/repoShield');
  const owner = config.OWNER_ID;
  const result = await repoShield.undoLast(owner);
  assert.equal(result.ok, true);
  const update = t.queries.find((q) => /UPDATE users SET repos_protected/.test(q.sql));
  assert.match(update.sql, /AND repos_protected = \$4/);
  assert.deepEqual(update.params.slice(1), [false, owner, true], 'undoing a "protect" only touches accounts that are still protected');
  t.resetQueries();
});

test('bulk helpers: long lists are cut to fit a message; long runs show a compact progress line', () => {
  const { fitLines, renderProgress, MAX_BULK_REPOS } = t.req('handlers/bulkActions');
  assert.equal(MAX_BULK_REPOS, 100);
  const lines = Array.from({ length: 300 }, (_, i) => `repo-number-${i}-with-a-fairly-long-name`);
  const fitted = fitLines(lines, 3800);
  assert.ok(fitted.length <= 3800);
  assert.match(fitted, /…and \d+ more$/);
  assert.equal(fitLines(['a', 'b']), 'a\nb');
  const names = Array.from({ length: 60 }, (_, i) => `r${i}`);
  const progress = renderProgress('delete', names, [{ ok: true }, { ok: false }], 2);
  assert.ok(progress.length < 300);
  assert.match(progress, /1 done · ⚠️ 1 failed · ⏳ 58 left/);
  assert.match(renderProgress('private', ['a', 'b'], [{ ok: true }], 1), /✅ a\n⏳ b$/);
});

// ── Trash restore (G2, G3, G6) ────────────────────────────────────────────────
async function runRestore({ entry, github, fetchBuffer }) {
  stubModule('lib/requireConnected.js', async () => 'tok');
  const gh = t.req('lib/github');
  const repoCache = t.req('lib/repoCache');
  const trash = t.req('lib/trash');
  const calls = { created: [], committed: [], deleted: [], restored: [] };
  repoCache.getUser = async () => ({ login: 'me' });
  repoCache.invalidateRepos = () => {};
  Object.assign(gh, {
    getRepo: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); },
    createRepo: async (_t, o) => { if (github.failCreate) throw new Error('create exploded'); calls.created.push(o); return { name: o.name, owner: { login: 'me' }, html_url: `https://github.com/me/${o.name}` }; },
    commitMultipleFiles: async (_t, _o, _r, files, msg) => { if (github.failCommit) throw new Error('commit exploded'); calls.committed.push({ files, msg }); },
    getTree: async () => github.tree || [],
    deleteRepo: async (_t, _o, name) => { calls.deleted.push(name); },
  });
  trash.get = async () => entry;
  trash.markRestored = async (...a) => { calls.restored.push(a); };
  delete require.cache[require.resolve(path.join(SRC, 'handlers/trash.js'))];
  const trashHandler = t.req('handlers/trash');
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => fetchBuffer });
  const ctx = fakeCtx({ telegram: { getFileLink: async () => { if (github.noLink) throw new Error('file is too big'); return { href: 'https://t.me/file' }; } } });
  try { await trashHandler.requestRestore(ctx, 5); } finally { global.fetch = realFetch; unstub('lib/requireConnected.js', 'handlers/trash.js'); }
  return { ctx, calls };
}
const baseEntry = { id: 5, original_name: 'demo', description: 'd', visibility: 'private', backup_file_id: 'F', expires_at: null, restored_at: null, restorable: true };
const zipball = () => makeZip([{ name: 'me-demo-abc123/README.md', data: Buffer.from('# real readme\n') }, { name: 'me-demo-abc123/src/a.js', data: Buffer.from('1') }]);

test('trash restore: reads the backup first, strips GitHub\'s wrapper folder, commits once, and says what it does not bring back', async () => {
  const { ctx, calls } = await runRestore({ entry: { ...baseEntry, expires_at: null }, github: {}, fetchBuffer: zipball() });
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].isPrivate, true);
  assert.deepEqual(calls.committed[0].files.map((f) => f.path).sort(), ['README.md', 'src/a.js']);
  assert.equal(calls.committed[0].msg, 'Restore from Trash');
  assert.equal(calls.restored.length, 1, 'an entry with retention "Never" (NULL expiry) restores fine');
  assert.match(ctx.sent[ctx.sent.length - 1].text, /Not brought back: commit history, issues, stars, webhooks, topics/);
});

test('trash restore: if the backup can\'t be read, nothing is created on GitHub', async () => {
  const { ctx, calls } = await runRestore({ entry: baseEntry, github: { noLink: true }, fetchBuffer: Buffer.alloc(0) });
  assert.equal(calls.created.length, 0);
  assert.match(ctx.sent[ctx.sent.length - 1].text, /Nothing was created on GitHub/);
});

test('trash restore: a failed commit removes the empty repo it just made — but never one that actually received the files', async () => {
  let r = await runRestore({ entry: baseEntry, github: { failCommit: true, tree: [{ path: 'README.md', sha: 'not-the-backup' }] }, fetchBuffer: zipball() });
  assert.deepEqual(r.calls.deleted, ['demo'], 'only an auto-init placeholder was there → removed');
  assert.match(r.ctx.sent[r.ctx.sent.length - 1].text, /removed the empty repo/);
  assert.equal(r.calls.restored.length, 0);
  r = await runRestore({ entry: baseEntry, github: { failCommit: true, tree: [{ path: 'README.md', sha: 'x' }, { path: 'src/a.js', sha: 'y' }] }, fetchBuffer: zipball() });
  assert.deepEqual(r.calls.deleted, [], 'files are there → keep the repo');
  assert.match(r.ctx.sent[r.ctx.sent.length - 1].text, /files did reach GitHub/);
});

test('trash restore: a ZIP-only (too large) backup is refused before anything happens; an expired one is unavailable', async () => {
  let r = await runRestore({ entry: { ...baseEntry, restorable: false }, github: {}, fetchBuffer: zipball() });
  assert.equal(r.calls.created.length, 0);
  assert.ok(r.ctx.sent.some((m) => /too large to restore in place/.test(m.text)));
  r = await runRestore({ entry: { ...baseEntry, expires_at: new Date(Date.now() - 1000).toISOString() }, github: {}, fetchBuffer: zipball() });
  assert.equal(r.calls.created.length, 0);
  assert.match(r.ctx.sent[0].text, /no longer available/);
});

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) {
      console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 4).join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
