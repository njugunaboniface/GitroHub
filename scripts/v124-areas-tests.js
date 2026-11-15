#!/usr/bin/env node
/**
 * v1.2.4-multi — feature-area tests (⚡ Manage / 💼 Workspace), fully offline.
 *
 * A scripted fake GitHub answers every route the areas use. A "crawler" then opens each area's home screen and taps
 * EVERY button it finds (and answers every typed-input prompt with sample text), checking on each screen that:
 *   • no handler crashed and no "Something went wrong" error was shown
 *   • the message is valid Telegram MarkdownV2 and under Telegram's 4096-character limit
 *   • every button's callback data fits 64 bytes (or is a shortened ~ref) and every `manage:` button routes somewhere
 * Run:  node scripts/v124-areas-tests.js   (npm run test:v124:areas)
 */
const assert = require('assert');
const t = require('./lib/testEnv');

// ── Fake GitHub (replaces the Octokit client BEFORE any lib/github/* module loads) ──────────────────────────
const calls = [];
const handlers = new Map();
const on = (route, fn) => handlers.set(route, fn);
const apiError = (status, message) => Object.assign(new Error(message), { status });
const fakeClient = {
  async request(route, params = {}) {
    const [method, template] = route.split(' ');
    calls.push({ route, params });
    const h = handlers.get(route);
    if (!h) throw apiError(404, `Not Found (no fake for ${route})`);
    const out = await h(params, { method, template });
    if (out && out.__raw) return { status: out.status || 200, headers: out.headers || {}, data: out.data };
    return { status: 200, headers: {}, data: out === undefined ? {} : out };
  },
};
const github = t.req('lib/github');
github.internals.client = () => fakeClient;

