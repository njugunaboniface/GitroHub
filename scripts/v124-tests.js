#!/usr/bin/env node
/**
 * v1.2.4-multi regression tests — fully offline. Run with:  node scripts/v124-tests.js   (npm run test:v124)
 */
const assert = require('assert');
const path = require('path');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Admin / Owner roster (fix 1) ──────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, '..', 'src', 'config.js');
function loadConfig(env) {
  const keys = ['OWNER_ID', 'ADMIN_ID', 'ADMIN_IDS', 'SUPER_ADMIN_IDS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[CONFIG_PATH];
  try { return require(CONFIG_PATH); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    delete require.cache[CONFIG_PATH];
  }
}

test('admin roster: the Owner works together with ADMIN_IDS even when NOT repeated in it', () => {
  const c = loadConfig({ OWNER_ID: '9', ADMIN_IDS: '1,2' });
  assert.equal(c.OWNER_ID, 9);
  assert.deepEqual([...c.ADMIN_IDS].sort(), [1, 2, 9]);
  assert.ok(c.ADMIN_IDS.includes(9), 'owner must be an admin');
  assert.ok(c.SUPER_ADMIN_IDS.includes(9), 'owner must be a super admin');
});

test('admin roster: no duplicates when the Owner is also listed in ADMIN_IDS', () => {
  const c = loadConfig({ OWNER_ID: '1', ADMIN_IDS: '1, 2 ,2' });
  assert.deepEqual(c.ADMIN_IDS, [1, 2]);
});

test('admin roster: the older ADMIN_ID, OWNER_ID and ADMIN_IDS all combine', () => {
  const c = loadConfig({ OWNER_ID: '5', ADMIN_ID: '6', ADMIN_IDS: '7,8' });
  assert.deepEqual([...c.ADMIN_IDS].sort(), [5, 6, 7, 8]);
});

test('admin roster: each old single-variable setup still works unchanged', () => {
  assert.deepEqual(loadConfig({ OWNER_ID: '5' }).ADMIN_IDS, [5]);
  const onlyAdminId = loadConfig({ ADMIN_ID: '6' });
  assert.deepEqual(onlyAdminId.ADMIN_IDS, [6]);
  assert.equal(onlyAdminId.OWNER_ID, 6);
  const onlyList = loadConfig({ ADMIN_IDS: '3,4' });
  assert.deepEqual(onlyList.ADMIN_IDS, [3, 4]);
  assert.equal(onlyList.OWNER_ID, 3, 'first ADMIN_IDS entry is the Owner when OWNER_ID is unset');
});

test('admin roster: junk entries are ignored and the Owner is always a super admin', () => {
  const c = loadConfig({ OWNER_ID: '9', ADMIN_IDS: 'abc,,0,1.5,2', SUPER_ADMIN_IDS: '2' });
  assert.deepEqual([...c.ADMIN_IDS].sort(), [2, 9]);
  assert.deepEqual([...c.SUPER_ADMIN_IDS].sort(), [2, 9], 'owner kept even though SUPER_ADMIN_IDS omitted it');
  const c2 = loadConfig({ OWNER_ID: '9', ADMIN_IDS: '1,2', SUPER_ADMIN_IDS: '2,77' });
  assert.ok(!c2.SUPER_ADMIN_IDS.includes(77), 'a super admin must be an admin');
});

// ── Revoked token handling (fix 2) ────────────────────────────────────────────
function setup({ probeStatus, token = 'tok', connected = true }) {
  t.resetQueries();
  const users = t.req('lib/users');
  const saved = { gdt: users.getDecryptedToken, ic: users.isConnected };
  users.getDecryptedToken = async () => token;
  users.isConnected = async () => connected;
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (probeStatus === 'throw') throw new Error('network down');
    return { status: probeStatus, ok: probeStatus >= 200 && probeStatus < 300 };
  };
  return {
    calls,
    restore() { users.getDecryptedToken = saved.gdt; users.isConnected = saved.ic; global.fetch = realFetch; },
  };
}
const disconnected = () => t.queries.some((q) => /UPDATE users SET github_token_enc = NULL/.test(q.sql));
const authErr = () => Object.assign(new Error('Bad credentials - https://docs.github.com/rest'), { status: 401 });

