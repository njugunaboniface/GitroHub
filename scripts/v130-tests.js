#!/usr/bin/env node
/**
 * v1.3.0-multi — navigation redesign tests (offline): one-row bottom menu, 💼 Workspace, ⚙️ Settings, the inline
 * 🛡️ Admin dashboard and its tiers, re-anchoring of typed answers, and stale-screen handling.
 * Run:  node scripts/v130-tests.js   (npm run test:v130)
 */
const assert = require('assert');
const t = require('./lib/testEnv');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function makeCtx({ id = 42, admin = false, callback = true } = {}) {
  const sent = [];
  const deleted = [];
  const ctx = {
    from: { id, username: 'tester' }, sent, deleted, chat: { id }, session: {}, state: { isAdmin: admin },
    reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: 100 + sent.length }; },
    editMessageText: async (text, extra) => { sent.push({ text, extra, edited: true }); return true; },
    answerCbQuery: async () => {},
    deleteMessage: async () => { deleted.push('typed'); },
    telegram: { deleteMessage: async (chat, mid) => { deleted.push(mid); } },
  };
  if (callback) ctx.callbackQuery = { data: 'x', message: { message_id: 1 } };
  else ctx.message = { text: 'typed answer', message_id: 7 };
  return ctx;
}
const inline = (extra) => ((extra && extra.reply_markup && extra.reply_markup.inline_keyboard) || []);
const flat = (extra) => inline(extra).flat();
const texts = (extra) => flat(extra).map((b) => b.text);
const keyboardRows = (kb) => kb.reply_markup.keyboard || kb.reply_markup.inline_keyboard;

function stub(obj, patch) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = obj[k]; obj[k] = patch[k]; }
  return () => { for (const k of Object.keys(saved)) obj[k] = saved[k]; };
}

function withUser({ connected = true, scope = 'repo,delete_repo,gist,notifications,read:org,project' } = {}) {
  const users = t.req('lib/users');
  return stub(users, { isConnected: async () => connected, getUser: async () => ({ github_scope: scope }) });
}

function registerAreas() {
  const reg = t.req('handlers/manage/registry');
  reg._resetForTests();
  t.req('handlers/manage/areas').registerAll();
  return reg;
}

test('home bar: 2×2 for everyone (admins included); disconnected people get Connect + Workspace', () => {
  const bbtb = t.req('keyboards/bbtb');
  for (const admin of [false, true]) {
    const rows = keyboardRows(bbtb.mainMenuFor(admin));
    assert.strictEqual(rows.length, 2, `admin=${admin}: two rows`);
    assert.deepStrictEqual(rows[0].map((b) => b.text || b), ['📁 My Repos', '💼 Workspace']);
    assert.deepStrictEqual(rows[1].map((b) => b.text || b), ['⚙️ Settings', '🔔 Notifications']);
  }
  for (const admin of [false, true]) {
    const rows = keyboardRows(bbtb.disconnectedFor(admin));
    assert.deepStrictEqual(rows[0].map((b) => b.text || b), ['🔗 Connect GitHub', '💼 Workspace']);
  }
});

test('workspace: connected home shows its tiles; PRs/Issues/Accounts/Admin moved elsewhere', async () => {
  registerAreas();
  const restore = withUser();
  try {
    const ctx = makeCtx();
    await t.req('handlers/hub').showWorkspace(ctx);
    const labels = texts(ctx.sent[0].extra).join(' | ');
    for (const want of ['Search GitHub', 'Gists', 'Projects', 'Organisations', 'Restore center']) {
      assert.ok(labels.includes(want), `tile ${want} present in: ${labels}`);
    }
    for (const gone of ['My work', 'Pull requests', 'Issues', 'Notifications', 'Settings', 'Admin']) assert.ok(!labels.includes(gone), `${gone} no longer in Workspace`);
  } finally { restore(); }
});

test('workspace: a tile whose GitHub permission is missing gets a 🔒', async () => {
  registerAreas();
  const restore = withUser({ scope: 'repo,delete_repo' });
  try {
    const ctx = makeCtx();
    await t.req('handlers/hub').showWorkspace(ctx);
    const labels = texts(ctx.sent[0].extra);
    assert.ok(labels.some((l) => /🔒 .*Gists/.test(l)), labels.join('|'));
    assert.ok(labels.some((l) => /🔒 .*Organisations/.test(l)));
    assert.ok(labels.some((l) => /🔒 .*Projects/.test(l)));
    assert.ok(!labels.some((l) => /🔒 .*Search/.test(l)), 'search needs no extra scope');
  } finally { restore(); }
});

