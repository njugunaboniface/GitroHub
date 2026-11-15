/** ⚡ Manage → Actions (v1.2.4-multi): runs (re-run/cancel), workflows (run/enable/disable), secrets, variables. */
const ui = require('../ui');
const input = require('../input');
const { repoCtx, num, pageOf, workBranch } = require('../common');
const act = require('../../../lib/github/actions');
const core = require('../../../lib/github/core');

const { esc, btn, plain, back, code, ago, trunc, icon, style } = ui;
const D = (action, repo, ...args) => `manage:actions:${[action, repo, ...args].join(':')}`;
const FILTERS = { all: null, failed: 'failure', running: 'in_progress', queued: 'queued', success: 'success' };

const runIcon = (r) => (r.status === 'completed' ? icon(r.conclusion || 'completed') : icon(r.status));

async function hub(ctx, c) {
  return ui.screen(ctx, `⚙️ *Actions* — ${esc(c.repo)}`, [
    [plain('🏃 Workflow runs', D('runs', c.repo, 'all', 1)), plain('📋 Workflows', D('wf', c.repo, 1))],
    [plain('🔐 Secrets', D('secrets', c.repo, 1)), plain('📦 Variables', D('vars', c.repo, 1))],
    back('Manage', `manage:hub:${c.repo}`),
  ]);
}