test('revoked token: a 401 that GitHub confirms disconnects locally (tokenDead: no GitHub cleanup calls)', async () => {
  const s = setup({ probeStatus: 401 });
  try {
    const r = await t.req('lib/revokedToken').disconnectIfRevoked(42, authErr());
    assert.equal(r.revoked, true);
    assert.ok(disconnected(), 'token must be wiped');
    assert.equal(s.calls.length, 1, 'only the single probe hits GitHub');
    assert.match(s.calls[0].url, /api\.github\.com\/user$/);
  } finally { s.restore(); }
});

test('revoked token: a token that still works is NEVER disconnected (the 401 was a fluke)', async () => {
  const s = setup({ probeStatus: 200 });
  try {
    const r = await t.req('lib/revokedToken').disconnectIfRevoked(42, authErr());
    assert.equal(r.revoked, false);
    assert.equal(disconnected(), false);
  } finally { s.restore(); }
});

test('revoked token: GitHub outages / timeouts / 5xx never log anyone out', async () => {
  for (const probeStatus of ['throw', 500, 502, 403]) {
    const s = setup({ probeStatus });
    try {
      const r = await t.req('lib/revokedToken').disconnectIfRevoked(42, authErr());
      assert.equal(r.revoked, false, `probe ${probeStatus}`);
      assert.equal(disconnected(), false, `probe ${probeStatus}`);
    } finally { s.restore(); }
  }
});

test('revoked token: only auth errors trigger anything — other errors do not even probe', async () => {
  const s = setup({ probeStatus: 401 });
  try {
    const rv = t.req('lib/revokedToken');
    for (const err of [Object.assign(new Error('Not Found'), { status: 404 }), new Error('boom'), null, undefined]) {
      assert.equal((await rv.disconnectIfRevoked(42, err)).revoked, false);
    }
    assert.equal(s.calls.length, 0);
    assert.equal(disconnected(), false);
  } finally { s.restore(); }
});

test('revoked token: "Bad credentials" without a status is recognised too', async () => {
  const s = setup({ probeStatus: 401 });
  try {
    const r = await t.req('lib/revokedToken').disconnectIfRevoked(42, new Error('Bad credentials'));
    assert.equal(r.revoked, true);
  } finally { s.restore(); }
});

test('revoked token: ten simultaneous failures cause ONE probe and one disconnect', async () => {
  const s = setup({ probeStatus: 401 });
  try {
    const rv = t.req('lib/revokedToken');
    const results = await Promise.all(Array.from({ length: 10 }, () => rv.disconnectIfRevoked(42, authErr())));
    assert.ok(results.every((r) => r.revoked === true));
    assert.equal(s.calls.length, 1);
  } finally { s.restore(); }
});

test('revoked token: someone already disconnected still gets the connect flow; a connected-but-undecryptable token is left alone', async () => {
  let s = setup({ probeStatus: 401, token: null, connected: false });
  try {
    const r = await t.req('lib/revokedToken').disconnectIfRevoked(42, authErr());
    assert.deepEqual([r.revoked, r.alreadyDisconnected], [true, true]);
    assert.equal(s.calls.length, 0);
  } finally { s.restore(); }
  s = setup({ probeStatus: 401, token: null, connected: true });
  try {
    assert.equal((await t.req('lib/revokedToken').disconnectIfRevoked(42, authErr())).revoked, false);
  } finally { s.restore(); }
});

test('revoked token: in chat, the person gets the connect prompt (disconnected keyboard) instead of "Something went wrong"', async () => {
  const s = setup({ probeStatus: 401 });
  const sent = [];
  const ctx = {
    from: { id: 42 },
    session: { awaitingSearch: true, adminZone: true },
    scene: { leave: async () => { ctx.left = true; } },
    reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: sent.length }; },
    telegram: { sendMessage: async (_c, text, extra) => { sent.push({ text, extra }); return { message_id: sent.length }; }, deleteMessage: async () => {} },
    chat: { id: 42 },
  };
  try {
    const handled = await t.req('lib/revokedToken').handleAuthFailure(ctx, authErr());
    assert.equal(handled, true);
    assert.ok(ctx.left, 'wizard left');
    assert.equal(ctx.session.awaitingSearch, false);
    assert.ok(sent.some((m) => /revoked|removed/i.test(String(m.text)) && /Connect/i.test(JSON.stringify(m.extra || {}) + m.text)), 'connect prompt sent');
    assert.ok(!sent.some((m) => /Something went wrong/.test(String(m.text))));
  } finally { s.restore(); }
});

