#!/usr/bin/env node
/**
 * v2.1.0-multi — clean bars (no duplicated buttons), the dynamic Start card and the GitHub account picker (offline).
 * Run:  node scripts/v210-tests.js
 */
const assert = require('assert');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function stub(obj, patch) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = obj[k]; obj[k] = patch[k]; }
  return () => { for (const k of Object.keys(saved)) obj[k] = saved[k]; };
}
const HOME_LEVEL = ['📁 My Repos', '💼 Workspace', '⚙️ Settings', '🔔 Notifications'];
const plainText = (s) => String(s).replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();

function makeCtx({ admin = false } = {}) {
  const sent = [];
  return {
    from: { id: 42, username: 'tester' }, sent, chat: { id: 42 }, session: {}, state: { isAdmin: admin },
    reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: 100 + sent.length, chat: { id: 42 } }; },
    editMessageText: async (text, extra) => { sent.push({ text, extra, edited: true }); return true; },
    answerCbQuery: async () => {}, deleteMessage: async () => {},
    telegram: { deleteMessage: async () => {} },
    callbackQuery: { data: 'x', message: { message_id: 1 } },
  };
}
const inlineTexts = (extra) => (((extra && extra.reply_markup && extra.reply_markup.inline_keyboard) || []).flat()).map((b) => b.text);

test('bars: only Home (and the disconnected bar) carry Home-level buttons; no bar repeats a label', () => {
  const { BARS } = t.req('lib/chrome');
  for (const [id, bar] of Object.entries(BARS)) {
    const labels = bar.rows.flat();
    assert.strictEqual(new Set(labels).size, labels.length, `bar ${id} repeats a button`);
    assert.ok(bar.rows.length <= 2 && bar.rows.every((r) => r.length <= 2), `bar ${id} is at most 2×2`);
    if (id !== 'home') assert.ok(!labels.some((l) => HOME_LEVEL.filter((h) => h !== '💼 Workspace').includes(l)), `bar ${id} repeats a Home button`);
    if (!['home', 'disconnected', 'disconnectedAdmin'].includes(id)) assert.ok(!labels.includes('💼 Workspace'), `bar ${id} repeats Workspace`);
    if (bar.rows.flat().includes('⬅️ Back')) assert.ok(bar.rows[bar.rows.length - 1].includes('⬅️ Back'), `Back is in the last row of ${id}`);
  }
});

test('bars: a page-specific button lives on exactly one bar', () => {
  const { BARS } = t.req('lib/chrome');
  const seen = new Map();
  for (const [id, bar] of Object.entries(BARS)) {
    for (const l of bar.rows.flat()) {
      if (['⬅️ Back', '❌ Cancel', '⏭️ Skip'].includes(l)) continue;
      if (id === 'disconnected' || id === 'home') continue;
      assert.ok(!seen.has(l), `${l} is on both ${seen.get(l)} and ${id}`);
      seen.set(l, id);
    }
  }
});

test('bars: nothing on a screen\'s inline keyboard repeats a button of its own bar', async () => {
  const reg = t.req('handlers/manage/registry'); reg._resetForTests(); t.req('handlers/manage/areas').registerAll();
  const users = t.req('lib/users');
  const restore = stub(users, { isConnected: async () => true, getUser: async () => ({ github_scope: 'repo,delete_repo,gist,notifications,read:org,project' }), getDecryptedToken: async () => 'tok' });
  const restoreAtt = stub(t.req('lib/adminAttention'), { counts: async () => ({ total: 1, reports: 1, flagged: 0, held: 0 }) });
  try {
    const { BARS } = t.req('lib/chrome');
    const hub = t.req('handlers/hub');
    const screens = [['workspace', (c) => hub.showWorkspace(c)], ['settings', (c) => hub.showSettings(c)], ['notifications', (c) => hub.showNotifications(c)], ['searchgh', (c) => hub.showSearch(c)]];
    for (const [barId, open] of screens) {
      const ctx = makeCtx({ admin: true });
      await open(ctx);
      const inl = inlineTexts(ctx.sent[0] && ctx.sent[0].extra).map(plainText);
      const bar = BARS[barId].rows.flat().filter((l) => l !== '⬅️ Back').map(plainText);
      for (const b of bar) assert.ok(!inl.includes(b), `${barId}: "${b}" is on the bar AND inline`);
    }
    // No screen offers the same button (label or action) twice.
    const dupes = (extra, where) => {
      const bs = (((extra && extra.reply_markup && extra.reply_markup.inline_keyboard) || []).flat());
      const labels = bs.map((b) => b.text); const data = bs.map((b) => b.callback_data).filter(Boolean);
      assert.strictEqual(new Set(labels).size, labels.length, `${where}: repeated button label`);
      assert.strictEqual(new Set(data).size, data.length, `${where}: repeated button action`);
    };
    for (const [barId, open] of screens) { const c = makeCtx({ admin: true }); await open(c); dupes(c.sent[0].extra, barId); }
    const inline = t.req('keyboards/inline');
    dupes(inline.repoActions('demo', false, 'https://github.com/x/demo', 'none', true, true), 'repo card');
    dupes(inline.repoMore('demo', 'https://github.com/x/demo', true), 'repo more');
    dupes(inline.repoList([{ name: 'a', private: false }, { name: 'b', private: true }], 1, 2, { recent: ['a', 'c'] }), 'my repos');
    const repoInline = inline.repoActions('demo', false, 'https://github.com/x/demo', 'none', true, true).reply_markup.inline_keyboard.flat().map((b) => plainText(b.text));
    for (const b of BARS.repo.rows.flat().filter((l) => l !== '⬅️ Back').map(plainText)) assert.ok(!repoInline.includes(b), `repo: "${b}" is on the bar AND inline`);
    const list = inline.repoList([{ name: 'a', private: false }], 1, 1, {}).reply_markup.inline_keyboard.flat().map((b) => plainText(b.text));
    for (const b of BARS.repos.rows.flat().filter((l) => l !== '⬅️ Back').map(plainText)) assert.ok(!list.includes(b), `My Repos: "${b}" is on the bar AND inline`);
  } finally { restoreAtt(); restore(); }
});

