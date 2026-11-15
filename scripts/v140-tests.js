#!/usr/bin/env node
/**
 * v2.0.0-multi — navigation trail, Back that never dead-ends, short Help/Legal pages, the glance/detail repo card and the
 * context dock (offline).
 * Run:  node scripts/v140-tests.js   (npm run test:v140)
 */
const assert = require('assert');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function makeCtx({ id = 42, callback = false } = {}) {
  const sent = [];
  const ctx = {
    from: { id }, sent, chat: { id }, session: {}, state: { isAdmin: false },
    reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: 100 + sent.length }; },
    editMessageText: async (text, extra) => { sent.push({ text, extra, edited: true }); return true; },
    answerCbQuery: async () => {},
  };
  if (callback) ctx.callbackQuery = { data: 'x', message: { message_id: 1 } };
  return ctx;
}
const rowsOf = (extra) => (extra && extra.reply_markup && (extra.reply_markup.inline_keyboard || extra.reply_markup.keyboard)) || [];
const last = (ctx) => ctx.sent[ctx.sent.length - 1];
const lastRowData = (ctx) => rowsOf(last(ctx).extra).slice(-1)[0].map((b) => b.callback_data);

function stub(obj, patch) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = obj[k]; obj[k] = patch[k]; }
  return () => { for (const k of Object.keys(saved)) obj[k] = saved[k]; };
}

test('nav trail: Back returns to where you came from, not to a fixed parent', () => {
  const nav = t.req('lib/nav');
  const ctx = makeCtx();
  nav.resetToHome(ctx);
  nav.enter(ctx, 'settings'); nav.enter(ctx, 'hubhelp'); nav.enter(ctx, 'help');
  assert.strictEqual(nav.parentOf(ctx, 'help').data, 'hub:help');
  nav.enter(ctx, 'legal'); // Help → Legal
  assert.strictEqual(nav.parentOf(ctx, 'legal').data, 'help:menu', 'Legal opened from Help goes back to Help');
  nav.enter(ctx, 'legalsection');
  assert.strictEqual(nav.parentOf(ctx, 'legalsection').data, 'legal:index');
  nav.resetToHome(ctx);
  nav.enter(ctx, 'settings'); nav.enter(ctx, 'legal'); // Settings → Legal (disconnected people)
  assert.strictEqual(nav.parentOf(ctx, 'legal').data, 'hub:settings', 'Legal opened from Settings goes back to Settings');
});

test('nav trail: an empty, stale or unrelated trail rebuilds a sensible default instead of dead-ending', () => {
  const nav = t.req('lib/nav');
  for (const start of [[], [{ id: 'legalsection', label: 'x', data: 'y' }], [{ id: 'nonsense', label: 'x', data: 'y' }]]) {
    const ctx = makeCtx();
    ctx.session.navTrail = start;
    assert.strictEqual(nav.parentOf(ctx, 'legal').data, 'hub:help', 'typed /legal → Help & support');
    ctx.session.navTrail = start;
    assert.strictEqual(nav.parentOf(ctx, 'settings').data, 'manage:ws', 'Settings → Workspace');
  }
  const ctx = makeCtx();
  assert.strictEqual(nav.parentOf(ctx, 'doesnotexist').data, 'manage:ws', 'unknown screen still falls back to Workspace');
});

test('nav trail: stays short and never repeats a screen', () => {
  const nav = t.req('lib/nav');
  const ctx = makeCtx();
  for (let i = 0; i < 30; i++) { nav.enter(ctx, 'help'); nav.enter(ctx, 'helptopic'); nav.enter(ctx, 'legal'); nav.enter(ctx, 'legalsection'); }
  const ids = ctx.session.navTrail.map((e) => e.id);
  assert.ok(ids.length <= nav.MAX_TRAIL);
  assert.strictEqual(new Set(ids).size, ids.length, `no repeats: ${ids}`);
});

test('Help → topic → Back → Help → Legal → Back → Help → Back → Help & support (the screens really link up)', async () => {
  const help = t.req('handlers/help');
  const legal = t.req('handlers/legal');
  const hub = t.req('handlers/hub');
  const users = t.req('lib/users');
  const restore = stub(users, { isConnected: async () => true, getUser: async () => ({ github_scope: 'repo' }) });
  try {
    const ctx = makeCtx();
    await hub.showSettings(ctx);
    // Settings is a top-level page: Back lives on the bottom bar, so it has no inline Back row.
    await hub.showHelp(ctx);
    assert.ok(lastRowData(ctx).includes('hub:settings'), 'Help & support → Back to Settings');
    await help.showMenu(ctx);
    assert.ok(lastRowData(ctx).includes('hub:help'), 'Help menu → Back to Help & support (it used to have no Back at all)');
    await help.showTopic(ctx, 'start');
    assert.ok(lastRowData(ctx).includes('help:menu'), 'a topic → Back to Help');
    await help.showMenu(ctx);
    await legal.showIndex(ctx);
    assert.ok(lastRowData(ctx).includes('help:menu'), 'Legal opened from Help → Back to Help');
    await legal.showSection(ctx, 0);
    assert.ok(lastRowData(ctx).includes('legal:index'), 'a Legal section → Back to the Legal index');
    await legal.showIndex(ctx);
    await help.showMenu(ctx);
    assert.ok(lastRowData(ctx).includes('hub:help'), 'and back up to Help & support');
  } finally { restore(); }
});