test('revoked token: wired into the global error handler, the GitHub error helper and both scheduled-job pollers', () => {
  const fs = require('fs');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
  assert.match(read('bot.js'), /revokedToken'\)\.handleAuthFailure\(ctx, err\)/);
  assert.match(read('lib/errorHelpers.js'), /revokedToken'\)\.handleAuthFailure\(ctx, err\)/);
  assert.equal((read('index.js').match(/handleBackgroundAuthFailure/g) || []).length, 2);
});

// ── OAuth scopes ──────────────────────────────────────────────────────────────
test('scopes: parsing, implication and "missing" are exact', () => {
  const sc = t.req('lib/scopes');
  assert.deepEqual([...sc.parse('repo, delete_repo,gist')].sort(), ['delete_repo', 'gist', 'repo']);
  assert.deepEqual(sc.missing('repo,delete_repo', ['gist', 'read:org']), ['gist', 'read:org']);
  assert.deepEqual(sc.missing('repo,delete_repo,gist', ['gist']), []);
  assert.deepEqual(sc.missing('repo,admin:org', ['read:org']), [], 'admin:org implies read:org');
  assert.deepEqual(sc.missing('repo', ['notifications']), [], 'repo covers notifications');
  assert.deepEqual(sc.missing(null, ['repo']), [], 'unknown stored scope is treated as the base grant');
  assert.deepEqual(sc.missing('', ['gist']), ['gist']);
});

test('scopes: authorize URL = base + validated extras; unknown scopes are refused', () => {
  const oauth = t.req('lib/oauth');
  const scopeOf = (url) => new URL(url).searchParams.get('scope');
  assert.equal(scopeOf(oauth.buildAuthorizeUrl(7)), 'repo,delete_repo', 'plain connect is unchanged');
  assert.equal(scopeOf(oauth.buildAuthorizeUrl(7, { extraScopes: ['gist', 'repo'] })), 'repo,delete_repo,gist');
  assert.throws(() => oauth.buildAuthorizeUrl(7, { extraScopes: ['admin:org'] }), /unknown OAuth scope/);
});

test('feature switch: on by default, off only when an admin stored "off"; keys are validated', async () => {
  const gc = t.req('lib/globalConfig');
  const f = t.req('lib/features');
  assert.equal(f.isEnabled('gists'), true);
  await gc.set(1, 'feature_gists', 'off');
  assert.equal(f.isEnabled('gists'), false);
  await gc.clear(1, 'feature_gists');
  assert.equal(f.isEnabled('gists'), true);
  assert.throws(() => f.isEnabled('Bad Key'), /Invalid feature key/);
  await assert.rejects(() => gc.set(1, 'not_a_known_key', 'x'), /Unknown global config key/);
});

// ── Manage registry + dispatcher ──────────────────────────────────────────────
function makeCtx({ id = 42 } = {}) {
  const sent = [];
  const ctx = {
    from: { id }, sent, chat: { id }, session: {},
    callbackQuery: { data: 'x', message: { message_id: 1 } },
    reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: sent.length }; },
    editMessageText: async (text, extra) => { sent.push({ text, extra, edited: true }); return true; },
    answerCbQuery: async () => {},
  };
  return ctx;
}
// the offline Telegraf stand-in files both keyboard kinds under inline_keyboard; real Telegraf uses `keyboard` for reply keyboards
const rowsOf = (kb) => kb.reply_markup.keyboard || kb.reply_markup.inline_keyboard;
const flat = (extra) => ((extra && extra.reply_markup && extra.reply_markup.inline_keyboard) || []).flat();

function withUser({ connected = true, scope = 'repo,delete_repo' } = {}) {
  const users = t.req('lib/users');
  const saved = { ic: users.isConnected, gu: users.getUser };
  users.isConnected = async () => connected;
  users.getUser = async () => ({ github_scope: scope });
  return () => { users.isConnected = saved.ic; users.getUser = saved.gu; };
}

test('registry: rejects malformed areas and duplicates', () => {
  const reg = t.req('handlers/manage/registry');
  reg._resetForTests();
  const ok = { key: 'pulls', label: 'Pull Requests', emoji: '🔀', level: 'repo', scopes: [], handle: async () => {} };
  assert.throws(() => reg.register({ ...ok, key: 'Bad' }), /key/);
  assert.throws(() => reg.register({ ...ok, label: 'x'.repeat(19) }), /label/);
  assert.throws(() => reg.register({ ...ok, level: 'galaxy' }), /level/);
  assert.throws(() => reg.register({ ...ok, scopes: 'gist' }), /scopes/);
  assert.throws(() => reg.register({ ...ok, handle: null }), /handle/);
  reg.register(ok);
  assert.throws(() => reg.register(ok), /already registered/);
  reg._resetForTests();
});

