#!/usr/bin/env node
/**
 * v1.2.5-multi regression tests — offline. Tests that need a database run on a REAL local PostgreSQL
 * (scripts/lib/realPg.js) and are skipped with a note when none is reachable.
 * Run:  node scripts/v125-tests.js   (npm run test:v125)
 */
const assert = require('assert');
const zlib = require('zlib');
const t = require('./lib/testEnv');
const realPg = require('./lib/realPg');

const tests = [];
const test = (name, fn, { pg = false } = {}) => tests.push({ name, fn, pg });
const HAVE_PG = realPg.available();

// ── Owner import / export: the whole current structure must survive a round trip ─────────────────────────────
test('import/export round trip on real Postgres: tags (self-FK), accounts, webhooks, bytea, stray tables', async () => {
  const A = realPg.createDb('v125_a'); const B = realPg.createDb('v125_b');
  try {
    const crypto = t.req('lib/crypto');
    const { pool } = t.req('db/postgres');
    const mig = t.req('lib/instanceMigration');
    t.setQueryHandler(A.handler);
    await pool.query("INSERT INTO users (telegram_id, github_username, github_token_enc, connected_at) VALUES (10,'alice',$1,now()),(11,'bob',$2,now())", [crypto.encrypt('tok-a'), crypto.encrypt('tok-b')]);
    await pool.query("INSERT INTO github_accounts (telegram_id, github_login, token_enc) VALUES (10,'alice',$1),(10,'alice2',$2)", [crypto.encrypt('tok-a'), crypto.encrypt('tok-a2')]);
    // child inserted BEFORE parent id order on purpose: child id 1, parent id 2
    await pool.query("INSERT INTO tags (id, telegram_id, name, emoji) VALUES (2,10,'work','💼')");
    await pool.query("INSERT INTO tags (id, telegram_id, name, emoji, parent_id) VALUES (1,10,'work-sub','🔧',2)");
    await pool.query("INSERT INTO repo_tags (telegram_id, repo_name, tag_id) VALUES (10,'app',1)");
    await pool.query("INSERT INTO pinned_repos (telegram_id, repo_name, position, owner_login) VALUES (10,'app',0,'alice'),(10,'app',1,'alice2')");
    await pool.query("INSERT INTO repo_webhooks (telegram_id, repo_name, webhook_id, secret) VALUES (10,'app',5,$1)", ['enc1:' + crypto.encrypt('whsec')]);
    const out = await mig.exportInstance(async () => {});
    const snap = JSON.parse(zlib.gunzipSync(out.buffer));
    assert.ok(snap.tables.repo_tags.length === 1);
    assert.ok(snap.tables.repo_webhooks[0].secret.startsWith('enc1:'));

    t.setQueryHandler(B.handler);
    // a stray row that exists only on the TARGET must not survive in a per-person table the snapshot lacks
    await pool.query("INSERT INTO users (telegram_id, github_username) VALUES (99,'old')");
    const res = await mig.importInstance(out.buffer, out.transportKey, async () => {});
    assert.equal(res.tokenResult, 'carried');
    const n = async (q) => Number((await pool.query(q)).rows[0].count);
    assert.equal(await n('select count(*) from users'), 2);
    assert.equal(await n('select count(*) from tags'), 2);
    assert.equal(await n('select count(*) from repo_tags'), 1);
    assert.equal(await n('select count(*) from github_accounts'), 3 - 1 + 1); // alice, alice2, bob (reconciled)
    assert.equal(await n("select count(*) from pinned_repos where owner_login = 'alice2'"), 1);
    const sub = (await pool.query("select parent_id from tags where id = 1")).rows[0];
    assert.equal(String(sub.parent_id), '2');
    const hook = (await pool.query('select secret, owner_login, account_login from repo_webhooks')).rows[0];
    assert.equal(crypto.decrypt(hook.secret.slice(5)), 'whsec');
    assert.ok(hook.owner_login && hook.account_login, 'webhook is tied to an account after import');
    // sequences are usable after import
    await pool.query("INSERT INTO tags (telegram_id, name, emoji) VALUES (10,'later','⭐')");
    assert.equal(await n('select count(*) from tags'), 3);
  } finally { A.drop(); B.drop(); }
}, { pg: true });


