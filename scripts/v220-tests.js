#!/usr/bin/env node
/**
 * v2.2.0-multi — SVG icons on every web page, and the owner web panel (offline).
 * Run:  node scripts/v220-tests.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
// Emoji and pictographic symbols (but not ordinary typographic dashes, arrows in text, box drawing…).
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B06}\u{2705}\u{274C}\u{26A0}\u{23F3}\u{2139}\u{FE0F}]/u;

const ownerWeb = t.req('lib/ownerWeb');
const config = t.req('config');
const OWNER = Number(config.OWNER_ID);
const redisClient = t.req('db/redis').client;
const panel = t.req('server/ownerPanel');

const host = { host: 'example.com' };
const getLinkToken = (url) => url.split('/owner/go/')[1];
async function signIn({ fresh = true } = {}) {
  const { url } = await ownerWeb.issueLink(OWNER);
  const token = getLinkToken(url);
  const out = await panel.handle({ method: 'POST', path: '/owner/go', headers: { ...host, origin: 'https://example.com' }, body: { token }, ip: '1.1.1.1' });
  assert.strictEqual(out.status, 303, 'sign-in redirects');
  const sid = /gh_owner=([^;]+)/.exec(out.headers['Set-Cookie'])[1];
  const s = await ownerWeb.getSession(sid);
  if (!fresh) { // age the session past the 10-minute "fresh" window
    const k = [...redisStoreKeys()].find((x) => x.startsWith('ownerweb:sess:'));
    void k;
    s.freshUntil = Date.now() - 1;
  }
  return { sid, csrf: s.csrf, session: s, cookie: `gh_owner=${sid}` };
}
const redisStoreKeys = () => t.redisStore.keys();
const call = (method, p, { cookie, csrf, body, query, headers = {}, ip = '2.2.2.2' } = {}) => panel.handle({
  method, path: p, query, body, ip, headers: { ...host, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers },
}, { bot: fakeBot });
const fakeBot = { telegram: { sendMessage: async () => ({}), setMyCommands: async () => true, deleteMyCommands: async () => true } };

test('icon registry: every icon renders as inline SVG, no emoji, accessible names optional', () => {
  const icons = t.req('server/icons');
  for (const n of icons.names()) {
    const out = icons.svg(n);
    assert.ok(/^<(svg|img)\b/.test(out), n);
    assert.ok(!EMOJI.test(out), `${n} has no emoji`);
  }
  assert.throws(() => icons.svg('nope'));
  assert.ok(/aria-label="Health"/.test(icons.svg('shield', { title: 'Health' })));
  assert.ok(/aria-hidden="true"/.test(icons.svg('shield')));
  assert.ok(/ic-draw/.test(icons.stateIcon('ok')) && /ic-shake/.test(icons.stateIcon('bad')) && /ic-shake/.test(icons.stateIcon('warn')));
  assert.ok(/<path d="M12 \.297c/.test(icons.svg('github')) && /fill/.test(icons.svg('telegram')), 'real GitHub and Telegram marks');
  assert.ok(/src="\/logo\.png"/.test(icons.svg('logo')), 'the GitroHub logo');
});

test('animations exist and stop for reduced motion', () => {
  const { CSS } = t.req('server/icons');
  for (const k of ['ic-spin', 'ic-pulse', 'ic-shake', 'ic-draw', 'ic-bob']) assert.ok(CSS.includes(k), k);
  const [before, ...rest] = CSS.split('@media (prefers-reduced-motion:no-preference)');
  assert.ok(rest.length === 1 && !/animation:/.test(before.replace(/@keyframes[^}]+\}[^}]*\}/g, '')), 'no animation outside the no-preference block');
});

test('official PostgreSQL / Redis logos are used automatically when dropped into public/icons/brands/', () => {
  const icons = t.req('server/icons');
  const dir = path.join(__dirname, '..', 'public', 'icons', 'brands');
  const f = path.join(dir, 'postgresql.svg');
  assert.ok(!/<img/.test(icons.svg('database')), 'generic icon by default');
  fs.writeFileSync(f, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
  try { assert.ok(/<img class="ic brand[^"]*" src="\/icons\/brands\/postgresql\.svg"/.test(icons.svg('database'))); } finally { fs.unlinkSync(f); }
  assert.ok(!/<img/.test(icons.svg('database')));
});

test('no emoji on any web page: status page, connect pages, owner pages', () => {
  const app = t.req('server/app');
  const tiles = t.req('server/statusTiles');
  const view = tiles.build({ status: 'DEGRADED', pgStatus: { ok: false }, redisStatus: { ok: true }, traffic: { breaker: { state: 'open' }, queued: 60, active: 3 } }, { version: '2.2.0-multi', uptimeSeconds: 3700 });
  const html = app.renderStatusPage({ botDeepLink: 'https://t.me/x' }, view);
  assert.ok(!EMOJI.test(html), 'rendered status page');
  assert.ok(!EMOJI.test(read('public/status.html')) && !EMOJI.test(read('public/callback.html')) && !EMOJI.test(read('public/icons/brands/README.txt')));
  for (const tile of view.tiles) assert.ok(/^[a-z]+$/.test(tile.icon), `tile icon "${tile.icon}" is an icon name, not a glyph`);
  assert.ok((html.match(/<svg/g) || []).length >= 10, 'tiles, banner, theme and Telegram are SVG');
  const page = t.req('server/ownerPage');
  assert.ok(!EMOJI.test(page.renderPanel({ csrf: 'c', version: '2.2.0-multi', fresh: true, nonce: 'n' })));
  assert.ok(!EMOJI.test(page.renderEnter({ token: 'x'.repeat(43), nonce: 'n', minutes: 2 })));
  assert.ok(!EMOJI.test(page.PANEL_JS), 'the panel script contains no emoji');
  // the confirm-GitHub page is rendered by app.js; its own source for web markup must not contain emoji either
  const src = read('src/server/app.js');
  const web = src.slice(src.indexOf('function renderConfirmPage'), src.indexOf('const webhookEvents'));
  assert.ok(!EMOJI.test(web), 'confirm page markup');
});

test('status page: icon names reach the browser as markup, and only changed tiles are repainted', () => {
  const app = t.req('server/app');
  const view = t.req('server/statusTiles').build({ status: 'HEALTHY', pgStatus: { ok: true }, redisStatus: { ok: true }, traffic: null }, {});
  const html = app.renderStatusPage({ botDeepLink: '#' }, view);
  assert.ok(/window\.__GITROHUB_ICONS__ = \{/.test(html) && /"github":"\\u003csvg/.test(html));
  assert.ok(/lastTiles/.test(html) && /sig !== lastTiles/.test(html), 'icons are not re-drawn on every refresh');
});

test('links: single-use, expire after 2 minutes, only the owner can get one', async () => {
  redisClient.isReady = false; ownerWeb._memory.clear();
  try {
    await assert.rejects(() => ownerWeb.issueLink(OWNER + 99), /not_owner/);
    const { url, expiresInSeconds } = await ownerWeb.issueLink(OWNER);
    assert.strictEqual(expiresInSeconds, 120);
    assert.ok(url.startsWith('https://example.com/owner/go/'));
    const token = getLinkToken(url);
    assert.strictEqual(await ownerWeb.peekLink(token), true);
    assert.strictEqual(await ownerWeb.peekLink(token), true, 'looking does not spend it');
    const [a, b] = await Promise.all([ownerWeb.consumeLink(token), ownerWeb.consumeLink(token)]);
    assert.ok((a === OWNER) !== (b === OWNER), 'exactly one of two racing requests wins');
    assert.strictEqual(await ownerWeb.consumeLink(token), null, 'spent');
    const second = getLinkToken((await ownerWeb.issueLink(OWNER)).url);
    for (const v of ownerWeb._memory.values()) v.until = Date.now() - 1;
    assert.strictEqual(await ownerWeb.consumeLink(second), null, 'expired');
    assert.strictEqual(await ownerWeb.peekLink('short'), false);
  } finally { redisClient.isReady = true; }
});

test('sessions: HttpOnly + SameSite=Strict + Secure cookie, 12 h, owner re-checked on every request', async () => {
  const s = await ownerWeb.createSession(OWNER);
  const cookie = ownerWeb.sessionCookie(s.sid, s.maxAgeSeconds);
  assert.ok(/HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Path=\/owner/.test(cookie) && /Secure/.test(cookie) && /Max-Age=43200/.test(cookie));
  assert.ok((await ownerWeb.getSession(s.sid)).uid === OWNER);
  assert.strictEqual(await ownerWeb.getSession('x'.repeat(43)), null);
  const saved = config.OWNER_ID; config.OWNER_ID = 777; // the owner role moves to someone else
  try { assert.strictEqual(await ownerWeb.getSession(s.sid), null, 'access ends at once'); } finally { config.OWNER_ID = saved; }
  assert.deepStrictEqual(ownerWeb.parseCookies('a=1; gh_owner=abc; b=2'), { a: '1', gh_owner: 'abc', b: '2' });
  assert.ok(ownerWeb.csrfOk({ csrf: 'abc' }, 'abc') && !ownerWeb.csrfOk({ csrf: 'abc' }, 'abd') && !ownerWeb.csrfOk({ csrf: 'abc' }, ''));
});

test('strangers get nothing: every /owner path is "not handled" (the ordinary 404)', async () => {
  for (const [m, p] of [['GET', '/owner'], ['GET', '/owner/'], ['GET', '/owner/api/overview'], ['POST', '/owner/api/broadcast'], ['POST', '/owner/logout'], ['GET', '/owner/go/' + 'a'.repeat(43)], ['POST', '/owner/go']]) {
    assert.strictEqual(await call(m, p, { body: { token: 'a'.repeat(43) } }), null, `${m} ${p}`);
  }
  assert.strictEqual(await call('GET', '/owner', { cookie: 'gh_owner=' + 'b'.repeat(43) }), null, 'a made-up session');
  assert.strictEqual(await call('GET', '/health'), null, 'other paths are not ours');
});

test('opening a link: a page first (nothing spent), the Continue button spends it and starts the session', async () => {
  const { url } = await ownerWeb.issueLink(OWNER);
  const token = getLinkToken(url);
  const view = await call('GET', `/owner/go/${token}`);
  assert.strictEqual(view.status, 200);
  assert.ok(view.body.includes('Open the panel') && !EMOJI.test(view.body));
  assert.ok((await call('GET', `/owner/go/${token}`)).status === 200, 'a link preview can look as often as it likes');
  assert.strictEqual(await call('POST', '/owner/go', { body: { token }, headers: { origin: 'https://evil.example' } }), null, 'a foreign site cannot spend it');
  const ok = await call('POST', '/owner/go', { body: { token }, headers: { origin: 'https://example.com' } });
  assert.strictEqual(ok.status, 303);
  assert.strictEqual(ok.headers.Location, '/owner');
  assert.ok(/gh_owner=/.test(ok.headers['Set-Cookie']));
  assert.strictEqual(await call('POST', '/owner/go', { body: { token } }), null, 'second use');
});

test('the panel page: strict CSP with a per-response nonce, no caching, carries the CSRF token', async () => {
  const s = await signIn();
  const r = await call('GET', '/owner', { cookie: s.cookie });
  assert.strictEqual(r.status, 200);
  const csp = r.headers['Content-Security-Policy'];
  const nonce = /nonce-([^']+)'/.exec(csp)[1];
  assert.ok(r.body.includes(`nonce="${nonce}"`));
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp) && /frame-ancestors 'none'/.test(csp) && /default-src 'none'/.test(csp));
  assert.ok(/no-store/.test(r.headers['Cache-Control']) && /noindex/.test(r.headers['X-Robots-Tag']) && r.headers['X-Frame-Options'] === 'DENY');
  assert.ok(r.body.includes(s.csrf));
  assert.ok(!/onclick=|onerror=|javascript:/i.test(r.body), 'no inline handlers');
});

test('API: reads work with a session and never include secrets', async () => {
  const s = await signIn();
  const rm = t.req('lib/runtimeMetrics'); const stats = t.req('lib/adminStats'); const reports = t.req('lib/reports');
  const saved = [rm.getHealth, stats.fleetOverview, reports.openCount, stats.searchUsers];
  rm.getHealth = async () => ({ status: 'HEALTHY', reasons: [], pgStatus: { ok: true }, redisStatus: { ok: true }, rssMB: 120, lag: { p99: 4 }, traffic: { state: 'ok', breaker: { state: 'closed' }, active: 1, queued: 0 } });
  stats.fleetOverview = async () => ({ totalUsers: 10, activeToday: 3, connected: 7, blocked: 1, suspended: 0, totalCommits: 99, errorsToday: 2, newToday: 1, newThisWeek: 4, avgCommitsPerActiveUser: 1.5, githubAccounts: 8, multiAccountUsers: 1, revokedAccounts: 0 });
  reports.openCount = async () => 2;
  t.setQueryHandler((sql) => (/FROM users/.test(sql) ? { rows: [{ telegram_id: 5, telegram_username: 'bob', telegram_first_name: 'Bob', github_username: 'bobgh', github_token_enc: 'SECRET-TOKEN', is_blocked: false, admin_notes: 'n', connected_at: new Date() }] } : { rows: [] }));
  try {
    const o = await call('GET', '/owner/api/overview', { cookie: s.cookie });
    assert.strictEqual(o.status, 200);
    const j = JSON.parse(o.body);
    assert.strictEqual(j.health, 'HEALTHY'); assert.strictEqual(j.fleet.users, 10); assert.strictEqual(j.openReports, 2); assert.strictEqual(j.github.circuit, 'closed');
    const u = await call('GET', '/owner/api/users', { cookie: s.cookie, query: { q: 'bob' } });
    assert.strictEqual(u.status, 200);
    assert.ok(!/SECRET-TOKEN|github_token_enc/.test(u.body), 'no token column ever leaves the server');
    assert.strictEqual(JSON.parse(u.body).users[0].connected, true);
  } finally { [rm.getHealth, stats.fleetOverview, reports.openCount, stats.searchUsers] = saved; t.setQueryHandler(() => ({ rows: [], rowCount: 0 })); }
});

test('changes need the CSRF token and our own origin', async () => {
  const s = await signIn();
  assert.strictEqual((await call('POST', '/owner/api/reports/1/resolve', { cookie: s.cookie, body: {} })).status, 403, 'no token');
  assert.strictEqual((await call('POST', '/owner/api/reports/1/resolve', { cookie: s.cookie, csrf: 'wrong', body: {} })).status, 403, 'wrong token');
  assert.strictEqual((await call('POST', '/owner/api/reports/1/resolve', { cookie: s.cookie, csrf: s.csrf, body: {}, headers: { origin: 'https://evil.example' } })).status, 403, 'foreign origin');
  assert.strictEqual((await call('POST', '/owner/api/reports/1/resolve', { cookie: s.cookie, csrf: s.csrf, body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'cross-site fetch');
  const reports = t.req('lib/reports'); const actions = t.req('lib/adminActions');
  const saved = [reports.resolve, actions.auditLog]; let resolved = null;
  reports.resolve = async (id, admin, st) => { resolved = [id, admin, st]; }; actions.auditLog = async () => {};
  try {
    const r = await call('POST', '/owner/api/reports/7/resolve', { cookie: s.cookie, csrf: s.csrf, body: { status: 'dismissed' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(resolved, [7, OWNER, 'dismissed']);
  } finally { [reports.resolve, actions.auditLog] = saved; }
});

test('dangerous actions need a fresh sign-in (roles, bans, announcements, switches that affect everyone)', async () => {
  const stale = await signIn({ fresh: false });
  // the session object was aged in memory only — age the stored copy too
  const key = [...t.redisStore.keys()].filter((k) => k.startsWith('ownerweb:sess:')).pop();
  const stored = JSON.parse(t.redisStore.get(key)); stored.freshUntil = Date.now() - 1000; t.redisStore.set(key, JSON.stringify(stored));
  const roles = t.req('lib/roles'); const actions = t.req('lib/adminActions'); const gc = t.req('lib/globalConfig');
  const saved = [roles.setRole, roles.getRole, actions.auditLog, actions.banUser, actions.broadcast, gc.set];
  const did = [];
  roles.setRole = async (...a) => did.push(['role', ...a]); roles.getRole = async () => 'guest'; actions.auditLog = async () => {};
  actions.banUser = async (...a) => did.push(['ban', a[1]]); actions.broadcast = async () => ({ sent: 1, total: 1, blocked: 0, failed: 0 }); gc.set = async (...a) => did.push(['set', a[1], a[2]]);
  try {
    for (const [p, body] of [['/owner/api/users/5/role', { role: 'admin' }], ['/owner/api/users/5/role_revoke', {}], ['/owner/api/users/5/ban', {}], ['/owner/api/broadcast', { text: 'hi' }], ['/owner/api/controls', { key: 'maintenance_enabled', value: true }]]) {
      const r = await call('POST', p, { cookie: stale.cookie, csrf: stale.csrf, body });
      assert.strictEqual(r.status, 403, p);
      assert.strictEqual(JSON.parse(r.body).needFresh, true, p);
    }
    assert.deepStrictEqual(did, [], 'nothing happened');
    // an everyday change is fine on an older session
    const fine = await call('POST', '/owner/api/controls', { cookie: stale.cookie, csrf: stale.csrf, body: { key: 'default_hourly_action_cap', value: 30 } });
    assert.strictEqual(fine.status, 200);
    // a freshly signed-in session may do them
    const f = await signIn();
    assert.strictEqual((await call('POST', '/owner/api/users/5/role', { cookie: f.cookie, csrf: f.csrf, body: { role: 'admin' } })).status, 200);
    assert.strictEqual((await call('POST', '/owner/api/users/5/ban', { cookie: f.cookie, csrf: f.csrf, body: { reason: 'spam' } })).status, 200);
    assert.ok(did.some((d) => d[0] === 'role' && d[2] === 5 && d[3] === 'admin') && did.some((d) => d[0] === 'ban' && d[1] === 5));
  } finally { [roles.setRole, roles.getRole, actions.auditLog, actions.banUser, actions.broadcast, gc.set] = saved; }
});

test('the owner cannot be banned, demoted or have their role changed from the panel; bad input is refused', async () => {
  const s = await signIn();
  for (const what of ['role', 'role_revoke', 'ban', 'unban', 'suspend']) {
    const r = await call('POST', `/owner/api/users/${OWNER}/${what}`, { cookie: s.cookie, csrf: s.csrf, body: { role: 'admin' } });
    assert.strictEqual(r.status, 409, what);
  }
  assert.strictEqual((await call('POST', `/owner/api/users/${OWNER}/pause`, { cookie: s.cookie, csrf: s.csrf, body: { key: 'pulls' } })).status, 409);
  assert.strictEqual((await call('POST', '/owner/api/users/5/role', { cookie: s.cookie, csrf: s.csrf, body: { role: 'owner' } })).status, 400);
  assert.strictEqual((await call('POST', '/owner/api/users/5/role', { cookie: s.cookie, csrf: s.csrf, body: { role: 'guest' } })).status, 400);
  assert.strictEqual((await call('POST', '/owner/api/users/abc/ban', { cookie: s.cookie, csrf: s.csrf, body: {} })).status, 400);
  assert.strictEqual((await call('POST', '/owner/api/controls', { cookie: s.cookie, csrf: s.csrf, body: { key: 'bot_token', value: 'x' } })).status, 400, 'only known settings');
  assert.strictEqual((await call('POST', '/owner/api/controls', { cookie: s.cookie, csrf: s.csrf, body: { key: 'default_hourly_action_cap', value: 'lots' } })).status, 400);
});

test('every panel action is written to the audit log with a [web] tag', async () => {
  const s = await signIn();
  const roles = t.req('lib/roles'); const actions = t.req('lib/adminActions');
  const saved = [roles.setRole, roles.getRole, actions.auditLog]; const logged = [];
  roles.setRole = async () => {}; roles.getRole = async () => 'guest'; actions.auditLog = async (...a) => logged.push(a);
  try {
    await call('POST', '/owner/api/users/5/role', { cookie: s.cookie, csrf: s.csrf, body: { role: 'moderator' } });
    assert.ok(logged.some((l) => l[0] === OWNER && l[1] === 5 && l[2] === 'role_change' && /\[web\]/.test(l[3])), JSON.stringify(logged));
  } finally { [roles.setRole, roles.getRole, actions.auditLog] = saved; }
});

test('broadcast: needs text, runs in the background, one at a time, reports back in the chat', async () => {
  const api = t.req('server/ownerApi');
  const s = await signIn();
  const actions = t.req('lib/adminActions');
  const saved = actions.broadcast; let release; const told = [];
  actions.broadcast = () => new Promise((res) => { release = () => res({ sent: 4, total: 5, blocked: 1, failed: 0 }); });
  t.setQueryHandler((sql) => (/COUNT/.test(sql) ? { rows: [{ n: 5 }] } : { rows: [] }));
  const bot = { telegram: { sendMessage: async (id, m) => told.push([id, m]) } };
  try {
    const run = (body) => panel.handle({ method: 'POST', path: '/owner/api/broadcast', headers: { ...host, cookie: s.cookie, 'x-csrf-token': s.csrf }, body, ip: '9.9.9.9' }, { bot });
    assert.strictEqual((await run({ text: '   ' })).status, 400);
    const first = await run({ text: 'Maintenance tonight' });
    assert.strictEqual(first.status, 200); assert.strictEqual(JSON.parse(first.body).recipients, 5);
    assert.strictEqual((await run({ text: 'again' })).status, 409, 'one at a time');
    release(); await new Promise((r) => setTimeout(r, 20));
    assert.ok(told.some(([id, m]) => id === OWNER && /4\/5 delivered/.test(m)), 'the owner is told how it went');
    assert.strictEqual((await run({ text: 'next' })).status, 200, 'free again');
    release();
    await new Promise((r) => setTimeout(r, 20));
  } finally { actions.broadcast = saved; api._setBroadcastRunning(false); t.setQueryHandler(() => ({ rows: [], rowCount: 0 })); }
});

test('sign out ends the session; OWNER_WEB=off turns the whole panel off', async () => {
  const s = await signIn();
  assert.strictEqual((await call('POST', '/owner/logout', { cookie: s.cookie, csrf: s.csrf })).status, 200);
  assert.strictEqual(await call('GET', '/owner', { cookie: s.cookie }), null);
  const s2 = await signIn();
  process.env.OWNER_WEB = 'off';
  try {
    assert.strictEqual(await call('GET', '/owner', { cookie: s2.cookie }), null);
    await assert.rejects(() => ownerWeb.issueLink(OWNER), /switched off/);
  } finally { delete process.env.OWNER_WEB; }
  assert.strictEqual((await call('GET', '/owner', { cookie: s2.cookie })).status, 200);
});

test('rate limiting: guessing links and hammering the API both stop', async () => {
  for (let i = 0; i < 20; i++) await call('GET', '/owner/go/' + 'z'.repeat(43), { ip: '8.8.8.8' });
  const { url } = await ownerWeb.issueLink(OWNER);
  assert.strictEqual(await call('GET', '/owner/go/' + getLinkToken(url), { ip: '8.8.8.8' }), null, 'even a valid link is refused from an address that has been guessing');
  assert.strictEqual((await call('GET', '/owner/go/' + getLinkToken(url), { ip: '8.8.4.4' })).status, 200, 'other addresses are unaffected');
  const s = await signIn();
  let last;
  for (let i = 0; i < 250; i++) last = await call('GET', '/owner/api/nothing', { cookie: s.cookie });
  assert.strictEqual(last.status, 429);
});

test('the bot: /owner gives the owner a link behind a button; everyone else gets silence', async () => {
  const { sendLink } = t.req('handlers/ownerWebLink');
  const sent = [];
  const mk = (id) => ({ from: { id }, chat: { id }, telegram: { deleteMessage: async () => {} }, reply: async (text, extra) => { sent.push({ id, text, extra }); return { message_id: 1 }; } });
  await sendLink(mk(OWNER + 1));
  assert.strictEqual(sent.length, 0, 'not the owner: nothing at all');
  await sendLink(mk(OWNER));
  assert.strictEqual(sent.length, 1);
  const btn = sent[0].extra.reply_markup.inline_keyboard[0][0];
  assert.ok(btn.url.startsWith('https://example.com/owner/go/') && !/owner\/go/.test(sent[0].text), 'the link is on the button, not in the text');
  assert.ok(sent[0].extra.__keep && /expires in 2 minutes/.test(sent[0].text));
  assert.strictEqual(await ownerWeb.peekLink(getLinkToken(btn.url)), true);
});

test('menus and wiring: /owner is the owner\'s menu only, below /start and /admin; Dashboard button is owner-only', () => {
  const ac = t.req('lib/adminCommands');
  assert.deepStrictEqual(ac.OWNER.slice(0, 3).map((c) => c.command), ['start', 'admin', 'owner']);
  assert.ok(!ac.ADMIN.some((c) => c.command === 'owner') && !ac.BASE.some((c) => c.command === 'owner' || c.command === 'admin'));
  assert.ok(!/command: 'owner'/.test(read('src/index.js')), 'not in the global list');
  assert.ok(/bot\.command\('owner'/.test(read('src/bot.js')) && /data === 'admin:web'/.test(read('src/bot.js')));
  assert.ok(/isOwner\(ctx\.from\.id\) && require\('\.\.\/lib\/ownerWeb'\)\.enabled\(\) \? \[\[plain\('[^']+ Web panel', 'admin:web'\)\]\]/.test(read('src/handlers/adminHub.js')));
  assert.ok(/require\('\.\/ownerPanel'\)\.mount\(app, bot\)/.test(read('src/server/app.js')));
});

test('syncFor gives the owner the owner menu and admins the admin menu', async () => {
  const ac = t.req('lib/adminCommands');
  const calls = [];
  const tg = { setMyCommands: async (list, o) => calls.push([o.scope.chat_id, list.map((c) => c.command)]), deleteMyCommands: async () => {} };
  await ac.syncFor(tg, OWNER, true); await ac.syncFor(tg, 55, true);
  assert.deepStrictEqual(calls[0], [OWNER, ['start', 'admin', 'owner', 'report', 'help', 'legal', 'cancel']]);
  assert.deepStrictEqual(calls[1], [55, ['start', 'admin', 'report', 'help', 'legal', 'cancel']]);
});

test('the version is declared in package.json and the changelog', () => {
  assert.ok(/^2\.\d+\.\d+-multi$/.test(require('../package.json').version));
  assert.ok(read('CHANGELOG.md').includes('v2.2.0-multi'));
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  \u2713 ${name}`); } catch (err) {
      console.log(`  \u2717 ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 7).join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