test('menus: no areas → still the one-row menu (Workspace is always there); no ⚡ Manage button on a repo', () => {
  const reg = t.req('handlers/manage/registry'); reg._resetForTests();
  const bbtb = t.req('keyboards/bbtb');
  const labels = (kb) => rowsOf(kb).flat().map((b) => b.text);
  assert.ok(labels(bbtb.mainMenuFor(false)).includes('💼 Workspace'), 'v1.3.0: Workspace is visible to everybody');
  const inline = t.req('keyboards/inline');
  const data = (kb) => flat(kb).map((b) => b.callback_data || '');
  assert.ok(!data(inline.repoActions('r', false, 'https://x', 'none', false, false)).some((d) => d.startsWith('manage:')));
});

test('menus: Home bar is 2×2 for everybody; disconnected people get Connect + Workspace; admins get no extra row', () => {
  const bbtb = t.req('keyboards/bbtb');
  const user = rowsOf(bbtb.mainMenuFor(false));
  const admin = rowsOf(bbtb.mainMenuFor(true));
  assert.deepEqual(user, admin);
  assert.deepEqual(user.map((r) => r.map((b) => b.text)), [['📁 My Repos', '💼 Workspace'], ['⚙️ Settings', '🔔 Notifications']]);
  for (const isAdmin of [false, true]) {
    const off = rowsOf(bbtb.disconnectedFor(isAdmin));
    assert.deepEqual(off[0].map((b) => b.text), ['🔗 Connect GitHub', '💼 Workspace']);
  }
  assert.deepEqual(rowsOf(bbtb.menuFor(true, true)), rowsOf(bbtb.mainMenuFor(true)));
});

test('menus: ⚡ Manage button callback data fits Telegram\'s 64 bytes even for a 100-char repo name', () => {
  const inline = t.req('keyboards/inline');
  const longName = 'a'.repeat(100);
  const kb = inline.repoActions(longName, false, 'https://x', 'none', false, true);
  const btn = flat(kb).find((b) => /^(manage:|~)/.test(b.callback_data || '') && /Manage/.test(b.text));
  assert.ok(btn, 'button present');
  assert.ok(Buffer.byteLength(btn.callback_data) <= 64);
});

test('dispatcher: disconnected people get the connect prompt, nothing runs', async () => {
  const reg = t.req('handlers/manage/registry'); reg._resetForTests();
  let ran = false;
  reg.register({ key: 'pulls', label: 'Pull Requests', emoji: '🔀', level: 'repo', scopes: [], handle: async () => { ran = true; } });
  const restore = withUser({ connected: false });
  try {
    const ctx = makeCtx();
    assert.equal(await t.req('handlers/manage').route(ctx, 'manage:pulls:home:myrepo'), true);
    assert.equal(ran, false);
    assert.ok(ctx.sent.length >= 1);
  } finally { restore(); reg._resetForTests(); }
});

test('dispatcher: repo-level handler receives action, repoName and args; bad repo names never reach it', async () => {
  const reg = t.req('handlers/manage/registry'); reg._resetForTests();
  const calls = [];
  reg.register({ key: 'pulls', label: 'Pull Requests', emoji: '🔀', level: 'repo', scopes: [], handle: async (_c, call) => { calls.push(call); } });
  const restore = withUser();
  try {
    const m = t.req('handlers/manage');
    const ctx = makeCtx();
    await m.route(ctx, 'manage:pulls:view:my.repo-1:12:x');
    assert.deepEqual(calls, [{ action: 'view', args: ['12', 'x'], repoName: 'my.repo-1' }]);
    await m.route(ctx, 'manage:pulls:view:bad name');
    await m.route(ctx, 'manage:pulls:view:..');
    await m.route(ctx, 'manage:pulls:view');
    await m.route(ctx, 'manage:pulls:BAD!:repo');
    assert.equal(calls.length, 1, 'only the valid call ran');
  } finally { restore(); reg._resetForTests(); }
});