test('disconnected people get a Connect card and a limited Settings; admins see Admin (and the version) in Settings only', async () => {
  registerAreas();
  const restore = withUser({ connected: false });
  const restoreOauth = stub(t.req('lib/oauth'), { connectUrl: async () => 'https://example.test/connect' });
  const restoreAtt = stub(t.req('lib/adminAttention'), { counts: async () => ({ total: 2, reports: 2, flagged: 0, held: 0 }) });
  try {
    const ctx = makeCtx();
    await t.req('handlers/hub').showWorkspace(ctx);
    const labels = texts(ctx.sent[0].extra);
    assert.ok(labels.some((l) => /Connect GitHub/.test(l)));
    assert.ok(!labels.some((l) => /Gists|Restore|Admin/.test(l)), 'GitHub tiles are hidden while disconnected');
    const settings = makeCtx();
    await t.req('handlers/hub').showSettings(settings);
    const sl = texts(settings.sent[0].extra).join('|');
    assert.ok(/Help/.test(sl) && /Legal/.test(sl));
    assert.ok(!/Accounts|Automation|Admin/.test(sl), 'limited Settings while disconnected');
    assert.ok(!/v\d/.test(settings.sent[0].text), 'no version for non-admins');
  } finally { restoreAtt(); restoreOauth(); restore(); }
});