test('bars: every bar button has a handler', () => {
  const chrome = t.req('lib/chrome');
  t.req('lib/barActions').register();
  const known = chrome.knownLabels();
  for (const [id, bar] of Object.entries(chrome.BARS)) {
    for (const l of bar.rows.flat()) {
      if (['⬅️ Back', '❌ Cancel', '⏭️ Skip'].includes(l)) continue;
      assert.ok(known.has(l), `${id}: "${l}" has no handler`);
    }
  }
});

test('start card: the user\'s layout — greeting, all clear, quoted GitHub block in two columns, Help', async () => {
  const start = t.req('handlers/start');
  assert.ok(/^🌅|^☀️|^🌆|^🌌/.test(start.greeting('Africa/Nairobi')));
  const users = t.req('lib/users');
  const repoCache = t.req('lib/repoCache');
  const restores = [
    stub(users, { isConnected: async () => true, getUser: async () => ({ github_username: 'octo', timezone: 'UTC' }), getDecryptedToken: async () => 'tok' }),
    stub(repoCache, { getRepos: async () => [{ name: 'Old', private: false, pushed_at: '2020-01-01' }, { name: 'GitroHub', private: true, pushed_at: '2026-10-01' }, { name: 'C', private: false }] }),
    stub(t.req('lib/pins'), { list: async () => [] }),
    stub(t.req('lib/activity'), { recent: async () => ({ rows: [{ created_at: new Date() }] }) }),
    stub(t.req('lib/accounts'), { activeLoginOf: async () => 'octo' }),
    stub(t.req('lib/needsYou'), { startCard: async () => ({ v: { prs: 0, issues: 0, failing: 0, notifs: 0 } }) }),
  ];
  try {
    const ctx = makeCtx();
    await start.handleStart(ctx);
    const text = ctx.sent[ctx.sent.length - 1].text;
    assert.match(text, /^(🌅|☀️|🌆|🌌) Good (morning|afternoon|evening|night), \*octo\*/);
    assert.match(text, /✨ \*All clear\\\.\* Nothing needs you right now\\\./);
    assert.match(text, /📊 \*YOUR GITHUB\*\n>📁 3 repos　　🌐 2 public\n>🔒 1 private/);
    assert.match(text, /📦 GitroHub/, 'shows the most recently pushed repo');
    assert.match(text, /🧭 \*HELP\*\n>❓ \/help　　📜 \/legal/);
    assert.ok(!/📌|⭐/.test(text), 'zero counts are hidden');
    assert.ok(!/v\d+\.\d+/.test(text), 'no version on the card');
    // dynamic: something needs you → the Needs-you block replaces "All clear"
    users.getUser = async () => ({ github_username: 'octo', timezone: 'UTC' });
    t.req('lib/needsYou').startCard = async () => ({ v: { prs: 2, issues: 0, failing: 1, notifs: 3 } });
    const busy = makeCtx();
    await start.handleStart(busy);
    const b = busy.sent[busy.sent.length - 1].text;
    assert.match(b, /🔔 \*NEEDS YOU\*\n>🔀 2 pull requests waiting on you\n>❌ 1 PR failing checks\n>🔔 3 unread/);
    assert.ok(!/All clear/.test(b));
  } finally { restores.reverse().forEach((r) => r()); }
});