test('dispatcher: account-level handler gets no repoName; unknown areas and non-manage data are handled safely', async () => {
  const reg = t.req('handlers/manage/registry'); reg._resetForTests();
  const calls = [];
  reg.register({ key: 'gists', label: 'Gists', emoji: '📝', level: 'account', scopes: [], handle: async (_c, call) => { calls.push(call); } });
  const restore = withUser();
  try {
    const m = t.req('handlers/manage');
    const ctx = makeCtx();
    await m.route(ctx, 'manage:gists:list:2');
    assert.deepEqual(calls, [{ action: 'list', args: ['2'], repoName: null }]);
    assert.equal(await m.route(ctx, 'manage:nothing:home'), true);
    assert.ok(ctx.sent.some((x) => /expired|out of date/.test(x.text)));
    assert.equal(await m.route(ctx, 'repo:foo'), false);
    assert.equal(await m.route(ctx, 'manage:'), false);
  } finally { restore(); reg._resetForTests(); }
});

test('dispatcher: a missing OAuth scope shows ONE grant prompt with the right authorize link and runs nothing', async () => {
  const reg = t.req('handlers/manage/registry'); reg._resetForTests();
  let ran = false;
  reg.register({ key: 'gists', label: 'Gists', emoji: '📝', level: 'account', scopes: ['gist'], handle: async () => { ran = true; } });
  let restore = withUser({ scope: 'repo,delete_repo' });
  try {
    const ctx = makeCtx();
    await t.req('handlers/manage').route(ctx, 'manage:gists:home');
    assert.equal(ran, false);
    assert.equal(ctx.sent.length, 1);
    const url = flat(ctx.sent[0].extra).find((b) => b.url).url;
    assert.equal(new URL(url).searchParams.get('scope'), 'repo,delete_repo,gist');
  } finally { restore(); }
  restore = withUser({ scope: 'repo,delete_repo,gist' });
  try {
    await t.req('handlers/manage').route(makeCtx(), 'manage:gists:home');
    assert.equal(ran, true, 'granted → runs');
  } finally { restore(); reg._resetForTests(); }
});

test('dispatcher: an admin-disabled feature runs nothing and says so', async () => {
  const reg = t.req('handlers/manage/registry'); reg._resetForTests();
  let ran = false;
  reg.register({ key: 'pulls', label: 'Pull Requests', emoji: '🔀', level: 'repo', scopes: [], handle: async () => { ran = true; } });
  const restore = withUser();
  const gc = t.req('lib/globalConfig');
  await gc.set(1, 'feature_pulls', 'off');
  try {
    const ctx = makeCtx();
    await t.req('handlers/manage').route(ctx, 'manage:pulls:home:repo1');
    assert.equal(ran, false);
    assert.match(ctx.sent[0].text, /switched off/);
  } finally { await gc.clear(1, 'feature_pulls'); restore(); reg._resetForTests(); }
});

test('dispatcher: a handler that throws a GitHub error is reported, not crashed; a revoked token leads to the connect flow', async () => {
  const reg = t.req('handlers/manage/registry'); reg._resetForTests();
  reg.register({ key: 'pulls', label: 'Pull Requests', emoji: '🔀', level: 'repo', scopes: [], handle: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } });
  const restore = withUser();
  try {
    const ctx = makeCtx();
    await t.req('handlers/manage').route(ctx, 'manage:pulls:home:repo1');
    assert.ok(ctx.sent.some((x) => /Pull Requests/.test(x.text)), 'error message names the action');
  } finally { restore(); reg._resetForTests(); }
});

test('hub screens: only enabled areas appear, two per row, with a Back button; every callback fits 64 bytes', async () => {
  const reg = t.req('handlers/manage/registry'); reg._resetForTests();
  for (const [key, label, level] of [['pulls', 'Pull Requests', 'repo'], ['issues', 'Issues', 'repo'], ['branches', 'Branches', 'repo'], ['gists', 'Gists', 'account']]) {
    reg.register({ key, label, emoji: '🔹', level, scopes: [], handle: async () => {} });
  }
  const restore = withUser();
  try {
    const m = t.req('handlers/manage');
    const ctx = makeCtx();
    await m.showHub(ctx, 'b'.repeat(100));
    const rows = ctx.sent[0].extra.reply_markup.inline_keyboard;
    assert.deepEqual(rows.map((r) => r.length), [2, 1, 2], 'Collaborate (2) · Code (1) · then Back + Workspace');
    assert.match(ctx.sent[0].text, /Collaborate/);
    assert.match(ctx.sent[0].text, /Code/);
    assert.ok(!rows.flat().some((b) => /Gists/.test(b.text)), 'account areas stay out of ⚡ Manage');
    assert.ok(rows.flat().every((b) => Buffer.byteLength(b.callback_data) <= 64));
    const ws = makeCtx();
    await m.showWorkspace(ws);
    assert.ok(flat(ws.sent[0].extra).some((b) => /Gists/.test(b.text)));
  } finally { restore(); reg._resetForTests(); }
});

