#!/usr/bin/env node
/**
 * v2.3.3-multi — live upload progress, pause/resume, cancel, restart recovery, fewer GitHub requests (offline).
 * (The commit pipeline itself — inline text, chunked trees, pacing, pause/resume, cancel — is proven against the fake
 * GitHub in scripts/github-e2e-tests.js.)
 * Run:  node scripts/v233-tests.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = () => t.req('lib/uploadProgress');

function fakeTelegram() {
  const calls = { edit: [], send: [], del: [] };
  return {
    calls,
    async editMessageText(chatId, messageId, _inline, text, extra) { calls.edit.push({ chatId, messageId, text, extra }); return true; },
    async sendMessage(chatId, text, extra) { calls.send.push({ chatId, text, extra }); return { message_id: 900 + calls.send.length }; },
    async deleteMessage(chatId, id) { calls.del.push({ chatId, id }); return true; },
  };
}
const fakeStore = () => ({ data: new Map(), set(k, v) { this.data.set(k, v); return Promise.resolve(); }, del(k) { this.data.delete(k); return Promise.resolve(); } });

// ── The card ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test('the card walks Extracting → Comparing → Committing with a bar and a count', () => {
  const { render } = up();
  assert.ok(/Extracting.*Comparing.*Committing/.test(render({ stage: 'extracting', repo: 'SavahBot' }).text));
  assert.ok(/✅ Extracting/.test(render({ stage: 'comparing', repo: 'x' }).text));
  const c = render({ stage: 'committing', done: 40, total: 300, repo: 'SavahBot' });
  assert.ok(/✅ Extracting.*✅ Comparing/.test(c.text));
  assert.ok(/▰▱▱▱▱▱▱▱▱▱ {2}40 \/ 300 files/.test(c.text), c.text);
  assert.strictEqual(c.cancellable, true);
});

test('paused: says GitHub paused it, shows the countdown, reassures, and still offers Cancel', () => {
  const r = up().render({ stage: 'paused', done: 40, total: 300, pauseSecs: 61 });
  assert.ok(/Paused by GitHub/.test(r.text) && /resuming in 61s/.test(r.text) && /Nothing is lost/.test(r.text));
  assert.strictEqual(r.cancellable, true);
  assert.ok(/resuming in 2 min/.test(up().render({ stage: 'paused', total: 5, pauseSecs: 100 }).text));
});

test('finalizing has no Cancel (the branch is about to move); queued and cancelling read correctly', () => {
  const { render } = up();
  assert.strictEqual(render({ stage: 'finalizing', done: 3, total: 3 }).cancellable, false);
  assert.ok(/Finishing the commit/.test(render({ stage: 'finalizing', done: 3, total: 3 }).text));
  assert.ok(/queued/.test(render({ stage: 'queued' }).text));
  const c = render({ stage: 'cancelling' });
  assert.ok(/Cancelling/.test(c.text) && c.cancellable === false);
});

test('every rendered card is valid MarkdownV2: no unescaped reserved characters outside the formatting we add', () => {
  const { render } = up();
  const text = render({ stage: 'paused', repo: 'my.repo-v2_(x)', done: 1, total: 9, pauseSecs: 3 }).text;
  const bare = text.replace(/\\./g, '').replace(/\*[^*]*\*/g, '').replace(/_[^_]*_/g, '');
  assert.ok(!/[.()\-!+=|{}>#~`\[\]]/.test(bare.replace(/—/g, '')), `unescaped reserved char in: ${text}`);
});

// ── Throttled edits ────────────────────────────────────────────────────────────────────────────────────────────────────
test('edits are throttled: a burst of 200 updates is a couple of edits, and the last state always lands', async () => {
  const tg = fakeTelegram();
  const card = new (up().ProgressCard)({ telegram: tg, chatId: 1, messageId: 5, userId: 1, repo: 'r', minEditMs: 120, store: fakeStore() });
  for (let i = 1; i <= 200; i++) await card.update({ stage: 'committing', done: i, total: 200 });
  await sleep(300);
  assert.ok(tg.calls.edit.length <= 3, `${tg.calls.edit.length} edits for 200 updates`);
  assert.ok(/200 \/ 200 files/.test(tg.calls.edit[tg.calls.edit.length - 1].text), 'the final count was shown');
  assert.ok(tg.calls.edit.every((e) => e.chatId === 1 && e.messageId === 5));
});