test('GitHub connect link always asks for the account picker (add-another-account works)', () => {
  const url = new URL(t.req('lib/oauth').buildAuthorizeUrl(42));
  assert.strictEqual(url.searchParams.get('prompt'), 'select_account');
  assert.strictEqual(url.searchParams.get('allow_signup'), 'false');
});

test('bars: tapping every button of every bar does something (never silently ignored)', async () => {
  const chrome = t.req('lib/chrome');
  t.req('lib/barActions').register();
  const hits = [];
  const mark = (name) => async () => { hits.push(name); };
  // Record instead of calling GitHub / Telegram: whichever feature a button opens simply has to be reached.
  const restores = [];
  const patchAll = (mod, names) => names.forEach((n) => { if (typeof mod[n] === 'function') restores.push(stub(mod, { [n]: mark(`${n}`) })); });
  patchAll(t.req('handlers/myRepos'), ['showMyRepos']);
  patchAll(t.req('handlers/hub'), ['showWorkspace', 'showSettings', 'showNotifications', 'showRecentSearches', 'showSearch']);
  patchAll(t.req('handlers/pinned'), ['showPinned']);
  patchAll(t.req('handlers/start'), ['sendConnectPrompt']);
  patchAll(t.req('handlers/help'), ['handleStart']);
  patchAll(t.req('handlers/admin'), ['showDashboard']);
  patchAll(t.req('handlers/legal'), ['handleStart']);
  patchAll(t.req('handlers/browseFiles'), ['showDirectory']);
  patchAll(t.req('handlers/repoView'), ['downloadRepo']);
  restores.push(stub(chrome, { tap: async (c, d) => { hits.push(`tap:${d}`); } }));
  try {
    for (const [barId, bar] of Object.entries(chrome.BARS)) {
      for (const label of bar.rows.flat()) {
        if (['⬅️ Back', '❌ Cancel', '⏭️ Skip'].includes(label)) continue;
        hits.length = 0;
        const entered = [];
        const ctx = makeCtx();
        ctx.session.barId = barId; ctx.session.currentRepo = 'demo'; ctx.session.currentBrowseDir = '';
        ctx.state = { ...(ctx.state || {}), isAdmin: true }; // the admin-only label does nothing for anyone else, by design
        ctx.scene = { enter: async (name) => { entered.push(name); }, leave: async () => {} };
        const ran = await chrome.runLabel(ctx, label);
        assert.ok(ran, `${barId}: "${label}" was not recognised`);
        assert.ok(hits.length || entered.length || ctx.sent.length, `${barId}: "${label}" did nothing`);
        if (['📤 Upload', '📤 Upload Here', '🔁 Replace Folder'].includes(label)) assert.deepStrictEqual(entered, ['uploadFile'], `${label} must open the upload flow`);
      }
    }
  } finally { restores.reverse().forEach((r) => r()); }
});

test('New Repo prompts: every MarkdownV2 text in the scene has its reserved characters escaped', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'scenes', 'createRepo.js'), 'utf8');
  assert.ok(!/e\.g\./.test(src.split('\n').filter((l) => /MarkdownV2/.test(l)).join('\n')), 'no raw "e.g." in a MarkdownV2 message');
  assert.ok(/Choose a \\\\\.gitignore/.test(src), 'the .gitignore picker title escapes its dot');
});

test('safe send: a MarkdownV2 parse error is re-sent as readable plain text', async () => {
  const chrome = t.req('lib/chrome');
  const calls = [];
  const send = async (text, extra) => {
    calls.push({ text, extra });
    if (extra && extra.parse_mode) { const e = new Error('400: Bad Request: can\'t parse entities: Character \'.\' is reserved'); throw e; }
    return { message_id: 1 };
  };
  const res = await chrome.withPlainFallback(send, '🚫 *Choose a .gitignore*\n>quoted \\(x\\)\\.', { parse_mode: 'MarkdownV2' });
  assert.deepStrictEqual(res, { message_id: 1 });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].extra.parse_mode, undefined);
  assert.strictEqual(calls[1].text, '🚫 Choose a .gitignore\nquoted (x).');
  await assert.rejects(() => chrome.withPlainFallback(async () => { throw new Error('403 blocked'); }, 'x', { parse_mode: 'MarkdownV2' }), /403/);
});