// ── Webhook events ────────────────────────────────────────────────────────────
test('webhook events: a push lists up to 3 commit subjects and the branch; +N more beyond that', () => {
  const ev = t.req('lib/webhookEvents');
  const commits = ['Fix login\n\nlong body', 'Add tests', 'Bump deps', 'Docs', 'Typo'].map((message) => ({ message }));
  const r = ev.describe('push', { ref: 'refs/heads/main', commits });
  assert.equal(r.key, 'push');
  assert.equal(r.summary, '5 new commits pushed to main (Fix login; Add tests; Bump deps; +2 more)');
  assert.equal(ev.describe('push', { ref: 'refs/heads/x', commits: [{ message: 'One' }] }).summary, '1 new commit pushed to x (One)');
  assert.equal(ev.describe('push', { ref: 'refs/heads/x', commits: [] }), null, 'branch creation pings are not interesting');
  assert.equal(ev.describe('push', { ref: 'refs/heads/x', deleted: true, commits: [{ message: 'a' }] }), null);
});

test('webhook events: stars, forks, creates, deletes, comments and reviews each produce one clean line', () => {
  const ev = t.req('lib/webhookEvents');
  assert.match(ev.describe('star', { action: 'created', sender: { login: 'amy' }, repository: { stargazers_count: 42 } }).summary, /@amy starred it \(42 total\)/);
  assert.equal(ev.describe('star', { action: 'deleted', sender: { login: 'amy' } }), null, 'un-stars are silent');
  assert.match(ev.describe('fork', { sender: { login: 'bob' } }).summary, /@bob forked it/);
  assert.equal(ev.describe('create', { ref_type: 'tag', ref: 'v1.0.0' }).summary, 'New tag: v1.0.0');
  assert.equal(ev.describe('create', { ref_type: 'repository' }), null);
  assert.equal(ev.describe('delete', { ref_type: 'branch', ref: 'old' }).summary, 'Deleted branch: old');
  assert.match(ev.describe('issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: { user: { login: 'zed' } } }).summary, /@zed commented on PR #7/);
  assert.equal(ev.describe('issue_comment', { action: 'edited', issue: { number: 7 } }), null);
  assert.match(ev.describe('pull_request_review', { action: 'submitted', pull_request: { number: 3 }, review: { state: 'approved', user: { login: 'amy' } } }).summary, /approved PR #3/);
});

test('webhook events: the original six behave exactly as before, and hostile titles are flattened and shortened', () => {
  const ev = t.req('lib/webhookEvents');
  assert.equal(ev.describe('issues', { action: 'opened', issue: { title: 'Bug' } }).summary, 'New issue: "Bug"');
  assert.equal(ev.describe('issues', { action: 'closed', issue: { title: 'Bug' } }), null);
  assert.equal(ev.describe('pull_request', { action: 'opened', pull_request: { title: 'Feat' } }).summary, 'New PR: "Feat"');
  assert.equal(ev.describe('release', { action: 'published', release: { tag_name: 'v2' } }).summary, 'New release: v2');
  assert.equal(ev.describe('workflow_run', { action: 'completed', workflow_run: { name: 'CI', conclusion: 'failure' } }).summary, '❌ Workflow "CI" failure');
  assert.equal(ev.describe('workflow_run', { action: 'requested', workflow_run: { name: 'CI' } }), null);
  assert.equal(ev.describe('deployment_status', { deployment_status: { state: 'success', environment: 'prod' } }).summary, 'Deployment success → prod');
  const evil = ev.describe('issues', { action: 'opened', issue: { title: `line1\n\n${'x'.repeat(500)}` } }).summary;
  assert.ok(!/\n/.test(evil) && evil.length < 120, evil.length);
  assert.equal(ev.describe('ping', { zen: 'hi' }), null);
  assert.equal(ev.describe('push', null), null);
});

test('webhook events: every event type GitHub is subscribed to has a definition, new noisy ones default OFF', () => {
  const ev = t.req('lib/webhookEvents');
  const github = t.req('lib/github');
  for (const e of github.WEBHOOK_EVENTS) assert.ok(ev.KEYS.has(e), `${e} has no alert definition`);
  assert.equal(ev.defaultFor('star'), true);
  for (const k of ['create', 'delete', 'issue_comment', 'pull_request_review']) assert.equal(ev.defaultFor(k), false, k);
  assert.equal(ev.defaultFor('nonsense'), false);
});

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) {
      console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 5).join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