test('onCommitProgress maps the commit stages (preparing/resumed → committing; paused keeps its countdown)', async () => {
  const tg = fakeTelegram();
  const card = new (up().ProgressCard)({ telegram: tg, chatId: 1, messageId: 5, userId: 1, repo: 'r', minEditMs: 10, store: fakeStore() });
  await card.onCommitProgress({ stage: 'preparing', done: 0, total: 10 }); await sleep(30);
  assert.ok(/Committing/.test(tg.calls.edit[0].text));
  await card.onCommitProgress({ stage: 'paused', done: 4, total: 10, pauseSecs: 61 }); await sleep(30);
  assert.ok(/resuming in 61s/.test(tg.calls.edit[tg.calls.edit.length - 1].text));
  await card.onCommitProgress({ stage: 'resumed', done: 4, total: 10 }); await sleep(30);
  assert.ok(!/Paused/.test(tg.calls.edit[tg.calls.edit.length - 1].text));
});

test('a rate-limited edit backs off instead of hammering Telegram; "not modified" is ignored', async () => {
  const tg = fakeTelegram();
  let n = 0;
  tg.editMessageText = async () => { n++; throw Object.assign(new Error('Too Many Requests: retry after 5'), { description: 'Too Many Requests: retry after 5' }); };
  const card = new (up().ProgressCard)({ telegram: tg, chatId: 1, messageId: 5, userId: 1, repo: 'r', minEditMs: 40, store: fakeStore() });
  await card.update({ stage: 'committing', done: 1, total: 9 });
  assert.strictEqual(card.minEditMs, 80, 'doubled after a 429');
  tg.editMessageText = async () => { throw new Error('Bad Request: message is not modified'); };
  await card.update({ stage: 'committing', done: 2, total: 9 }); // must not throw
});

test('finish() turns the card into the result, drops the Cancel button, stops later edits and clears the heartbeat', async () => {
  const tg = fakeTelegram(); const store = fakeStore();
  const card = new (up().ProgressCard)({ telegram: tg, chatId: 1, messageId: 5, userId: 7, repo: 'r', minEditMs: 10, store });
  await card.begin();
  assert.ok(store.data.has('upload-job:7'), 'heartbeat written');
  await card.finish('✅ *Pushed to GitHub*');
  assert.ok(!store.data.has('upload-job:7'), 'heartbeat cleared');
  const n = tg.calls.edit.length;
  await card.update({ stage: 'committing', done: 1, total: 2 }); await sleep(40);
  assert.strictEqual(tg.calls.edit.length, n, 'no edits after finish');
  assert.strictEqual(tg.calls.edit[n - 1].text, '✅ *Pushed to GitHub*');
  assert.deepStrictEqual(tg.calls.edit[n - 1].extra.reply_markup.inline_keyboard, [], 'no buttons left');
});

// ── Jobs and cancel ────────────────────────────────────────────────────────────────────────────────────────────────────
test('requestCancel flags only the person’s own running upload', () => {
  const u = up();
  assert.strictEqual(u.requestCancel(55), false, 'nothing running');
  const job = u.startJob(55);
  assert.strictEqual(u.requestCancel(55), true);
  assert.strictEqual(job.cancelled, true);
  assert.strictEqual(u.requestCancel(56), false, 'someone else’s upload is untouched');
  u.endJob(55, job);
  assert.strictEqual(u.getJob(55), null);
});