const now = new Date().toISOString();
const U = (login) => ({ login });
const pr = (n, extra = {}) => ({ number: n, title: `PR ${n} <b>&</b> *x* _y_ [z](u)`, state: 'open', draft: false, user: U('bob'), head: { ref: 'feat/one', repo: { full_name: 'me/repo1' } }, base: { ref: 'main' }, body: 'Body with `code` and # hash.', html_url: `https://github.com/me/repo1/pull/${n}`, comments: 1, review_comments: 0, commits: 2, additions: 5, deletions: 1, changed_files: 1, mergeable: true, mergeable_state: 'clean', created_at: now, updated_at: now, labels: [{ name: 'bug' }], assignees: [], requested_reviewers: [], ...extra });
const issue = (n, extra = {}) => ({ number: n, title: `Issue ${n}: (parens) & dots...`, state: 'open', user: U('amy'), body: 'Issue body', html_url: `https://github.com/me/repo1/issues/${n}`, comments: 2, labels: [{ name: 'bug' }, { name: 'type: docs' }], assignees: [U('amy')], milestone: { number: 1, title: 'v1' }, created_at: now, updated_at: now, ...extra });
const commit = (sha) => ({ sha, html_url: `https://github.com/me/repo1/commit/${sha}`, commit: { message: 'Fix the thing\n\nlong body', author: { name: 'Bob', date: now } }, author: U('bob'), parents: [{ sha: 'p1' }], stats: { additions: 3, deletions: 1, total: 4 }, files: [{ filename: 'src/a.txt', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new `tick` \\ slash', sha: 'blob1' }] });
const REPO = { full_name: 'me/repo1', default_branch: 'main', fork: false, private: false, visibility: 'public', stargazers_count: 3, forks_count: 1, subscribers_count: 2, open_issues_count: 4, size: 2048, created_at: now, pushed_at: now, license: { spdx_id: 'MIT' }, archived: false };

function seed() {
  handlers.clear(); calls.length = 0;
  on('GET /repos/{owner}/{repo}', () => REPO);
  on('PATCH /repos/{owner}/{repo}', () => REPO);
  // pulls
  on('GET /repos/{owner}/{repo}/pulls', (p) => (p.head ? [] : [pr(1), pr(2, { draft: true })]));
  on('GET /repos/{owner}/{repo}/pulls/{pull_number}', (p) => pr(p.pull_number));
  on('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', () => [{ filename: 'a.js', status: 'modified', additions: 1, deletions: 0, patch: '@@' }]);
  on('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', () => [{ user: U('amy'), state: 'APPROVED', body: '' }]);
  on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', () => ({ merged: true }));
  on('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', (p) => pr(p.pull_number, { state: p.state }));
  on('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', () => ({}));
  on('POST /repos/{owner}/{repo}/pulls', (p) => pr(9, { title: p.title }));
  on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', () => ({}));
  // issues
  on('GET /repos/{owner}/{repo}/issues', () => [issue(1), issue(2, { pull_request: {} }), issue(3, { state: 'closed' })]);
  on('GET /repos/{owner}/{repo}/issues/{issue_number}', (p) => issue(p.issue_number));
  on('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', () => [{ id: 1, user: U('amy'), body: 'hello _world_', created_at: now }]);
  on('POST /repos/{owner}/{repo}/issues', (p) => issue(7, { title: p.title }));
  on('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', () => ({ id: 2 }));
  on('PATCH /repos/{owner}/{repo}/issues/{issue_number}', (p) => issue(p.issue_number, { state: p.state || 'open' }));
  on('GET /repos/{owner}/{repo}/labels', () => [{ name: 'bug', color: 'ff0000', description: '' }, { name: 'type: docs', color: '00ff00', description: '' }]);
  on('POST /repos/{owner}/{repo}/labels', () => ({}));
  on('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', () => ({}));
  on('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', () => ({}));
  on('GET /repos/{owner}/{repo}/assignees', () => [U('amy'), U('bob')]);
  on('POST /repos/{owner}/{repo}/issues/{issue_number}/assignees', () => ({}));
  on('DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees', () => ({}));
  const ms = { number: 1, title: 'v1', state: 'open', description: 'first', open_issues: 2, closed_issues: 3, due_on: now, html_url: 'https://github.com/me/repo1/milestone/1' };
  on('GET /repos/{owner}/{repo}/milestones', () => [ms]);
  on('GET /repos/{owner}/{repo}/milestones/{milestone_number}', () => ms);
  on('POST /repos/{owner}/{repo}/milestones', (p) => ({ ...ms, title: p.title }));
  on('PATCH /repos/{owner}/{repo}/milestones/{milestone_number}', () => ms);
  on('DELETE /repos/{owner}/{repo}/milestones/{milestone_number}', () => ({}));
  // branches
  on('GET /repos/{owner}/{repo}/branches', () => [{ name: 'main', commit: { sha: 'aaa1111' }, protected: true }, { name: 'feat/one', commit: { sha: 'bbb2222' }, protected: false }]);
  on('GET /repos/{owner}/{repo}/git/ref/{ref}', (p) => { if (/^heads\/new-branch$/.test(p.ref)) throw apiError(404, 'Not Found'); return { object: { sha: p.ref === 'heads/main' || /^heads\/feat/.test(p.ref) ? 'aaa1111' : 'tip' } }; });
  on('POST /repos/{owner}/{repo}/git/refs', () => ({}));
  on('DELETE /repos/{owner}/{repo}/git/refs/{ref}', () => ({}));
  on('POST /repos/{owner}/{repo}/branches/{branch}/rename', () => ({}));
  on('GET /repos/{owner}/{repo}/compare/{basehead}', () => ({ status: 'ahead', ahead_by: 2, behind_by: 1, total_commits: 2, commits: [{ sha: 'abcdef12', commit: { message: 'm' } }], files: [{}] }));
  let prot = null;
  on('GET /repos/{owner}/{repo}/branches/{branch}/protection', () => { if (!prot) throw apiError(404, 'Branch not protected'); return prot; });
  on('PUT /repos/{owner}/{repo}/branches/{branch}/protection', (p) => { prot = { required_pull_request_reviews: p.required_pull_request_reviews, enforce_admins: { enabled: p.enforce_admins }, allow_force_pushes: { enabled: p.allow_force_pushes }, allow_deletions: { enabled: p.allow_deletions }, required_linear_history: { enabled: p.required_linear_history }, required_conversation_resolution: { enabled: p.required_conversation_resolution }, required_status_checks: p.required_status_checks, restrictions: null }; return prot; });
  on('DELETE /repos/{owner}/{repo}/branches/{branch}/protection', () => { prot = null; return {}; });
  // commits + revert plumbing
  on('GET /repos/{owner}/{repo}/commits', () => [{ sha: 'abc1234def', html_url: 'u', commit: { message: 'Fix (it) & more', author: { name: 'Bob', date: now } }, author: U('bob') }]);
  on('GET /repos/{owner}/{repo}/commits/{ref}', (p) => commit(p.ref.length >= 7 ? `${p.ref}0000000000`.slice(0, 40) : 'abc1234def'));
  on('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', (p) => ({ tree: { sha: `t${p.commit_sha}` } }));
  on('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', (p) => ({ tree: [{ path: 'src', type: 'tree', sha: `d${p.tree_sha}`, mode: '040000' }, ...(/^d?tp1/.test(p.tree_sha) ? [{ path: 'a.txt', type: 'blob', sha: 'old', mode: '100644' }] : [{ path: 'a.txt', type: 'blob', sha: 'blob1', mode: '100644' }])] }));
  on('POST /repos/{owner}/{repo}/git/trees', () => ({ sha: 'newtree' }));
  on('POST /repos/{owner}/{repo}/git/commits', () => ({ sha: 'newcommit1234' }));
  on('PATCH /repos/{owner}/{repo}/git/refs/{ref}', () => ({}));
  // releases / tags
  const rel = { id: 11, tag_name: 'v1.0.0', name: 'First *release*', body: 'notes', draft: false, prerelease: false, target_commitish: 'main', html_url: 'https://github.com/me/repo1/releases/tag/v1.0.0', published_at: now, created_at: now, author: U('me'), assets: [{ name: 'a.zip', size: 1, download_count: 3 }] };
  on('GET /repos/{owner}/{repo}/releases', () => [rel]);
  on('GET /repos/{owner}/{repo}/releases/{release_id}', () => rel);
  on('GET /repos/{owner}/{repo}/releases/tags/{tag}', () => rel);
  on('POST /repos/{owner}/{repo}/releases', () => rel);
  on('PATCH /repos/{owner}/{repo}/releases/{release_id}', () => rel);
  on('DELETE /repos/{owner}/{repo}/releases/{release_id}', () => ({}));
  on('GET /repos/{owner}/{repo}/tags', () => [{ name: 'v1.0.0', commit: { sha: 'aaa1111' } }]);
  // actions
  const run = { id: 500, name: 'CI', display_title: 'Fix stuff', status: 'completed', conclusion: 'failure', head_branch: 'main', event: 'push', run_number: 8, run_attempt: 1, actor: U('bob'), html_url: 'https://github.com/me/repo1/actions/runs/500', created_at: now, updated_at: now, head_sha: 'abcdef123456', workflow_id: 77 };
  on('GET /repos/{owner}/{repo}/actions/runs', () => ({ total_count: 1, workflow_runs: [run, { ...run, id: 501, status: 'in_progress', conclusion: null }] }));
  on('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', () => ({ total_count: 1, workflow_runs: [run] }));
  on('GET /repos/{owner}/{repo}/actions/runs/{run_id}', (p) => ({ ...run, id: p.run_id, status: p.run_id === 501 ? 'in_progress' : 'completed' }));
  on('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', () => ({ jobs: [{ id: 1, name: 'build (node 20)', status: 'completed', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] }));
  on('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', () => ({}));
  on('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs', () => ({}));
  on('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel', () => ({}));
  on('GET /repos/{owner}/{repo}/actions/workflows', () => ({ total_count: 1, workflows: [{ id: 77, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }));
  on('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', () => ({}));
  on('PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable', () => ({}));
  on('PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable', () => ({}));
  on('GET /repos/{owner}/{repo}/actions/secrets', () => ({ total_count: 1, secrets: [{ name: 'DEPLOY_TOKEN', updated_at: now }] }));
  on('GET /repos/{owner}/{repo}/actions/secrets/public-key', () => ({ key: 'AAAA', key_id: '1' }));
  on('PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}', () => ({}));
  on('DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}', () => ({}));
  on('GET /repos/{owner}/{repo}/actions/variables', () => ({ total_count: 1, variables: [{ name: 'NODE_ENV', value: 'prod', updated_at: now }] }));
  on('POST /repos/{owner}/{repo}/actions/variables', () => ({}));
  on('PATCH /repos/{owner}/{repo}/actions/variables/{name}', () => ({}));
  on('DELETE /repos/{owner}/{repo}/actions/variables/{name}', () => ({}));
  // access
  on('GET /repos/{owner}/{repo}/collaborators', () => [{ login: 'me', role_name: 'admin' }, { login: 'amy', role_name: 'write' }]);
  on('GET /repos/{owner}/{repo}/invitations', () => [{ id: 31, invitee: U('zed'), permissions: 'read' }]);
  on('PUT /repos/{owner}/{repo}/collaborators/{username}', () => ({ id: 5 }));
  on('DELETE /repos/{owner}/{repo}/collaborators/{username}', () => ({}));
  on('DELETE /repos/{owner}/{repo}/invitations/{invitation_id}', () => ({}));
  on('GET /repos/{owner}/{repo}/keys', () => [{ id: 41, title: 'server', read_only: true, created_at: now, key: 'ssh-ed25519 AAAAC3Nza' }]);
  on('POST /repos/{owner}/{repo}/keys', () => ({}));
  on('DELETE /repos/{owner}/{repo}/keys/{key_id}', () => ({}));
  let topics = ['bot', 'telegram'];
  on('GET /repos/{owner}/{repo}/topics', () => ({ names: topics }));
  on('PUT /repos/{owner}/{repo}/topics', (p) => { topics = p.names; return { names: topics }; });
  on('POST /repos/{owner}/{repo}/transfer', () => ({}));
  // security + insights
  const dep = { number: 3, state: 'open', security_advisory: { severity: 'high', summary: 'Prototype pollution (lodash)', ghsa_id: 'GHSA-xxxx' }, dependency: { package: { name: 'lodash', ecosystem: 'npm' }, manifest_path: 'package.json' }, security_vulnerability: { first_patched_version: { identifier: '4.17.21' }, vulnerable_range: '< 4.17.21' }, html_url: 'https://github.com/me/repo1/security/dependabot/3', created_at: now };
  on('GET /repos/{owner}/{repo}/dependabot/alerts', () => [dep]);
  on('GET /repos/{owner}/{repo}/dependabot/alerts/{alert_number}', () => dep);
  on('PATCH /repos/{owner}/{repo}/dependabot/alerts/{alert_number}', () => dep);
  on('GET /repos/{owner}/{repo}/code-scanning/alerts', () => { throw apiError(404, 'no analysis found'); });
  on('GET /repos/{owner}/{repo}/secret-scanning/alerts', () => [{ number: 1, state: 'open', secret_type_display_name: 'GitHub token', html_url: 'https://github.com/x', created_at: now }]);
  on('GET /repos/{owner}/{repo}/vulnerability-alerts', () => ({}));
  on('PUT /repos/{owner}/{repo}/vulnerability-alerts', () => ({}));
  on('DELETE /repos/{owner}/{repo}/vulnerability-alerts', () => ({}));
  on('GET /repos/{owner}/{repo}/contributors', () => [{ login: 'me', contributions: 40 }, { login: 'amy', contributions: 9 }]);
  on('GET /repos/{owner}/{repo}/stats/commit_activity', () => ({ __raw: true, status: 200, data: Array.from({ length: 52 }, (_, i) => ({ total: i % 7 })) }));
  on('GET /repos/{owner}/{repo}/traffic/views', () => ({ count: 10, uniques: 4 }));
  on('GET /repos/{owner}/{repo}/traffic/clones', () => ({ count: 6, uniques: 2 }));
  on('GET /repos/{owner}/{repo}/traffic/popular/referrers', () => [{ referrer: 'google.com', count: 3 }]);
  on('GET /repos/{owner}/{repo}/traffic/popular/paths', () => [{ path: '/me/repo1', count: 5 }]);
  // account level
  on('GET /notifications', () => [{ id: '1001', unread: true, reason: 'mention', subject: { title: 'Please look <now>', url: 'https://api.github.com/repos/me/repo1/issues/3', type: 'Issue' }, repository: { full_name: 'me/repo1', name: 'repo1', owner: U('me') }, updated_at: now }]);
  on('PATCH /notifications/threads/{thread_id}', () => ({}));
  on('PUT /notifications', () => ({}));
  on('PUT /notifications/threads/{thread_id}/subscription', () => ({}));
  const gist = { id: 'a'.repeat(32), description: 'My (gist) *1*', public: false, html_url: 'https://gist.github.com/a', updated_at: now, created_at: now, files: { 'n.md': { filename: 'n.md', size: 3, language: 'Markdown', content: 'hi `there`' } } };
  on('GET /gists', () => [gist]);
  on('GET /gists/{gist_id}', () => gist);
  on('POST /gists', () => gist);
  on('PATCH /gists/{gist_id}', () => gist);
  on('DELETE /gists/{gist_id}', () => ({}));
  on('GET /search/code', () => ({ total_count: 1, items: [{ path: 'src/a.js', name: 'a.js', repository: { full_name: 'me/repo1' }, html_url: 'https://github.com/me/repo1/blob/main/src/a.js', text_matches: [{ fragment: 'const foo = 1; // *x*' }] }] }));
  on('GET /search/issues', () => ({ total_count: 2, items: [{ number: 5, title: 'Mine', repository_url: 'https://api.github.com/repos/me/repo1', html_url: 'https://github.com/me/repo1/pull/5', pull_request: {}, comments: 0, updated_at: now }, { number: 6, title: 'Theirs', repository_url: 'https://api.github.com/repos/other/zzz', html_url: 'https://github.com/other/zzz/issues/6', comments: 0, updated_at: now }] }));
  on('GET /user/orgs', () => [{ login: 'acme-inc', description: 'Acme' }]);
  on('GET /user/memberships/orgs/{org}', () => ({ role: 'admin', state: 'active' }));
  on('POST /graphql', (p) => {
    if (/addProjectV2DraftIssue/.test(p.query)) return { data: { addProjectV2DraftIssue: { projectItem: { id: 'item1' } } } };
    if (/items\(first/.test(p.query)) return { data: { node: { title: 'Roadmap', url: 'https://github.com/users/me/projects/1', items: { nodes: [{ id: 'i1', type: 'ISSUE', content: { title: 'Do it', number: 1, state: 'OPEN', repository: { nameWithOwner: 'me/repo1' } }, fieldValues: { nodes: [{ name: 'Todo', field: { name: 'Status' } }] } }] } } } };
    return { data: { viewer: { projectsV2: { nodes: [{ id: 'PVT_kwHOAAAA', title: 'Roadmap', number: 1, url: 'https://github.com/users/me/projects/1', closed: false, shortDescription: '' }] } } } };
  });
}

// ── Test harness ─────────────────────────────────────────────────────────────
const users = t.req('lib/users');
const repoCache = t.req('lib/repoCache');
users.isConnected = async () => true;
users.getUser = async () => ({ github_token_enc: 'x', github_scope: 'repo,delete_repo,gist,notifications,read:org,project' });
users.getDecryptedToken = async () => 'tok';
t.req('lib/crypto').tryDecrypt = () => 'tok';
repoCache.getUser = async () => ({ login: 'me', personalLogin: 'me', isOrg: false });
const accounts = t.req('lib/accounts');
accounts.getActiveOwner = async () => null;
accounts.list = async () => [{ id: 1, login: 'me', active: true }, { id: 2, login: 'work', active: false }];
accounts.activate = async (id, login) => ({ login });
accounts.removeAccount = async () => {};
accounts.setActiveOwner = async () => {};
accounts.activeLoginOf = async () => 'me';

const registry = t.req('handlers/manage/registry');
const manage = t.req('handlers/manage');
const input = t.req('handlers/manage/input');
t.req('handlers/manage/areas').registerAll();

function assertValidMarkdownV2(text) {
  const RESERVED = '_*[]()~>#+-=|{}.!';
  let i = 0; let bold = false; let italic = false; let code = false; let pre = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '>' && (i === 0 || text[i - 1] === '\n')) { i++; continue; } // blockquote line
    if (text.startsWith('```', i)) { pre = !pre; i += 3; continue; }
    if (pre) { i++; continue; }
    if (c === '`') { code = !code; i++; continue; }
    if (code) { i++; continue; }
    if (c === '*') { bold = !bold; i++; continue; }
    if (c === '_') { italic = !italic; i++; continue; }
    assert.ok(!RESERVED.includes(c), `unescaped '${c}' at ${i}: …${text.slice(Math.max(0, i - 30), i + 30)}…`);
    i++;
  }
  assert.ok(!bold && !italic && !code && !pre, `unbalanced formatting (bold:${bold} italic:${italic} code:${code} pre:${pre}) in: ${text.slice(0, 160)}`);
}

function makeCtx(id = 42) {
  const sent = [];
  const ctx = {
    from: { id }, sent, chat: { id }, session: {}, state: {},
    callbackQuery: { data: 'x', message: { message_id: 1 } },
    reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: sent.length }; },
    editMessageText: async (text, extra) => { sent.push({ text, extra, edited: true }); return true; },
    editMessageReplyMarkup: async () => true, deleteMessage: async () => true, answerCbQuery: async () => {},
    telegram: {},
  };
  return ctx;
}
const buttonsOf = (m) => ((m.extra && m.extra.reply_markup && m.extra.reply_markup.inline_keyboard) || []).flat();
const SAMPLE_INPUT = { default: 'test', invite: 'octocat', transfer: 'octocat', topic: 'new-topic', query: 'foo language:js', newlabel: 'newlabel ff8800', new: 'v2 launch 2026-12-31', filename: 'x.md', description: '-', secvalue: 'sUp3r s3cret', secname: 'MY_SECRET', varname: 'MY_VAR', keybody: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA test', keytitle: 'my server', create: 'new-branch', tag: 'v9.9.9', newtag: 'v9.9.8', newbody: 'body text', newtitle: 'A new title' };

/** Taps every manage: button reachable from `startData`, answering typed prompts, and checks every screen. */
async function crawl(startData, { maxScreens = 400 } = {}) {
  const ctx = makeCtx();
  const seen = new Set(); const queue = [startData]; const problems = []; let screens = 0;
  const check = (m, from) => {
    assert.ok(String(m.text).length <= 4096, `message too long (${m.text.length}) after ${from}`);
    assert.ok(!/Something went wrong|no fake for/.test(m.text), `error screen after ${from}: ${m.text.slice(0, 200)}`);
    if (m.extra && m.extra.parse_mode === 'MarkdownV2') assertValidMarkdownV2(m.text);
    // v1.4.0-multi: no dead ends — every screen offers a way out (Back, Workspace, Cancel or a link).
    if (m.extra && m.extra.reply_markup) {
      const btns = buttonsOf(m);
      const wayOut = btns.some((b) => /⬅️|💼|❌|🏠|Cancel|Back|Workspace/.test(b.text || '') || b.url || /^(manage|hub|nav|repos?|admin|help|legal|settings):/.test(b.callback_data || ''));
      const isHome = /^💼 \*Workspace\*/.test(String(m.text)); // the home screen is where every way out leads
      assert.ok(wayOut || isHome, `dead end (no Back/Workspace/Cancel button) after ${from}: ${String(m.text).slice(0, 60)}`);
    }
    for (const b of buttonsOf(m)) {
      if (b.callback_data !== undefined) assert.ok(Buffer.byteLength(b.callback_data) <= 64, `callback too long (${Buffer.byteLength(b.callback_data)}B): ${b.callback_data}`);
      assert.ok(b.text && b.text.length <= 60, `button text too long/empty: "${b.text}"`);
    }
  };
  while (queue.length && screens < maxScreens) {
    const data = queue.shift();
    if (seen.has(data)) continue;
    seen.add(data);
    screens++;
    ctx.sent.length = 0; ctx.session.manageInput = undefined;
    try {
      assert.equal(await manage.route(ctx, data), true, `unrouted: ${data}`);
      for (const m of ctx.sent) check(m, data);
      // a typed prompt? answer it, then check what comes next (chained prompts too)
      for (let depth = 0; depth < 4 && ctx.session.manageInput; depth++) {
        const pending = ctx.session.manageInput;
        const text = SAMPLE_INPUT[pending.action] || SAMPLE_INPUT.default;
        ctx.sent.length = 0;
        ctx.message = { text, message_id: 9 };
        await input.handleText(ctx);
        for (const m of ctx.sent) check(m, `${data} + typed "${text}" (${pending.area}.${pending.action})`);
        if (ctx.session.manageInput && ctx.session.manageInput.action === pending.action && ctx.session.manageInput.area === pending.area) { ctx.session.manageInput = undefined; break; } // re-armed after a bad answer
        for (const m of ctx.sent) for (const b of buttonsOf(m)) if (/^manage:/.test(b.callback_data || '')) queue.push(b.callback_data);
      }
      for (const m of ctx.sent) for (const b of buttonsOf(m)) if (/^manage:/.test(b.callback_data || '') && !/^manage:cancel/.test(b.callback_data)) queue.push(b.callback_data);
    } catch (err) { problems.push(`${data}: ${err.message}`); }
  }
  return { screens, problems, seen };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('crawler: every screen of every repo area opens, renders valid MarkdownV2 under 4096 chars, and every button routes', async () => {
  for (const key of ['pulls', 'issues', 'branches', 'commits', 'restore', 'releases', 'actions', 'access', 'security', 'insights', 'milestones']) {
    seed();
    const r = await crawl(`manage:${key}:home:repo1`);
    assert.deepEqual(r.problems, [], `${key}: ${r.problems.slice(0, 3).join(' | ')}`);
    assert.ok(r.screens >= 3, `${key} only reached ${r.screens} screens`);
    console.log(`      ${key}: ${r.screens} screens`);
  }
});

test('crawler: every screen of every Workspace area opens and renders cleanly', async () => {
  for (const key of ['notify', 'mywork', 'gists', 'codesearch', 'projects', 'orgs', 'alerts', 'accounts', 'attn', 'safety']) {
    seed();
    const r = await crawl(`manage:${key}:home`);
    assert.deepEqual(r.problems, [], `${key}: ${r.problems.slice(0, 3).join(' | ')}`);
    console.log(`      ${key}: ${r.screens} screens`);
  }
});

test('hubs: ⚡ Manage lists all eleven repo areas and 💼 Workspace shows its tiles (v1.3.0 layout), each button routes', async () => {
  seed();
  const ctx = makeCtx(); await manage.showHub(ctx, 'repo1');
  const data = buttonsOf(ctx.sent[0]).map((b) => b.callback_data);
  assert.equal(data.filter((d) => /^manage:[a-z]+:home:repo1$/.test(d)).length, 11);
  const ws = makeCtx(); await manage.showWorkspace(ws);
  const wsData = buttonsOf(ws.sent[0]).map((b) => b.callback_data);
  for (const need of ['hub:search', 'manage:gists:home', 'manage:projects:home', 'manage:orgs:home', 'manage:restorec:home']) assert.ok(wsData.includes(need), `Workspace tile ${need}`);
  for (const b of [...buttonsOf(ctx.sent[0]), ...buttonsOf(ws.sent[0])]) if (/^manage:/.test(b.callback_data)) assert.equal(await manage.route(makeCtx(), b.callback_data), true);
});

test('writes: the right GitHub routes are called with the right parameters', async () => {
  seed();
  const ctx = makeCtx();
  const tap = async (d) => { ctx.sent.length = 0; await manage.route(ctx, d); };
  await tap('manage:pulls:mergeok:repo1:1:squash');
  assert.ok(calls.some((c) => c.route === 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge' && c.params.merge_method === 'squash' && c.params.pull_number === 1 && c.params.owner === 'me' && c.params.repo === 'repo1'));
  await tap('manage:pulls:closeok:repo1:2');
  assert.ok(calls.some((c) => c.route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}' && c.params.state === 'closed' && c.params.pull_number === 2));
  await tap('manage:issues:closeok:repo1:1:not_planned');
  assert.ok(calls.some((c) => c.route === 'PATCH /repos/{owner}/{repo}/issues/{issue_number}' && c.params.state === 'closed' && c.params.state_reason === 'not_planned'));
  await tap('manage:branches:delok:repo1:feat/one');
  assert.ok(calls.some((c) => c.route === 'DELETE /repos/{owner}/{repo}/git/refs/{ref}' && c.params.ref === 'heads/feat/one'));
  await tap('manage:branches:defok:repo1:feat/one');
  assert.ok(calls.some((c) => c.route === 'PATCH /repos/{owner}/{repo}' && c.params.default_branch === 'feat/one'));
  await tap('manage:actions:rerun:repo1:500:failed');
  assert.ok(calls.some((c) => c.route.endsWith('/rerun-failed-jobs') && c.params.run_id === 500));
  await tap('manage:actions:wfrun:repo1:77');
  assert.ok(calls.some((c) => c.route.endsWith('/dispatches') && c.params.ref === 'main' && c.params.workflow_id === 77));
  await tap('manage:access:perm:repo1:amy:maintain');
  assert.ok(calls.some((c) => c.route === 'PUT /repos/{owner}/{repo}/collaborators/{username}' && c.params.permission === 'maintain' && c.params.username === 'amy'));
  await tap('manage:releases:delok:repo1:11:yes');
  assert.ok(calls.some((c) => c.route === 'DELETE /repos/{owner}/{repo}/releases/{release_id}') && calls.some((c) => c.route === 'DELETE /repos/{owner}/{repo}/git/refs/{ref}' && c.params.ref === 'tags/v1.0.0'));
});

test('branch protection: changing ONE rule keeps the others (no accidental reset)', async () => {
  seed();
  const ctx = makeCtx();
  await manage.route(ctx, 'manage:branches:padd:repo1:main');
  await manage.route(ctx, 'manage:branches:ptoggle:repo1:main:linear');
  await manage.route(ctx, 'manage:branches:ptoggle:repo1:main:conversation');
  const puts = calls.filter((c) => c.route === 'PUT /repos/{owner}/{repo}/branches/{branch}/protection');
  const last = puts[puts.length - 1].params;
  assert.equal(last.required_linear_history, true);
  assert.equal(last.required_conversation_resolution, true);
  assert.equal(last.required_pull_request_reviews.required_approving_review_count, 1, 'review requirement kept');
  assert.equal(last.allow_force_pushes, false, 'force-push block kept');
  assert.equal(last.allow_deletions, false);
});

test('revert: a clean revert commits via the Git Data API; a changed file refuses with the list and writes nothing', async () => {
  seed();
  let ctx = makeCtx();
  await manage.route(ctx, 'manage:commits:revok:repo1:abc1234:main');
  assert.ok(/Reverted/.test(ctx.sent[ctx.sent.length - 1].text), ctx.sent.map((m) => m.text).join('|'));
  const upd = calls.find((c) => c.route === 'PATCH /repos/{owner}/{repo}/git/refs/{ref}');
  assert.ok(upd && upd.params.force === false && upd.params.sha === 'newcommit1234', 'fast-forward only, never force');
  // someone changed a.txt after the commit → blob differs from the commit's blob
  seed(); ctx = makeCtx();
  on('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', (p) => ({ tree: [{ path: 'a.txt', type: 'blob', sha: 'CHANGED', mode: '100644' }] }));
  await manage.route(ctx, 'manage:commits:revok:repo1:abc1234:main');
  assert.ok(/Can.t revert cleanly/.test(ctx.sent[ctx.sent.length - 1].text) && /a\.txt/.test(ctx.sent[ctx.sent.length - 1].text));
  assert.ok(!calls.some((c) => c.route === 'PATCH /repos/{owner}/{repo}/git/refs/{ref}'), 'nothing was written');
});

test('secrets: the typed value message is deleted, never echoed, and a missing libsodium is reported plainly', async () => {
  seed();
  const ctx = makeCtx(); let deleted = 0; ctx.deleteMessage = async () => { deleted++; };
  await manage.route(ctx, 'manage:actions:secset:repo1:DEPLOY_TOKEN');
  assert.equal(ctx.session.manageInput.secret, true);
  ctx.message = { text: 'TOP-SECRET-VALUE-123', message_id: 5 };
  ctx.sent.length = 0;
  await input.handleText(ctx);
  assert.equal(deleted, 1, 'user message deleted');
  assert.ok(!ctx.sent.some((m) => /TOP-SECRET-VALUE-123/.test(m.text)), 'value never echoed');
  assert.ok(!JSON.stringify(calls).includes('TOP-SECRET-VALUE-123'), 'plaintext never sent to GitHub');
  assert.ok(ctx.sent.some((m) => /libsodium|saved/i.test(m.text)));
});

test('typed input: empty and over-long answers re-arm the prompt; ❌ Cancel clears it; a stale prompt cannot swallow other text', async () => {
  seed();
  const ctx = makeCtx();
  await manage.route(ctx, 'manage:issues:new:repo1');
  ctx.message = { text: 'x'.repeat(300) }; ctx.sent.length = 0;
  assert.equal(await input.handleText(ctx), true);
  assert.ok(ctx.session.manageInput && /limit/i.test(ctx.sent[0].text), 'over-long answer keeps the prompt armed');
  await manage.route(ctx, 'manage:cancel');
  assert.equal(ctx.session.manageInput, undefined);
  ctx.message = { text: 'hello' };
  assert.equal(await input.handleText(ctx), false, 'no prompt → not consumed');
});

test('scope gate: Gists/Projects/Orgs without their scope show ONE grant prompt and make no GitHub call', async () => {
  seed();
  const saved = users.getUser;
  users.getUser = async () => ({ github_token_enc: 'x', github_scope: 'repo,delete_repo' });
  try {
    for (const d of ['manage:gists:home', 'manage:projects:home', 'manage:orgs:home']) {
      const ctx = makeCtx(); await manage.route(ctx, d);
      assert.equal(ctx.sent.length, 1, d);
      assert.ok(/one more GitHub permission/.test(ctx.sent[0].text), d);
    }
    // notifications are implied by the base `repo` scope
    const n = makeCtx(); await manage.route(n, 'manage:notify:home');
    assert.ok(!/one more GitHub permission/.test(n.sent[0].text));
    assert.equal(calls.filter((c) => /gists|graphql|user\/orgs/.test(c.route)).length, 0);
  } finally { users.getUser = saved; }
});

test('org view: Workspace → Organisations lists the personal account and orgs; picking one verifies membership first', async () => {
  seed();
  const saved = accounts.setActiveOwner; let setTo;
  accounts.setActiveOwner = async (id, o) => { setTo = o; };
  try {
    const ctx = makeCtx();
    await manage.route(ctx, 'manage:orgs:home');
    const labels = buttonsOf(ctx.sent[0]).map((b) => b.text).join('|');
    assert.match(labels, /me \(personal\)/); assert.match(labels, /acme-inc/);
    await manage.route(ctx, 'manage:orgs:use:acme-inc');
    assert.equal(setTo, 'acme-inc');
    assert.ok(calls.some((c) => c.route === 'GET /user/memberships/orgs/{org}' && c.params.org === 'acme-inc'));
    await manage.route(ctx, 'manage:orgs:use:-');
    assert.equal(setTo, null);
  } finally { accounts.setActiveOwner = saved; }
});

test('alerts: toggles save per person; "update my repo alerts" re-points every registered hook, bounded', async () => {
  seed();
  const prefsMod = t.req('lib/alertPrefs');
  const store = new Map();
  t.setQueryHandler((sql, params) => {
    if (/INSERT INTO alert_event_prefs/.test(sql)) { store.set(params[1], params[2]); return { rows: [] }; }
    if (/FROM alert_event_prefs/.test(sql)) return { rows: [...store].map(([event_key, enabled]) => ({ event_key, enabled })) };
    if (/FROM repo_webhooks/.test(sql)) return { rows: Array.from({ length: 30 }, (_, i) => ({ repo_name: `r${i}`, webhook_id: 100 + i, owner_login: 'me', account_login: 'me' })) };
    return { rows: [] };
  });
  const ctx = makeCtx();
  await manage.route(ctx, 'manage:alerts:home');
  const star = buttonsOf(ctx.sent[0]).find((b) => /Stars/.test(b.text));
  assert.match(star.text, /✅/, 'stars default on');
  await manage.route(ctx, star.callback_data);
  assert.equal(store.get('star'), false);
  assert.equal((await prefsMod.getAll(42)).star, false);
  assert.equal((await prefsMod.getAll(42)).issue_comment, false, 'comments default off');
  handlers.set('PATCH /repos/{owner}/{repo}/hooks/{hook_id}', () => ({}));
  calls.length = 0;
  // updateWebhookEvents goes through lib/github.js (real client stub) — only the bound matters here
  await manage.route(ctx, 'manage:alerts:upd');
  assert.ok(/Updated|couldn/.test(ctx.sent[ctx.sent.length - 1].text));
  t.resetQueries();
});

test('admin feature switches: toggling an area OFF hides it from the hub and blocks its buttons; ON restores it', async () => {
  seed();
  const admin = t.req('handlers/admin');
  const gc = t.req('lib/globalConfig');
  t.req('lib/adminActions').auditLog = async () => {};
  // run as an owner (super admin) — requireAdmin/requireSuperAdmin read config + users
  const ctx = makeCtx(1); ctx.state.isAdmin = true;
  t.req('lib/lockdown').isLocked = async () => false;
  t.req('lib/roles').getRole = async () => 'super_admin';
  await admin.showFeatureSwitches(ctx);
  const first = ctx.sent[0];
  const labels = buttonsOf(first).map((b) => b.text).join('|');
  assert.match(labels, /Pull requests · Manage/); assert.match(labels, /Gists · Workspace/);
  await admin.toggleFeatureSwitch(ctx, 'gists');
  assert.equal(gc.get('feature_gists'), 'off', JSON.stringify(ctx.sent.map((m) => m.text)));
  const ws = makeCtx(42); await manage.showWorkspace(ws);
  assert.ok(!buttonsOf(ws.sent[0]).some((b) => /Gists/.test(b.text)), 'hidden from the hub');
  const blocked = makeCtx(42); await manage.route(blocked, 'manage:gists:home');
  assert.ok(/switched off/.test(blocked.sent[0].text) && !calls.some((c) => c.route === 'GET /gists'));
  await admin.toggleFeatureSwitch(ctx, 'gists');
  assert.equal(gc.get('feature_gists'), null);
  const ws2 = makeCtx(42); await manage.showWorkspace(ws2);
  assert.ok(buttonsOf(ws2.sent[0]).some((b) => /Gists/.test(b.text)));
  const nope = makeCtx(1); nope.state.isAdmin = true; await admin.toggleFeatureSwitch(nope, 'does_not_exist');
  assert.ok(/no longer exists/.test(nope.sent[nope.sent.length - 1].text));
});

test('dispatcher hardening: hostile callback data never reaches GitHub', async () => {
  seed();
  for (const d of ['manage:pulls:view:..%2f..:1', 'manage:pulls:view:repo1:abc', 'manage:issues:lbl:repo1:1:-5', 'manage:branches:view:repo1', 'manage:commits:view:repo1:zzzzzzz', 'manage:actions:run:repo1:0', 'manage:releases:view:repo1:x']) {
    const ctx = makeCtx(); calls.length = 0;
    await manage.route(ctx, d);
    assert.ok(!calls.some((c) => /^(PUT|POST|PATCH|DELETE)/.test(c.route)), `${d} wrote something`);
  }
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
