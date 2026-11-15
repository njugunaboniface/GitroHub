/** ⚡ Manage → Security (v1.2.4-multi): Dependabot, code scanning and secret scanning alerts; Dependabot alerts on/off. */
const ui = require('../ui');
const { repoCtx, num, pageOf } = require('../common');
const sec = require('../../../lib/github/security');

const { esc, plain, back, code, trunc, ago } = ui;
const D = (action, repo, ...args) => `manage:security:${[action, repo, ...args].join(':')}`;
const SEV = { critical: '🟥', high: '🟧', medium: '🟨', moderate: '🟨', low: '🟩' };
const sev = (s) => SEV[s] || '⬜';
const count = (x) => (x.disabled ? 'n/a' : `${x.count}${x.capped ? '+' : ''}`);
const REASONS = { fix_started: 'A fix has started', inaccurate: 'Inaccurate', no_bandwidth: 'No time to fix', not_used: 'Code isn’t used', tolerable_risk: 'Risk is tolerable' };

async function home(ctx, c) {
  const [o, on] = await Promise.all([sec.overview(c.token, c.owner, c.repo), sec.alertsEnabled(c.token, c.owner, c.repo).catch(() => null)]);
  return ui.screen(ctx, `🛡️ *Security* — ${esc(c.repo)}\n\nOpen alerts — Dependabot: ${esc(count(o.dependabot))} · Code scanning: ${esc(count(o.codeScanning))} · Secret scanning: ${esc(count(o.secretScanning))}\n_n/a means not enabled for this repo\\._\n\nDependabot alerts are ${on ? 'on ✅' : 'off ▫️'}`, [
    [plain(`📦 Dependabot (${count(o.dependabot)})`, D('dep', c.repo, 'open', 1))],
    [plain(`🔎 Code scanning (${count(o.codeScanning)})`, D('code', c.repo, 1)), plain(`🔑 Secrets (${count(o.secretScanning)})`, D('sscan', c.repo, 1))],
    [on === null ? plain('…', 'noop') : plain(on ? '🔕 Turn Dependabot alerts off' : '🔔 Turn Dependabot alerts on', D('toggle', c.repo, on ? 'off' : 'on'))],
    back('Manage', `manage:hub:${c.repo}`),
  ]);
}

/**
 * Page N of Dependabot alerts. GitHub only offers cursor paging for them, so the cursors seen so far are remembered per
 * repo+state (page 1 always starts fresh, because alerts change); an unknown page is reached by walking forward.
 */
async function depPage(ctx, c, state, pg) {
  ctx.session = ctx.session || {};
  const store = ctx.session.depCursors = ctx.session.depCursors || {};
  const key = `${c.repo}:${state}`;
  if (pg <= 1 || !store[key]) store[key] = [null];
  const cursors = store[key];
  while (cursors.length < pg) {
    const probe = await sec.listDependabotAlerts(c.token, c.owner, c.repo, { state, after: cursors[cursors.length - 1] });
    if (probe.disabled || !probe.nextCursor) break;
    cursors.push(probe.nextCursor);
  }
  const idx = Math.min(pg, cursors.length) - 1;
  const r = await sec.listDependabotAlerts(c.token, c.owner, c.repo, { state, after: cursors[idx] });
  if (r.nextCursor) cursors[idx + 1] = r.nextCursor;
  const keys = Object.keys(store); if (keys.length > 8) delete store[keys[0]]; // a few repos at most
  return { r, pageNo: idx + 1 };
}

