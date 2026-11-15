#!/usr/bin/env node
/**
 * v2.1.3-multi — taps answered once (toasts no longer swallowed), PR dates with year, admin bar + /admin (offline).
 * Run:  node scripts/v213-tests.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function makeCbCtx() {
  const answers = [];
  class FakeCtx {
    async reply() { return { message_id: 1, chat: { id: 42 } }; }
    async answerCbQuery(text, extra) { answers.push({ text, extra }); return true; }
  }
  const ctx = new FakeCtx();
  Object.assign(ctx, { from: { id: 42 }, chat: { id: 42 }, session: {}, state: {}, callbackQuery: { id: 'q1', data: 'x', message: { message_id: 3, chat: { id: 42 } } } });
  return { ctx, answers };
}

test('a toast after an early bare answer is delivered (it used to be swallowed by Telegram)', async () => {
  const chrome = t.req('lib/chrome');
  const { ctx, answers } = makeCbCtx();
  chrome.wrapContext(ctx);
  await ctx.answerCbQuery();                                                   // the handler's early "stop the spinner"
  await ctx.answerCbQuery('🔒 Admin access needed for this.', { show_alert: true }); // …and its real message later
  await chrome.flushAnswer(ctx);
  assert.strictEqual(answers.length, 1, 'exactly one real answer is sent');
  assert.strictEqual(answers[0].text, '🔒 Admin access needed for this.');
  assert.strictEqual(answers[0].extra.show_alert, true);
});

test('a bare answer alone is still sent — once — when the handler finishes', async () => {
  const chrome = t.req('lib/chrome');
  const { ctx, answers } = makeCbCtx();
  chrome.wrapContext(ctx);
  await ctx.answerCbQuery();
  assert.strictEqual(answers.length, 0, 'held back while the handler works');
  await chrome.flushAnswer(ctx);
  await chrome.flushAnswer(ctx);
  await ctx.answerCbQuery('late');
  assert.strictEqual(answers.length, 1);
  assert.strictEqual(answers[0].text, undefined);
});

test('a slow handler still stops the spinner after about a second and a half', async () => {
  const chrome = t.req('lib/chrome');
  const { ctx, answers } = makeCbCtx();
  chrome.wrapContext(ctx);
  await ctx.answerCbQuery();
  await new Promise((r) => setTimeout(r, 1700));
  assert.strictEqual(answers.length, 1);
});

test('not connected + admin: row 2 of the bar is the Admin Dashboard; everyone else keeps Help / Legal', () => {
  const chrome = t.req('lib/chrome');
  assert.deepStrictEqual(chrome.BARS.disconnectedAdmin.rows, [['🔗 Connect GitHub', '💼 Workspace'], ['🛡️ Admin Dashboard']]);
  assert.deepStrictEqual(chrome.BARS.disconnected.rows[1], ['❓ Help', '📜 Legal']);
  assert.strictEqual(chrome.disconnectedBarId({ state: { isAdmin: true } }), 'disconnectedAdmin');
  assert.strictEqual(chrome.disconnectedBarId({ state: { isAdmin: false } }), 'disconnected');
  assert.strictEqual(chrome.disconnectedBarId({ state: {} }), 'disconnected');
  assert.strictEqual(chrome.barIdOfKeyboard(chrome.BARS.disconnectedAdmin.rows), 'disconnectedAdmin');
  const start = read('src/handlers/start.js');
  assert.ok(!/setBar\(ctx, 'disconnected'\)/.test(start), 'start.js picks the bar through disconnectedBarId');
});

test('🛡️ Admin Dashboard is a known label; a non-admin typing it by hand gets nothing', async () => {
  const chrome = t.req('lib/chrome');
  t.req('lib/barActions').register();
  assert.ok(chrome.knownLabels().has('🛡️ Admin Dashboard'));
  const sent = [];
  const ctx = { from: { id: 7 }, chat: { id: 7 }, session: { barId: 'disconnectedAdmin' }, state: { isAdmin: false }, reply: async (x) => { sent.push(x); return { message_id: 1 }; } };
  await chrome.runLabel(ctx, '🛡️ Admin Dashboard');
  assert.strictEqual(sent.length, 0);
});

test('/admin is registered for admins only and does nothing for anyone else', () => {
  const src = read('src/bot.js');
  const m = /bot\.command\('admin', async \(ctx\) => \{([\s\S]*?)\n  \}\);/.exec(src);
  assert.ok(m, '/admin command found');
  assert.ok(/ctx\.state\.isAdmin\)\) return;/.test(m[1]) && /showDashboard/.test(m[1]));
});

test('admins get /admin in their own "/" menu; the default menu never lists it', async () => {
  const ac = t.req('lib/adminCommands');
  const calls = [];
  const tg = { setMyCommands: async (list, o) => calls.push(['set', list, o]), deleteMyCommands: async (o) => calls.push(['del', o]) };
  await ac.syncFor(tg, 99, true);
  await ac.syncFor(tg, 99, false);
  assert.ok(calls[0][1].some((c) => c.command === 'admin'), 'admins get /admin');
  assert.deepStrictEqual(calls[0][2], { scope: { type: 'chat', chat_id: 99 } });
  assert.strictEqual(calls[1][0], 'del');
  assert.ok(!ac.BASE.some((c) => c.command === 'admin'));
  assert.ok(!/command: 'admin'/.test(read('src/index.js')), 'the global list has no /admin');
  assert.ok(/adminCommands'\)\.syncAll/.test(read('src/index.js')) && /syncFor\(ctx\.telegram, targetId, true\)/.test(read('src/handlers/admin.js')) && /syncFor\(ctx\.telegram, targetId, false\)/.test(read('src/handlers/admin.js')));
  const failing = { setMyCommands: async () => { throw new Error('x'); }, deleteMyCommands: async () => { throw new Error('x'); } };
  assert.strictEqual(await ac.syncFor(failing, 1, true), false, 'a Telegram failure never throws');
});

test('PR times carry date, time AND year in the person\'s timezone', async () => {
  const users = t.req('lib/users');
  const saved = users.getUser;
  users.getUser = async () => ({ timezone: 'Africa/Nairobi', time_format: '24h' });
  try {
    const ui = t.req('handlers/manage/ui');
    const when = await ui.clock({ from: { id: 1 } });
    const text = when('2026-10-23T06:24:00Z');
    assert.ok(/2026/.test(text) && /09:24/.test(text) && /Oct/.test(text), text);
    assert.strictEqual(when.tz, 'Africa/Nairobi');
    assert.strictEqual(when(null), '');
    users.getUser = async () => ({ timezone: 'Not/AZone' });
    assert.strictEqual((await ui.clock({ from: { id: 1 } })).tz, 'UTC', 'bad zone falls back to UTC');
  } finally { users.getUser = saved; }
});

test('PR list, PR page, PR comments and the "my PRs" lists all show dates', async () => {
  const users = t.req('lib/users'); const repoCache = t.req('lib/repoCache'); const crypto = t.req('lib/crypto');
  const pulls = t.req('lib/github/pulls'); const search = t.req('lib/github/search');
  const saved = [users.getUser, repoCache.getUser, pulls.listPulls, pulls.getPull, pulls.listReviews, pulls.listPullComments, search.myWork];
  users.getUser = async () => ({ github_token_enc: crypto.encrypt('tok'), disconnected_at: null, timezone: 'UTC', time_format: '24h' });
  repoCache.getUser = async () => ({ login: 'octo' });
  const pr = { number: 7, title: 'Add thing', state: 'open', draft: false, merged: false, author: 'octo', head: 'a', base: 'main', body: '', labels: [], createdAt: '2026-10-23T06:20:00Z', updatedAt: '2026-10-23T07:00:00Z', closedAt: null, mergedAt: null };
  pulls.listPulls = async () => ({ items: [pr], hasNext: false });
  pulls.getPull = async () => pr;
  pulls.listReviews = async () => [];
  pulls.listPullComments = async () => ({ items: [{ author: 'bob', body: 'hi', createdAt: '2026-10-23T06:30:00Z' }], hasNext: false });
  search.myWork = async () => ({ items: [{ number: 7, title: 'Add thing', repo: 'octo/x', owner: 'octo', repoName: 'x', url: 'u', isPull: true, createdAt: '2026-10-23T06:20:00Z', updatedAt: '2026-10-23T07:00:00Z' }], hasNext: false });
  try {
    const run = async (mod, action, args) => {
      const sent = [];
      const ctx = { from: { id: 1 }, chat: { id: 1 }, session: {}, state: {}, reply: async (x) => { sent.push(x); return { message_id: 1 }; } };
      await t.req(mod).handle(ctx, { action, args, repoName: 'x' });
      return sent.join('\n');
    };
    for (const [mod, action, args, label] of [
      ['handlers/manage/areas/pulls', 'list', ['open', '1'], 'list'],
      ['handlers/manage/areas/pulls', 'view', ['7'], 'view'],
      ['handlers/manage/areas/pulls', 'comments', ['7', '1'], 'comments'],
      ['handlers/manage/areas/mywork', 'v', ['authored', '1'], 'my PRs'],
    ]) {
      const text = (await run(mod, action, args)).replace(/\\/g, '');
      assert.ok(/23 Oct 2026, \d\d:\d\d/.test(text), `${label} shows date, time and year: ${text.slice(0, 200)}`);
    }
  } finally { [users.getUser, repoCache.getUser, pulls.listPulls, pulls.getPull, pulls.listReviews, pulls.listPullComments, search.myWork] = saved; }
});

test('the pause screen explains the owner can\'t be paused instead of failing silently', () => {
  const src = read('src/handlers/monitoring.js');
  assert.ok(/The owner can’t be paused/.test(src));
  assert.ok(/const canPause = !roles\.isOwner\(targetId\)/.test(src));
});

test('the version is declared in package.json and the changelog', () => {
  assert.ok(/^2\.\d+\.\d+-multi$/.test(require('../package.json').version));
  assert.ok(read('CHANGELOG.md').includes('v2.1.3-multi'));
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
