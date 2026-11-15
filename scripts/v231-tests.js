#!/usr/bin/env node
/**
 * v2.3.1-multi — no stuck bottom keyboards after typed commands; Warden's eye icon replaced (offline).
 * Run:  node scripts/v231-tests.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const PAGE = { reply_markup: { inline_keyboard: [[{ text: 'Open', callback_data: 'x:y' }]] } };

function makeCtx({ text, data, barId }) {
  const sent = [];
  let id = 100;
  class FakeCtx {
    async reply(body, extra) {
      const message = { message_id: ++id, chat: { id: 42 } };
      // A bar marker is the small message whose text is a bar's title (the offline Markup stub has no reply keyboards).
      sent.push({ body, bar: Object.values(t.req('lib/chrome').BARS).some((b) => b.title === body) });
      return message;
    }
    async editMessageText() { return true; }
    async editMessageReplyMarkup() { return true; }
    async answerCbQuery() { return true; }
  }
  const ctx = new FakeCtx();
  Object.assign(ctx, {
    from: { id: 42 }, chat: { id: 42, type: 'private' }, session: { barId }, state: {},
    telegram: { deleteMessage: async () => true },
  });
  if (text) ctx.message = { message_id: 5, text };
  if (data) ctx.callbackQuery = { id: 'q1', data, message: { message_id: 7, chat: { id: 42 } } };
  return { ctx, sent };
}

const open = (ctx, body) => ctx.reply(body, PAGE);

for (const bar of ['repos', 'repo', 'files', 'notifications', 'searchgh']) {
  for (const command of ['/admin', '/help', '/legal']) {
    test(`${command} while the ${bar} bar is up swaps it for ⬅️ Back, above the page`, async () => {
      const chrome = t.req('lib/chrome');
      const { ctx, sent } = makeCtx({ text: command, barId: bar });
      await chrome.middleware(ctx, async () => { await open(ctx, 'PAGE'); });
      assert.strictEqual(ctx.session.barId, 'back');
      assert.ok(sent[0].bar && sent[1].body === 'PAGE', 'the marker is sent first, so it sits above the page');
    });
  }
}

test('an Admin / Warden tap on a stale page swaps the bar too', async () => {
  const chrome = t.req('lib/chrome');
  for (const data of ['admin:people', 'warden:main', 'migrate:hub']) {
    const { ctx } = makeCtx({ data, barId: 'files' });
    await chrome.middleware(ctx, async () => { await open(ctx, 'PAGE'); });
    assert.strictEqual(ctx.session.barId, 'back', data);
  }
});

test('a page that picks its own bar keeps it, with a single marker (/repos from Files)', async () => {
  const chrome = t.req('lib/chrome');
  const { ctx, sent } = makeCtx({ text: '/repos', barId: 'files' });
  await chrome.middleware(ctx, async () => { await chrome.setBar(ctx, 'repos'); await open(ctx, 'REPOS'); });
  assert.strictEqual(ctx.session.barId, 'repos');
  assert.strictEqual(sent.filter((s) => s.bar).length, 1);
});

test('buttons that belong to the page never reset its bar (✅ Mark all read, an inline tap inside a repo)', async () => {
  const chrome = t.req('lib/chrome');
  let made = makeCtx({ text: '✅ Mark all read', barId: 'notifications' });
  await chrome.middleware(made.ctx, async () => { await open(made.ctx, 'CONFIRM'); });
  assert.strictEqual(made.ctx.session.barId, 'notifications');
  made = makeCtx({ data: 'repo:open:demo', barId: 'repo' });
  await chrome.middleware(made.ctx, async () => { await open(made.ctx, 'CARD'); });
  assert.strictEqual(made.ctx.session.barId, 'repo');
});

test('a Home keyboard sent from outside the chat (GitHub-connect page) updates the saved session, so the next page swaps it', async () => {
  const chrome = t.req('lib/chrome');
  const saved = { barId: 'repos', barMsgId: 9, barTitle: 'x', backTo: 'repo:open:a', currentRepo: 'keep-me' };
  const store = { data: { '42:42': saved }, async get(k) { return this.data[k]; }, async set(k, v) { this.data[k] = v; } };
  assert.strictEqual(await chrome.syncBarFromOutside(42, 'home', store), true);
  assert.strictEqual(store.data['42:42'].barId, 'home');
  assert.strictEqual(store.data['42:42'].barMsgId, null);
  assert.strictEqual(store.data['42:42'].currentRepo, 'keep-me', 'the rest of the session is untouched');
  assert.strictEqual(await chrome.syncBarFromOutside(7, 'home', store), false, 'no saved session: nothing to do');
  assert.strictEqual(await chrome.syncBarFromOutside(42, 'nope', store), false, 'unknown bar ids are ignored');
  assert.strictEqual(await chrome.syncBarFromOutside(42, 'home', { get() { throw new Error('redis down'); } }), false, 'never throws');
  assert.ok(/syncBarFromOutside/.test(read('src/server/app.js')), 'the connect page calls it');
});

test('Warden no longer uses an eye: the web icon is a shield-and-pulse and every Warden page points at it', () => {
  const icons = read('src/server/icons.js');
  assert.ok(/\n\s+warden: '/.test(icons), 'a warden icon is registered');
  for (const f of ['src/server/ownerPage.js', 'src/server/ownerClient/22-more.js', 'src/server/ownerClient/12-warden.js', 'src/server/ownerClient/10-overview.js', 'src/server/ownerClient/11-users.js', 'src/server/ownerClient/90-boot.js']) {
    assert.ok(!/'eye'/.test(read(f)), `${f} no longer uses the eye icon`);
  }
  for (const f of ['src/keyboards/inline.js', 'src/handlers/wardenBoard.js', 'src/handlers/wardenAdmin.js', 'src/lib/wardenBrain/engine.js', 'src/lib/wardenBrain/warnings.js']) {
    assert.ok(!/👁/.test(read(f).replace(/👁 View Content|guest: '👁️'|'👁️ Guest'/g, '')), `${f} has no Warden eye emoji`);
  }
});

test('the 2.3.1 release is in the changelog and the version is still on the 2.3 line', () => {
  assert.ok(/^2\.3\.\d+-multi$/.test(require('../package.json').version));
  assert.ok(read('CHANGELOG.md').includes('v2.3.1-multi'));
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
