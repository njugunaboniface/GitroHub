#!/usr/bin/env node
/**
 * github-e2e-tests.js (v1.2.1-multi) — drives the REAL src/lib/github.js
 * through the REAL traffic manager against a scriptable fake GitHub
 * (scripts/lib/fakeGithub.js). Proves the integration, not just the parts:
 * every operation goes through the manager, retries are safe, and uncertain
 * writes are reconciled by reading GitHub back instead of guessing.
 */
Object.assign(process.env, {
  GITHUB_REQUEST_TIMEOUT_MS: '1000', GITHUB_RETRY_BASE_DELAY_MS: '50', GITHUB_RETRY_JITTER_MS: '0',
  GITHUB_MUTATION_MIN_INTERVAL_MS: '0', GITHUB_SECONDARY_DEFAULT_WAIT_MS: '1000', GITHUB_QUEUE_TIMEOUT_MS: '3000',
});
const assert = require('assert');
const Module = require('module');
const path = require('path');
const { FakeGitHub, makeOctokit, requestError, networkError, secondaryLimit } = require('./lib/fakeGithub');

const gh = new FakeGitHub();
const real = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@octokit/rest') return { Octokit: makeOctokit(gh) };
  if (request === 'pino') { const f = () => ({ info() {}, warn() {}, error() {} }); f.stdTimeFunctions = { isoTime() {} }; return f; }
  return real.call(this, request, parent, isMain);
};
const github = require(path.join('..', 'src/lib/github'));
const { gitBlobSha } = require('../src/lib/gitHash');
const { getTraffic } = require('../src/lib/githubTraffic');
const requestContext = require('../src/lib/requestContext');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let tokenSeq = 0;
const fresh = () => { gh.clear(); gh.latencyMs = 0; return `tok-${++tokenSeq}`; };
const D = (headers = {}) => ({ headers: { 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000), ...headers } });

test('reads go through the manager: pagination, rate-limit capture, per-token concurrency bound', async () => {
  const t = fresh();
  gh.on('GET /user/repos', async (o) => ({ ...D(), data: o.params.page === 1 ? Array.from({ length: 100 }, (_, i) => ({ name: `r${i}` })) : [{ name: 'last' }] }));
  const repos = await github.listRepos(t);
  assert.strictEqual(repos.length, 101);
  assert.strictEqual(gh.calls.length, 2);
  assert.strictEqual(github.getLastKnownRateLimit(t).remaining, 4000);
  const before = getTraffic().manager.getSnapshot().totals.requests;
  gh.latencyMs = 15;
  gh.on('GET /repos/{owner}/{repo}/languages', async () => ({ ...D(), data: { JS: 1 } }));
  await Promise.all(Array.from({ length: 40 }, (_, i) => github.getLanguages(t, 'o', `r${i}`)));
  assert.ok(gh.byToken.get(t).peak <= getTraffic().config.perIdentityConcurrency, `peak ${gh.byToken.get(t).peak}`);
  assert.ok(getTraffic().manager.getSnapshot().totals.requests >= before + 40);
});

test('a secondary limit on a read is paused and retried transparently (the user just gets the result)', async () => {
  const t = fresh();
  gh.on('GET /user', async () => { throw secondaryLimit('1'); }, { times: 1 });
  gh.on('GET /user', async () => ({ ...D(), data: { login: 'octo' } }));
  const t0 = Date.now();
  assert.strictEqual((await github.getAuthenticatedUser(t)).login, 'octo');
  assert.ok(Date.now() - t0 >= 950, 'waited Retry-After');
  assert.strictEqual(gh.calls.length, 2);
});

test('putFile: 502 on the write → verified by reading the file back → reported as the success it was', async () => {
  const t = fresh();
  const content = 'hello world\n';
  gh.on('PUT /repos/{owner}/{repo}/contents/{path}', async () => { throw requestError(502, 'Bad Gateway'); });
  gh.on('GET /repos/{owner}/{repo}/contents/{path}', async () => ({ ...D(), data: { sha: gitBlobSha(content), content: Buffer.from(content).toString('base64'), encoding: 'base64', size: content.length } }));
  const res = await github.putFile(t, 'o', 'r', 'a.txt', content, 'msg');
  assert.strictEqual(res.content.sha, gitBlobSha(content));
  assert.strictEqual(gh.calls.filter((c) => c.method === 'PUT').length, 1, 'the write itself was NOT retried');
});