test('Cancel is answered ahead of the scenes and the serializer-blocking handler is gone (the commit is a background job)', () => {
  const bot = read('src/bot.js');
  const early = bot.indexOf("data !== 'upload:job:cancel'");
  assert.ok(early > 0 && early < bot.indexOf('bot.use(stage.middleware())'), 'registered before the scene stage');
  const scene = read('src/scenes/uploadFile.js');
  assert.ok(/setImmediate\(\(\) => \{\s*\n\s*runUploadJob\(plan, job\)/.test(scene), 'the commit is started detached');
});

// ── The whole job, against stubs ───────────────────────────────────────────────────────────────────────────────────────
function stubWorld(commit) {
  const m = {
    github: t.req('lib/github'), repoCache: t.req('lib/repoCache'), cache: t.req('lib/fileBufferCache'), activity: t.req('lib/activity'),
    pathMemory: t.req('lib/pathMemory'), defaults: t.req('lib/defaults'), prog: up(), errorHelpers: t.req('lib/errorHelpers'),
    bulk: t.req('handlers/bulkActions'),
  };
  const saved = {
    commit: m.github.commitMultipleFiles, getUser: m.repoCache.getUser, get: m.cache.get, releaseAll: m.cache.releaseAll, log: m.activity.log,
    setLast: m.pathMemory.setLastPath, bump: m.defaults.bumpUploadPathFrequency, check: m.defaults.checkUploadPathPattern, store: m.prog.redisStore,
    notice: m.bulk.maybeAddLongOpNotice, inv: [m.repoCache.invalidateRepos, m.repoCache.invalidateLanguages, m.repoCache.invalidateTreeStats],
  };
  const released = [];
  m.github.commitMultipleFiles = commit;
  m.repoCache.getUser = async () => ({ login: 'me' });
  m.repoCache.invalidateRepos = m.repoCache.invalidateLanguages = m.repoCache.invalidateTreeStats = () => {};
  m.cache.get = async (ref) => Buffer.from(`bytes of ${ref}`);
  m.cache.releaseAll = async (refs) => { released.push(...refs); };
  m.activity.log = async () => {};
  m.pathMemory.setLastPath = async () => {};
  m.defaults.bumpUploadPathFrequency = async () => {};
  m.defaults.checkUploadPathPattern = async () => null;
  m.bulk.maybeAddLongOpNotice = async () => {};
  m.prog.redisStore = () => fakeStore();
  const restore = () => {
    m.github.commitMultipleFiles = saved.commit; m.repoCache.getUser = saved.getUser; m.cache.get = saved.get; m.cache.releaseAll = saved.releaseAll;
    m.activity.log = saved.log; m.pathMemory.setLastPath = saved.setLast; m.defaults.bumpUploadPathFrequency = saved.bump;
    m.defaults.checkUploadPathPattern = saved.check; m.prog.redisStore = saved.store; m.bulk.maybeAddLongOpNotice = saved.notice;
    [m.repoCache.invalidateRepos, m.repoCache.invalidateLanguages, m.repoCache.invalidateTreeStats] = saved.inv;
  };
  return { m, released, restore };
}
const planOf = (tg, over = {}) => ({
  userId: 9001, chatId: 77, telegram: tg, token: 'tok', repoName: 'SavahBot', branch: null, replaceFolder: false, message: 'Update via GitroHub', messageId: 321,
  changed: [{ path: 'src/a.js', status: 'modified', contentRef: 'r1' }, { path: 'b.png', status: 'new', contentRef: 'r2' }], toDelete: [], repoUrl: 'https://github.com/me/SavahBot', ...over,
});

test('job: progress edits flow through, then the SAME message becomes the result card with Open repo / Upload more', async () => {
  const tg = fakeTelegram();
  const w = stubWorld(async (_t, _o, _r, files, _m, _d, opts) => {
    assert.strictEqual(files.length, 2); assert.ok(Buffer.isBuffer(files[0].content));
    opts.onProgress({ stage: 'committing', done: 1, total: 2 }); opts.onProgress({ stage: 'finalizing', done: 2, total: 2 });
    return { sha: 'c1' };
  });
  try {
    const { runUploadJob } = t.req('scenes/uploadFile');
    const job = w.m.prog.startJob(9001);
    await runUploadJob(planOf(tg), job);
    const last = tg.calls.edit[tg.calls.edit.length - 1];
    assert.strictEqual(last.messageId, 321, 'edited in place');
    assert.ok(/Pushed to GitHub/.test(last.text) && /1 new/.test(last.text) && /1 modified/.test(last.text), last.text);
    const labels = last.extra.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.deepStrictEqual(labels, ['📂 Open repo', '📤 Upload more']);
    assert.deepStrictEqual(w.released.sort(), ['r1', 'r2'], 'cached file bytes released at the end');
    assert.strictEqual(w.m.prog.getJob(9001), null, 'job unregistered');
  } finally { w.restore(); }
});

test('job: Cancel before the branch moves → "Upload cancelled — nothing was changed", with Upload again', async () => {
  const tg = fakeTelegram();
  const w = stubWorld(async (_t, _o, _r, _f, _m, _d, opts) => {
    for (let i = 0; i < 50 && !opts.shouldCancel(); i++) await sleep(10);
    throw Object.assign(new Error('Upload cancelled — nothing was changed.'), { code: 'UPLOAD_CANCELLED', outcome: 'failed' });
  });
  try {
    const { runUploadJob } = t.req('scenes/uploadFile');
    const job = w.m.prog.startJob(9001);
    const running = runUploadJob(planOf(tg), job);
    await sleep(30);
    assert.strictEqual(w.m.prog.requestCancel(9001), true);
    await running;
    const last = tg.calls.edit[tg.calls.edit.length - 1];
    assert.ok(/Upload cancelled/.test(last.text) && /Nothing was changed/.test(last.text), last.text);
    assert.ok(last.extra.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'upload:start:SavahBot'));
    assert.strictEqual(tg.calls.send.length, 0, 'no extra error message for a cancel');
  } finally { w.restore(); }
});

test('job: a GitHub "slow down" that ends the commit is one friendly line plus a card saying nothing changed', async () => {
  const tg = fakeTelegram();
  const slow = Object.assign(new Error('GitHub secondary rate limit — requests are paused for about 61s (held locally)'), { code: 'GITHUB_RATE_LIMITED', status: 403, retryAfterMs: 61000, outcome: 'failed' });
  const w = stubWorld(async () => { throw slow; });
  try {
    const { runUploadJob } = t.req('scenes/uploadFile');
    await runUploadJob(planOf(tg), w.m.prog.startJob(9001));
    const last = tg.calls.edit[tg.calls.edit.length - 1];
    assert.ok(/didn’t finish/.test(last.text) && /Nothing was changed/.test(last.text), last.text);
    assert.strictEqual(tg.calls.send.length, 1);
    assert.ok(/short break/.test(tg.calls.send[0].text) && !/Something went wrong/.test(tg.calls.send[0].text));
  } finally { w.restore(); }
});

test('job: a rejected token points to Settings (a background job has no session for the reconnect flow)', async () => {
  const tg = fakeTelegram();
  const w = stubWorld(async () => { throw Object.assign(new Error('Bad credentials'), { status: 401, outcome: 'failed' }); });
  try {
    const { runUploadJob } = t.req('scenes/uploadFile');
    await runUploadJob(planOf(tg), w.m.prog.startJob(9001));
    assert.ok(/didn’t finish/.test(tg.calls.edit[tg.calls.edit.length - 1].text));
    assert.ok(tg.calls.send.length === 1 && /Settings to reconnect/.test(tg.calls.send[0].text), JSON.stringify(tg.calls.send));
  } finally { w.restore(); }
});

test('job: an unknown outcome is never reported as a success or as "nothing changed"', async () => {
  const tg = fakeTelegram();
  const w = stubWorld(async () => { throw Object.assign(new Error('x'), { code: 'GITHUB_OUTCOME_UNKNOWN', outcome: 'unknown' }); });
  try {
    const { runUploadJob } = t.req('scenes/uploadFile');
    await runUploadJob(planOf(tg), w.m.prog.startJob(9001));
    const last = tg.calls.edit[tg.calls.edit.length - 1];
    assert.ok(/status unknown/i.test(last.text) && !/Nothing was changed/.test(last.text), last.text);
  } finally { w.restore(); }
});

test('job: a second upload by the same person while one runs is refused, not doubled', () => {
  const src = read('src/scenes/uploadFile.js');
  assert.ok(/if \(uploadProgress\.getJob\(userId\)\) \{\s*\n\s*await ctx\.reply\('⏳ Already uploading/.test(src));
});

// ── Restart recovery ───────────────────────────────────────────────────────────────────────────────────────────────────
test('restart recovery: a card whose heartbeat went quiet is rewritten to "interrupted"; a live one is left alone', async () => {
  const tg = fakeTelegram();
  const now = 1_000_000;
  const store = new Map([
    ['upload-job:1', JSON.stringify({ chatId: 10, messageId: 100, repo: 'Old', at: now - 5 * 60 * 1000 })],
    ['upload-job:2', JSON.stringify({ chatId: 20, messageId: 200, repo: 'Live', at: now - 10 * 1000 })],
    ['upload-job:3', 'not json'],
  ]);
  const redis = {
    async *scanIterator() { for (const k of [...store.keys()]) yield k; },
    async get(k) { return store.get(k); }, async del(k) { store.delete(k); },
  };
  const fixed = await up().sweepStale({ telegram: tg, redis, now: () => now });
  assert.strictEqual(fixed, 1);
  assert.strictEqual(tg.calls.edit.length, 1);
  assert.ok(tg.calls.edit[0].chatId === 10 && /Upload interrupted/.test(tg.calls.edit[0].text) && /nothing was changed/i.test(tg.calls.edit[0].text));
  assert.ok(!store.has('upload-job:1') && !store.has('upload-job:3') && store.has('upload-job:2'));
  assert.ok(/startSweeper\(bot\)/.test(read('src/index.js')), 'started at boot');
});

// ── Fewer GitHub requests ──────────────────────────────────────────────────────────────────────────────────────────────
test('the commit sends text inside tree requests and paces blobs (see github-e2e-tests for the live behaviour)', () => {
  const src = read('src/lib/github.js');
  assert.ok(/function inlineTextOf/.test(src) && /const BLOB_PACE_MS/.test(src) && /const TREE_CHUNK_FILES = 100/.test(src));
  assert.ok(/MAX_PAUSES/.test(src) && /UPLOAD_CANCELLED/.test(src));
});

test('the "learn this folder" button works without the old session value (the job has no session)', () => {
  const bot = read('src/bot.js');
  assert.ok(/ctx\.session\.suggestedUploadPath \|\| await require\('\.\/lib\/defaults'\)\.checkUploadPathPattern/.test(bot));
});

test('a stale button is logged with the button that caused it', () => {
  assert.ok(/stale button — out-of-date screen shown/.test(read('src/handlers/manage/ui.js')));
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
      console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 7).join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