// ── Revert suite against an in-memory Git server ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const sha1 = (x) => crypto.createHash('sha1').update(String(x)).digest('hex');
function makeGit() {
  const blobs = new Map(); const trees = new Map(); const commitsMap = new Map(); const refs = new Map(); const log = [];
  const blob = (text) => { const s = sha1(`blob ${text}`); blobs.set(s, text); return s; };
  const mkTree = (files) => { const entries = Object.entries(files).sort().map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })); const s = sha1(JSON.stringify(entries)); trees.set(s, entries); return s; };
  const treeFiles = (treeSha) => Object.fromEntries(trees.get(treeSha).map((e) => [e.path, e.sha]));
  let n = 0;
  const commit = (files, parents, message) => { const tree = mkTree(files); const s = sha1(`c${++n}${tree}${parents}`); commitsMap.set(s, { sha: s, tree, parents, message }); return s; };
  const apiErr = (status, message) => Object.assign(new Error(message), { status });
  const fileDiff = (c) => {
    const parent = c.parents[0] ? treeFiles(commitsMap.get(c.parents[0]).tree) : {}; const now = treeFiles(c.tree); const files = [];
    for (const [f, sh] of Object.entries(now)) if (parent[f] !== sh) files.push({ filename: f, status: parent[f] ? 'modified' : 'added', additions: 1, deletions: parent[f] ? 1 : 0, sha: sh, patch: '' });
    for (const f of Object.keys(parent)) if (!now[f]) files.push({ filename: f, status: 'removed', additions: 0, deletions: 1, sha: parent[f], patch: '' });
    return files;
  };
  const isAncestor = (anc, of) => { const seen = new Set(); const q = [of]; while (q.length) { const x = q.shift(); if (x === anc) return true; if (seen.has(x)) continue; seen.add(x); q.push(...(commitsMap.get(x) || { parents: [] }).parents); } return false; };
  const full = (ref) => [...commitsMap.keys()].find((k) => k.startsWith(ref));
  const protectedBranches = new Set();
  const g = {};
  const client = {
    async request(route, p = {}) {
      log.push(route);
      const ok = (data) => ({ status: 200, headers: {}, data });
      const r = route.replace('/repos/{owner}/{repo}', '');
      if (r === 'GET /git/ref/{ref}') { const sha = refs.get(p.ref); if (!sha) throw apiErr(404, 'Not Found'); return ok({ object: { sha } }); }
      if (r === 'GET /git/commits/{commit_sha}') { const c = commitsMap.get(p.commit_sha); if (!c) throw apiErr(404, 'Not Found'); return ok({ sha: c.sha, message: c.message, tree: { sha: c.tree }, parents: c.parents.map((x) => ({ sha: x })) }); }
      if (r === 'GET /commits/{ref}') { const s = commitsMap.has(p.ref) ? p.ref : full(p.ref); const c = commitsMap.get(s); if (!c) throw apiErr(404, 'Not Found'); return ok({ sha: c.sha, html_url: 'u', commit: { message: c.message, author: { name: 'x', date: new Date().toISOString() } }, parents: c.parents.map((x) => ({ sha: x })), stats: { additions: 1, deletions: 0, total: 1 }, files: fileDiff(c) }); }
      if (r === 'GET /git/trees/{tree_sha}') return ok({ tree: trees.get(p.tree_sha) });
      if (r === 'POST /git/trees') { const files = p.base_tree ? treeFiles(p.base_tree) : {}; for (const e of p.tree) { if (e.sha === null) delete files[e.path]; else files[e.path] = e.sha; } return ok({ sha: mkTree(files) }); }
      if (r === 'POST /git/commits') { const s = sha1(`c${++n}${p.tree}${p.parents}`); commitsMap.set(s, { sha: s, tree: p.tree, parents: p.parents, message: p.message }); return ok({ sha: s }); }
      if (r === 'PATCH /git/refs/{ref}') { const cur = refs.get(p.ref); if (!p.force && cur && !isAncestor(cur, p.sha)) throw apiErr(422, 'Update is not a fast forward'); refs.set(p.ref, p.sha); return ok({}); }
      if (r === 'POST /git/refs') { const k = p.ref.replace('refs/', ''); if (refs.has(k)) throw apiErr(422, 'Reference already exists'); refs.set(k, p.sha); return ok({}); }
      if (r === 'GET /branches/{branch}') { const sha = refs.get(`heads/${p.branch}`); if (!sha) throw apiErr(404, 'Not Found'); return ok({ protected: protectedBranches.has(p.branch), commit: { sha } }); }
      if (r === 'GET /search/issues') { g.searches.push(p.q); if (g.searchFails) throw apiErr(502, 'Bad gateway'); const hit = Object.entries(g.searchCounts).find(([k]) => p.q.includes(k)); return ok({ total_count: hit ? hit[1] : 0, items: [] }); }
      if (r === 'GET /compare/{basehead}') { const [a, b] = p.basehead.split('...'); const status = a === b ? 'identical' : isAncestor(b, a) ? 'behind' : isAncestor(a, b) ? 'ahead' : 'diverged'; return ok({ status, merge_base_commit: { sha: status === 'behind' ? b : a }, files: [] }); }
      throw apiErr(404, `no fake for ${route}`);
    },
  };
  Object.assign(g, { client, blob, commit, refs, log, treeFiles, commitsMap, protectedBranches, searches: [], searchCounts: {}, searchFails: false });
  return g;
}

function gitWorld() {
  const g = makeGit();
  const c1 = g.commit({ 'a.txt': g.blob('a1'), 'b.txt': g.blob('b1') }, [], 'first');
  const c2 = g.commit({ 'a.txt': g.blob('a2'), 'b.txt': g.blob('b1') }, [c1], 'change a');
  const c3 = g.commit({ 'a.txt': g.blob('a2'), 'b.txt': g.blob('b2') }, [c2], 'change b');
  g.refs.set('heads/main', c3);
  return { g, c1, c2, c3 };
}

const github = t.req('lib/github');
let activeGit = null;
github.internals.client = () => activeGit.client;
const rv = t.req('lib/github/revert');
const cm = t.req('lib/github/commits');
const content = (g, sha, f) => g.treeFiles(g.commitsMap.get(sha).tree)[f];

