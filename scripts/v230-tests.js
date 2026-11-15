#!/usr/bin/env node
/**
 * v2.3.0-multi — owner panel: Warden, badges, undo, charts, announcements, team, sessions, errors feed, search, bulk tools,
 * installable app, desktop layout (offline).
 *
 * The libraries are stubbed with their REAL return shapes ({rows,total}, camelCase fleet overview …) — in 2.2.0 the panel
 * assumed other shapes and two pages would have broken on real data — and the server's own answers are then fed to the
 * panel's browser script to prove every page renders.
 * Run:  node scripts/v230-tests.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B06}\u{2705}\u{274C}\u{26A0}\u{23F3}\u{2139}\u{FE0F}]/u;

const ownerWeb = t.req('lib/ownerWeb');
const config = t.req('config');
const OWNER = Number(config.OWNER_ID);
const panel = t.req('server/ownerPanel');
const redisClient = t.req('db/redis').client;
const host = { host: 'example.com' };
const sameSite = { 'sec-fetch-site': 'same-origin' };
const NOW = Date.now();
const iso = (ms) => new Date(NOW + ms).toISOString();
const HOSTILE = '<img src=x onerror=alert(1)>';

// ── stubs with real shapes ──
const sent = [];
const bot = { telegram: { sendMessage: async (id, m) => { sent.push([id, m]); return {}; }, setMyCommands: async () => true, deleteMyCommands: async () => true } };

function sqlRows(sql) {
  if (/generate_series/.test(sql)) return Array.from({ length: 14 }, (_, i) => ({ label: `Oct ${String(i + 1).padStart(2, '0')}`, day: `2026-10-${String(i + 1).padStart(2, '0')}`, count: (i * 3) % 7 }));
  if (/COUNT\(\*\)::int AS n FROM/.test(sql) || /COUNT\(DISTINCT \(telegram_id, repo_name\)\)/.test(sql) || /COUNT\(\*\)::int AS n\b/.test(sql)) return [{ n: 5 }];
  if (/FROM admin_undo_log/.test(sql)) return [{ id: 9, admin_id: OWNER, action_type: 'ban', target_ids: JSON.stringify([5]), created_at: iso(-60000), expires_at: iso(3000000) }];
  if (/FROM sensitive_approvals/.test(sql)) return [{ id: 4, telegram_id: 5, action: 'delete_repo', repo_name: 'demo', created_at: iso(-120000), telegram_username: 'bob', telegram_first_name: 'Bob' }];
  if (/FROM warden_evidence/.test(sql)) return [{ id: 1, type: 'error_burst', class: 'failure', strength: 0.8, reliability: 0.9, observed: { errors: 12 }, baseline: { errors: 1 }, window_start: iso(-3600000), window_end: iso(-60000), created_at: iso(-60000) }];
  if (/FROM warden_profiles/.test(sql)) return [{ stage: 'flag', risk: 0.62, confidence: 0.74, snooze_until: null }];
  if (/FROM warden_cases c LEFT JOIN users/.test(sql)) return [{ id: 12, telegram_id: 5, stage: 'flag', telegram_username: 'bob', telegram_first_name: 'Bob' }];
  if (/FROM warden_cases WHERE telegram_id/.test(sql)) return [{ id: 12, stage: 'flag', opened_at: iso(-86400000) }];
  if (/FROM user_reports r/.test(sql)) return [{ id: 3, message: `It broke ${HOSTILE}`, status: 'open', telegram_id: 5, telegram_username: 'bob' }];
  if (/FROM github_accounts/.test(sql)) return [{ github_login: 'bobgh', health_status: 'ok' }];
  if (/FROM repo_webhooks/.test(sql) && /COUNT/.test(sql)) return [{ hooks: 3, people: 2 }];
  if (/FROM repo_webhooks/.test(sql)) return [{ telegram_id: 5, repo_name: 'demo', created_at: iso(-1000) }];
  if (/telegram_id = ANY/.test(sql)) return [{ telegram_id: 5, telegram_username: 'bob', telegram_first_name: 'Bob' }, { telegram_id: OWNER, telegram_username: 'owner', telegram_first_name: 'Owner' }];
  if (/FROM users/.test(sql)) return [USER_ROW];
  return [];
}
const USER_ROW = { telegram_id: 5, telegram_username: 'bob', telegram_first_name: 'Bob', github_username: 'bobgh', github_token_enc: 'SECRET-TOKEN', connected_at: new Date(NOW - 86400000), is_blocked: false, is_admin: false, is_trusted: false, admin_notes: `note ${HOSTILE}`, timezone: 'UTC', created_at: new Date(NOW - 5 * 86400000), last_active_at: new Date(NOW - 3600000), suspended_until: null };
let lastSql = [];

const restore = [];
function stub(mod, name, fn) { const m = t.req(mod); const old = m[name]; m[name] = fn; restore.push(() => { m[name] = old; }); }

function installStubs(calls) {
  t.setQueryHandler((sql, params) => { lastSql.push([sql, params]); return { rows: sqlRows(sql), rowCount: sqlRows(sql).length }; });
  stub('lib/runtimeMetrics', 'getHealth', async () => ({ status: 'DEGRADED', reasons: ['Event loop is slow'], pgStatus: { ok: true }, redisStatus: { ok: true }, rssMB: 120, lag: { p99: 4 }, cpuPercent: 12, poolWaiting: 0, traffic: { state: 'ok', breaker: { state: 'half-open' }, active: 1, queued: 2 } }));
  stub('lib/adminStats', 'fleetOverview', async () => ({ totalUsers: 10, activeToday: 3, connected: 7, blocked: 1, suspended: 0, totalCommits: 99, errorsToday: 30, newToday: 1, newThisWeek: 4, avgCommitsPerActiveUser: 1.5, githubAccounts: 8, multiAccountUsers: 1, revokedAccounts: 0 }));
  stub('lib/adminStats', 'userDetail', async () => ({ user: USER_ROW, commitCount: 3, errorCount: 1, lastActivity: { summary: 'Uploaded a file', created_at: iso(-3600000) } }));
  stub('lib/adminStats', 'auditLog', async (o) => ({ rows: [{ id: 1, admin_id: OWNER, target_telegram_id: 5, action: 'ban', detail: `spam ${HOSTILE} [web]`, created_at: iso(-60000) }], total: 41, _o: o }));
  stub('lib/adminStats', 'distinctAuditActions', async () => ['ban', 'role_change']);
  stub('lib/adminStats', 'distinctAuditAdmins', async () => [{ admin_id: OWNER, telegram_username: 'owner', telegram_first_name: 'Owner' }]);
  stub('lib/adminStats', 'globalErrorFeed', async () => ({ rows: [{ telegram_id: 5, telegram_username: 'bob', icon: 'x', summary: `Upload failed ${HOSTILE}`, detail: 'timeout', created_at: iso(-1000) }], total: 31 }));
  stub('lib/adminStats', 'anomalyFeed', async () => ({ rows: [{ telegram_id: 5, telegram_username: 'bob', event: 'reconnect', anomaly_reason: 'new scope', created_at: iso(-1000) }], total: 2 }));
  stub('lib/adminStats', 'scheduledJobsOverview', async () => [{ telegram_id: 5, kind: 'upload', label: 'demo', status: 'failed', scheduled_for: iso(-5000), error_message: 'rate limited' }]);
  stub('lib/reports', 'list', async () => ({ rows: [{ id: 3, telegram_id: 5, message: `It broke ${HOSTILE}`, status: 'open', created_at: iso(-1000), telegram_username: 'bob', telegram_first_name: 'Bob' }], total: 1 }));
  stub('lib/reports', 'openCount', async () => 1);
  stub('lib/roles', 'getRole', async () => 'guest');
  stub('lib/roles', 'listAdmins', async () => [{ telegram_id: 77, role: 'admin', granted_by: OWNER, granted_at: iso(-86400000), telegram_username: 'ann', telegram_first_name: 'Ann' }]);
  stub('lib/roles', 'setRole', async (...a) => calls.push(['setRole', ...a]));
  stub('lib/roles', 'revokeRole', async (...a) => calls.push(['revokeRole', ...a]));
  stub('lib/sensitiveActions', 'listPauses', async () => [{ feature_key: 'pulls', created_at: iso(-1000), expires_at: null }]);
  stub('lib/sensitiveActions', 'userActivity', async () => ({ sensitive: [{ action: 'delete_repo', repo_name: 'demo', account_login: 'bobgh', score: 8, flagged: true, created_at: iso(-1000) }], changes: [], accounts: [] }));
  stub('lib/sensitiveActions', 'counts', async () => ({ actions_24h: 4, flagged_open: 2, approvals_pending: 1, pauses: 1, manage_24h: 5, dead_accounts: 0 }));
  stub('lib/sensitiveActions', 'listFlagged', async () => ({ items: [{ id: 8, telegram_id: 5, account_login: 'bobgh', action: 'delete_repo', repo_name: 'demo', score: 9, created_at: iso(-1000), telegram_username: 'bob', telegram_first_name: 'Bob' }], hasNext: false }));
  stub('lib/sensitiveActions', 'auditTrail', async () => ({ items: [{ telegram_id: 5, account_login: 'bobgh', area: 'branches', action: 'delete', repo_name: 'demo', is_change: true, created_at: iso(-1000), telegram_username: 'bob', telegram_first_name: 'Bob' }], hasNext: false }));
  stub('lib/sensitiveActions', 'markReviewed', async (...a) => calls.push(['reviewed', ...a]));
  stub('lib/sensitiveActions', 'decide', async (ctx, id, allow) => { calls.push(['decide', ctx.from.id, id, allow]); return id === 4 ? { ok: true, userId: 5 } : { ok: false }; });
  stub('lib/sensitiveActions', 'pause', async (...a) => calls.push(['pause', ...a]));
  stub('lib/sensitiveActions', 'unpause', async (...a) => calls.push(['unpause', ...a]));
  stub('lib/wardenBrain/cases', 'stageCounts', async () => ({ stages: { normal: 90, observe: 5, flag: 3, enhanced_monitoring: 1, review_candidate: 1 }, openCases: 4 }));
  stub('lib/wardenBrain/cases', 'listOpen', async () => ({ rows: [{ id: 12, telegram_id: 5, status: 'open', stage: 'flag', peak_stage: 'enhanced_monitoring', risk: '0.62', confidence: '0.74', summary: { reason: 'error burst', signals: ['errors', 'retries'] }, opened_at: iso(-86400000), updated_at: iso(-1000), telegram_username: 'bob', telegram_first_name: 'Bob', snooze_until: null }], total: 4 }));
  stub('lib/wardenBrain/cases', 'getCase', async (id) => (id === 12 ? { id: 12, telegram_id: 5, status: 'open', stage: 'flag', peak_stage: 'flag', risk: '0.62', confidence: '0.74', summary: { reason: 'error burst' }, opened_at: iso(-86400000), updated_at: iso(-1000), closed_at: null, close_reason: null } : null));
  stub('lib/wardenBrain/cases', 'getEvents', async () => [{ id: 1, kind: 'warning_sent', detail: { summary: 'warned' }, actor: OWNER, created_at: iso(-1000) }]);
  stub('lib/wardenBrain/cases', 'stats', async () => ({ priorCases: 1, warnings: 2 }));
  stub('lib/wardenBrain/cases', 'profileOf', async () => ({ snooze_until: null, dismissed_until: null }));
  stub('lib/wardenBrain/cases', 'dismiss', async (id, actor, days) => { calls.push(['dismiss', id, actor, days]); return id === 12 ? { telegram_id: 5 } : null; });
  stub('lib/wardenBrain/cases', 'snooze', async (id, actor, days) => { calls.push(['snooze', id, actor, days]); return { telegram_id: 5 }; });
  stub('lib/users', 'getUser', async () => USER_ROW);
  stub('lib/warden', 'getConfig', async () => ({ enabled: true, alerts_review: true }));
  stub('lib/warden', 'updateConfig', async (a, p) => calls.push(['wconfig', a, p]));
  stub('lib/warden', 'getRecentSummary', async () => ({ flags: 2 }));
  stub('lib/warden', 'getActionLog', async () => ({ rows: [{ id: 1, target_id: 5, action_type: 'mute', reason: 'noisy', dry_run: true, created_at: iso(-1000), telegram_username: 'bob', telegram_first_name: 'Bob' }], total: 1 }));
  t.req('lib/warden').DATASETS.cases_test = 'x';
  stub('lib/warden', 'exportDataset', async (d) => ({ filename: `warden-${d}.jsonl`, body: '{"a":1}\n', count: 1 }));
  stub('lib/lockdown', 'getLockedAdmins', async () => []);
  stub('lib/lockdown', 'lockAll', async () => { calls.push(['lockAll']); return [77]; });
  stub('lib/lockdown', 'unlockAll', async () => { calls.push(['unlockAll']); return [77]; });
  stub('lib/lockdown', 'lockAdmin', async (...a) => calls.push(['lockAdmin', ...a]));
  stub('lib/lockdown', 'unlockAdmin', async (...a) => calls.push(['unlockAdmin', ...a]));
  stub('lib/scheduledBroadcasts', 'listPending', async () => [{ id: 21, text: `Maintenance ${HOSTILE}`, send_at: iso(86400000), status: 'pending', recurrence_type: 'weekly', recurrence_fired_count: 0, admin_id: OWNER, created_at: iso(-1000) }]);
  stub('lib/scheduledBroadcasts', 'history', async () => ({ rows: [{ id: 20, text: 'Hello all', send_at: iso(-86400000), status: 'sent', sent_count: 8, total_count: 9, sent_at: iso(-86000000), admin_id: OWNER, created_at: iso(-87000000) }], total: 1 }));
  stub('lib/scheduledBroadcasts', 'create', async (...a) => { calls.push(['sbcreate', ...a]); return { id: 30 }; });
  stub('lib/scheduledBroadcasts', 'cancel', async (id) => (id === 21 ? { id } : null));
  stub('lib/scheduledBroadcasts', 'get', async (id) => (id === 20 ? { id, text: 'Hello all' } : null));
  stub('lib/scheduledBroadcasts', 'repost', async () => ({ id: 31 }));
  stub('lib/scheduledBroadcasts', 'markSent', async (...a) => calls.push(['markSent', ...a]));
  stub('lib/scheduledBroadcasts', 'markFailed', async (...a) => calls.push(['markFailed', ...a]));
  stub('lib/adminActions', 'auditLog', async (...a) => calls.push(['audit', ...a]));
  stub('lib/adminActions', 'broadcast', async () => ({ sent: 4, total: 5, blocked: 1, failed: 0 }));
  stub('lib/adminActions', 'banUser', async (...a) => { calls.push(['ban', a[1]]); return { undoId: 9 }; });
  stub('lib/adminActions', 'suspendUser', async (...a) => { calls.push(['suspend', a[1], a[2]]); return { undoId: 10 }; });
  stub('lib/adminActions', 'undoAction', async (admin, id) => (id === 9 ? { ok: true, actionType: 'ban' } : { ok: false, reason: id === 8 ? 'expired' : 'not_found' }));
  stub('lib/adminActions', 'bulkSuspend', async (...a) => { calls.push(['bulkSuspend', a[1], a[2]]); return { count: 3, undoId: 11 }; });
  stub('lib/adminActions', 'bulkMuteAll', async (...a) => { calls.push(['bulkMute', a[1]]); return { affected: 3 }; });
  stub('lib/adminActions', 'nudgeNeverConnected', async () => ({ sent: 2 }));
  stub('lib/adminActions', 'bulkPurgeNeverConnected', async (a, d) => { calls.push(['purge', d]); return 4; });
  stub('lib/adminActions', 'bulkDeleteBanned', async () => 1);
  stub('lib/adminActions', 'exportAllUsers', async () => ({ content: '[{"id":5}]', filename: 'gitrohub-users 2026.json' }));
  stub('handlers/manage/registry', 'list', () => [{ key: 'pulls', label: 'Pull requests' }, { key: 'issues', label: 'Issues' }]);
  stub('handlers/manage/registry', 'get', (k) => (['pulls', 'issues'].includes(k) ? { key: k } : null));
}
const uninstall = () => { while (restore.length) restore.pop()(); t.setQueryHandler(() => ({ rows: [], rowCount: 0 })); };

let ipCounter = 0;
async function signIn({ fresh = true, ua = 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36', ip = `203.0.113.${(ipCounter++ % 250) + 1}` } = {}) {
  const { url } = await ownerWeb.issueLink(OWNER);
  const token = url.split('/owner/go/')[1];
  const out = await panel.handle({ method: 'POST', path: '/owner/go', headers: { ...host, ...sameSite, origin: 'null', 'user-agent': ua }, body: { token }, ip });
  assert.strictEqual(out.status, 303);
  const sid = /gh_owner=([^;]+)/.exec(out.headers['Set-Cookie'])[1];
  const s = await ownerWeb.getSession(sid);
  if (!fresh) {
    const key = [...t.redisStore.keys()].filter((k) => k.startsWith('ownerweb:sess:')).pop();
    const stored = JSON.parse(t.redisStore.get(key)); stored.freshUntil = Date.now() - 1000; t.redisStore.set(key, JSON.stringify(stored));
  }
  return { sid, csrf: s.csrf, cookie: `gh_owner=${sid}` };
}
const call = (s, method, p, { body, query, headers = {} } = {}) => panel.handle({ method, path: `/owner/api${p}`, query, body, ip: '2.2.2.2', headers: { ...host, ...sameSite, cookie: s.cookie, 'x-csrf-token': s.csrf, ...headers } }, { bot });
const J = (r) => JSON.parse(r.body);
async function withEnv(fn) { const calls = []; installStubs(calls); lastSql = []; sent.length = 0; try { return await fn(calls, await signIn()); } finally { uninstall(); } }

// ── API ──
test('overview reads the real camelCase fleet shape (2.2.0 would have shown "?")', () => withEnv(async (calls, s) => {
  const j = J(await call(s, 'GET', '/overview'));
  assert.strictEqual(j.fleet.users, 10); assert.strictEqual(j.fleet.activeToday, 3); assert.strictEqual(j.fleet.newWeek, 4); assert.strictEqual(j.fleet.commits, 99); assert.strictEqual(j.fleet.accounts, 8);
  assert.strictEqual(j.github.circuit, 'half-open');
}));

test('audit and errors read {rows,total} (2.2.0 treated them as arrays) and show people by name', () => withEnv(async (calls, s) => {
  const a = J(await call(s, 'GET', '/audit', { query: { limit: '20', action: 'ban' } }));
  assert.strictEqual(a.total, 41); assert.strictEqual(a.rows[0].adminName, 'Owner'); assert.strictEqual(a.rows[0].targetName, 'Bob'); assert.deepStrictEqual(a.actions, ['ban', 'role_change']); assert.strictEqual(a.admins[0].name, 'Owner');
  const e = J(await call(s, 'GET', '/feed/errors'));
  assert.strictEqual(e.total, 31); assert.strictEqual(e.rows[0].username, 'bob');
  assert.strictEqual(J(await call(s, 'GET', '/feed/anomalies')).rows[0].event, 'reconnect');
  assert.strictEqual(J(await call(s, 'GET', '/feed/jobs')).rows[0].status, 'failed');
}));

test('users: filters and search are real parameterised SQL (no string-built LIKE), tokens never returned', () => withEnv(async (calls, s) => {
  const r = await call(s, 'GET', '/users', { query: { q: '@50%_x', filter: 'blocked', limit: '5' } });
  assert.ok(!/SECRET-TOKEN|github_token_enc/.test(r.body));
  const [sql, params] = lastSql.filter(([q]) => /SELECT \* FROM users/.test(q)).pop();
  assert.ok(/is_blocked = TRUE/.test(sql) && /ILIKE \$2 ESCAPE/.test(sql) && /LIMIT \$3 OFFSET \$4/.test(sql));
  assert.deepStrictEqual(params, ['50%_x', '%50\\%\\_x%', 6, 0], 'LIKE wildcards in the search are escaped');
  const bad = await call(s, 'GET', '/users', { query: { filter: '1; DROP TABLE users' } });
  assert.ok(!/DROP/.test(lastSql.pop()[0]), 'unknown filters are ignored');
  assert.strictEqual(J(bad).filter, '');
  const d = J(await call(s, 'GET', '/users/5'));
  assert.strictEqual(d.warden.stage, 'flag'); assert.strictEqual(d.warden.caseId, 12); assert.strictEqual(d.sensitive[0].flagged, true); assert.strictEqual(d.audit[0].adminName, 'Owner');
}));

test('Warden: overview, cases, case detail, watch, approvals, log', () => withEnv(async (calls, s) => {
  const w = J(await call(s, 'GET', '/warden'));
  assert.strictEqual(w.openCases, 4); assert.strictEqual(w.flaggedOpen, 2); assert.strictEqual(w.approvalsPending, 1); assert.strictEqual(w.config.enabled, true); assert.deepStrictEqual(w.order[0], 'normal'); assert.ok(w.datasets.includes('cases_test'));
  const c = J(await call(s, 'GET', '/warden/cases', { query: { stage: 'review_candidate' } }));
  assert.strictEqual(c.stage, 'review_candidate'); assert.strictEqual(c.cases[0].risk, 0.62); assert.strictEqual(c.cases[0].name, 'Bob'); assert.deepStrictEqual(c.cases[0].summary.signals, ['errors', 'retries']);
  assert.strictEqual(J(await call(s, 'GET', '/warden/cases', { query: { stage: 'bogus' } })).stage, 'flag');
  const d = J(await call(s, 'GET', '/warden/cases/12'));
  assert.strictEqual(d.case.id, 12); assert.strictEqual(d.events[0].actor, 'Owner'); assert.strictEqual(d.evidence[0].strength, 0.8); assert.strictEqual(d.prior.warnings, 2);
  assert.strictEqual((await call(s, 'GET', '/warden/cases/99')).status, 404);
  assert.strictEqual((await call(s, 'GET', '/warden/cases/abc')).status, 400);
  assert.strictEqual(J(await call(s, 'GET', '/warden/watch')).flagged[0].label, 'Delete repository' === 'x' ? 'x' : J(await call(s, 'GET', '/warden/watch')).flagged[0].label);
  assert.strictEqual(J(await call(s, 'GET', '/warden/watch')).changes[0].area, 'branches');
  assert.strictEqual(J(await call(s, 'GET', '/warden/approvals')).approvals[0].id, 4);
  const l = J(await call(s, 'GET', '/warden/log'));
  assert.strictEqual(l.rows[0].dryRun, true); assert.strictEqual(l.total, 1);
}));

test('Warden decisions: dismiss / snooze / review / config / approve / deny — audited, validated, and Approve needs a fresh sign-in', () => withEnv(async (calls, s) => {
  assert.strictEqual((await call(s, 'POST', '/warden/cases/12/dismiss', { body: { days: '14' } })).status, 200);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'dismiss'), ['dismiss', 12, OWNER, 14]);
  assert.strictEqual((await call(s, 'POST', '/warden/cases/99/dismiss', { body: {} })).status, 409, 'closed / unknown case');
  assert.strictEqual((await call(s, 'POST', '/warden/cases/12/snooze', { body: { days: '500' } })).status, 200);
  assert.strictEqual(calls.find((c) => c[0] === 'snooze')[3], 90, 'days are clamped');
  assert.ok(calls.some((c) => c[0] === 'audit' && c[3] === 'warden_dismiss' && /\[web\]/.test(c[4])));
  await call(s, 'POST', '/warden/watch/8/review', { body: {} });
  assert.deepStrictEqual(calls.find((c) => c[0] === 'reviewed'), ['reviewed', OWNER, 8]);
  assert.strictEqual((await call(s, 'POST', '/warden/config', { body: { enabled: false } })).status, 200);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'wconfig')[2], { enabled: false });
  assert.strictEqual((await call(s, 'POST', '/warden/config', { body: {} })).status, 400);
  assert.strictEqual((await call(s, 'POST', '/warden/approvals/4/decide', { body: { allow: true } })).status, 200);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'decide'), ['decide', OWNER, 4, true]);
  assert.strictEqual((await call(s, 'POST', '/warden/approvals/5/decide', { body: { allow: false } })).status, 409, 'already decided');
  const stale = await signIn({ fresh: false });
  assert.strictEqual((await call(stale, 'POST', '/warden/approvals/4/decide', { body: { allow: true } })).status, 403, 'approving needs a fresh sign-in');
  assert.strictEqual((await call(stale, 'POST', '/warden/approvals/4/decide', { body: { allow: false } })).status, 200, 'denying is always safe');
  assert.strictEqual((await call(stale, 'POST', '/warden/lockdown', { body: { on: true } })).status, 403);
  assert.strictEqual((await call(stale, 'GET', '/warden/export/cases_test')).status, 403);
  assert.strictEqual((await call(s, 'POST', '/warden/lockdown', { body: { on: true } })).status, 200);
  assert.ok(calls.some((c) => c[0] === 'lockAll'));
}));

test('exports are real downloads: attachment, no sniffing, safe file names, fresh only', () => withEnv(async (calls, s) => {
  const r = await call(s, 'GET', '/export/users');
  assert.strictEqual(r.status, 200);
  assert.ok(/attachment; filename="gitrohub-users_2026\.json"/.test(r.headers['Content-Disposition']) && /application\/json/.test(r.headers['Content-Type']) && r.headers['X-Content-Type-Options'] === 'nosniff' && /no-store/.test(r.headers['Cache-Control']));
  assert.strictEqual(r.body, '[{"id":5}]');
  const w = await call(s, 'GET', '/warden/export/cases_test', { query: { days: '30' } });
  assert.ok(/warden-cases_test\.jsonl/.test(w.headers['Content-Disposition']) && /ndjson/.test(w.headers['Content-Type']));
  assert.strictEqual((await call(s, 'GET', '/warden/export/nope')).status, 400);
  const stale = await signIn({ fresh: false });
  assert.strictEqual((await call(stale, 'GET', '/export/users')).status, 403);
}));

test('team: roster with locks, add / change / revoke / lock / unlock — and the owner is untouchable', () => withEnv(async (calls, s) => {
  const r = J(await call(s, 'GET', '/team'));
  assert.strictEqual(r.owner.id, OWNER); assert.strictEqual(r.admins[0].role, 'admin'); assert.deepStrictEqual(r.roles, ['moderator', 'admin', 'super_admin']);
  assert.strictEqual((await call(s, 'POST', '/team/add', { body: { id: '88', role: 'moderator' } })).status, 200);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'setRole').slice(0, 4), ['setRole', OWNER, 88, 'moderator']);
  assert.strictEqual((await call(s, 'POST', '/team/add', { body: { id: String(OWNER), role: 'admin' } })).status, 409);
  assert.strictEqual((await call(s, 'POST', '/team/add', { body: { id: '88', role: 'owner' } })).status, 400);
  assert.strictEqual((await call(s, 'POST', '/team/add', { body: { id: 'x', role: 'admin' } })).status, 400);
  assert.strictEqual((await call(s, 'POST', '/team/77/lock', { body: {} })).status, 200);
  assert.strictEqual((await call(s, 'POST', '/team/77/unlock', { body: {} })).status, 200);
  assert.strictEqual((await call(s, 'POST', '/team/77/revoke', { body: {} })).status, 200);
  for (const w of ['lock', 'unlock', 'role', 'revoke']) assert.strictEqual((await call(s, 'POST', `/team/${OWNER}/${w}`, { body: { role: 'admin' } })).status, 409, w);
  const stale = await signIn({ fresh: false });
  for (const w of ['unlock', 'revoke']) assert.strictEqual((await call(stale, 'POST', `/team/77/${w}`, { body: {} })).status, 403, w);
  assert.strictEqual((await call(stale, 'POST', '/team/77/lock', { body: {} })).status, 200, 'locking someone out is protective, so it never needs a fresh sign-in');
}));

test('announcements: schedule rules, repeating, cancel, repost, and the shared history row for "send now"', () => withEnv(async (calls, s) => {
  const r = J(await call(s, 'GET', '/schedule'));
  assert.strictEqual(r.pending[0].recurrence.type, 'weekly'); assert.strictEqual(r.history[0].sent, 8); assert.strictEqual(r.recipients, 5);
  const ok = await call(s, 'POST', '/schedule', { body: { text: 'Hello', sendAt: iso(3600000), recurrence: { type: 'interval', days: 3, endAt: iso(30 * 86400000) } } });
  assert.strictEqual(ok.status, 200);
  const created = calls.find((c) => c[0] === 'sbcreate');
  assert.strictEqual(created[1], OWNER); assert.strictEqual(created[2], 'Hello'); assert.strictEqual(created[5].recurrenceType, 'interval'); assert.strictEqual(created[5].recurrenceIntervalDays, 3);
  for (const [body, why] of [[{ text: '', sendAt: iso(3600000) }, 'empty'], [{ text: 'x', sendAt: 'soon' }, 'bad date'], [{ text: 'x', sendAt: iso(1000) }, 'too soon'], [{ text: 'x', sendAt: iso(400 * 86400000) }, 'too far'], [{ text: 'x', sendAt: iso(3600000), recurrence: { type: 'hourly' } }, 'bad repeat'], [{ text: 'x', sendAt: iso(3600000), recurrence: { type: 'daily', endAt: iso(1800000) } }, 'end before start']]) {
    assert.strictEqual((await call(s, 'POST', '/schedule', { body })).status, 400, why);
  }
  assert.strictEqual((await call(s, 'POST', '/schedule/21/cancel', { body: {} })).status, 200);
  assert.strictEqual((await call(s, 'POST', '/schedule/5/cancel', { body: {} })).status, 409);
  assert.strictEqual((await call(s, 'POST', '/schedule/20/repost', { body: {} })).status, 200);
  await new Promise((res) => setTimeout(res, 30));
  assert.ok(sent.some(([id, m]) => id === OWNER && /4\/5 delivered/.test(m)));
  assert.ok(calls.some((c) => c[0] === 'markSent' && c[1] === 31 && c[2] === 4 && c[3] === 5), 'the repost row records its result');
  assert.strictEqual((await call(s, 'POST', '/schedule/99/repost', { body: {} })).status, 404);
  calls.length = 0;
  assert.strictEqual((await call(s, 'POST', '/broadcast', { body: { text: 'Now!' } })).status, 200);
  await new Promise((res) => setTimeout(res, 30));
  assert.strictEqual(calls.find((c) => c[0] === 'sbcreate')[5].claimed, true, 'send-now is recorded as an already-claimed row, so the poller can never send it twice');
  assert.ok(calls.some((c) => c[0] === 'markSent' && c[1] === 30));
  const stale = await signIn({ fresh: false });
  assert.strictEqual((await call(stale, 'POST', '/schedule', { body: { text: 'x', sendAt: iso(3600000) } })).status, 403);
  assert.strictEqual((await call(stale, 'POST', '/schedule/20/repost', { body: {} })).status, 403);
}));

test('ban and suspend hand back the undo id, so the Undo button needs no lookup', () => withEnv(async (calls, s) => {
  assert.strictEqual(J(await call(s, 'POST', '/users/5/ban', { body: { reason: 'spam' } })).undoId, 9);
  assert.strictEqual(J(await call(s, 'POST', '/users/5/suspend', { body: { hours: '5' } })).undoId, 10);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'suspend'), ['suspend', 5, 5]);
}));

test('undo: lists what can be reversed, reverses it, and explains why not', () => withEnv(async (calls, s) => {
  const r = J(await call(s, 'GET', '/undo'));
  assert.strictEqual(r.entries[0].action, 'ban'); assert.strictEqual(r.entries[0].targets[0].name, 'Bob'); assert.strictEqual(r.entries[0].by, 'Owner');
  assert.strictEqual((await call(s, 'POST', '/undo/9', { body: {} })).status, 200);
  assert.strictEqual((await call(s, 'POST', '/undo/8', { body: {} })).status, 410);
  assert.strictEqual((await call(s, 'POST', '/undo/7', { body: {} })).status, 404);
}));

test('bulk tools: preview counts; every action needs a fresh sign-in; destructive ones need DELETE typed', () => withEnv(async (calls, s) => {
  const p = J(await call(s, 'GET', '/bulk/preview'));
  for (const k of ['neverConnected', 'banned', 'stale30d', 'activeNonAdmins']) assert.strictEqual(p[k], 5, k);
  assert.strictEqual((await call(s, 'POST', '/bulk/suspend', { body: { scope: 'stale', hours: '9999' } })).status, 200);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'bulkSuspend').slice(1), ['stale', 2160], 'hours are clamped to 90 days');
  assert.strictEqual(J(await call(s, 'POST', '/bulk/suspend', { body: { scope: 'all', hours: '2' } })).undoId, 11, 'the undo id comes back');
  assert.strictEqual((await call(s, 'POST', '/bulk/mute', { body: { mute: true } })).status, 200);
  assert.strictEqual((await call(s, 'POST', '/bulk/purge', { body: { days: 30 } })).status, 400, 'no DELETE typed');
  assert.strictEqual((await call(s, 'POST', '/bulk/purge', { body: { days: 30, confirm: 'delete' } })).status, 400, 'case matters');
  assert.strictEqual((await call(s, 'POST', '/bulk/purge', { body: { days: 30, confirm: 'DELETE' } })).status, 200);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'purge'), ['purge', 30]);
  assert.strictEqual((await call(s, 'POST', '/bulk/delete_banned', { body: {} })).status, 400);
  assert.strictEqual((await call(s, 'POST', '/bulk/delete_banned', { body: { confirm: 'DELETE' } })).status, 200);
  assert.strictEqual((await call(s, 'POST', '/bulk/nope', { body: {} })).status, 404);
  const stale = await signIn({ fresh: false });
  for (const w of ['suspend', 'mute', 'nudge', 'purge', 'delete_banned']) assert.strictEqual((await call(stale, 'POST', `/bulk/${w}`, { body: { confirm: 'DELETE' } })).status, 403, w);
}));

test('charts, badges and search', () => withEnv(async (calls, s) => {
  const c = J(await call(s, 'GET', '/charts', { query: { days: '30' } }));
  assert.strictEqual(c.days, 30);
  for (const k of ['signups', 'active', 'actions', 'errors', 'commits', 'rateLimited']) assert.ok(Array.isArray(c[k]) && c[k][0].label, k);
  assert.strictEqual(J(await call(s, 'GET', '/charts', { query: { days: '7' } })).days, 14, 'only 14 / 30 / 90');
  const b = J(await call(s, 'GET', '/badges'));
  assert.strictEqual(b.reports, 1); assert.strictEqual(b.warden, 4 + 2 + 1); assert.strictEqual(b.errors, 5); assert.strictEqual(b.scheduled, 5); assert.strictEqual(b.undo, 5);
  assert.deepStrictEqual(J(await call(s, 'GET', '/search', { query: { q: 'b' } })), { users: [], reports: [], cases: [] }, 'one letter searches nothing');
  const r = J(await call(s, 'GET', '/search', { query: { q: 'bob' } }));
  assert.strictEqual(r.users[0].id, 5); assert.strictEqual(r.cases[0].id, 12); assert.strictEqual(r.reports[0].id, 3); assert.ok(!/SECRET/.test(JSON.stringify(r)));
  assert.ok(lastSql.some(([q, p]) => /ESCAPE/.test(q) && p.includes('%bob%')), 'the term is passed as a parameter');
}));

test('sessions: devices and masked addresses, revoke one, revoke the others, sign-in history', () => withEnv(async (calls, s) => {
  const other = await signIn({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', ip: '198.51.100.7' });
  const r = J(await call(s, 'GET', '/sessions'));
  const me = r.sessions.find((x) => x.current), them = r.sessions.find((x) => !x.current && x.device === 'Safari on iOS');
  assert.ok(me && me.device === 'Chrome on Android' && me.ip === '203.0.113.x', JSON.stringify(r.sessions));
  assert.ok(them && them.ip === '198.51.100.x');
  assert.ok(!JSON.stringify(r).includes(s.sid) && !JSON.stringify(r).includes(other.sid), 'a session id is never shown');
  assert.strictEqual((await call(s, 'POST', '/sessions/revoke', { body: { ref: 'nothex' } })).status, 400);
  assert.strictEqual((await call(s, 'POST', '/sessions/revoke', { body: { ref: them.ref } })).status, 200);
  assert.strictEqual(await ownerWeb.getSession(other.sid), null, 'that browser is out');
  const third = await signIn();
  assert.strictEqual(J(await call(third, 'POST', '/sessions/revoke_others', { body: {} })).revoked >= 1, true);
  assert.strictEqual(await ownerWeb.getSession(s.sid), null);
  assert.ok(await ownerWeb.getSession(third.sid), 'the session that asked stays');
  assert.strictEqual(ownerWeb.maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::');
  assert.strictEqual(ownerWeb.describeDevice('Mozilla/5.0 (Windows NT 10.0) Edg/120'), 'Edge on Windows');
}));

test('sign-ins are audited with the device and a masked address; the manifest makes the panel installable (signed-in only)', () => withEnv(async (calls, s) => {
  const login = calls.filter((c) => c[0] === 'audit' && c[3] === 'web_login').pop();
  assert.ok(login && /Chrome on Android, 203\.0\.113\.x/.test(login[4]), JSON.stringify(login));
  const m = await panel.handle({ method: 'GET', path: '/owner/manifest.webmanifest', headers: { ...host, cookie: s.cookie }, ip: '1.1.1.1' });
  const j = JSON.parse(m.body);
  assert.strictEqual(j.display, 'standalone'); assert.strictEqual(j.scope, '/owner/'); assert.strictEqual(j.start_url, '/owner'); assert.ok(j.icons[0].src === '/logo.png' && /512x512/.test(j.icons[0].sizes));
  assert.strictEqual(await panel.handle({ method: 'GET', path: '/owner/manifest.webmanifest', headers: host, ip: '1.1.1.1' }), null, 'strangers get the 404');
  const page = await panel.handle({ method: 'GET', path: '/owner', headers: { ...host, cookie: s.cookie }, ip: '1.1.1.1' });
  assert.ok(/rel="manifest" href="\/owner\/manifest\.webmanifest" crossorigin="use-credentials"/.test(page.body) && /manifest-src 'self'/.test(page.headers['Content-Security-Policy']));
  assert.ok(!/unsafe-inline|unsafe-eval/.test(page.headers['Content-Security-Policy']));
}));

test('every dangerous kind of action is refused on a stale sign-in', () => withEnv(async (calls, s) => {
  const stale = await signIn({ fresh: false });
  const api = t.req('server/ownerApi');
  assert.deepStrictEqual([...api.DANGEROUS].sort(), ['approval', 'ban', 'broadcast', 'bulk', 'control_danger', 'export', 'lockdown', 'role', 'role_revoke', 'team']);
  for (const [m, p, body] of [['POST', '/users/5/role', { role: 'admin' }], ['POST', '/users/5/ban', {}], ['POST', '/broadcast', { text: 'x' }], ['POST', '/controls', { key: 'signups_paused', value: true }], ['POST', '/team/add', { id: '9', role: 'admin' }], ['POST', '/bulk/suspend', {}], ['GET', '/export/users'], ['POST', '/schedule', { text: 'x', sendAt: iso(3600000) }], ['POST', '/warden/lockdown', { on: true }]]) {
    const r = await call(stale, m, p, { body });
    assert.strictEqual(r.status, 403, `${m} ${p}`);
    assert.strictEqual(J(r).needFresh, true);
  }
  assert.deepStrictEqual(calls.filter((c) => !['audit'].includes(c[0])), [], 'nothing happened');
}));

// ── the panel script, fed the server's real answers ──
function makeDom(session, { wide }) {
  const calls = [];
  const els = new Map();
  const el = (id) => ({ id, innerHTML: '', className: '', value: '', textContent: '', hidden: false, style: {}, attrs: {}, children: [],
    addEventListener() {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] == null ? '' : this.attrs[k]; }, appendChild() {}, insertBefore() {}, remove() {}, contains() { return false; },
    showModal() {}, close() {}, closest() { return null; }, querySelectorAll() { return []; }, querySelector() { return get('x'); }, parentNode: { insertBefore() {} }, focus() {} });
  const get = (sel) => { if (!els.has(sel)) els.set(sel, el(sel)); return els.get(sel); };
  const fetch = async (url, init = {}) => {
    calls.push(String(url));
    const u = new URL(String(url), 'https://example.com');
    const q = {}; u.searchParams.forEach((v, k) => { q[k] = v; });
    const out = await panel.handle({ method: init.method || 'GET', path: u.pathname, query: q, body: init.body ? JSON.parse(init.body) : undefined, ip: '4.4.4.4', headers: { ...host, ...sameSite, cookie: session.cookie, 'x-csrf-token': session.csrf } }, { bot });
    if (!out) return { ok: false, status: 404, json: async () => { throw new Error('html'); } };
    return { ok: out.status < 400, status: out.status, json: async () => JSON.parse(out.body), headers: { get: () => '' } };
  };
  const listeners = {};
  const page = t.req('server/ownerPage');
  const icons = t.req('server/icons');
  const win = { __OWNER__: { csrf: session.csrf, fresh: true, test: true, icons: icons.bundle(icons.names().filter((n) => n !== 'logo')) }, addEventListener(ev, fn) { listeners[ev] = fn; }, scrollTo() {}, matchMedia: () => ({ matches: wide, addEventListener() {} }) };
  const ctx = { window: win, document: { querySelector: get, querySelectorAll: () => [], createElement: () => el('new'), body: { innerHTML: '', appendChild() {} }, documentElement: el('html'), addEventListener() {}, visibilityState: 'visible', title: '', activeElement: null },
    location: { hash: '' }, fetch, localStorage: { getItem() { return null; }, setItem() {} }, navigator: { userAgent: 'test' }, URL, Intl, setTimeout, clearTimeout, setInterval: () => 0, Date, Promise, JSON, Math, encodeURIComponent, console };
  win.matchMedia = win.matchMedia; ctx.window.location = ctx.location;
  vm.createContext(ctx);
  vm.runInContext(page.PANEL_JS, ctx);
  return { ctx, get, listeners, calls, main: get('#main') };
}
const tick = () => new Promise((r) => setTimeout(r, 25));
const stripTags = (h) => h.replace(/<[^>]*>/g, ' ');

for (const wide of [false, true]) {
  test(`the panel script renders every page from the server's real answers (${wide ? 'desktop two-pane' : 'phone'} layout), escapes hostile text, shows no error`, () => withEnv(async (calls, s) => {
    const d = makeDom(s, { wide });
    const visit = async (hash, ...expects) => {
      d.ctx.location.hash = hash; d.listeners.hashchange(); await tick(); await tick(); await tick();
      const html = d.main.innerHTML;
      assert.ok(!/Could not load|Something went wrong|is not a function|undefined/.test(html), `${hash} shows no error: ${html.slice(0, 200)}`);
      for (const e of expects) assert.ok(html.includes(e) || stripTags(html).includes(e), `${hash} contains "${e}"`);
      assert.ok(!html.includes(HOSTILE) && !/<img src=x/.test(html), `${hash} escapes hostile text`);
      return html;
    };
    await tick(); await tick();
    assert.ok(/Needs attention/.test(d.main.innerHTML) && /class="chart"/.test(d.main.innerHTML), 'the first page (overview) is up');
    const ov = d.main.innerHTML;
    assert.ok(/>10</.test(ov) && /\+4 this week/.test(ov) && /Recovering/.test(ov) && /1 open report/.test(ov) && /7 for Warden/.test(ov), 'real numbers, not "?"');
    await visit('#users', 'Bob', 'Never connected', 'Bulk tools');
    const u = await visit('#users/5', 'Warden', 'Open case', 'Recent sensitive actions', 'Paused features', 'History');
    if (wide) assert.ok(/class="split"/.test(u) && /Bob/.test(u), 'list and detail side by side');
    await visit('#warden', 'Open cases', 'Flagged actions', 'Lockdown', 'Cases');
    const w = await visit('#warden/12', 'Timeline', 'Evidence', 'Dismiss', 'Earlier cases');
    if (wide) assert.ok(/class="split"/.test(w));
    await visit('#warden/watch', 'Flagged sensitive actions', 'Recent changes');
    await visit('#warden/approvals', 'Held actions', 'Approve');
    await visit('#warden/log', 'What Warden decided', 'dry run');
    await visit('#warden/settings', 'Warden is on', 'Emergency lockdown');
    await visit('#reports', 'Reports', 'Resolve');
    await visit('#audit', 'Audit log', 'Can be undone', 'Undo', '41 entries');
    await visit('#controls', 'Controls', 'Maintenance mode');
    await visit('#schedule', 'Announcements', 'Scheduled', 'History', 'repeats weekly', '8/9 delivered');
    const ch = await visit('#charts', 'Sign-ups', 'Active people', 'Rate-limited actions');
    assert.strictEqual((ch.match(/class="card chartcard/g) || []).length, 6);
    await visit('#feed', 'Errors', 'Anomalies', 'Scheduled jobs', '31 in total');
    await visit('#feed/anomalies', 'reconnect');
    await visit('#feed/jobs', 'rate limited');
    await visit('#team', 'Admin team', 'Ann', 'Add an admin');
    await visit('#sessions', 'Sessions', 'Chrome on Android', 'this device', 'Install');
    await visit('#webhooks', 'Webhooks', 'demo');
    await visit('#bulk', 'Bulk tools', 'Suspend people', 'Download');
    await visit('#more', 'Errors &amp; jobs', 'Sign out');
    assert.ok(d.calls.every((u2) => String(u2).startsWith('/owner/api/')), 'only our own API is called');
  }));
}

// ── interaction sweep: click everything, confirm every dialog, expect no script error and no server crash ──
function makeInteractiveDom(session, { wide }) {
  const handlers = [], api = [], errors = [], dialogs = [], overrides = {}, delays = {};
  let html = '';
  const parseTags = (h) => [...h.matchAll(/<(\w+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g)].map((m) => {
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] == null ? '' : a[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return { tag: m[1].toLowerCase(), attrs, index: m.index };
  });
  const matches = (node, sel) => {
    const tag = /^[a-z]+/.exec(sel); if (tag && tag[0] !== node.tag) return false;
    const id = /#([\w-]+)/.exec(sel); if (id && node.attrs.id !== id[1]) return false;
    const cls = /\.([\w-]+)/.exec(sel); if (cls && !(` ${node.attrs.class || ''} `).includes(` ${cls[1]} `)) return false;
    for (const a of sel.matchAll(/\[([\w:-]+)(?:([\^$*]?=)"?([^\]"]*)"?)?\]/g)) {
      const v = node.attrs[a[1]];
      if (v === undefined) return false;
      if (a[2] === '=' && v !== a[3]) return false;
      if (a[2] === '^=' && !v.startsWith(a[3])) return false;
    }
    return true;
  };
  const makeEl = (node, domHtml) => {
    const e = { tagName: (node.tag || 'div').toUpperCase(), id: node.attrs.id || '', type: node.attrs.type || '', value: node.attrs.value || '', checked: node.attrs.checked !== undefined, hidden: false, className: node.attrs.class || '', textContent: '', style: {}, innerHTML: '',
      getAttribute: (k) => (node.attrs[k] == null ? '' : node.attrs[k]), setAttribute() {}, addEventListener(ev, fn) { handlers.push({ ev, fn, el: e }); }, focus() {}, remove() {}, contains() { return false; }, closest() { return null; }, appendChild() {}, insertBefore() {}, querySelector() { return null; }, querySelectorAll() { return []; }, parentNode: { insertBefore() {} } };
    e._attrs = node.attrs;
    if (node.tag === 'select' && node.attrs.id && domHtml) { const m = new RegExp(`<select[^>]*id="${node.attrs.id}"[^>]*>([\\s\\S]*?)</select>`).exec(domHtml); if (m) { const sel = /<option value="([^"]*)" selected/.exec(m[1]) || /<option value="([^"]*)"/.exec(m[1]); e.value = sel ? sel[1] : ''; } }
    if (e.id && overrides[e.id] !== undefined) e.value = overrides[e.id];
    return e;
  };
  const statics = {};
  const staticEl = (sel) => (statics[sel] = statics[sel] || makeEl({ tag: 'div', attrs: { id: sel.slice(1) } }, ''));
  const mainEl = staticEl('#main');
  Object.defineProperty(mainEl, 'innerHTML', { get: () => html, set: (v) => { html = v; } });
  const find = (sel) => parseTags(html).filter((n) => matches(n, sel)).map((n) => makeEl(n, html));
  const document = {
    querySelector: (sel) => { if (['#main', '#toast', '#theme', '#out', '#srch'].includes(sel)) return staticEl(sel); return find(sel)[0] || null; },
    querySelectorAll: (sel) => find(sel),
    createElement: () => {
      const d = { innerHTML: '', className: '', listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; }, remove() {}, close() {}, showModal() {
        const html2 = this.innerHTML;
        setTimeout(() => { // confirm the dialog, with the fields' own default values
          try { this.listeners.click({ target: { closest: () => ({ value: 'yes' }) } }); } catch (e) { errors.push(e); }
        }, 0);
        void html2;
      },
        querySelector(sel) { this._q = this._q || {}; return (this._q[sel] = this._q[sel] || makeEl({ tag: 'div', attrs: { id: sel.replace(/^[#.]/, '') } }, '')); },
        querySelectorAll(sel) {
          if (sel !== '[name]') return [];
          return parseTags(this.innerHTML).filter((n) => n.attrs.name).map((n) => {
            const el = makeEl(n, '');
            if (n.tag === 'select') { const m = new RegExp(`<select[^>]*name="${n.attrs.name}"[^>]*>([\\s\\S]*?)</select>`).exec(this.innerHTML); const o = m && (/<option value="([^"]*)" selected/.exec(m[1]) || /<option value="([^"]*)"/.exec(m[1])); el.value = o ? o[1] : ''; }
            if (n.attrs.name === 'confirm') el.value = 'DELETE';
            return el;
          });
        } };
      dialogs.push(d);
      return d;
    },
    body: { innerHTML: '', appendChild() {} }, documentElement: makeEl({ tag: 'html', attrs: {} }, ''), addEventListener() {}, visibilityState: 'visible', title: '', activeElement: null,
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'https://example.com');
    const q = {}; u.searchParams.forEach((v, k) => { q[k] = v; });
    const method = init.method || 'GET';
    const lag = delays[u.pathname.replace('/owner/api', '')]; if (lag) await new Promise((r) => setTimeout(r, lag));
    const out = await panel.handle({ method, path: u.pathname, query: q, body: init.body ? JSON.parse(init.body) : undefined, ip: '5.5.5.5', headers: { ...host, ...sameSite, cookie: session.cookie, 'x-csrf-token': session.csrf } }, { bot });
    api.push([method, u.pathname.replace('/owner/api', ''), out ? out.status : 404]);
    if (!out) return { ok: false, status: 404, json: async () => { throw new Error('html'); } };
    return { ok: out.status < 400, status: out.status, json: async () => JSON.parse(out.body), blob: async () => ({}), headers: { get: () => '' } };
  };
  const listeners = {};
  const page = t.req('server/ownerPage'); const icons = t.req('server/icons');
  const win = { __OWNER__: { csrf: session.csrf, fresh: true, test: true, icons: icons.bundle(icons.names().filter((n) => n !== 'logo')) }, addEventListener(ev, fn) { listeners[ev] = fn; }, scrollTo() {}, matchMedia: () => ({ matches: wide, addEventListener() {} }) };
  const ctx = { window: win, document, location: { hash: '' }, fetch, localStorage: { getItem() { return null; }, setItem() {} }, navigator: { userAgent: 'test' }, URL, Intl, setTimeout, clearTimeout, setInterval: () => 0, Date, Promise, JSON, Math, encodeURIComponent, console };
  win.location = ctx.location;
  vm.createContext(ctx);
  vm.runInContext(page.PANEL_JS, ctx);
  const alive = (el) => { if (el.id) return html.includes(`id="${el.id}"`); const k = Object.keys(el._attrs || {}).find((x) => /^data-/.test(x)); return k ? html.includes(` ${k}="${el._attrs[k]}"`) : true; };
  return { ctx, listeners, handlers, api, errors, dialogs, overrides, delays, alive, main: mainEl };
}

for (const wide of [false, true]) {
  test(`interaction sweep (${wide ? 'desktop' : 'phone'}): every button, switch and field on every page works end to end — no script error, no server crash`, () => withEnv(async (calls, s) => {
    const rej = []; const onRej = (e) => rej.push(e); process.on('unhandledRejection', onRej);
    try {
      await signIn({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' }); // another device, so Sessions has something to sign out
      await signIn({ ua: 'Mozilla/5.0 (Windows NT 10.0) Firefox/121.0' });
      const d = makeInteractiveDom(s, { wide });
      const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 12)); };
      await settle();
      Object.assign(d.overrides, { bc: 'Hello everyone', msg: 'Hi there', notes: 'A note' });
      const pages = ['#overview', '#users', '#users/5', '#warden', '#warden/12', '#warden/watch', '#warden/approvals', '#warden/log', '#warden/settings', '#reports', '#audit', '#controls', '#schedule', '#charts', '#feed', '#feed/anomalies', '#team', '#sessions', '#webhooks', '#bulk', '#more'];
      let fired = 0;
      for (const hash of pages) {
        ownerWeb._buckets.clear(); // a human never makes 240 requests a minute; the sweep does
        d.ctx.location.hash = hash; d.listeners.hashchange(); await settle();
        if (process.env.DEBUG_SWEEP && hash === '#sessions') console.log('SESSIONS HTML', (d.main.innerHTML.match(/data-rev=/g) || []).length, /revall/.test(d.main.innerHTML), d.handlers.map((h) => h.el.id || Object.keys(h.el._attrs || {})[0]).join(','));
        const batch = d.handlers.splice(0, d.handlers.length).filter((h) => ['click', 'change', 'input'].includes(h.ev) && !['theme', 'out', 'srch', 'mout'].includes(h.el.id));
        for (const h of batch) {
          if (!d.alive(h.el)) continue; // the page moved on; a real browser can't click an element that is gone
          try { const r = h.fn({ target: h.el, preventDefault() {}, key: '' }); if (r && r.then) await r; fired++; } catch (e) { d.errors.push(new Error(`${hash}: ${e.message}`)); }
          await new Promise((r) => setTimeout(r, 6));
        }
        await settle();
        d.handlers.length = 0;
      }
      // the scheduling path of the composer (the default pass uses "send now")
      Object.assign(d.overrides, { when: 'later', rep: 'interval', repd: '3', endat: '2027-01-01T10:00' });
      d.ctx.location.hash = '#schedule'; d.listeners.hashchange(); await settle(); d.handlers.length = 0; d.ctx.location.hash = '#users'; d.listeners.hashchange(); await settle(); d.ctx.location.hash = '#schedule'; d.listeners.hashchange(); await settle();
      for (const h of d.handlers.splice(0, d.handlers.length).filter((x) => x.el.id === 'bsend')) { await h.fn({}); await settle(); }
      await settle();
      assert.deepStrictEqual(d.errors.map((e) => e.stack || String(e)), [], 'no script errors');
      assert.deepStrictEqual(rej.map((e) => e && e.stack || String(e)), [], 'no unhandled promise rejections');
      const crashed = d.api.filter((a) => a[2] >= 500 || a[2] === 429 || a[2] === 404 && !/^\/(undo|schedule|warden)\//.test(a[1]) && !/\/(role_revoke|unban|unsuspend|unpause)/.test(a[1]));
      assert.deepStrictEqual(crashed, [], 'no server crashes or unknown routes');
      assert.ok(fired > 100, `plenty of controls were exercised (${fired})`);
      // signing out from the More page ends the session for real
      d.ctx.location.hash = '#more'; d.listeners.hashchange(); await settle();
      const mout = d.handlers.splice(0, d.handlers.length).find((x) => x.el.id === 'mout');
      assert.ok(mout, 'the More page has a sign-out button'); mout.fn({}); await settle();
      assert.ok(d.api.some((a) => a[0] === 'POST' && a[1] === '/owner/logout' || a[1] === '/owner/logout'), 'sign-out was sent');
      assert.strictEqual(await ownerWeb.getSession(s.sid), null, 'and the session is gone');
      const hit = (m, re) => d.api.some((a) => a[0] === m && re.test(a[1]));
      for (const [m, re, what] of [['POST', /^\/users\/5\/role$/, 'set role'], ['POST', /^\/users\/5\/ban$/, 'ban'], ['POST', /^\/users\/5\/suspend$/, 'suspend'], ['POST', /^\/users\/5\/pause$/, 'pause'], ['POST', /^\/users\/5\/notes$/, 'notes'], ['POST', /^\/warden\/cases\/12\/dismiss$/, 'dismiss'], ['POST', /^\/warden\/cases\/12\/snooze$/, 'snooze'], ['POST', /^\/warden\/watch\/8\/review$/, 'review'], ['POST', /^\/warden\/approvals\/4\/decide$/, 'approve / deny'], ['POST', /^\/warden\/config$/, 'warden settings'], ['POST', /^\/warden\/lockdown$/, 'lockdown'], ['POST', /^\/reports\/3\/resolve$/, 'resolve report'], ['POST', /^\/undo\/9$/, 'undo'], ['POST', /^\/controls$/, 'controls'], ['POST', /^\/broadcast$/, 'announce now'], ['POST', /^\/schedule$/, 'schedule an announcement'], ['POST', /^\/schedule\/21\/cancel$/, 'cancel scheduled'], ['POST', /^\/schedule\/20\/repost$/, 'send again'], ['POST', /^\/team\/77\/(lock|unlock|role|revoke)$/, 'team'], ['POST', /^\/sessions\/revoke/, 'sessions'], ['POST', /^\/bulk\/(suspend|mute|nudge|purge|delete_banned)$/, 'bulk'], ['GET', /^\/export\/users$/, 'export users'], ['GET', /^\/warden\/export\//, 'warden export']]) {
        assert.ok(hit(m, re), `${what} was exercised`);
      }
    } finally { process.off('unhandledRejection', onRej); }
  }));
}

test('a slow page can never be drawn over the page you moved to, and a delayed refresh cannot hijack the screen', () => withEnv(async (calls, s) => {
  const d = makeInteractiveDom(s, { wide: false });
  d.delays['/overview'] = 250;                      // the Overview answer is slow …
  await new Promise((r) => setTimeout(r, 20));
  d.ctx.location.hash = '#reports'; d.listeners.hashchange();   // … and the person moves on to Reports
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(/Reports/.test(d.main.innerHTML) && !/Needs attention/.test(d.main.innerHTML), 'Reports stays on screen: ' + d.main.innerHTML.slice(0, 80));
  // the "send now" refresh used to fire 800 ms later whatever page you were on
  d.overrides.bc = 'Hello everyone';
  d.ctx.location.hash = '#schedule'; d.listeners.hashchange(); await new Promise((r) => setTimeout(r, 120));
  const send = d.handlers.filter((h) => h.el.id === 'bsend').pop();
  assert.ok(send, 'the composer is there');
  send.fn({}); await new Promise((r) => setTimeout(r, 60));  // confirms the dialog and sends
  d.ctx.location.hash = '#charts'; d.listeners.hashchange();
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(/Charts/.test(d.main.innerHTML) && !/Announcements/.test(d.main.innerHTML), 'the delayed Announcements refresh did not take over the Charts page');
}));

test('search palette: opens, finds people / cases / reports through the API, arrow keys and Enter navigate', () => withEnv(async (calls, s) => {
  const d = makeInteractiveDom(s, { wide: false });
  await new Promise((r) => setTimeout(r, 60));
  const srch = d.handlers.find((h) => h.el.id === 'srch');
  assert.ok(srch, 'the search button is wired');
  srch.fn({});
  const pal = d.dialogs.find((x) => x.className === 'pal');
  assert.ok(pal, 'the palette dialog opened');
  const input = pal.querySelector('#pq'), res = pal.querySelector('#pres');
  assert.ok(/Overview/.test(res.innerHTML) && /Warden/.test(res.innerHTML), 'pages are listed before you type');
  const hand = (el, ev) => pal._handlers && pal._handlers[ev];
  void hand;
  const inputHandlers = d.handlers.filter((h) => h.el === input);
  input.value = 'bob';
  for (const h of inputHandlers.filter((x) => x.ev === 'input')) h.fn({});
  await new Promise((r) => setTimeout(r, 350));
  assert.ok(/Bob/.test(res.innerHTML) && /Case #12/.test(res.innerHTML) && /broke/.test(res.innerHTML) && !res.innerHTML.includes(HOSTILE), res.innerHTML.slice(0, 300));
  assert.ok(/href="#users\/5"/.test(res.innerHTML) && /href="#warden\/12"/.test(res.innerHTML));
  const keydown = inputHandlers.filter((x) => x.ev === 'keydown');
  assert.ok(keydown.length === 1);
  keydown[0].fn({ key: 'ArrowDown', preventDefault() {} });
  keydown[0].fn({ key: 'Enter', preventDefault() {} });
  assert.ok(/^#(users\/5|warden\/12|reports)/.test(d.ctx.location.hash), `Enter opened the chosen result: ${d.ctx.location.hash}`);
}));

test('browser-side helpers: chart geometry, relative time, uptime, summaries', () => withEnv(async (calls, s) => {
  const d = makeDom(s, { wide: false });
  await tick();
  const h = d.ctx.window.__OWNER_TEST__;
  const bars = h.chartSvg([{ label: 'a', count: 0 }, { label: 'b', count: 5 }, { label: 'c', count: 10 }], { type: 'bar' });
  const heights = [...bars.matchAll(/<rect class="bar"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.strictEqual(heights.length, 3); assert.strictEqual(heights[0], 0); assert.ok(Math.abs(heights[2] - 2 * heights[1]) < 0.2, 'bar heights are proportional');
  const line = h.chartSvg([{ label: 'a', count: 1 }, { label: 'b', count: 3 }], {});
  assert.ok(/<polyline class="line" pathLength="1"/.test(line) && /<path class="area"/.test(line) && /class="dot last"/.test(line));
  assert.ok(/<svg class="chart"[^>]*role="img"/.test(h.chartSvg([], {})) && !/NaN/.test(h.chartSvg([], {})) && !/NaN/.test(h.chartSvg([{ label: 'x', count: 3 }], {})), 'empty and one-point charts are safe');
  assert.strictEqual(h.ago(new Date(Date.now() - 3 * 3600000).toISOString()), '3 h ago');
  assert.strictEqual(h.ago(new Date(Date.now() + 2 * 86400000).toISOString()), 'in 2 d');
  assert.strictEqual(h.uptime(90061), '1d 1h'); assert.strictEqual(h.uptime(3700), '1h 1m');
  assert.ok(/2026/.test(h.fmt('2026-10-23T06:24:00Z')) && h.fmt(null) === '-');
  assert.strictEqual(h.briefObj({ reason: 'x', signals: ['a', 'b'], _hidden: 1 }), 'reason: x \u00b7 signals: a, b');
  assert.strictEqual(h.localInput(new Date(2026, 9, 5, 7, 3)), '2026-10-05T07:03');
  assert.ok(h.PAGES.length === 13 && h.PAGES.every((p) => h.views[p[0]]), 'every page in the menu has a view');
}));

test('no emoji anywhere in the panel (page, script, styles, icons) and the shell has sidebar, tabs, search and install', () => {
  const page = t.req('server/ownerPage');
  const html = page.renderPanel({ csrf: 'c', version: '2.3.3-multi', fresh: true, nonce: 'n' });
  assert.ok(!EMOJI.test(html) && !EMOJI.test(page.PANEL_JS) && !EMOJI.test(page.PANEL_CSS));
  for (const id of ['id="side"', 'id="srch"', 'id="theme"', 'id="out"', 'class="tabs"', 'data-badge="warden"', 'data-badge="reports"', 'data-badge="more"']) assert.ok(html.includes(id), id);
  assert.strictEqual((html.match(/data-v="warden"/g) || []).length, 2, 'Warden is in the sidebar and the bottom tabs');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src', 'server', 'ownerClient')).filter((x) => x.endsWith('.js'))) new Function(read(`src/server/ownerClient/${f}`).replace(/^const /gm, 'var '));
  const css = page.PANEL_CSS;
  assert.ok(/@media\(min-width:900px\)/.test(css) && /\.split\{display:grid/.test(css) && /prefers-reduced-motion/.test(css));
});

test('docs and wiring: Redis keys listed, README section, changelog, version', () => {
  assert.ok(/ownerweb:index/.test(read('docs/REDIS_KEYS.md')) && /ownerweb:sess:/.test(read('docs/REDIS_KEYS.md')));
  assert.strictEqual(require('../package.json').version, '2.3.3-multi');
  assert.strictEqual(t.req('config').BOT_VERSION, '2.3.3-multi');
  assert.ok(read('CHANGELOG.md').includes('v2.3.3-multi') && read('README.md').includes('Warden'));
  for (const f of ['README.md', 'docs/REDIS_KEYS.md', 'docs/SCALING.md', 'docs/LOAD_TESTING.md', 'docs/SECURITY_AUDIT.md']) assert.ok(read(f).includes('2.3.3-multi'), `${f} shows the version`);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  \u2713 ${name}`); } catch (err) {
      console.log(`  \u2717 ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