test('settings: the Admin tile (admins only) carries a count when something waits', async () => {
  registerAreas();
  const restore = withUser();
  const att = t.req('lib/adminAttention');
  try {
    let restoreAtt = stub(att, { counts: async () => ({ total: 3, reports: 2, flagged: 1, held: 0 }) });
    const busy = makeCtx({ admin: true });
    await t.req('handlers/hub').showSettings(busy);
    assert.ok(texts(busy.sent[0].extra).some((l) => /Admin \(3\)/.test(l)));
    assert.match(busy.sent[0].text, /v\d/, 'admins see the version');
    restoreAtt();
    restoreAtt = stub(att, { counts: async () => ({ total: 0, reports: 0, flagged: 0, held: 0 }) });
    const quiet = makeCtx({ admin: true });
    await t.req('handlers/hub').showSettings(quiet);
    const l = texts(quiet.sent[0].extra).filter((x) => /Admin/.test(x));
    assert.strictEqual(l.length, 1); assert.ok(!/\(/.test(l[0]), 'zero count hidden');
    const user = makeCtx();
    await t.req('handlers/hub').showSettings(user);
    assert.ok(!texts(user.sent[0].extra).some((x) => /Admin/.test(x)), 'non-admins never see Admin');
    restoreAtt();
  } finally { restore(); }
});

test('settings: connected people see the groups; every button fits 64 bytes; sub-screens have a Back target', async () => {
  registerAreas();
  const restore = withUser();
  try {
    const ctx = makeCtx();
    const hub = t.req('handlers/hub');
    await hub.showSettings(ctx);
    const labels = texts(ctx.sent[0].extra).join('|');
    for (const want of ['Accounts', 'Automation', 'Preferences', 'History', 'Data', 'Status', 'Help']) assert.ok(labels.includes(want), want);
    for (const fn of ['showSettings', 'showPrefs', 'showHistory', 'showHelp']) {
      const c = makeCtx();
      await hub[fn](c);
      assert.ok(flat(c.sent[0].extra).every((b) => Buffer.byteLength(b.callback_data || 'x') <= 64), fn);
      if (fn !== 'showSettings') assert.ok(flat(c.sent[0].extra).some((b) => /Back|⬅️/.test(b.text)), `${fn} has a Back target (shown on the bar)`);
    }
  } finally { restore(); }
});

test('hub routing: hub:* opens the screens, unknown nav:* shows the "out of date" card with one tap to refresh', async () => {
  registerAreas();
  const restore = withUser();
  try {
    const hub = t.req('handlers/hub');
    const ctx = makeCtx();
    assert.strictEqual(await hub.route(ctx, 'hub:prefs'), true);
    assert.match(ctx.sent[0].text, /Preferences/);
    const stale = makeCtx();
    assert.strictEqual(await hub.route(stale, 'nav:doesnotexist'), true);
    assert.match(stale.sent[0].text, /out of date/);
    assert.ok(texts(stale.sent[0].extra).some((l) => /Workspace/.test(l)));
    assert.strictEqual(await hub.route(makeCtx(), 'repo:foo'), false);
  } finally { restore(); }
});

test('admin dashboard: five tiles, role-aware first tile, never a bottom keyboard', async () => {
  registerAreas();
  const roles = t.req('lib/roles');
  const att = t.req('lib/adminAttention');
  const restores = [
    stub(t.req('lib/lockdown'), { isLocked: async () => false }),
    stub(roles, { getRole: async () => 'admin', isOwner: () => false, listAdmins: async () => [{}, {}] }),
    stub(att, { counts: async () => ({ total: 2, reports: 2, flagged: 0, held: 0 }), items: async () => ({ reports: [], flagged: [], approvals: [], openCases: 0 }) }),
    stub(t.req('lib/adminStats'), { fleetOverview: async () => ({ totalUsers: 5, activeToday: 2, connected: 4, blocked: 0, suspended: 0, newToday: 1, totalCommits: 9, errorsToday: 0 }) }),
  ];
  try {
    const ctx = makeCtx({ admin: true });
    await t.req('handlers/adminHub').showDashboard(ctx);
    const labels = texts(ctx.sent[0].extra);
    for (const want of ['Attention (2)', 'People', 'Watch', 'Broadcast', 'System', 'Workspace']) assert.ok(labels.some((l) => l.includes(want)), `${want} in ${labels.join('|')}`);
    assert.ok(!ctx.sent[0].extra.reply_markup.keyboard, 'inline only');
    assert.strictEqual(ctx.sent.length, 1, 'one message, no marker message');

    restores.push(stub(roles, { getRole: async () => 'moderator' }));
    const mod = makeCtx({ admin: true });
    await t.req('handlers/adminHub').showDashboard(mod);
    assert.ok(texts(mod.sent[0].extra).some((l) => /Reports \(2\)/.test(l)), 'moderators see "Reports"');
  } finally { restores.reverse().forEach((r) => r()); }
});

test('admin tiers: moderator = counts only; admin = flagged + audit; super admin adds rules; Owner adds Warden, lockdown, traffic', async () => {
  registerAreas();
  const roles = t.req('lib/roles');
  const sens = t.req('lib/sensitiveActions');
  const restores = [
    stub(t.req('lib/lockdown'), { isLocked: async () => false }),
    stub(sens, { counts: async () => ({ flagged_open: 1, actions_24h: 2, pauses: 0 }) }),
  ];
  const hubMod = t.req('handlers/adminHub');
  const watchLabels = async (role, owner) => {
    const r = stub(roles, { getRole: async () => role, isOwner: () => owner });
    try { const c = makeCtx({ admin: true }); await hubMod.showWatch(c); return texts(c.sent[0].extra).join('|'); } finally { r(); }
  };
  const systemLabels = async (role, owner) => {
    const r = stub(roles, { getRole: async () => role, isOwner: () => owner });
    try { const c = makeCtx({ admin: true }); await hubMod.showSystem(c); return texts(c.sent[0].extra).join('|'); } finally { r(); }
  };
  try {
    const mod = await watchLabels('moderator', false);
    assert.ok(!/Flagged|Audit|Warden|Alert rules/.test(mod), `moderator: ${mod}`);
    const adm = await watchLabels('admin', false);
    assert.ok(/Flagged/.test(adm) && /Audit log/.test(adm) && !/Alert rules|Warden/.test(adm), adm);
    const sup = await watchLabels('super_admin', false);
    assert.ok(/Alert rules/.test(sup) && !/Warden/.test(sup), sup);
    const own = await watchLabels('super_admin', true);
    assert.ok(/Warden/.test(own), own);
    assert.ok(!/Lockdown|GitHub traffic|Export/.test(await systemLabels('super_admin', false)));
    const ownSys = await systemLabels('super_admin', true);
    assert.ok(/Lockdown/.test(ownSys) && /GitHub traffic/.test(ownSys) && /Export/.test(ownSys));
  } finally { restores.reverse().forEach((r) => r()); }
});

test('admin attention: owner gets one-tap approve/deny, reports get resolve/dismiss, flagged get reviewed; non-admins are refused', async () => {
  registerAreas();
  const roles = t.req('lib/roles');
  const att = t.req('lib/adminAttention');
  const restores = [
    stub(t.req('lib/lockdown'), { isLocked: async () => false }),
    stub(roles, { getRole: async () => 'super_admin', isOwner: () => true }),
    stub(att, {
      counts: async () => ({ total: 3, reports: 1, flagged: 1, held: 1 }),
      items: async () => ({
        reports: [{ id: 5, message: 'it broke', telegram_id: 9, telegram_username: 'sam' }],
        flagged: [{ id: 6, action: 'delete_repo', score: 70, telegram_id: 9, telegram_username: 'sam' }],
        approvals: [{ id: 7, action: 'delete_repo', repo_name: 'x', telegram_id: 9, telegram_username: 'sam' }],
        openCases: 0,
      }),
    }),
  ];
  try {
    const ctx = makeCtx({ admin: true });
    await t.req('handlers/adminHub').showAttention(ctx);
    const data = flat(ctx.sent[0].extra).map((b) => b.callback_data);
    for (const want of ['admin:mon:appr:7:ok:a', 'admin:mon:appr:7:no:a', 'admin:report:5:resolve', 'admin:report:5:dismiss', 'admin:mon:rev:6']) {
      assert.ok(data.includes(want), `${want} in ${data.join(',')}`);
    }
    assert.ok(data.every((d) => !d || Buffer.byteLength(d) <= 64));
    const plainUser = makeCtx({ admin: false });
    await t.req('handlers/adminHub').showAttention(plainUser);
    assert.ok(!plainUser.sent.some((x) => /Attention/.test(x.text)), 'a non-admin never sees the screen');
  } finally { restores.reverse().forEach((r) => r()); }
});

test('typed answers re-anchor: after an accepted answer the typed message and the prompt are deleted; a bad answer keeps both', async () => {
  const input = t.req('handlers/manage/input');
  const reg = registerAreas();
  void reg;
  const registry = t.req('handlers/manage/registry');
  registry._resetForTests();
  let mode = 'ok';
  registry.register({ key: 'demo', label: 'Demo', emoji: '🔹', level: 'account', scopes: [], handle: async () => {},
    onInput: async (ctx) => { if (mode === 'bad') throw Object.assign(new Error('Too short'), { userInput: true }); await ctx.reply('done'); } });
  const ctx = makeCtx({ callback: false });
  await input.ask(ctx, { area: 'demo', action: 'x', prompt: 'Send it' });
  assert.ok(ctx.session.manageInput.promptId, 'prompt id remembered');
  const promptId = ctx.session.manageInput.promptId;
  mode = 'bad';
  await input.handleText(ctx);
  assert.deepStrictEqual(ctx.deleted, [], 'bad answer: nothing deleted, prompt stays armed');
  assert.ok(ctx.session.manageInput, 're-armed');
  mode = 'ok';
  await input.handleText(ctx);
  assert.ok(ctx.deleted.includes('typed') && ctx.deleted.includes(promptId), JSON.stringify(ctx.deleted));
  registry._resetForTests();
});

test('manage hub: sections follow the locked design (Collaborate / Code / Automate / Insights)', async () => {
  registerAreas();
  const restore = withUser();
  try {
    const ctx = makeCtx();
    await t.req('handlers/manage').showHub(ctx, 'repo1');
    const text = ctx.sent[0].text;
    const order = ['Collaborate', 'Code', 'Automate', 'Insights'].map((s) => text.indexOf(s));
    assert.ok(order.every((i) => i >= 0), text);
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'groups appear in order');
    const labels = texts(ctx.sent[0].extra).join('|');
    for (const want of ['Pull requests', 'Issues', 'Milestones', 'Branches', 'Commits', 'Releases', 'Actions', 'Security', 'Access', 'Insights']) assert.ok(labels.includes(want), want);
    assert.ok(inline(ctx.sent[0].extra).pop().some((b) => /Workspace/.test(b.text)), 'last row has a Workspace button');
  } finally { restore(); }
});

test('inline screens that used to rely on the bottom keyboard now carry Back/Workspace buttons', () => {
  const inl = t.req('keyboards/inline');
  const auto = inl.automationHubActions();
  const d = flat(auto).map((b) => b.callback_data);
  for (const want of ['nav:rules', 'nav:schedule', 'nav:defaults', 'hub:settings', 'manage:ws']) assert.ok(d.includes(want), want);
  assert.ok(flat(inl.rulesHubMenu()).some((b) => b.callback_data === 'automation:runrules'));
  assert.ok(flat(inl.backupRulesMenu([{ id: 1 }])).some((b) => b.callback_data === 'nav:backup'));
  assert.ok(!flat(inl.backupRulesMenu([])).some((b) => b.callback_data === 'nav:backup'), 'Backup Now only when a rule exists');
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