test('putFile: 502 and the file is unchanged → confirmed FAILURE (not unknown)', async () => {
  const t = fresh();
  gh.on('PUT /repos/{owner}/{repo}/contents/{path}', async () => { throw requestError(502, 'Bad Gateway'); });
  gh.on('GET /repos/{owner}/{repo}/contents/{path}', async () => ({ ...D(), data: { sha: 'oldsha', content: '', encoding: 'base64', size: 0 } }));
  const err = await github.putFile(t, 'o', 'r', 'a.txt', 'new', 'msg', 'oldsha').catch((e) => e);
  assert.strictEqual(err.outcome, 'failed');
  assert.ok(!github.isUnknownOutcome(err));
});

test('putFile: write fails AND GitHub can’t be read back → stays UNKNOWN, with an honest message, never a fake success', async () => {
  const t = fresh();
  gh.on('PUT /repos/{owner}/{repo}/contents/{path}', async () => { throw networkError('socket hang up', 'ECONNRESET'); });
  gh.on('GET /repos/{owner}/{repo}/contents/{path}', async () => { throw requestError(503, 'down'); });
  const err = await github.putFile(t, 'o', 'r', 'a.txt', 'x', 'msg', 'sha1').catch((e) => e);
  assert.ok(github.isUnknownOutcome(err), JSON.stringify({ o: err.outcome, c: err.code, m: err.message }));
  assert.strictEqual(err.code, 'GITHUB_OUTCOME_UNKNOWN');
});

test('deleteRepo: timeout → read back: 404 means it really was deleted', async () => {
  const t = fresh();
  gh.on('DELETE /repos/{owner}/{repo}', async () => { throw requestError(504, 'Gateway Timeout'); });
  gh.on('GET /repos/{owner}/{repo}', async () => { throw requestError(404, 'Not Found'); });
  await github.deleteRepo(t, 'o', 'gone'); // resolves: confirmed by reading back
  assert.strictEqual(gh.calls.filter((c) => c.method === 'DELETE').length, 1, 'a destructive call is never repeated');
});

test('deleteRepo: repo still exists after an uncertain delete → reported as failed, not success', async () => {
  const t = fresh();
  gh.on('DELETE /repos/{owner}/{repo}', async () => { throw requestError(502, 'Bad Gateway'); });
  gh.on('GET /repos/{owner}/{repo}', async () => ({ ...D(), data: { name: 'still-here' } }));
  const err = await github.deleteRepo(t, 'o', 'still-here').catch((e) => e);
  assert.ok(err instanceof Error); assert.strictEqual(err.outcome, 'failed');
});

test('setVisibility: dropped connection, but the repo already has the new visibility → success', async () => {
  const t = fresh();
  gh.on('PATCH /repos/{owner}/{repo}', async () => { throw networkError('reset', 'ECONNRESET'); });
  gh.on('GET /repos/{owner}/{repo}', async () => ({ ...D(), data: { name: 'r', private: true } }));
  assert.strictEqual((await github.setVisibility(t, 'o', 'r', true)).private, true);
});

test('createRepo: uncertain create → found a brand-new repo of that name → returned; pre-existing repo is NOT claimed', async () => {
  const t = fresh();
  gh.on('POST /user/repos', async () => { throw requestError(502, 'Bad Gateway'); });
  gh.on('GET /user', async () => ({ ...D(), data: { login: 'me' } }));
  gh.on('GET /repos/{owner}/{repo}', async () => ({ ...D(), data: { name: 'x', created_at: new Date().toISOString() } }));
  assert.strictEqual((await github.createRepo(t, { name: 'x', isPrivate: true })).name, 'x');
  const t2 = fresh();
  gh.on('POST /user/repos', async () => { throw requestError(502, 'Bad Gateway'); });
  gh.on('GET /user', async () => ({ ...D(), data: { login: 'me' } }));
  gh.on('GET /repos/{owner}/{repo}', async () => ({ ...D(), data: { name: 'x', created_at: '2019-01-01T00:00:00Z' } }));
  const err = await github.createRepo(t2, { name: 'x', isPrivate: true }).catch((e) => e);
  assert.strictEqual(err.outcome, 'failed', 'an old repo with that name is not our success');
});

