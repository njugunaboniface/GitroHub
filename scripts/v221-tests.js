#!/usr/bin/env node
/**
 * v2.3.0-multi — the owner panel's "Open the panel" / API calls work in a real browser (offline).
 * A browser told `Referrer-Policy: no-referrer` sends `Origin: null` on every POST; the same-origin check used to refuse that.
 * Run:  node scripts/v221-tests.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const ownerWeb = t.req('lib/ownerWeb');
const panel = t.req('server/ownerPanel');
const OWNER = Number(t.req('config').OWNER_ID);
const host = { host: 'example.com' };
const call = (method, p, { cookie, csrf, body, headers = {}, ip = '3.3.3.3' } = {}) => panel.handle({
  method, path: p, body, ip, headers: { ...host, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers },
});
const tokenOf = async () => (await ownerWeb.issueLink(OWNER)).url.split('/owner/go/')[1];

// What Chrome / Safari actually send for a same-site form post or fetch under these headers.
const BROWSER_SAME_SITE = { origin: 'null', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };

test('pressing "Open the panel" works with the headers a real browser sends (Origin: null, Sec-Fetch-Site: same-origin)', async () => {
  const token = await tokenOf();
  const r = await call('POST', '/owner/go', { body: { token }, headers: BROWSER_SAME_SITE });
  assert.ok(r && r.status === 303, 'the sign-in goes through');
  assert.ok(/gh_owner=/.test(r.headers['Set-Cookie']));
});

test('the same holds for the panel\'s own API calls and sign-out', async () => {
  const token = await tokenOf();
  const r = await call('POST', '/owner/go', { body: { token }, headers: BROWSER_SAME_SITE });
  const sid = /gh_owner=([^;]+)/.exec(r.headers['Set-Cookie'])[1];
  const { csrf } = await ownerWeb.getSession(sid);
  const cookie = `gh_owner=${sid}`;
  const reports = t.req('lib/reports'); const actions = t.req('lib/adminActions');
  const saved = [reports.resolve, actions.auditLog]; reports.resolve = async () => {}; actions.auditLog = async () => {};
  try {
    const ok = await call('POST', '/owner/api/reports/4/resolve', { cookie, csrf, body: { status: 'resolved' }, headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } });
    assert.strictEqual(ok.status, 200);
  } finally { [reports.resolve, actions.auditLog] = saved; }
  const out = await call('POST', '/owner/logout', { cookie, csrf, headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } });
  assert.strictEqual(out.status, 200);
});

test('forged requests are still refused: other sites, cross-site fetches, and a bare "Origin: null" with no Sec-Fetch-Site', async () => {
  const token = await tokenOf();
  for (const headers of [
    { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    { origin: 'https://example.com', 'sec-fetch-site': 'same-site' },   // a sibling subdomain is not us
    { origin: 'null' },                                                  // sandboxed / data: pages, with no browser attestation
    { origin: 'https://evil.example' },
  ]) {
    assert.strictEqual(await call('POST', '/owner/go', { body: { token }, headers }), null, JSON.stringify(headers));
  }
  assert.strictEqual(await ownerWeb.peekLink(token), true, 'none of that spent the link');
  assert.ok(panel.sameOrigin({ 'sec-fetch-site': 'none' }) && panel.sameOrigin({}) && panel.sameOrigin({ origin: 'https://example.com' }));
});

test('pages use Referrer-Policy same-origin (never no-referrer, which makes POSTs look forged)', async () => {
  const { url } = await ownerWeb.issueLink(OWNER);
  const view = await call('GET', '/owner/go/' + url.split('/owner/go/')[1]);
  assert.strictEqual(view.headers['Referrer-Policy'], 'same-origin');
  assert.ok(/<meta name="referrer" content="same-origin">/.test(view.body));
  const src = read('src/server/ownerPage.js') + read('src/server/ownerPanel.js');
  assert.ok(!/content="no-referrer"|'Referrer-Policy': 'no-referrer'/.test(src));
  const token = await tokenOf();
  const sid = /gh_owner=([^;]+)/.exec((await call('POST', '/owner/go', { body: { token }, headers: BROWSER_SAME_SITE })).headers['Set-Cookie'])[1];
  const page = await call('GET', '/owner', { cookie: `gh_owner=${sid}` });
  assert.ok(/<meta name="referrer" content="same-origin">/.test(page.body) && page.headers['Referrer-Policy'] === 'same-origin');
});

test('the version is declared in package.json and the changelog', () => {
  assert.ok(/^2\.\d+\.\d+-multi$/.test(require('../package.json').version));
  assert.ok(read('CHANGELOG.md').includes('v2.2.1-multi'));
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