async function runs(ctx, c, filter, pg, workflowId = null) {
  const r = await act.listRuns(c.token, c.owner, c.repo, { status: FILTERS[filter] || null, page: pg, workflowId });
  const wfArg = workflowId ? [workflowId] : [];
  const chips = Object.keys(FILTERS).filter((k) => ['all', 'failed', 'running'].includes(k)).map((k) => plain(`${k === filter ? '● ' : ''}${k[0].toUpperCase()}${k.slice(1)}`, D('runs', c.repo, k, 1, ...wfArg)));
  const rows = ui.listRows({
    items: r.items,
    render: (x) => ({ label: `${runIcon(x)} #${x.number} ${x.title || x.name}`, data: D('run', c.repo, x.id) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (n) => D('runs', c.repo, filter, n, ...wfArg),
    extra: [chips], backRow: back('Actions', D('home', c.repo)),
  });
  return ui.screen(ctx, `🏃 *Workflow runs* — ${esc(c.repo)}\nFilter: ${esc(filter)}${r.items.length ? '' : '\n\n_No runs\\._'}`, rows);
}

async function runView(ctx, c, id) {
  const [r, jobs] = await Promise.all([act.getRun(c.token, c.owner, c.repo, id), act.listJobs(c.token, c.owner, c.repo, id).catch(() => [])]);
  const lines = [
    `${runIcon(r)} *${esc(trunc(r.title || r.name, 120))}*`,
    `${esc(r.name || '')} · \\#${r.number}${r.attempt > 1 ? ` \\(attempt ${r.attempt}\\)` : ''}`,
    `${esc(r.status === 'completed' ? (r.conclusion || 'done') : r.status)} · ${esc(r.branch || '')} · ${esc(r.event || '')} · ${esc(ago(r.updatedAt))}`,
  ];
  if (jobs.length) {
    lines.push('');
    for (const j of jobs.slice(0, 10)) {
      lines.push(`${j.status === 'completed' ? icon(j.conclusion || 'completed') : icon(j.status)} ${esc(trunc(j.name, 60))}${j.failedSteps.length ? ` — failed: ${esc(trunc(j.failedSteps.join(', '), 80))}` : ''}`);
    }
  }
  const rows = [];
  if (r.status === 'completed') {
    rows.push([btn('🔁 Re-run all', D('rerun', c.repo, id, 'all'), style.GREEN)]);
    if (r.conclusion === 'failure') rows.push([btn('🔁 Re-run failed jobs', D('rerun', c.repo, id, 'failed'), style.GREEN)]);
  } else rows.push([btn('🛑 Cancel run', D('cancelask', c.repo, id), style.RED)]);
  rows.push([plain('🔄 Refresh', D('run', c.repo, id))]);
  if (r.url) rows.push([ui.link('🔗 Open on GitHub', r.url)]);
  rows.push(back('Runs', D('runs', c.repo, 'all', 1)));
  return ui.screen(ctx, lines.join('\n'), rows);
}

async function workflows(ctx, c, pg) {
  const r = await act.listWorkflows(c.token, c.owner, c.repo, { page: pg });
  const rows = ui.listRows({
    items: r.items, render: (w) => ({ label: `${w.state === 'active' ? '▶️' : '⏸'} ${w.name}`, data: D('wfview', c.repo, w.id) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (n) => D('wf', c.repo, n), backRow: back('Actions', D('home', c.repo)),
  });
  return ui.screen(ctx, `📋 *Workflows* — ${esc(c.repo)}${r.items.length ? '' : '\n\n_No workflows\\. Add one under_ `.github/workflows`\\.'}`, rows);
}

async function secrets(ctx, c, pg) {
  const r = await act.listSecrets(c.token, c.owner, c.repo, { page: pg });
  const rows = ui.listRows({
    items: r.items, render: (s) => ({ label: `🔐 ${s.name}`, data: D('secview', c.repo, s.name) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (n) => D('secrets', c.repo, n),
    extra: [[btn('➕ Add / update secret', D('secnew', c.repo), style.GREEN)]], backRow: back('Actions', D('home', c.repo)),
  });
  return ui.screen(ctx, `🔐 *Secrets* — ${esc(c.repo)}\nValues are write\\-only — GitHub never shows them again${r.items.length ? '' : '\n\n_No secrets yet\\._'}`, rows);
}

async function vars(ctx, c, pg) {
  const r = await act.listVariables(c.token, c.owner, c.repo, { page: pg });
  const rows = ui.listRows({
    items: r.items, render: (v) => ({ label: `📦 ${v.name} = ${trunc(v.value, 24)}`, data: D('varview', c.repo, v.name) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (n) => D('vars', c.repo, n),
    extra: [[btn('➕ Add variable', D('varnew', c.repo), style.GREEN)]], backRow: back('Actions', D('home', c.repo)),
  });
  return ui.screen(ctx, `📦 *Variables* — ${esc(c.repo)}${r.items.length ? '' : '\n\n_No variables yet\\._'}`, rows);
}

async function handle(ctx, { action, args, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const id = num(args[0]);
  switch (action) {
    case 'home': return hub(ctx, c);
    case 'runs': return runs(ctx, c, FILTERS[args[0]] !== undefined ? args[0] : 'all', pageOf(args[1]), num(args[2]));
    case 'run': if (!id) return; return runView(ctx, c, id);
    case 'rerun': if (!id) return; await act.rerunRun(c.token, c.owner, c.repo, id, { failedOnly: args[1] === 'failed' }); return ui.screen(ctx, '🔁 Re\\-run started\\.', [[plain('🔄 View run', D('run', c.repo, id))]]);
    case 'cancelask': if (!id) return; return ui.screen(ctx, 'Cancel this run?', ui.confirmRows('🛑 Yes, cancel', D('cancelok', c.repo, id), D('run', c.repo, id)));
    case 'cancelok': if (!id) return; await act.cancelRun(c.token, c.owner, c.repo, id); return ui.screen(ctx, '🛑 Cancel requested\\.', [[plain('🔄 View run', D('run', c.repo, id))]]);
    case 'wf': return workflows(ctx, c, pageOf(args[0]));
    case 'wfview': {
      if (!id) return;
      const all = await act.listWorkflows(c.token, c.owner, c.repo, { perPage: 50 });
      const w = all.items.find((x) => x.id === id); if (!w) return ctx.reply('That workflow is no longer listed.');
      const br = workBranch(ctx, c.repo);
      return ui.screen(ctx, `📋 *${esc(w.name)}*\n${code(w.path)}\n${w.state === 'active' ? 'Enabled' : 'Disabled'}`, [
        [btn(`▶️ Run on ${trunc(br || 'default branch', 24)}`, D('wfrun', c.repo, id), style.GREEN)],
        [plain('🏃 Its runs', D('runs', c.repo, 'all', 1, id)), plain(w.state === 'active' ? '⏸ Disable' : '▶️ Enable', D('wftoggle', c.repo, id, w.state === 'active' ? 'off' : 'on'))],
        back('Workflows', D('wf', c.repo, 1)),
      ]);
    }
    case 'wfrun': {
      if (!id) return;
      const ref = workBranch(ctx, c.repo) || (await core.get(c.token, 'GET /repos/{owner}/{repo}', { owner: c.owner, repo: c.repo }, 'Get repo')).default_branch;
      await act.dispatchWorkflow(c.token, c.owner, c.repo, id, ref);
      return ui.screen(ctx, `▶️ Started on *${esc(ref)}*\\. It appears in the runs list in a few seconds\\.`, [[plain('🏃 Runs', D('runs', c.repo, 'all', 1))]]);
    }
    case 'wftoggle': if (!id) return; await act.setWorkflowEnabled(c.token, c.owner, c.repo, id, args[1] === 'on'); return workflows(ctx, c, 1);
    case 'secrets': return secrets(ctx, c, pageOf(args[0]));
    case 'secview': { const n = args[0]; if (!n) return; return ui.screen(ctx, `🔐 *${esc(n)}*\n\nThe value can’t be read back — only replaced or deleted\\.`, [[plain('✏️ Replace value', D('secset', c.repo, n))], [btn('🗑 Delete', D('secdelask', c.repo, n), style.RED)], back('Secrets', D('secrets', c.repo, 1))]); }
    case 'secnew': return input.ask(ctx, { area: 'actions', action: 'secname', repoName, prompt: '🔐 Send the secret NAME (e.g. DEPLOY_TOKEN). Sending an existing name replaces it.', maxLen: 100, cancelData: D('secrets', c.repo, 1) });
    case 'secset': { const n = args[0]; if (!n) return; return input.ask(ctx, { area: 'actions', action: 'secvalue', repoName, args: [n], secret: true, prompt: `🔐 Send the value for ${n}. I delete your message right after reading it, and it is encrypted before it reaches GitHub.`, maxLen: 20000, cancelData: D('secrets', c.repo, 1) }); }
    case 'secdelask': { const n = args[0]; if (!n) return; return ui.screen(ctx, `Delete secret *${esc(n)}*?\n\nWorkflows using it will fail\\.`, ui.confirmRows('🗑 Yes, delete', D('secdelok', c.repo, n), D('secview', c.repo, n))); }
    case 'secdelok': { const n = args[0]; if (!n) return; await act.deleteSecret(c.token, c.owner, c.repo, n); return secrets(ctx, c, 1); }
    case 'vars': return vars(ctx, c, pageOf(args[0]));
    case 'varview': {
      const n = args[0]; if (!n) return;
      const all = await act.listVariables(c.token, c.owner, c.repo, { perPage: 30 });
      const v = all.items.find((x) => x.name === n); if (!v) return ctx.reply('That variable is no longer listed.');
      return ui.screen(ctx, `📦 *${esc(v.name)}*\n${code(trunc(v.value, 500))}`, [[plain('✏️ Change value', D('varset', c.repo, n))], [btn('🗑 Delete', D('vardelask', c.repo, n), style.RED)], back('Variables', D('vars', c.repo, 1))]);
    }
    case 'varnew': return input.ask(ctx, { area: 'actions', action: 'varname', repoName, prompt: '📦 Send the variable NAME (e.g. NODE_ENV).', maxLen: 100, cancelData: D('vars', c.repo, 1) });
    case 'varset': { const n = args[0]; if (!n) return; return input.ask(ctx, { area: 'actions', action: 'varvalue', repoName, args: [n, 'exists'], prompt: `📦 Send the new value for ${n}.`, maxLen: 20000, cancelData: D('vars', c.repo, 1) }); }
    case 'vardelask': { const n = args[0]; if (!n) return; return ui.screen(ctx, `Delete variable *${esc(n)}*?`, ui.confirmRows('🗑 Yes, delete', D('vardelok', c.repo, n), D('varview', c.repo, n))); }
    case 'vardelok': { const n = args[0]; if (!n) return; await act.deleteVariable(c.token, c.owner, c.repo, n); return vars(ctx, c, 1); }
    default: return ctx.reply('This button has expired.');
  }
}

async function onInput(ctx, { action, args, repoName, text }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const nameOrThrow = (t) => { try { return act.assertSecretName(t); } catch (e) { throw input.inputError(e.message); } };
  if (action === 'secname') {
    const n = nameOrThrow(text);
    return input.ask(ctx, { area: 'actions', action: 'secvalue', repoName, args: [n], secret: true, prompt: `🔐 Send the value for ${n}. I delete your message right after reading it, and it is encrypted before it reaches GitHub.`, maxLen: 20000, cancelData: D('secrets', c.repo, 1) });
  }
  if (action === 'secvalue') {
    try { await act.setSecret(c.token, c.owner, c.repo, args[0], text); } catch (e) {
      if (e && e.code === 'NO_LIBSODIUM') return ui.notice(ctx, `⚠️ ${e.message}`, [back('Secrets', D('secrets', c.repo, 1))]);
      throw e;
    }
    return ui.screen(ctx, `✅ Secret *${esc(args[0])}* saved\\. Your message with the value was deleted\\.`, [back('Secrets', D('secrets', c.repo, 1))]);
  }
  if (action === 'varname') {
    const n = nameOrThrow(text);
    return input.ask(ctx, { area: 'actions', action: 'varvalue', repoName, args: [n], prompt: `📦 Send the value for ${n}.`, maxLen: 20000, cancelData: D('vars', c.repo, 1) });
  }
  if (action === 'varvalue') {
    let exists = args[1] === 'exists';
    if (!exists) { const all = await act.listVariables(c.token, c.owner, c.repo, { perPage: 100 }); exists = all.items.some((v) => v.name === args[0]); }
    await act.setVariable(c.token, c.owner, c.repo, args[0], text, { exists });
    return ui.screen(ctx, `✅ Variable *${esc(args[0])}* saved\\.`, [back('Variables', D('vars', c.repo, 1))]);
  }
}

module.exports = { key: 'actions', label: 'Actions / CI', emoji: '⚙️', level: 'repo', scopes: [], handle, onInput };
