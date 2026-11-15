#!/usr/bin/env node
/**
 * v2.3.3-multi — zip uploads no longer burst GitHub with per-file preview requests; "slow down" is one friendly line (offline).
 * Run:  node scripts/v232-tests.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the upload summary caps its per-file preview requests and skips them once GitHub says slow down', () => {
  const src = read('src/scenes/uploadFile.js');
  const cap = /const MAX_DIFF_FETCHES = (\d+);/.exec(src);
  assert.ok(cap && Number(cap[1]) > 0 && Number(cap[1]) <= 10, 'a small, fixed cap');
  assert.ok(/let diffBudget = MAX_DIFF_FETCHES;/.test(src));
  assert.ok(/diffBudget <= 0 \|\| diffsPaused/.test(src), 'files past the cap make no request');
  assert.ok(/diffsPaused = true/.test(src), 'a rate limit stops further previews');
  assert.ok(/existingSizeByPath/.test(src), 'old size for the rest comes from the file list, not a request');
});

test('a rate limit in Files is one friendly line, not a red error', async () => {
  const browse = t.req('handlers/browseFiles');
  const github = t.req('lib/github');
  const repoCache = t.req('lib/repoCache');
  const users = t.req('lib/users');
  const crypto = t.req('lib/crypto');
  const err = Object.assign(new Error('GitHub secondary rate limit — requests are paused for about 61s (held locally)'), { code: 'GITHUB_RATE_LIMITED', status: 403, retryAfterMs: 61000 });
  const saved = [github.getTree, repoCache.getUser, users.getUser, crypto.tryDecrypt];
  github.getTree = async () => { throw err; };
  repoCache.getUser = async () => ({ login: 'me' });
  users.getUser = async () => ({ github_token_enc: 'enc', disconnected_at: null });
  crypto.tryDecrypt = () => 'tok';
  try {
    const sent = [];
    const ctx = { from: { id: 1 }, chat: { id: 1 }, session: {}, state: {}, reply: async (text) => { sent.push(text); return { message_id: 1, chat: { id: 1 } }; } };
    await browse.showDirectory(ctx, 'SavahBot', '');
    assert.strictEqual(sent.length, 1);
    assert.ok(/short break/.test(sent[0]) && !/Couldn/.test(sent[0]), sent[0]);
  } finally { [github.getTree, repoCache.getUser, users.getUser, crypto.tryDecrypt] = saved; }
});

test('the global error handler turns a rate limit into the friendly line', () => {
  const src = read('src/bot.js');
  assert.ok(/const slow = require\('\.\/lib\/rateLimitFriendly'\)\.describe\(err\);\s*\n\s*if \(slow\)/.test(src));
});

test('the version is 2.3.3-multi in package.json, config and the changelog', () => {
  assert.strictEqual(require('../package.json').version, '2.3.3-multi');
  assert.strictEqual(t.req('config').BOT_VERSION, '2.3.3-multi');
  assert.ok(read('CHANGELOG.md').includes('v2.3.3-multi'));
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