test('restore a file: puts the earlier version back as a NEW commit, leaves other files alone, says so when identical or missing', async () => {
  const { g, c1, c3 } = gitWorld(); activeGit = g;
  const out = await rv.restoreFile('tok', 'me', 'r', 'main', 'a.txt', c1.slice(0, 7));
  assert.ok(out.sha && out.parent === c3);
  assert.equal(content(g, out.sha, 'a.txt'), g.blob('a1'));
  assert.equal(content(g, out.sha, 'b.txt'), g.blob('b2'), 'other file untouched');
  assert.equal(g.refs.get('heads/main'), out.sha);
  assert.deepEqual(await rv.restoreFile('tok', 'me', 'r', 'main', 'a.txt', c1), { unchanged: true });
  assert.deepEqual(await rv.restoreFile('tok', 'me', 'r', 'main', 'nope.txt', c1), { missing: true });
  await assert.rejects(() => rv.restoreFile('tok', 'me', 'r', 'main', '../x', c1), /valid/);
});

test('go back to a version: branch content matches that commit again, history kept; nothing to do when already there', async () => {
  const { g, c1, c3 } = gitWorld(); activeGit = g;
  const out = await rv.revertToCommit('tok', 'me', 'r', 'main', c1.slice(0, 7));
  assert.deepEqual(g.treeFiles(g.commitsMap.get(out.sha).tree), g.treeFiles(g.commitsMap.get(c1).tree));
  assert.deepEqual(g.commitsMap.get(out.sha).parents, [c3]);
  assert.deepEqual(await rv.revertToCommit('tok', 'me', 'r', 'main', c1), { unchanged: true });
});

test('roll a branch back: backup branch first, force-moves the ref, refuses protected branches and non-ancestors', async () => {
  const { g, c1, c2, c3 } = gitWorld(); activeGit = g;
  g.protectedBranches.add('main');
  await assert.rejects(() => rv.rollbackBranch('tok', 'me', 'r', 'main', c1), (e) => e.code === 'BRANCH_PROTECTED');
  assert.equal(g.refs.get('heads/main'), c3, 'protected branch untouched');
  g.protectedBranches.clear();
  const side = g.commit({ 'z.txt': g.blob('z') }, [c1], 'side'); // not part of main
  await assert.rejects(() => rv.rollbackBranch('tok', 'me', 'r', 'main', side), (e) => e.code === 'NOT_ANCESTOR');
  const out = await rv.rollbackBranch('tok', 'me', 'r', 'main', c2.slice(0, 7));
  assert.equal(g.refs.get('heads/main'), c2);
  assert.ok(/^backup\/main-\d{8}-\d{6}$/.test(out.backup), out.backup);
  assert.equal(g.refs.get(`heads/${out.backup}`), c3, 'backup holds the old tip');
  assert.deepEqual(await rv.rollbackBranch('tok', 'me', 'r', 'main', c2), { unchanged: true });
  // the old tip is ahead of the branch now → undoing the rollback is a plain fast-forward
  assert.deepEqual(await rv.fastForward('tok', 'me', 'r', 'main', c3), { sha: c3 });
});

test('recover a deleted branch or tag: recreated at the saved sha; refuses when the name exists again or the sha is short', async () => {
  const { g, c2, c3 } = gitWorld(); activeGit = g;
  await rv.restoreRef('tok', 'me', 'r', 'branch', 'feature/x', c2);
  assert.equal(g.refs.get('heads/feature/x'), c2);
  await assert.rejects(() => rv.restoreRef('tok', 'me', 'r', 'branch', 'feature/x', c2), (e) => e.code === 'REF_EXISTS');
  await rv.restoreRef('tok', 'me', 'r', 'tag', 'v1', c3);
  assert.equal(g.refs.get('tags/v1'), c3);
  await assert.rejects(() => rv.restoreRef('tok', 'me', 'r', 'tag', 'v2', c3.slice(0, 7)), (e) => e.code === 'BAD_REF');
});

test('conflict help: a later edit makes a strict revert refuse; "skip" reverts the rest; "force" overwrites', async () => {
  const { g, c2, c3 } = gitWorld(); activeGit = g;
  // a commit touching BOTH files, then someone edits a.txt afterwards
  const both = g.commit({ 'a.txt': g.blob('a3'), 'b.txt': g.blob('b3') }, [c3], 'both');
  const later = g.commit({ 'a.txt': g.blob('a4'), 'b.txt': g.blob('b3') }, [both], 'edit a later');
  g.refs.set('heads/main', later);
  const strict = await cm.revertCommit('tok', 'me', 'r', both, 'main');
  assert.deepEqual(strict.conflicts, ['a.txt']);
  assert.equal(g.refs.get('heads/main'), later, 'strict changes nothing');
  const skip = await cm.revertCommit('tok', 'me', 'r', both, 'main', { mode: 'skip' });
  assert.deepEqual(skip.skipped, ['a.txt']);
  assert.equal(content(g, skip.sha, 'b.txt'), g.blob('b2'));
  assert.equal(content(g, skip.sha, 'a.txt'), g.blob('a4'), 'conflicting file left alone');
  g.refs.set('heads/main', later);
  const force = await cm.revertCommit('tok', 'me', 'r', both, 'main', { mode: 'force' });
  assert.deepEqual(force.overwritten, ['a.txt']);
  assert.equal(content(g, force.sha, 'a.txt'), g.blob('a2'), 'overwritten with the earlier version');
  // every file conflicting + skip → nothing to do, no empty commit
  g.refs.set('heads/main', g.commit({ 'a.txt': g.blob('a9'), 'b.txt': g.blob('b9') }, [later], 'both again'));
  const none = await cm.revertCommit('tok', 'me', 'r', both, 'main', { mode: 'skip' });
  assert.ok(none.nothingToRevert);
});