const commitHandlers = (over = {}) => {
  gh.on('GET /repos/{owner}/{repo}', async () => ({ ...D(), data: { default_branch: 'main' } }));
  gh.on('GET /repos/{owner}/{repo}/git/ref/{ref}', async () => ({ ...D(), data: { object: { sha: 'base' } } }), { times: 1 });
  gh.on('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', async () => ({ ...D(), data: { tree: { sha: 'basetree' } } }));
  gh.on('POST /repos/{owner}/{repo}/git/blobs', over.blob || (async () => ({ ...D(), data: { sha: 'blobsha' } })));
  gh.on('POST /repos/{owner}/{repo}/git/trees', over.tree || (async () => ({ ...D(), data: { sha: 'newtree' } })));
  gh.on('POST /repos/{owner}/{repo}/git/commits', over.commit || (async () => ({ ...D(), data: { sha: 'newcommit' } })));
  gh.on('PATCH /repos/{owner}/{repo}/git/refs/{ref}', over.ref || (async () => ({ ...D(), data: {} })));
};
const files = [{ path: 'a.txt', content: 'a' }, { path: 'b.txt', content: 'b' }];

test('commitMultipleFiles: the happy path commits once, blobs run concurrently', async () => {
  const t = fresh(); gh.latencyMs = 10; commitHandlers();
  const c = await github.commitMultipleFiles(t, 'o', 'r', files, 'msg');
  assert.strictEqual(c.sha, 'newcommit');
});

test('commitMultipleFiles: a secondary limit on a blob is paused + retried by the manager and the commit still lands', async () => {
  const t = fresh(); let n = 0;
  commitHandlers({ blob: async () => { if (++n === 1) throw secondaryLimit('1'); return { ...D(), data: { sha: 'blobsha' } }; } });
  // v2.3.3: text files ride inside the tree request now; binaries (a NUL byte) still need a blob each.
  const binaries = [{ path: 'a.bin', content: Buffer.from([0, 1, 2]) }, { path: 'b.bin', content: Buffer.from([0, 3, 4]) }];
  assert.strictEqual((await github.commitMultipleFiles(t, 'o', 'r', binaries, 'msg')).sha, 'newcommit');
  assert.ok(n >= 3, `blob calls ${n}`);
});

// ── v2.3.3: inline text, paced blobs, progress, pause/resume, cancel ───────────────────────────────────────────────────
const textFiles = (n) => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.js`, content: Buffer.from(`// file ${i}\n`) }));
const treeCalls = () => gh.calls.filter((c) => c.method === 'POST' && /\/git\/trees$/.test(c.url || c.path || ''));
const callsTo = (re) => gh.calls.filter((c) => re.test(`${c.method} ${c.url || c.path || ''}`));

test('v2.3.3 commit: text files travel inside tree requests — 250 files need ZERO blob requests, and trees are chunked', async () => {
  const t = fresh(); const seen = [];
  commitHandlers({ tree: async (o) => { seen.push(o.params.tree); return { ...D(), data: { sha: `tree${seen.length}` } }; } });
  const c = await github.commitMultipleFiles(t, 'o', 'r', textFiles(250), 'msg');
  assert.strictEqual(c.sha, 'newcommit');
  assert.strictEqual(callsTo(/POST .*\/git\/blobs/).length, 0, 'no blob requests for text');
  assert.strictEqual(seen.length, 3, '250 entries → 3 chunks of ≤100');
  assert.ok(seen.every((tree) => tree.length <= 100));
  assert.ok(seen.flat().every((e) => typeof e.content === 'string' && e.sha === undefined), 'entries carry content, not shas');
  assert.strictEqual(seen.flat().length, 250);
});

test('v2.3.3 commit: binaries and empty files still get a blob; text beside them stays inline; deletions land in the tree', async () => {
  const t = fresh(); const seen = [];
  commitHandlers({ tree: async (o) => { seen.push(o.params.tree); return { ...D(), data: { sha: `tree${seen.length}` } }; } });
  const mixed = [{ path: 'a.png', content: Buffer.from([0x89, 0, 1]) }, { path: 'empty.txt', content: Buffer.alloc(0) }, { path: 'b.js', content: 'x', mode: '100755' }, { path: 'bad.txt', content: Buffer.from([0xff, 0xfe, 0x41]) }];
  await github.commitMultipleFiles(t, 'o', 'r', mixed, 'msg', ['old.txt']);
  assert.strictEqual(callsTo(/POST .*\/git\/blobs/).length, 3, 'png + empty + invalid-UTF-8 file');
  const entries = seen.flat();
  assert.strictEqual(entries.find((e) => e.path === 'b.js').content, 'x');
  assert.strictEqual(entries.find((e) => e.path === 'b.js').mode, '100755', 'executable bit kept');
  assert.strictEqual(entries.find((e) => e.path === 'old.txt').sha, null, 'deletion');
});

