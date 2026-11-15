#!/usr/bin/env node
/**
 * v2.1.4-multi — /start above /admin, Dependabot cursor paging, huge repos (Linux), friendly rate-limit messages (offline).
 * Run:  node scripts/v214-tests.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('admins\' "/" menu lists /start first, /admin right under it', () => {
  const { ADMIN, BASE } = t.req('lib/adminCommands');
  assert.deepStrictEqual(ADMIN.slice(0, 2).map((c) => c.command), ['start', 'admin']);
  assert.deepStrictEqual(ADMIN.filter((c) => c.command !== 'admin').map((c) => c.command), BASE.map((c) => c.command));
  assert.ok(!BASE.some((c) => c.command === 'admin'));
});

test('core.page: cursor mode never sends `page`; reads the `after` cursor from the Link header', async () => {
  const core = t.req('lib/github/core');
  assert.strictEqual(core.nextCursor({ link: '<https://api.github.com/repos/o/r/dependabot/alerts?per_page=8&after=abc123>; rel="next", <https://api.github.com/x>; rel="first"' }), 'abc123');
  assert.strictEqual(core.nextCursor({ link: '<https://api.github.com/x?page=1>; rel="prev"' }), null);
  assert.strictEqual(core.nextCursor({}), null);
  const src = read('src/lib/github/security.js');
  assert.ok(/listDependabotAlerts[\s\S]{0,700}cursor: true/.test(src), 'Dependabot list uses cursor mode');
  assert.ok(!/dependabot\/alerts', \{[^}]*page: pg/.test(src), 'no page number is sent to the Dependabot endpoint');
  assert.ok(/cursor: true \}\);\s*\n?[\s\S]{0,200}/.test(src) && !/per_page: 100, page: 1/.test(src), 'the overview counts send no page either');
});

test('safety net: a "page parameter is not supported" answer is retried once without `page`', () => {
  const src = read('src/lib/github/core.js');
  assert.ok(/PAGE_PARAM_UNSUPPORTED = \/pagination using the/.test(src), 'GitHub\'s wording is matched');
  assert.ok(/delete query\.page;\s*res = await withRetry/.test(src), 'and the request is repeated without page');
});

test('Dependabot pages are walked with remembered cursors (page 3 asks for the cursor of page 2, never a page number)', async () => {
  const sec = t.req('lib/github/security');
  const area = t.req('handlers/manage/areas/security');
  const asked = [];
  const saved = sec.listDependabotAlerts;
  sec.listDependabotAlerts = async (tok, o, r, { state, after }) => {
    asked.push(after);
    const n = after ? Number(after.replace('c', '')) : 1; // cursor "c2" = the page after page 1
    return { items: [{ number: n, state: 'open', severity: 'high', summary: `alert ${n}`, package: 'p', createdAt: '2026-10-23T00:00:00Z' }], hasNext: n < 3, nextCursor: n < 3 ? `c${n + 1}` : null };
  };
  try {
    const ctx = { session: {}, state: {}, from: { id: 1 }, chat: { id: 1 }, reply: async () => ({ message_id: 1 }) };
    const c = { token: 't', owner: 'o', repo: 'r' };
    await area.__test.deps(ctx, c, 'open', 3);
    assert.ok(asked.every((a) => a === null || /^c\d$/.test(a)), `only cursors were used: ${JSON.stringify(asked)}`);
    assert.deepStrictEqual(ctx.session.depCursors['r:open'], [null, 'c2', 'c3']);
    asked.length = 0;
    await area.__test.deps(ctx, c, 'open', 2);   // known cursor: one request
    assert.deepStrictEqual(asked, ['c2']);
  } finally { sec.listDependabotAlerts = saved; }
});

test('huge repos (the Linux kernel) are never tree-scanned — card, lists and Details fall back to GitHub\'s own size', async () => {
  const repoCache = t.req('lib/repoCache');
  const github = t.req('lib/github');
  let scanned = 0;
  const saved = github.getTreeStats;
  github.getTreeStats = async () => { scanned++; return { sizeBytes: 1, fileCount: 1, folderCount: 1 }; };
  try {
    assert.strictEqual(await repoCache.getTreeStats(1, 'o', 'linux', 'tok', 'master', { sizeKb: 6400000 }), null);
    assert.strictEqual(scanned, 0, 'no GitHub tree request at all');
    assert.ok((await repoCache.getTreeStats(1, 'o', 'small', 'tok', 'main', { sizeKb: 1200 })).fileCount === 1, 'normal repos still get exact counts');
    const batch = await repoCache.getTreeStatsBatch(1, 'tok', [{ owner: { login: 'o' }, name: 'linux', size: 6400000, default_branch: 'master' }]);
    assert.deepStrictEqual(batch, [null]);
  } finally { github.getTreeStats = saved; }
  const src = read('src/handlers/repoView.js');
  assert.ok(/getTreeStats\([^)]*sizeKb: repo\.size/.test(src));
});

test('📊 Details reuses what the card just loaded: no new GitHub calls inside the minute', async () => {
  const src = read('src/handlers/repoView.js');
  assert.ok(/const warm = detail \? warmView\(viewKey\) : null;/.test(src));
  assert.ok(/warm \? warm\.readmeResult/.test(src) && /warm \? warm\.commits/.test(src) && /if \(warm\) repo = warm\.repo;/.test(src));
  assert.ok(/if \(!warm\) viewCache\.set\(viewKey/.test(src));
});

test('rate limits are one short friendly line — GitHub\'s and the local hold-back alike', () => {
  const { describe } = t.req('lib/rateLimitFriendly');
  const local = Object.assign(new Error('GitHub secondary rate limit — requests are paused for about 41s (held locally)'), { code: 'GITHUB_RATE_LIMITED', retryAfterMs: 41000, status: 403 });
  const d = describe(local);
  assert.ok(d && d.local && /^⏳ GitHub needs a short break — try again in about \d+s\. Nothing was changed\.$/.test(d.text), d && d.text);
  assert.ok(!/held locally|secondary|longer than I can hold/i.test(d.text));
  const queue = Object.assign(new Error('GitHub is temporarily rate-limiting requests and the wait is longer than I can hold this open. Nothing was changed — try again shortly.'), { code: 'GITHUB_QUEUE_TIMEOUT', retryAfterMs: 5000 });
  assert.ok(/^⏳ GitHub needs a short break/.test(describe(queue).text));
  const remote = Object.assign(new Error('You have exceeded a secondary rate limit.'), { status: 403, response: { headers: { 'retry-after': '90' } } });
  const r = describe(remote);
  assert.ok(r && !r.local && /2 min/.test(r.text) && !/Nothing was changed/.test(r.text), 'GitHub-side limits never claim nothing changed');
  assert.strictEqual(describe(Object.assign(new Error('Not Found'), { status: 404 })), null);
  assert.strictEqual(describe(null), null);
});

test('errors that already end in a full stop no longer show ".."', () => {
  const format = t.req('lib/format');
  assert.strictEqual(format.errorMessage('Couldn\u2019t open', 'try again shortly.', 'Go back.'), '⚠️ Couldn\u2019t open: try again shortly.\nGo back.');
  assert.strictEqual(format.errorMessage('X', 'plain reason'), '⚠️ X: plain reason.');
});

test('replyGithubError answers with the friendly line for every rate-limit kind', async () => {
  const eh = t.req('lib/errorHelpers');
  const sent = [];
  const ctx = { from: { id: 1 }, chat: { id: 1 }, session: {}, state: {}, reply: async (x) => { sent.push(x); return { message_id: 1 }; } };
  await eh.replyGithubError(ctx, Object.assign(new Error('GitHub secondary rate limit — requests are paused for about 40s (held locally)'), { code: 'GITHUB_RATE_LIMITED', retryAfterMs: 40000 }), 'Open the repo');
  assert.strictEqual(sent.length, 1);
  assert.ok(/^⏳ GitHub needs a short break/.test(sent[0]) && sent[0].length < 100, sent[0]);
});

test('the repo card says it plainly (and offers Try again) when GitHub is rate-limiting', () => {
  const src = read('src/handlers/repoView.js');
  assert.ok(/rateLimitFriendly'\)\.describe\(err\)/.test(src) && /🔄 Try again/.test(src));
});

test('the version is declared in package.json and the changelog', () => {
  assert.ok(/^2\.\d+\.\d+-multi$/.test(require('../package.json').version));
  assert.ok(read('CHANGELOG.md').includes('v2.1.4-multi'));
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) {
      console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