test('change journal: records ids only, scopes by owner, hides undone entries, rejects unknown kinds', async () => {
  const A = realPg.createDb('v125_j');
  try {
    const { pool } = t.req('db/postgres');
    t.setQueryHandler(A.handler);
    const j = t.req('lib/changeJournal');
    const id1 = await j.record({ telegramId: 7, owner: 'Alice', repo: 'app', kind: 'commit', ref: 'main', sha: 'a'.repeat(40), label: 'Upload\nsecond line' });
    await j.record({ telegramId: 7, owner: 'bob-org', repo: 'app', kind: 'branch_delete', ref: 'old', prevSha: 'b'.repeat(40), label: 'Deleted branch old' });
    assert.equal(await j.record({ telegramId: 7, owner: 'alice', repo: 'app', kind: 'nonsense' }), null);
    assert.equal(await j.record({ owner: 'alice', repo: 'app', kind: 'commit' }), null, 'no user → nothing recorded');
    const mine = await j.list(7, 'alice', 'app');
    assert.equal(mine.items.length, 1);
    assert.equal(mine.items[0].label, 'Upload');
    assert.equal((await j.list(7, 'bob-org', 'app')).items.length, 1);
    await j.markUndone(7, id1);
    assert.equal((await j.list(7, 'alice', 'app')).items.length, 0);
    assert.equal((await j.list(7, 'alice', 'app', { includeUndone: true })).items.length, 1);
    assert.equal(await j.get(8, id1), null, 'another person can not read it');
  } finally { A.drop(); }
}, { pg: true });


// ── "Needs you" counts, start-card line, daily summary, alert links ─────────────────────────────────────────
const needs = t.req('lib/needsYou');
const style = t.req('keyboards/buttonStyle');

test('needs-you counts: five searches, cached per account, forced refresh re-asks, a GitHub failure falls back to the cache', async () => {
  const g = makeGit(); activeGit = g;
  g.searchCounts = { 'review-requested:@me': 3, 'review:changes_requested': 1, 'status:failure': 2, 'assignee:@me': 5 };
  needs._cache.clear();
  const a = await needs.counts(1, 'Alice', 'tok');
  assert.deepEqual({ review: a.review, changes: a.changes, prs: a.prs, failing: a.failing, issues: a.issues }, { review: 3, changes: 1, prs: 4, failing: 2, issues: 5 });
  assert.equal(g.searches.length, 5);
  await needs.counts(1, 'alice', 'tok'); // same account, different case → cache
  assert.equal(g.searches.length, 5, 'served from cache');
  await needs.counts(1, 'other', 'tok2');
  assert.equal(g.searches.length, 10, 'a different account has its own numbers');
  g.searchFails = true;
  const stale = await needs.counts(1, 'alice', 'tok', { force: false });
  assert.equal(stale.prs, 4);
  await assert.rejects(() => needs.counts(1, 'alice', 'tok', { force: true }), /Bad gateway|502|GitHub/i);
  assert.equal(needs.cached(1, 'alice').prs, 4, 'cache survives a failed refresh');
});

test('needs-you line: hidden at zero, singular/plural, toggles respected, jump buttons only when there is something', () => {
  const all = { needs_line: true, needs_prs: true, needs_issues: true, needs_failing: true, needs_notifs: true };
  assert.equal(needs.line(needs.visible({ prs: 0, issues: 0, failing: 0 }, all)), '');
  const v = needs.visible({ prs: 3, issues: 2, failing: 1 }, all);
  assert.equal(needs.line(v), '▸ 🔀 3 PRs need you · 🐞 2 issues · ❌ 1 failing\n');
  assert.equal(needs.line(needs.visible({ prs: 1, issues: 1, failing: 0 }, all)), '▸ 🔀 1 PR needs you · 🐞 1 issue\n');
  assert.ok(needs.line(v, { sum: 2 }).includes('\\+2 elsewhere'));
  const noIssues = needs.visible({ prs: 3, issues: 2, failing: 1 }, { ...all, needs_issues: false });
  assert.equal(noIssues.total, 4);
  assert.ok(!needs.line(noIssues).includes('issue'));
  assert.equal(needs.visible({ prs: 9, issues: 9, failing: 9 }, { ...all, needs_line: false }).total, 0);
  assert.equal(needs.jumpRows(needs.visible({ prs: 0, issues: 0, failing: 0 }, all), style), null);
  const rows = needs.jumpRows(v, style);
  assert.equal(rows[0].length, 2);
  assert.ok(/Review PRs \(3\)/.test(rows[0][0].text) && /Needs attention \(6\)/.test(rows[0][1].text));
  assert.equal(needs.jumpRows(needs.visible({ prs: 0, issues: 2, failing: 0 }, all), style)[0].length, 1, 'no Review PRs button without PRs');
  // unread GitHub notifications count too
  const n = needs.visible({ prs: 0, issues: 0, failing: 0, notifs: 4 }, all);
  assert.equal(n.total, 4);
  assert.equal(needs.line(n), '▸ 🔔 4 unread\n');
  assert.equal(needs.line(needs.visible({ prs: 1, issues: 0, failing: 0, notifs: 50 }, all)), '▸ 🔀 1 PR needs you · 🔔 50\\+ unread\n');
  assert.equal(needs.visible({ prs: 0, issues: 0, failing: 0, notifs: 4 }, { ...all, needs_notifs: false }).total, 0, 'notification toggle respected');
  const nr = needs.jumpRows(needs.visible({ prs: 2, issues: 0, failing: 0, notifs: 4 }, all), style);
  assert.equal(nr.length, 2); assert.ok(/Unread \(4\)/.test(nr[0][1].text) && nr[0][1].callback_data === 'manage:notify:list:unread:1');
});

