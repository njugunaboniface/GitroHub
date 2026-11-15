#!/usr/bin/env node
/**
 * v2.1.3-multi — bar marker above its page, open PRs counted, Upload bar buttons, empty-repo Files (offline).
 * Run:  node scripts/v212-tests.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/** A context whose prototype has reply/edit (like Telegraf's), recording every send in order. */
function makeWrappedCtx({ tappedId = 10 } = {}) {
  const log = [];
  let next = 100;
  class FakeCtx {
    async reply(text, extra) { const id = next++; log.push({ kind: 'send', id, text, extra }); return { message_id: id, chat: { id: 42 } }; }
    async editMessageText(text, extra) { log.push({ kind: 'edit', text, extra }); return true; }
    async editMessageReplyMarkup() { return true; }
  }
  const ctx = new FakeCtx();
  Object.assign(ctx, {
    from: { id: 42 }, chat: { id: 42, type: 'private' }, session: {}, state: {},
    telegram: { deleteMessage: async (chat, id) => { log.push({ kind: 'delete', id }); } },
    callbackQuery: { data: 'repo:open:x', message: { message_id: tappedId, chat: { id: 42 } } },
  });
  return { ctx, log };
}
const inlineExtra = { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: [[{ text: 'Manage', callback_data: 'm' }]] } };

test('opening a repo from a list: the bar marker is sent first and the card is a NEW message below it', async () => {
  const chrome = t.req('lib/chrome');
  const { ctx, log } = makeWrappedCtx();
  chrome.wrapContext(ctx);
  ctx.session.barId = 'repos';
  ctx.session.live = { id: 10, chat: 42 };
  await chrome.setBar(ctx, 'repo');                 // what showRepoView does first
  await ctx.editMessageText('📦 card', inlineExtra); // …then it edits the tapped message
  const sends = log.filter((l) => l.kind === 'send');
  assert.strictEqual(log.filter((l) => l.kind === 'edit').length, 0, 'the old message must not be edited in place');
  assert.strictEqual(sends.length, 2, 'marker + card');
  assert.ok(sends[0].text.includes('Repository'), 'marker first');
  assert.strictEqual(sends[1].text, '📦 card', 'card after the marker');
  await new Promise((r) => setImmediate(r));
  assert.ok(log.some((l) => l.kind === 'delete' && l.id === 10), 'the old page is removed');
});

test('no bar change: the page is still edited in place', async () => {
  const chrome = t.req('lib/chrome');
  const { ctx, log } = makeWrappedCtx();
  chrome.wrapContext(ctx);
  ctx.session.barId = 'repo';
  const changed = await chrome.setBar(ctx, 'repo');
  assert.strictEqual(changed, false);
  await ctx.editMessageText('📦 card', inlineExtra);
  assert.deepStrictEqual(log.map((l) => l.kind), ['edit']);
});

test('an inner page opened while the Home bar is up gets its marker ABOVE it', async () => {
  const chrome = t.req('lib/chrome');
  const { ctx, log } = makeWrappedCtx();
  chrome.wrapContext(ctx);
  ctx.session.barId = 'home';
  await ctx.reply('📖 Help', inlineExtra);
  const sends = log.filter((l) => l.kind === 'send');
  assert.strictEqual(sends.length, 2);
  assert.strictEqual(sends[0].text, '▫️', 'the small bar marker comes first');
  assert.strictEqual(sends[1].text, '📖 Help');
  assert.strictEqual(ctx.session.barId, 'back');
});

test('the Home card itself keeps the 2×2 (it is a kept message, not an inner page)', async () => {
  const chrome = t.req('lib/chrome');
  const { ctx, log } = makeWrappedCtx();
  chrome.wrapContext(ctx);
  ctx.session.barId = 'home';
  await ctx.reply('🌅 Good morning', { __keep: true, ...chrome.keyboardFor('home') });
  assert.strictEqual(log.filter((l) => l.kind === 'send').length, 1);
  assert.strictEqual(ctx.session.barId, 'home');
});