async function deps(ctx, c, state, pgWanted) {
  const { r, pageNo: pg } = await depPage(ctx, c, state, pgWanted);
  if (r.disabled) return ui.screen(ctx, 'Dependabot alerts aren’t available for this repo — they may be switched off\\.', [back('Security', D('home', c.repo))]);
  const rows = ui.listRows({
    items: r.items, render: (a) => ({ label: `${sev(a.severity)} ${a.package || 'package'} — ${a.summary}`, data: D('depview', c.repo, a.number) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (n) => D('dep', c.repo, state, n),
    extra: [[plain(state === 'open' ? '✅ Show dismissed/fixed' : '🟢 Show open', D('dep', c.repo, state === 'open' ? 'dismissed' : 'open', 1))]],
    backRow: back('Security', D('home', c.repo)),
  });
  return ui.screen(ctx, `📦 *Dependabot* — ${esc(state)}${r.items.length ? '' : '\n\n_Nothing here\\. 🎉_'}`, rows);
}

async function handle(ctx, { action, args, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const n = num(args[0]);
  switch (action) {
    case 'home': return home(ctx, c);
    case 'dep': return deps(ctx, c, args[0] === 'dismissed' ? 'dismissed' : 'open', pageOf(args[1]));
    case 'depview': {
      if (!n) return;
      const a = await sec.getDependabotAlert(c.token, c.owner, c.repo, n);
      const lines = [`${sev(a.severity)} *${esc(a.package || 'package')}* \\(${esc(a.ecosystem || '')}\\)`, esc(a.summary), `Severity: ${esc(a.severity)} · ${esc(a.ghsa || '')}`, `Affected: ${esc(a.vulnerableRange || '?')}`, `Fixed in: ${esc(a.fixedIn || 'no fix yet')}`, `In ${code(a.manifest || '')} · ${esc(ago(a.createdAt))}`];
      const rows = [a.state === 'open' ? [plain('🙈 Dismiss…', D('dismiss', c.repo, n))] : [plain('🟢 Reopen', D('reopen', c.repo, n))]];
      if (a.url) rows.push([ui.link('🔗 Open on GitHub', a.url)]);
      rows.push(back('Alerts', D('dep', c.repo, 'open', 1)));
      return ui.screen(ctx, lines.join('\n'), rows);
    }
    case 'dismiss': if (!n) return; return ui.screen(ctx, 'Why dismiss this alert?', [...Object.entries(REASONS).map(([k, v]) => [plain(v, D('dismissok', c.repo, n, k))]), back('Alert', D('depview', c.repo, n))]);
    case 'dismissok': if (!n) return; await sec.dismissDependabotAlert(c.token, c.owner, c.repo, n, args[1]); return deps(ctx, c, 'open', 1);
    case 'reopen': if (!n) return; await sec.reopenDependabotAlert(c.token, c.owner, c.repo, n); return deps(ctx, c, 'open', 1);
    case 'code': {
      const pg = pageOf(args[0]); const r = await sec.listCodeScanningAlerts(c.token, c.owner, c.repo, { page: pg });
      if (r.disabled) return ui.screen(ctx, 'Code scanning isn’t set up for this repo\\.', [back('Security', D('home', c.repo))]);
      const body = r.items.map((a) => `${sev(a.severity)} *${esc(trunc(a.rule || 'rule', 80))}*\n${code(trunc(a.location || '', 80))}`).join('\n\n') || '_No open alerts\\. 🎉_';
      const rows = []; const p = ui.pager(pg, r.hasNext, (x) => D('code', c.repo, x)); if (p.length) rows.push(p); rows.push(back('Security', D('home', c.repo)));
      return ui.screen(ctx, `🔎 *Code scanning*\n\n${body}`, rows);
    }
    case 'sscan': {
      const pg = pageOf(args[0]); const r = await sec.listSecretScanningAlerts(c.token, c.owner, c.repo, { page: pg });
      if (r.disabled) return ui.screen(ctx, 'Secret scanning isn’t available for this repo\\.', [back('Security', D('home', c.repo))]);
      const body = r.items.map((a) => `🔑 *${esc(trunc(a.type || 'secret', 80))}* · ${esc(ago(a.createdAt))}`).join('\n') || '_No open alerts\\. 🎉_';
      const rows = r.items.filter((a) => a.url).slice(0, 5).map((a) => [ui.link(`🔗 ${trunc(a.type || 'secret', 30)}`, a.url)]);
      const p = ui.pager(pg, r.hasNext, (x) => D('sscan', c.repo, x)); if (p.length) rows.push(p); rows.push(back('Security', D('home', c.repo)));
      return ui.screen(ctx, `🔑 *Secret scanning*\n\nRotate any exposed secret first, then close the alert on GitHub\\.\n\n${body}`, rows);
    }
    case 'toggle': await sec.setAlertsEnabled(c.token, c.owner, c.repo, args[0] === 'on'); return home(ctx, c);
    default: return ctx.reply('This button has expired.');
  }
}

module.exports = { key: 'security', label: 'Security', emoji: '🛡️', level: 'repo', scopes: [], handle, __test: { deps, depPage } };