test('daily summary: sent once at 8:00 local, not in quiet hours, not when empty, not when off; real Postgres', async () => {
  const A = realPg.createDb('v125_d');
  try {
    const crypto2 = t.req('lib/crypto');
    const { pool } = t.req('db/postgres');
    t.setQueryHandler(A.handler);
    const g = makeGit(); activeGit = g; needs._cache.clear();
    g.searchCounts = { 'review-requested:@me': 2, 'assignee:@me': 1 };
    await pool.query("INSERT INTO users (telegram_id, github_username, github_token_enc, connected_at, timezone) VALUES (21,'alice',$1,now(),'UTC'),(22,'bob',$1,now(),'UTC'),(23,'carl',$1,now(),'UTC')", [crypto2.encrypt('tok')]);
    await pool.query("INSERT INTO github_accounts (telegram_id, github_login, token_enc) VALUES (21,'alice',$1),(22,'bob',$1),(23,'carl',$1)", [crypto2.encrypt('tok')]);
    await pool.query("UPDATE users SET active_account = github_username WHERE telegram_id IN (21,22,23)").catch(() => {});
    const prefs = t.req('lib/userPrefs');
    await prefs.set(21, 'digest_daily', true); await prefs.set(22, 'digest_daily', true); // 23 left off
    await pool.query("UPDATE users SET quiet_hours_start = 6, quiet_hours_end = 10 WHERE telegram_id = 22");
    const sentTo = []; const bot = { telegram: { sendMessage: async (id, text) => { sentTo.push({ id, text }); } } };
    const store = new Map(); const redis = { get: async (k) => store.get(k) || null, set: async (k, v) => { store.set(k, v); } };
    const dig = t.req('lib/needsDigest');
    const at8 = new Date('2026-10-18T08:10:00Z');
    assert.equal(await dig.runOnce(bot, { now: new Date('2026-10-18T13:00:00Z'), redis }), 0, 'wrong hour → nothing');
    assert.equal(await dig.runOnce(bot, { now: at8, redis }), 1, 'alice only (bob is in quiet hours, carl switched it off)');
    assert.equal(sentTo[0].id, 21);
    assert.ok(/2 pull requests need you/.test(sentTo[0].text) && /1 issue assigned/.test(sentTo[0].text), sentTo[0].text);
    assert.equal(await dig.runOnce(bot, { now: at8, redis }), 0, 'once per day');
    assert.equal(dig.compose({ total: 0 }), '');
  } finally { A.drop(); }
}, { pg: true });