test('Upload labels on the bars cannot bounce inside the upload scene', () => {
  const src = read('src/bot.js');
  const m = /attachGlobalEscapes\(uploadFileScene, handlerMap, [^,]+, \[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'upload scene escapes found');
  const { BARS } = t.req('lib/chrome');
  const entry = Object.values(BARS).flatMap((b) => b.rows.flat()).filter((l) => /Upload|Replace Folder/.test(l));
  for (const label of entry) assert.ok(m[1].includes(`'${label}'`), `${label} must be a self-entry label of the upload scene`);
});

test('an empty repo is "no files", not an error', async () => {
  const github = t.req('lib/github');
  const empty = await github._emptyTreeIfRepoEmpty(Object.assign(new Error('Git Repository is empty.'), { status: 409 }), 'tok', 'o', 'r');
  assert.ok(Array.isArray(empty) && empty.length === 0 && empty.truncated === false);
  assert.strictEqual(await github._emptyTreeIfRepoEmpty(Object.assign(new Error('boom'), { status: 500 }), 'tok', 'o', 'r'), null);
});

test('Files on an empty repo says it in one short friendly line', async () => {
  const github = t.req('lib/github');
  const users = t.req('lib/users');
  const repoCache = t.req('lib/repoCache');
  const crypto = t.req('lib/crypto');
  const saved = [github.getTree, users.getUser, repoCache.getUser];
  github.getTree = async () => Object.assign([], { truncated: false });
  users.getUser = async () => ({ github_token_enc: crypto.encrypt('tok'), disconnected_at: null }); repoCache.getUser = async () => ({ login: 'octo' });
  try {
    const browse = t.req('handlers/browseFiles');
    const sent = [];
    const ctx = { from: { id: 42 }, chat: { id: 42 }, session: { currentRepo: 'testx' }, state: {}, reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: 1 }; } };
    await browse.showDirectory(ctx, 'testx', '');
    assert.strictEqual(sent.length, 1);
    assert.ok(/Nothing here yet/.test(sent[0].text) && !/Couldn|Not Found|docs\.github/i.test(sent[0].text));
    assert.ok(sent[0].text.length < 80, 'very small message');
  } finally { github.getTree = saved[0]; users.getUser = saved[1]; repoCache.getUser = saved[2]; }
});

test('open PRs you opened are counted (GitHub never notifies you about your own PR)', () => {
  const needs = t.req('lib/needsYou');
  assert.ok(/author:@me/.test(needs.QUERIES.open) && /is:pr/.test(needs.QUERIES.open));
  const prefs = { needs_line: true, needs_prs: true, needs_issues: true, needs_failing: true, needs_notifs: true };
  const v = needs.visible({ prs: 0, open: 1, issues: 0, failing: 0, notifs: 0 }, prefs);
  assert.strictEqual(v.open, 1);
  assert.strictEqual(v.total, 1, 'a lone open PR is enough to show on the Start card');
  assert.ok(/1 open PR of yours/.test(needs.line(v)));
  const rows = needs.jumpRows(v, t.req('keyboards/buttonStyle'));
  assert.ok(rows.flat().some((b) => /My open PRs \(1\)/.test(b.text)));
  assert.strictEqual(needs.visible({ prs: 0, open: 3, issues: 0, failing: 0, notifs: 0 }, { ...prefs, needs_prs: false }).open, 0, 'the toggle still switches it off');
  assert.ok(needs.TTL_MS <= 60 * 1000, 'a PR opened a moment ago must not wait minutes to show');
});

test('the Start card lists your open pull requests', async () => {
  const start = t.req('handlers/start');
  const users = t.req('lib/users'); const repoCache = t.req('lib/repoCache'); const needs = t.req('lib/needsYou');
  const saved = { isConnected: users.isConnected, getUser: users.getUser, tok: users.getDecryptedToken, getRepos: repoCache.getRepos, startCard: needs.startCard };
  users.isConnected = async () => true; users.getUser = async () => ({ github_username: 'octo', timezone: 'UTC' }); users.getDecryptedToken = async () => 'tok';
  repoCache.getRepos = async () => []; needs.startCard = async () => ({ v: { prs: 0, open: 2, issues: 0, failing: 0, notifs: 0, total: 2 } });
  const accounts = t.req('lib/accounts'); const savedAcc = accounts.activeLoginOf; accounts.activeLoginOf = async () => 'octo';
  try {
    const sent = [];
    const ctx = { from: { id: 42 }, chat: { id: 42 }, session: {}, state: {}, telegram: { deleteMessage: async () => {} }, reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: 5, chat: { id: 42 } }; } };
    await start.handleStart(ctx);
    assert.ok(/NEEDS YOU/.test(sent[0].text) && /2 open pull requests of yours/.test(sent[0].text.replace(/\\/g, '')), sent[0].text);
  } finally { Object.assign(users, { isConnected: saved.isConnected, getUser: saved.getUser, getDecryptedToken: saved.tok }); repoCache.getRepos = saved.getRepos; needs.startCard = saved.startCard; accounts.activeLoginOf = savedAcc; }
});

test('the version is declared in package.json and the changelog', () => {
  assert.ok(/^2\.\d+\.\d+-multi$/.test(require('../package.json').version));
  assert.ok(read('CHANGELOG.md').includes('v2.1.2-multi'));
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