test('v2.3.3 commit: progress is reported (committing n/total, finalizing) and ends complete', async () => {
  const t = fresh(); commitHandlers();
  const events = [];
  await github.commitMultipleFiles(t, 'o', 'r', textFiles(150), 'msg', [], { onProgress: (e) => events.push(e) });
  const committing = events.filter((e) => e.stage === 'committing');
  assert.ok(committing.length >= 2);
  assert.strictEqual(committing[committing.length - 1].done, 150);
  assert.ok(committing.every((e) => e.total === 150));
  assert.strictEqual(events[events.length - 1].stage, 'finalizing');
  assert.ok(events.every((e, i) => i === 0 || e.done >= events[i - 1].done), 'never goes backwards');
});

test('v2.3.3 commit: GitHub says slow down and will not wait → the commit pauses (reported), resumes, and still lands — files are not re-sent', async () => {
  const t = fresh(); let n = 0;
  commitHandlers({ tree: async () => { if (++n <= 8) throw secondaryLimit('1'); return { ...D(), data: { sha: 'newtree' } }; } });
  const events = [];
  const c = await github.commitMultipleFiles(t, 'o', 'r', textFiles(5), 'msg', [], { onProgress: (e) => events.push(e) });
  assert.strictEqual(c.sha, 'newcommit');
  assert.ok(events.some((e) => e.stage === 'paused' && e.pauseSecs >= 1), 'a paused state was reported');
  assert.ok(events.some((e) => e.stage === 'resumed'), 'and a resumed one');
  assert.strictEqual(callsTo(/PATCH .*\/git\/refs/).length, 1, 'the branch moved exactly once');
});