test('alert links: PR/issue/run events carry a link; a button opens the in-bot screen for the current owner, a GitHub link otherwise', async () => {
  const ev = t.req('lib/webhookEvents'); const digest = t.req('lib/webhookDigest'); const links = t.req('lib/alertLinks');
  const repo = { owner: { login: 'Alice' } };
  const pr = ev.describe('pull_request', { action: 'opened', repository: repo, pull_request: { title: 'T', number: 12, html_url: 'https://github.com/Alice/app/pull/12' } });
  assert.deepEqual(pr.link, { type: 'pr', owner: 'Alice', number: 12, url: 'https://github.com/Alice/app/pull/12' });
  const run = ev.describe('workflow_run', { action: 'completed', repository: repo, workflow_run: { id: 77, name: 'CI', conclusion: 'failure', html_url: 'https://github.com/Alice/app/actions/runs/77' } });
  assert.equal(run.link.runId, 77);
  assert.equal(ev.describe('star', { action: 'created', sender: { login: 'x' } }).link, undefined);
  // hostile or malformed links are dropped, a real one is kept
  assert.equal(digest.cleanLink({ type: 'pr', number: 'x' }), null);
  assert.equal(digest.cleanLink({ type: 'pr', number: 3, url: 'http://evil.example/x' }).url, undefined);
  assert.equal(digest.cleanLink({ type: 'zzz', number: 3 }), null);
  // keyboard: owner matches the person's active owner → in-bot; otherwise a URL button
  const { pool } = t.req('db/postgres');
  const own = t.req('lib/ownerScope');
  own.forget && own.forget(5);
  t.setQueryHandler(async (sql) => (/active_owner|github_accounts|users/i.test(sql) ? { rows: [{ active_owner: null, github_login: 'alice', github_username: 'alice', login: 'alice' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
  const mine = await links.keyboard(5, 'app', [{ summary: 'x', link: pr.link }, { summary: 'y', link: run.link }]);
  const flat = mine ? mine.reply_markup.inline_keyboard.flat() : [];
  assert.ok(flat.length === 2, JSON.stringify(flat));
  assert.ok(flat.every((b) => b.callback_data || b.url));
  assert.equal(links.pick([{ link: { type: 'pr', number: 1 } }, { link: { type: 'pr', number: 2 } }]).length, 1, 'newest of each kind only');
  void pool;
});


// ── First connect: new people get every permission at once, existing people keep on-demand ──────────────────
test('every new connection (first, after Disconnect, another account) asks for all scopes; only the on-demand extra button stays minimal', async () => {
  const oauth = t.req('lib/oauth');
  const scopeOf = (url) => new URL(url).searchParams.get('scope').split(',').sort();
  const BASE = ['delete_repo', 'repo'];
  const ALL = ['delete_repo', 'gist', 'notifications', 'project', 'read:org', 'repo'];
  t.setQueryHandler(async (sql) => (/FROM users/i.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }));
  assert.deepEqual(scopeOf(await oauth.connectUrl(900)), ALL, 'no user row → everything');
  t.setQueryHandler(async (sql) => (/FROM users/i.test(sql) ? { rows: [{ telegram_id: 901, connected_at: null }], rowCount: 1 } : { rows: [], rowCount: 0 }));
  assert.deepEqual(scopeOf(await oauth.connectUrl(901)), ALL, 'a row that never connected is still new');
  t.setQueryHandler(async (sql) => (/FROM users/i.test(sql) ? { rows: [{ telegram_id: 902, connected_at: new Date(), disconnected_at: new Date() }], rowCount: 1 } : { rows: [], rowCount: 0 }));
  assert.deepEqual(scopeOf(await oauth.connectUrl(902)), ALL, 'disconnected and connecting again → everything again');
  assert.deepEqual(scopeOf(oauth.buildAuthorizeUrl(903)), BASE, 'plain URL builder unchanged');
  process.env.FIRST_CONNECT_ALL_SCOPES = 'off';
  try {
    t.setQueryHandler(async () => ({ rows: [], rowCount: 0 }));
    assert.deepEqual(scopeOf(await oauth.connectUrl(904)), BASE, 'switch off → base for everyone');
  } finally { delete process.env.FIRST_CONNECT_ALL_SCOPES; }
});


// ── Warden Watch: scoring, flags, notifications, owner approval, pauses, tiers ─────────────────────────────
test('warden watch scoring: weights, burst bonus, new-account bonus, flag threshold; pure functions', () => {
  const w = t.req('lib/sensitiveActions');
  assert.equal(w.score({ action: 'revert' }), 8);
  assert.equal(w.score({ action: 'transfer' }), 40);
  assert.equal(w.score({ action: 'collab_add', recent: 4 }), 15 + 30, 'each extra action in 10 min adds 10');
  assert.equal(w.score({ action: 'transfer', recent: 20, newAccount: true }), 95, 'burst bonus capped at +40, plus 15 for a new account');
  assert.equal(w.score({ action: 'revert', newAccount: true }), 23);
  assert.equal(w.score({ action: 'something_new' }), 5);
  assert.ok(w.shouldFlag({ total: 40, recent: 0 }) && !w.shouldFlag({ total: 39, recent: 0 }));
  assert.ok(w.shouldFlag({ total: 8, recent: 4 }), 'the 5th action in a window flags (default burst 5)');
});

test('warden watch on real Postgres: notes are stored, flags tell admins once, approvals hold only ordinary people, pauses are per person', async () => {
  const A = realPg.createDb('v125_w');
  try {
    const { pool } = t.req('db/postgres');
    t.setQueryHandler(A.handler);
    const gc = t.req('lib/globalConfig');
    const w = t.req('lib/sensitiveActions');
    const config = t.req('config');
    t.redisStore.clear();
    await pool.query("INSERT INTO users (telegram_id, github_username, connected_at) VALUES (31,'dan', now() - interval '3 days'), (32,'eve', now())");
    await pool.query("INSERT INTO admin_roles (telegram_id, role) VALUES (77,'admin') ON CONFLICT DO NOTHING").catch(() => {});
    const sent = [];
    const mk = (id, extra = {}) => ({ from: { id, username: `u${id}` }, state: { isAdmin: false }, telegram: { sendMessage: async (to, text, opts) => { sent.push({ to, text, opts }); } }, ...extra });
    const dan = mk(31);
    let r = await w.note(dan, { action: 'revert', repo: 'app' });
    assert.deepEqual({ score: r.score, flagged: r.flagged }, { score: 8, flagged: false });
    assert.equal(sent.length, 0);
    r = await w.note(dan, { action: 'transfer', repo: 'app', detail: 'to mallory' });
    assert.ok(r.flagged && r.score >= 40);
    assert.equal(sent.length, 0, 'admins are told only when that switch is on');
    gc.set(1, 'sens_notify_admins', 'on').catch(() => {});
    await gc.set(1, 'sens_notify_admins', 'on');
    await w.note(dan, { action: 'transfer', repo: 'app2' });
    const toAdmins = sent.filter((m) => /Warden Watch/.test(m.text));
    assert.ok(toAdmins.length >= 1 && toAdmins.every((m) => m.to !== 31), 'never tells the actor');
    assert.ok(/dan|u31/.test(toAdmins[0].text) || /@u31/.test(toAdmins[0].text));
    const before = sent.length;
    await w.note(dan, { action: 'transfer', repo: 'app3' });
    assert.equal(sent.length, before, 'one notification per person per 10 minutes');
    // the burst: five quick actions flag even small ones
    const eve = mk(32);
    let last; for (let i = 0; i < 5; i++) last = await w.note(eve, { action: 'revert', repo: 'x' });
    assert.ok(last.flagged, 'burst flagged');
    // counts + tiers read the same data
    const c = await w.counts();
    assert.ok(c.flagged_open >= 3 && c.actions_24h >= 8);
    // owner approval
    const hold = mk(31);
    assert.deepEqual(await w.gate(hold, { action: 'transfer', repo: 'app' }), { ok: true }, 'hold is off by default');
    await gc.set(1, 'sens_hold', 'on');
    assert.deepEqual(await w.gate(mk(31, { state: { isAdmin: true } }), { action: 'transfer', repo: 'app' }), { ok: true }, 'admins are never held');
    assert.deepEqual(await w.gate(hold, { action: 'revert', repo: 'app' }), { ok: true }, 'only the risky kinds are held');
    const held = await w.gate(hold, { action: 'transfer', repo: 'app' });
    assert.equal(held.ok, false);
    const ownerMsg = sent.filter((m) => m.to === config.OWNER_ID && /approval needed/.test(m.text)).pop();
    assert.ok(ownerMsg, 'the owner is asked');
    const reqId = Number(ownerMsg.opts.reply_markup.inline_keyboard[0][0].callback_data.split(':')[3]);
    const again = await w.gate(hold, { action: 'transfer', repo: 'app' });
    assert.equal(again.ok, false);
    assert.equal(sent.filter((m) => m.to === config.OWNER_ID && /approval needed/.test(m.text)).length, 1, 'no second request while one is pending');
    const decided = await w.decide(mk(config.OWNER_ID), reqId, true);
    assert.ok(decided.ok);
    assert.deepEqual(await w.gate(hold, { action: 'transfer', repo: 'app' }), { ok: true }, 'allowed once');
    assert.equal((await w.gate(hold, { action: 'transfer', repo: 'app' })).ok, false, 'one-time only');
    assert.equal((await w.decide(mk(config.OWNER_ID), reqId, false)).ok, false, 'already decided');
    // pauses
    assert.equal(await w.isPaused(31, 'access'), false);
    await w.pause(77, 31, 'access', 'testing');
    assert.equal(await w.isPaused(31, 'access'), true);
    assert.equal(await w.isPaused(32, 'access'), false, 'other people unaffected');
    await w.unpause(77, 31, 'access');
    assert.equal(await w.isPaused(31, 'access'), false);
    // manage audit
    await w.audit(31, 'access', 'rmok', 'app');
    await w.audit(31, 'access', 'collabs', 'app');
    await w.audit(31, 'access', 'home', 'app');
    const trail = await w.auditTrail({ onlyChanges: true });
    assert.equal(trail.items.length, 1);
    assert.equal((await w.auditTrail({ onlyChanges: false })).items.length, 2, 'home taps are not logged');
    const ua = await w.userActivity(31);
    assert.ok(ua.sensitive.length >= 3 && ua.changes.length === 1);
  } finally { A.drop(); }
}, { pg: true });

test('monitoring tiers: moderators see counts only; admins get flagged + activity; audit & rules need super admin; owner-only approval', async () => {
  const mon = t.req('handlers/monitoring');
  const roles = t.req('lib/roles');
  const config = t.req('config');
  const asRole = async (id, role) => {
    t.setQueryHandler(async (sql) => {
      if (/FROM admin_roles/i.test(sql)) return { rows: [{ role }], rowCount: 1 };
      if (/AS actions_24h/i.test(sql)) return { rows: [{ actions_24h: 3, flagged_open: 2, approvals_pending: 1, pauses: 0, manage_24h: 9, dead_accounts: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    return mon.tier({ from: { id } });
  };
  const mod = await asRole(5, 'moderator');
  assert.deepEqual({ admin: mod.admin, superAdmin: mod.superAdmin, owner: mod.owner }, { admin: false, superAdmin: false, owner: false });
  const adm = await asRole(6, 'admin');
  assert.deepEqual({ admin: adm.admin, superAdmin: adm.superAdmin }, { admin: true, superAdmin: false });
  const sup = await asRole(7, 'super_admin');
  assert.ok(sup.superAdmin && !sup.owner);
  assert.ok((await asRole(config.OWNER_ID, 'super_admin')).owner);
  assert.ok(roles.atLeast('admin', 'moderator'));
  // what each tier is shown on the hub
  const shownFor = async (tierObj) => {
    const sent = [];
    await mon.hub({ callbackQuery: null, reply: async (text, extra) => { sent.push({ text, extra }); } }, tierObj);
    const buttons = sent[0].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    return { text: sent[0].text, buttons };
  };
  const m = await shownFor(mod); const a = await shownFor(adm); const s = await shownFor(sup);
  assert.ok(!m.buttons.some((d) => /flag|audit|rules/.test(d)), 'moderator: counts only');
  assert.ok(/Counts only/.test(m.text));
  assert.ok(a.buttons.some((d) => /admin:mon:flag/.test(d)) && !a.buttons.some((d) => /audit|rules/.test(d)));
  assert.ok(s.buttons.some((d) => /audit/.test(d)) && s.buttons.some((d) => /rules/.test(d)));
});

// ── Web pages: status tiles, templates, signed scopes ───────────────────────────────────────────────────────
test('status tiles: healthy / degraded / down mapping, nothing sensitive', () => {
  const st = t.req('server/statusTiles');
  const ok = st.build({ status: 'HEALTHY', pgStatus: { ok: true }, redisStatus: { ok: true }, traffic: { queued: 0, active: 0, breaker: { state: 'closed' } } }, { version: '1.2.5-multi', uptimeSeconds: 93784 });
  assert.strictEqual(ok.overall, 'ok');
  assert.strictEqual(ok.tiles.length, 6);
  assert.ok(ok.tiles.every((x) => x.id && x.label && x.value && x.state));
  assert.strictEqual(ok.tiles.find((x) => x.id === 'uptime').value, '1d 2h');
  const down = st.build({ status: 'UNAVAILABLE', pgStatus: { ok: false }, redisStatus: { ok: true }, traffic: { queued: 0, active: 0, breaker: { state: 'open' } } });
  assert.strictEqual(down.overall, 'down');
  assert.strictEqual(down.tiles.find((x) => x.id === 'db').state, 'bad');
  assert.strictEqual(down.tiles.find((x) => x.id === 'github').state, 'bad');
  const busy = st.build({ status: 'DEGRADED', pgStatus: { ok: true }, redisStatus: { ok: true }, traffic: { queued: 80, active: 4, breaker: { state: 'closed' } } });
  assert.strictEqual(busy.overall, 'degraded');
  assert.strictEqual(busy.tiles.find((x) => x.id === 'queue').state, 'warn');
  assert.strictEqual(st.build(null).overall, 'down');
  assert.ok(!/token|secret|password|@|postgres:\/\//i.test(JSON.stringify(ok)), 'no sensitive data in the tiles');
  assert.strictEqual(st.formatUptime(59), '0m'); assert.strictEqual(st.formatUptime(3700), '1h 1m');
});

test('web templates: status page works without JS; result page keeps the ids its script needs', () => {
  const fs = require('fs'); const path = require('path');
  const status = fs.readFileSync(path.join(__dirname, '..', 'public', 'status.html'), 'utf8');
  for (const marker of ['<!--STATUS_INJECT-->', '<!--STATUS_TILES-->', '{{OVERALL}}', '{{LABEL}}', '{{VERSION}}', '{{CHECKED}}']) assert.ok(status.includes(marker), marker);
  assert.ok(/<noscript>\s*<meta http-equiv="refresh"/.test(status), 'no-JS visitors still get a refreshing page');
  assert.ok(/prefers-color-scheme: light/.test(status) && /min-width: 900px/.test(status));
  const cb = fs.readFileSync(path.join(__dirname, '..', 'public', 'callback.html'), 'utf8');
  for (const id of ['card', 'terminal', 'resultBox', 'resultTitle', 'resultDetail', 'openTelegramBtn', 'progressFill', 'logoRing', 'redirectLabel', 'subtitle', 'resultIconBadge']) assert.ok(cb.includes(`id="${id}"`), id);
  assert.ok(/min-width:900px/.test(cb) && /Return to Telegram/.test(cb));
  assert.ok(!/overflow:\s*hidden;[^}]*height:\s*\d+px/.test(cb), 'no fixed-height clipped card');
});

test('oauth state carries the requested scopes for the confirm page', () => {
  const oauth = t.req('lib/oauth');
  const url = new URL(oauth.buildAuthorizeUrl(77, { extraScopes: ['gist'] }));
  const state = url.searchParams.get('state');
  const info = oauth.inspectState(state);
  assert.strictEqual(Number(info.telegramId), 77);
  assert.ok(Array.isArray(info.scopes) && info.scopes.includes('repo') && info.scopes.includes('gist'), JSON.stringify(info.scopes));
});

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0; let skipped = 0;
  for (const { name, fn, pg } of tests) {
    if (pg && !HAVE_PG) { skipped++; console.log(`  - ${name} (skipped: no local PostgreSQL)`); continue; }
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) {
      console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length - skipped} passed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(passed === tests.length - skipped ? 0 : 1);
})();