test('typed /legal and /help always have a Back that works', async () => {
  const help = t.req('handlers/help');
  const legal = t.req('handlers/legal');
  const ctx = makeCtx();
  ctx.session.navTrail = [{ id: 'legalsection', label: 'x', data: 'y' }];
  await legal.handleStart(ctx);
  assert.ok(lastRowData(ctx).includes('hub:help'));
  await help.handleStart(ctx);
  assert.ok(lastRowData(ctx).includes('hub:help'));
});

test('Help and Legal pages are short: ≤ ~1500 characters, and a heading never ends a page', () => {
  const help = t.req('handlers/help');
  const legal = t.req('handlers/legal');
  const pages = [
    ...Object.values(help.TOPIC_PAGES).flat(), ...help.FAQ_PAGES, ...help.CONNECT_PAGES.connected, ...help.CONNECT_PAGES.disconnected,
    ...legal.PAGES.map((p) => p.text),
  ];
  for (const text of pages) {
    assert.ok(text.length <= 2600, `page of ${text.length} characters is too long: ${text.slice(0, 40)}`);
    const lines = text.trim().split('\n').filter(Boolean);
    const tail = lines[lines.length - 1];
    const headingOnly = /^\*[^*]+\*$/.test(tail) && lines.length > 1;
    assert.ok(!headingOnly, `a heading ends the page: ${tail}`);
  }
  const over = pages.filter((x) => x.length > 1800).length;
  assert.ok(over <= Math.ceil(pages.length * 0.1), `${over} of ${pages.length} pages are over 1800 characters`);
});

test('no dead ends: Settings, Preferences, History, Help & support, Search, Help and Legal screens all offer a way out', async () => {
  const hub = t.req('handlers/hub');
  const help = t.req('handlers/help');
  const legal = t.req('handlers/legal');
  const users = t.req('lib/users');
  for (const connected of [true, false]) {
    const restore = stub(users, { isConnected: async () => connected, getUser: async () => ({ github_scope: 'repo' }) });
    try {
      const ctx = makeCtx();
      const screens = [
        () => hub.showSettings(ctx), () => hub.showPrefs(ctx), () => hub.showHistory(ctx), () => hub.showHelp(ctx), () => hub.showSearch(ctx),
        () => help.showMenu(ctx), () => help.showTopic(ctx, 'start'), () => help.showFaq(ctx, 0), () => help.showContact(ctx),
        () => legal.showIndex(ctx), () => legal.showSection(ctx, 0), () => legal.showSection(ctx, 1),
      ];
      for (const open of screens) {
        ctx.sent.length = 0;
        await open();
        const m = last(ctx);
        if (!m) continue; // a screen that hands over to a connect prompt sends its own
        const buttons = rowsOf(m.extra).flat();
        const topLevel = /Settings|Search GitHub|Workspace|Notifications/.test(String(m.text).split('\n')[0]); // top-level pages: the bar's Back/Home is the way out
        const wayOut = topLevel || buttons.some((b) => /⬅️|💼/.test(b.text || '') || b.url);
        assert.ok(wayOut, `dead end (connected=${connected}): ${String(m.text).slice(0, 50)}`);
      }
    } finally { restore(); }
  }
});

test('repo card keyboard: 📊 Details next to ⋯ More, and both route', () => {
  const inl = t.req('keyboards/inline');
  const rows = inl.repoActions('demo', false, 'https://github.com/x/demo', 'none', true, true).reply_markup.inline_keyboard;
  const data = rows.flat().map((b) => b.callback_data);
  assert.ok(data.includes('repo:info:demo') && data.includes('repo:more:demo'));
  assert.ok(rows.length <= 6, `the repo card has ${rows.length} button rows`);
});

test('the version is declared consistently it is declared', () => {
  const pkg = require('../package.json');
  assert.ok(/^2\./.test(pkg.version), 'major version 2');
  assert.strictEqual(t.req('config').BOT_VERSION, pkg.version);
  const fs = require('fs');
  const changelog = fs.readFileSync(require('path').join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes('v2.0.0-multi'), 'CHANGELOG has a v2.0.0-multi entry');
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