test('serializer watchdog: a hung update does not freeze that person\'s next taps', async () => {
  const { UserSerializer } = t.req('lib/userSerializer');
  const q = new UserSerializer({ maxRunMs: 50 });
  const order = [];
  const first = q.run(7, () => new Promise(() => {})); // never finishes
  const second = q.run(7, async () => { order.push('second'); return 'ok'; });
  const [a, b] = await Promise.all([first, second]);
  assert.ok(a.timedOut); assert.strictEqual(b.value, 'ok'); assert.deepStrictEqual(order, ['second']);
});

function mdProblems(text) {
  const RESERVED = '_*[]()~`>#+-=|{}.!'; let i = 0; let code = false; const bad = [];
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { code = !code; i++; continue; }
    if (code || c === '*' || c === '_') { i++; continue; }
    if (c === '>' && (i === 0 || text[i - 1] === '\n')) { i++; continue; }
    if (RESERVED.includes(c)) bad.push(`'${c}' near “${text.slice(Math.max(0, i - 15), i + 15)}”`);
    i++;
  }
  return bad;
}

test('New Repo scene: every message it sends in every step is valid MarkdownV2', async () => {
  const users = t.req('lib/users');
  const restore = stub(users, { isConnected: async () => true, getUser: async () => ({ github_scope: 'repo', github_token_enc: 'x' }), getDecryptedToken: async () => 'tok' });
  const rc = require(require('path').join(__dirname, '..', 'src', 'lib', 'requireConnected'));
  const rcPath = require.resolve('../src/lib/requireConnected');
  const saved = require.cache[rcPath].exports;
  require.cache[rcPath].exports = async () => 'tok';
  delete require.cache[require.resolve('../src/scenes/createRepo')];
  const scene = require('../src/scenes/createRepo');
  const problems = [];
  const ctx = makeCtx();
  ctx.scene = { state: {}, leave: async () => {}, enter: async () => {} };
  const check = (text, extra) => { if (extra && extra.parse_mode === 'MarkdownV2') mdProblems(String(text)).forEach((p) => problems.push(p)); };
  ctx.reply = async (x, e) => { check(x, e); return { message_id: 10, chat: { id: 42 } }; };
  ctx.editMessageText = async (x, e) => { check(x, e); return true; };
  try {
    await scene.enterFn(ctx);
    const text = async (tx) => { ctx.message = { text: tx }; ctx.callbackQuery = undefined; for (const f of scene.h.text) await f(ctx); };
    const tap = async (d) => { ctx.callbackQuery = { data: d, message: { message_id: ctx.scene.state.cardId } }; ctx.message = undefined; for (const f of scene.h.callback_query) await f(ctx, async () => {}); };
    await text('my.repo');
    for (const d of ['create:pick:license', 'create:set:license:mit', 'create:pick:gitignore', 'create:set:gitignore:Node', 'create:pick:template', 'create:set:template:none',
      'create:vis:public', 'create:readme', 'create:desc', 'create:set:gitignore:custom', 'create:pick:schedule', 'createrepo:schedulepick:custom', 'create:back']) await tap(d);
    await text('Swift');
    assert.deepStrictEqual(problems, [], problems.join('\n'));
  } finally { require.cache[rcPath].exports = saved; restore(); void rc; }
});

test('hub screens, Start and the connect card are valid MarkdownV2', async () => {
  const reg = t.req('handlers/manage/registry'); reg._resetForTests(); t.req('handlers/manage/areas').registerAll();
  const users = t.req('lib/users');
  const restore = stub(users, { isConnected: async () => true, getUser: async () => ({ github_scope: 'repo,gist,notifications,read:org,project', github_username: 'octo' }), getDecryptedToken: async () => 'tok' });
  const restoreAtt = stub(t.req('lib/adminAttention'), { counts: async () => ({ total: 2, reports: 1, flagged: 1, held: 0 }) });
  try {
    const hub = t.req('handlers/hub');
    const problems = [];
    for (const admin of [false, true]) {
      for (const fn of ['showWorkspace', 'showSettings', 'showNotifications', 'showSearch', 'showPrefs', 'showHistory', 'showHelp']) {
        const ctx = makeCtx({ admin });
        await hub[fn](ctx);
        for (const m of ctx.sent) if (m.extra && m.extra.parse_mode === 'MarkdownV2') mdProblems(m.text).forEach((p) => problems.push(`${fn}: ${p}`));
      }
    }
    assert.deepStrictEqual(problems, [], problems.join('\n'));
  } finally { restoreAtt(); restore(); }
});

test('the version is 2.3.3-multi everywhere it is declared', () => {
  const fs = require('fs'); const path = require('path');
  assert.strictEqual(require('../package.json').version, '2.3.3-multi');
  assert.strictEqual(t.req('config').BOT_VERSION, '2.3.3-multi');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8').includes('v2.3.3-multi'));
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