test('v2.3.3 commit: parallel blob workers hitting the same limit share ONE pause (they do not each use up the pause budget)', async () => {
  const t = fresh(); let n = 0;
  commitHandlers({ blob: async () => { if (++n <= 12) throw secondaryLimit('1'); return { ...D(), data: { sha: 'blobsha' } }; } });
  const bins = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.bin`, content: Buffer.from([0, i]) }));
  const events = [];
  assert.strictEqual((await github.commitMultipleFiles(t, 'o', 'r', bins, 'msg', [], { onProgress: (e) => events.push(e) })).sha, 'newcommit');
  assert.ok(events.some((e) => e.stage === 'paused'), 'the pause was reported');
  assert.ok(events[events.length - 1].stage === 'finalizing', 'and it still finished — 12 limited blob calls across 4 workers did not exhaust the pause budget');
});

test('v2.3.3 commit: cancel before the branch moves → UPLOAD_CANCELLED, nothing changed', async () => {
  const t = fresh(); let cancel = false;
  commitHandlers({ tree: async () => { cancel = true; return { ...D(), data: { sha: 'newtree' } }; } });
  const err = await github.commitMultipleFiles(t, 'o', 'r', textFiles(3), 'msg', [], { shouldCancel: () => cancel }).catch((e) => e);
  assert.strictEqual(err.code, 'UPLOAD_CANCELLED');
  assert.strictEqual(callsTo(/PATCH .*\/git\/refs/).length, 0, 'the branch was never touched');
  assert.strictEqual(callsTo(/POST .*\/git\/commits/).length, 0, 'no commit was even created');
});

test('commitMultipleFiles: failure BEFORE the ref moves is a clean failure — nothing could have changed', async () => {
  const t = fresh();
  commitHandlers({ commit: async () => { throw requestError(502, 'Bad Gateway'); } });
  const err = await github.commitMultipleFiles(t, 'o', 'r', files, 'msg').catch((e) => e);
  assert.strictEqual(err.outcome, 'failed'); assert.ok(!github.isUnknownOutcome(err));
  assert.strictEqual(gh.calls.filter((c) => c.method === 'PATCH').length, 0, 'the branch was never touched');
});

test('commitMultipleFiles: ref update fails ambiguously but the branch now points at OUR commit → success', async () => {
  const t = fresh();
  commitHandlers({ ref: async () => { throw requestError(502, 'Bad Gateway'); } });
  gh.on('GET /repos/{owner}/{repo}/git/ref/{ref}', async () => ({ ...D(), data: { object: { sha: 'newcommit' } } }));
  assert.strictEqual((await github.commitMultipleFiles(t, 'o', 'r', files, 'msg')).sha, 'newcommit');
});

test('commitMultipleFiles: ref update fails ambiguously and the branch is still at the old tip → confirmed failure', async () => {
  const t = fresh();
  commitHandlers({ ref: async () => { throw requestError(502, 'Bad Gateway'); } });
  gh.on('GET /repos/{owner}/{repo}/git/ref/{ref}', async () => ({ ...D(), data: { object: { sha: 'base' } } }));
  const err = await github.commitMultipleFiles(t, 'o', 'r', files, 'msg').catch((e) => e);
  assert.strictEqual(err.outcome, 'failed');
});

test('commitMultipleFiles: a stale-branch conflict keeps its specific, safe message and is never retried or forced', async () => {
  const t = fresh();
  commitHandlers({ ref: async () => { throw requestError(422, 'Update is not a fast forward'); } });
  const err = await github.commitMultipleFiles(t, 'o', 'r', files, 'msg').catch((e) => e);
  assert.strictEqual(err.code, 'GIT_REF_CONFLICT');
  assert.strictEqual(gh.calls.filter((c) => c.method === 'PATCH').length, 1);
});

// ── v1.2.4-multi: the feature modules (src/lib/github/*) through the REAL traffic manager ──────────────────────
const pullsApi = require('../src/lib/github/pulls');
const branchesApi = require('../src/lib/github/branches');
const commitsApi = require('../src/lib/github/commits');
const releasesApi = require('../src/lib/github/releases');
const actionsApi = require('../src/lib/github/actions');
const accessApi = require('../src/lib/github/access');

test('feature modules: route-string requests are counted, paced and authenticated by the manager like any other call', async () => {
  const t = fresh();
  gh.on('GET /repos/{owner}/{repo}/pulls', async () => ({ ...D(), data: [{ number: 1, title: 'x', state: 'open', user: { login: 'a' }, head: { ref: 'h' }, base: { ref: 'b' } }] }));
  const before = getTraffic().manager.getSnapshot().totals.requests;
  const r = await pullsApi.listPulls(t, 'o', 'r');
  assert.strictEqual(r.items[0].number, 1);
  assert.strictEqual(gh.calls[0].token, t);
  assert.strictEqual(gh.calls[0].url, '/repos/{owner}/{repo}/pulls');
  assert.ok(getTraffic().manager.getSnapshot().totals.requests >= before + 1);
});

test('mergePull: 502 on the merge, but the PR is now merged → reported as the success it was', async () => {
  const t = fresh();
  gh.on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', async () => { throw requestError(502, 'Bad Gateway'); });
  gh.on('GET /repos/{owner}/{repo}/pulls/{pull_number}', async () => ({ ...D(), data: { number: 4, merged: true, state: 'closed' } }));
  const res = await pullsApi.mergePull(t, 'o', 'r', 4, 'squash');
  assert.ok(res && res.merged === true);
});

test('mergePull: 405 "not mergeable" is a clean failure with GitHub’s message, never retried', async () => {
  const t = fresh();
  gh.on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', async () => { throw requestError(405, 'Pull Request is not mergeable'); });
  const err = await pullsApi.mergePull(t, 'o', 'r', 4).catch((e) => e);
  assert.strictEqual(err.status, 405);
  assert.strictEqual(gh.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('createBranch: network drop, but the branch now exists at the sha we asked for → success', async () => {
  const t = fresh();
  gh.on('POST /repos/{owner}/{repo}/git/refs', async () => { throw networkError('socket hang up', 'ECONNRESET'); });
  gh.on('GET /repos/{owner}/{repo}/git/ref/{ref}', async () => ({ ...D(), data: { object: { sha: 'abc123' } } }));
  const res = await branchesApi.createBranch(t, 'o', 'r', 'feature/x', 'abc123');
  assert.ok(res);
});

test('createBranch: refuses unsafe names before any request (no path tricks into other refs)', async () => {
  const t = fresh();
  for (const bad of ['', '..', 'a..b', '/x', 'x/', 'x.lock', 'a b', '-rf', 'x//y', 'refs/../heads', 'a~b', 'a:b']) {
    const err = await branchesApi.createBranch(t, 'o', 'r', bad, 'abc').catch((e) => e);
    assert.strictEqual(err.code, 'BAD_REF', `"${bad}" should be refused`);
  }
  assert.strictEqual(gh.calls.length, 0);
});

test('deleteBranch: an already-deleted branch is success, not an error', async () => {
  const t = fresh();
  gh.on('DELETE /repos/{owner}/{repo}/git/refs/{ref}', async () => { throw requestError(422, 'Reference does not exist'); });
  assert.strictEqual(await branchesApi.deleteBranch(t, 'o', 'r', 'gone'), null);
});

test('revertCommit: moves the branch with force:false, only after every changed file was verified untouched', async () => {
  const t = fresh();
  const c = { sha: 'c0ffee1', commit: { message: 'Fix' }, parents: [{ sha: 'p1' }], stats: {}, files: [{ filename: 'a.txt', status: 'modified', additions: 1, deletions: 1, sha: 'blobNEW', patch: '' }] };
  gh.on('GET /repos/{owner}/{repo}/commits/{ref}', async () => ({ ...D(), data: c }));
  gh.on('GET /repos/{owner}/{repo}/git/ref/{ref}', async () => ({ ...D(), data: { object: { sha: 'tip1' } } }));
  gh.on('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', async (o) => ({ ...D(), data: { tree: { sha: o.params.commit_sha === 'p1' ? 'treeP' : 'treeH' } } }));
  gh.on('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', async (o) => ({ ...D(), data: { tree: [{ path: 'a.txt', type: 'blob', mode: '100644', sha: o.params.tree_sha === 'treeP' ? 'blobOLD' : 'blobNEW' }] } }));
  gh.on('POST /repos/{owner}/{repo}/git/trees', async () => ({ ...D(), data: { sha: 'newTree' } }));
  gh.on('POST /repos/{owner}/{repo}/git/commits', async () => ({ ...D(), data: { sha: 'revertSha' } }));
  gh.on('PATCH /repos/{owner}/{repo}/git/refs/{ref}', async () => ({ ...D(), data: {} }));
  const r = await commitsApi.revertCommit(t, 'o', 'r', 'c0ffee1', 'main');
  assert.strictEqual(r.sha, 'revertSha');
  const tree = gh.calls.find((x) => x.url === '/repos/{owner}/{repo}/git/trees' && x.method === 'POST');
  assert.deepStrictEqual(tree.params.tree, [{ path: 'a.txt', mode: '100644', type: 'blob', sha: 'blobOLD' }], 'file restored to its parent blob');
  assert.strictEqual(gh.calls.find((x) => x.method === 'PATCH').params.force, false);
});

test('revertCommit: ref update fails ambiguously and the branch is at OUR commit → success; at the old tip → failure', async () => {
  for (const [tipAfter, expectOk] of [['revertSha', true], ['tip1', false]]) {
    const t = fresh();
    const c = { sha: 'c0ffee1', commit: { message: 'Fix' }, parents: [{ sha: 'p1' }], stats: {}, files: [{ filename: 'a.txt', status: 'added', additions: 1, deletions: 0, sha: 'blobNEW', patch: '' }] };
    let refReads = 0;
    gh.on('GET /repos/{owner}/{repo}/commits/{ref}', async () => ({ ...D(), data: c }));
    gh.on('GET /repos/{owner}/{repo}/git/ref/{ref}', async () => ({ ...D(), data: { object: { sha: ++refReads === 1 ? 'tip1' : tipAfter } } }));
    gh.on('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', async () => ({ ...D(), data: { tree: { sha: 'treeH' } } }));
    gh.on('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', async () => ({ ...D(), data: { tree: [{ path: 'a.txt', type: 'blob', mode: '100644', sha: 'blobNEW' }] } }));
    gh.on('POST /repos/{owner}/{repo}/git/trees', async () => ({ ...D(), data: { sha: 'newTree' } }));
    gh.on('POST /repos/{owner}/{repo}/git/commits', async () => ({ ...D(), data: { sha: 'revertSha' } }));
    gh.on('PATCH /repos/{owner}/{repo}/git/refs/{ref}', async () => { throw networkError('socket hang up', 'ECONNRESET'); });
    const res = await commitsApi.revertCommit(t, 'o', 'r', 'c0ffee1', 'main').catch((e) => e);
    if (expectOk) assert.strictEqual(res.sha, 'revertSha'); else assert.ok(res instanceof Error, 'must not claim success');
  }
});

test('revertCommit: merge commits and huge commits are refused before anything is written', async () => {
  const t = fresh();
  gh.on('GET /repos/{owner}/{repo}/commits/{ref}', async () => ({ ...D(), data: { sha: 'm1', commit: { message: 'Merge' }, parents: [{ sha: 'a' }, { sha: 'b' }], files: [{ filename: 'x', status: 'added' }] } }));
  const err = await commitsApi.revertCommit(t, 'o', 'r', 'm1', 'main').catch((e) => e);
  assert.strictEqual(err.code, 'REVERT_UNSUPPORTED');
  assert.ok(!gh.calls.some((c) => c.method !== 'GET'));
});

test('createRelease: dropped connection but the tag now has a release → success; none → confirmed failure', async () => {
  let t = fresh();
  gh.on('POST /repos/{owner}/{repo}/releases', async () => { throw requestError(502, 'Bad Gateway'); });
  gh.on('GET /repos/{owner}/{repo}/releases/tags/{tag}', async () => ({ ...D(), data: { id: 5, tag_name: 'v1.0.0', name: 'v1.0.0' } }));
  assert.strictEqual((await releasesApi.createRelease(t, 'o', 'r', { tag: 'v1.0.0' })).tag, 'v1.0.0');
  t = fresh();
  gh.on('POST /repos/{owner}/{repo}/releases', async () => { throw requestError(502, 'Bad Gateway'); });
  gh.on('GET /repos/{owner}/{repo}/releases/tags/{tag}', async () => { throw requestError(404, 'Not Found'); });
  const err = await releasesApi.createRelease(t, 'o', 'r', { tag: 'v1.0.0' }).catch((e) => e);
  assert.ok(err instanceof Error);
});

test('actions: workflow dispatch 422 about workflow_dispatch becomes a clear, coded message; secrets never send plaintext', async () => {
  const t = fresh();
  gh.on('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', async () => { throw requestError(422, 'Workflow does not have workflow_dispatch trigger'); });
  const err = await actionsApi.dispatchWorkflow(t, 'o', 'r', 1, 'main').catch((e) => e);
  assert.strictEqual(err.code, 'NO_DISPATCH');
  gh.on('GET /repos/{owner}/{repo}/actions/secrets/public-key', async () => ({ ...D(), data: { key: 'AAAA', key_id: '1' } }));
  const sErr = await actionsApi.setSecret(t, 'o', 'r', 'TOKEN_X', 'plain-secret-value').catch((e) => e);
  assert.ok(sErr.code === 'NO_LIBSODIUM' || sErr instanceof Error);
  assert.ok(!JSON.stringify(gh.calls).includes('plain-secret-value'), 'plaintext never leaves the process');
  assert.ok(!gh.calls.some((c) => c.method === 'PUT'), 'nothing was written without encryption');
});

test('collaborators: usernames are validated before any request (no path injection through the username)', async () => {
  const t = fresh();
  for (const bad of ['../../admin', 'a/b', 'x y', '', '-lead', 'a'.repeat(40)]) {
    const err = await accessApi.addCollaborator(t, 'o', 'r', bad).catch((e) => e);
    assert.ok(err instanceof Error, bad);
  }
  assert.strictEqual(gh.calls.length, 0);
});

test('branch option: putFile / getFileContent / deleteFile / commitMultipleFiles target the chosen branch, default untouched', async () => {
  const t = fresh();
  gh.on('GET /repos/{owner}/{repo}/contents/{path}', async () => ({ ...D(), data: { sha: 's1', size: 2, content: Buffer.from('hi').toString('base64'), encoding: 'base64' } }));
  gh.on('PUT /repos/{owner}/{repo}/contents/{path}', async () => ({ ...D(), data: { content: { sha: 'n' } } }));
  gh.on('DELETE /repos/{owner}/{repo}/contents/{path}', async () => ({ ...D(), data: {} }));
  await github.getFileContent(t, 'o', 'r', 'a.txt', { branch: 'dev' });
  await github.putFile(t, 'o', 'r', 'a.txt', 'x', 'm', 's1', { branch: 'dev' });
  await github.deleteFile(t, 'o', 'r', 'a.txt', 's1', 'm', { branch: 'dev' });
  assert.ok(gh.calls.every((c) => c.params.ref === 'dev' || c.params.branch === 'dev'), JSON.stringify(gh.calls.map((c) => c.params)));
  gh.clear();
  gh.on('GET /repos/{owner}/{repo}/contents/{path}', async () => ({ ...D(), data: { sha: 's1', size: 2, content: Buffer.from('hi').toString('base64'), encoding: 'base64' } }));
  gh.on('PUT /repos/{owner}/{repo}/contents/{path}', async () => ({ ...D(), data: { content: { sha: 'n' } } }));
  await github.getFileContent(t, 'o', 'r', 'a.txt');
  await github.putFile(t, 'o', 'r', 'a.txt', 'x', 'm', 's1');
  assert.ok(gh.calls.every((c) => c.params.ref === undefined && c.params.branch === undefined), 'no branch given → GitHub default branch');
  gh.clear();
  gh.on('GET /repos/{owner}/{repo}/git/ref/{ref}', async () => ({ ...D(), data: { object: { sha: 'tip' } } }));
  gh.on('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', async () => ({ ...D(), data: { tree: { sha: 'tr' } } }));
  gh.on('POST /repos/{owner}/{repo}/git/blobs', async () => ({ ...D(), data: { sha: 'b' } }));
  gh.on('POST /repos/{owner}/{repo}/git/trees', async () => ({ ...D(), data: { sha: 'nt' } }));
  gh.on('POST /repos/{owner}/{repo}/git/commits', async () => ({ ...D(), data: { sha: 'nc' } }));
  gh.on('PATCH /repos/{owner}/{repo}/git/refs/{ref}', async () => ({ ...D(), data: {} }));
  await github.commitMultipleFiles(t, 'o', 'r', [{ path: 'a', content: 'x' }], 'm', [], { branch: 'dev' });
  assert.strictEqual(gh.calls.find((c) => c.url === '/repos/{owner}/{repo}/git/ref/{ref}').params.ref, 'heads/dev');
  assert.strictEqual(gh.calls.find((c) => c.method === 'PATCH').params.ref, 'heads/dev');
  assert.ok(!gh.calls.some((c) => c.url === '/repos/{owner}/{repo}' && c.method === 'GET'), 'no default-branch lookup when a branch is given');
});

test('two users, identically named repos, same moment: each token only ever sees its own traffic and results', async () => {
  const a = fresh(); const b = `${a}-b`;
  gh.latencyMs = 10;
  gh.on('GET /repos/{owner}/{repo}', async (_o, call) => ({ ...D(), data: { name: 'same', owner: call.token } }));
  const [ra, rb] = await Promise.all([github.getRepo(a, 'x', 'same'), github.getRepo(b, 'x', 'same')]);
  assert.strictEqual(ra.owner, a); assert.strictEqual(rb.owner, b);
  assert.strictEqual(gh.calls.length, 2, 'not coalesced across users');
});

test('operation context: user id and priority reach the manager through the real github.js path', async () => {
  const t = fresh();
  gh.on('GET /rate_limit', async () => ({ ...D(), data: { resources: { core: { limit: 5000, remaining: 4000, reset: 0 } } } }));
  const m = getTraffic().manager; const seen = [];
  const orig = m.schedule.bind(m);
  m.schedule = (meta, run) => { seen.push(meta); return orig(meta, run); };
  await requestContext.runOperation({ userId: 99, operation: 'Open repo' }, () => github.getAuthenticatedUser(t));
  await requestContext.runBackground('Repo cache refresh', () => github.getRateLimit(t), 99);
  m.schedule = orig;
  assert.deepStrictEqual([seen[0].userId, seen[0].priority, seen[0].operation], [99, 'interactive', 'Open repo']);
  assert.deepStrictEqual([seen[1].priority, seen[1].operation], ['background', 'Repo cache refresh']);
});

(async () => {
  const keep = setInterval(() => {}, 1000);
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) {
      failed++; console.log(`  ✗ ${name}\n      ${(err && err.stack ? err.stack : String(err)).split('\n').slice(0, 5).join('\n      ')}`);
    }
  }
  clearInterval(keep);
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
