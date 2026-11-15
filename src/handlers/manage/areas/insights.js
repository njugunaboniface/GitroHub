/** ⚡ Manage → Insights (v1.2.4-multi): repo stats, contributors, commit activity chart, traffic. */
const ui = require('../ui');
const { repoCtx } = require('../common');
const ins = require('../../../lib/github/insights');

const { esc, plain, back, code, ago } = ui;
const D = (action, repo, ...args) => `manage:insights:${[action, repo, ...args].join(':')}`;
const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} MB` : `${n} KB`);

async function handle(ctx, { action, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const nav = [[plain('👥 Contributors', D('who', c.repo)), plain('📈 Commits', D('chart', c.repo))], [plain('👁 Traffic', D('traffic', c.repo)), plain('🔄 Refresh', D('home', c.repo))], back('Manage', `manage:hub:${c.repo}`)];
  const sub = [back('Insights', D('home', c.repo))];
  switch (action) {
    case 'home': {
      const o = await ins.overview(c.token, c.owner, c.repo);
      return ui.screen(ctx, [
        `📊 *${esc(o.fullName)}*`, `${esc(o.visibility)}${o.isFork ? ' · fork' : ''}${o.archived ? ' · archived' : ''}`, '',
        `⭐ ${o.stars} · 🍴 ${o.forks} · 👁 ${o.watchers} · 🐞 ${o.openIssues} open`,
        `💾 ${esc(kb(o.sizeKb))} · ${esc(o.license || 'no license')} · default ${code(o.defaultBranch)}`,
        `Created ${esc(ago(o.createdAt))} · last push ${esc(ago(o.pushedAt))}`,
      ].join('\n'), nav);
    }
    case 'who': {
      const list = await ins.contributors(c.token, c.owner, c.repo, 10);
      const max = Math.max(1, ...list.map((x) => x.contributions));
      const body = list.map((x) => `${code('█'.repeat(Math.max(1, Math.round((x.contributions / max) * 10))))} *${esc(x.login)}* — ${x.contributions}`).join('\n') || '_No data yet\\._';
      return ui.screen(ctx, `👥 *Top contributors*\n\n${body}`, sub);
    }
    case 'chart': {
      const weeks = await ins.commitActivity(c.token, c.owner, c.repo);
      if (!weeks) return ui.screen(ctx, '📈 GitHub is still calculating this repo’s commit stats\\. Try again in a minute\\.', [[plain('🔄 Try again', D('chart', c.repo))], ...sub]);
      const total = weeks.reduce((a, b) => a + b, 0);
      const last4 = weeks.slice(-4).reduce((a, b) => a + b, 0);
      return ui.screen(ctx, `📈 *Commits per week* \\(last 52 weeks\\)\n\n${code(ins.sparkline(weeks))}\n\nTotal ${total} · last 4 weeks ${last4} · best week ${Math.max(...weeks)}`, sub);
    }
    case 'traffic': {
      const t = await ins.traffic(c.token, c.owner, c.repo);
      if (!t) return ui.screen(ctx, '👁 Traffic stats need push access to the repo\\.', sub);
      const lines = ['👁 *Last 14 days*', ''];
      if (t.views) lines.push(`Views: ${t.views.count} \\(${t.views.uniques} unique\\)`);
      if (t.clones) lines.push(`Clones: ${t.clones.count} \\(${t.clones.uniques} unique\\)`);
      if (t.referrers.length) lines.push('', '*Top referrers*', ...t.referrers.map((r) => `• ${esc(r.name)} — ${r.count}`));
      if (t.paths.length) lines.push('', '*Popular pages*', ...t.paths.map((p) => `• ${code(p.path)} — ${p.count}`));
      return ui.screen(ctx, lines.join('\n'), sub);
    }
    default: return ctx.reply('This button has expired.');
  }
}

module.exports = { key: 'insights', label: 'Insights', emoji: '📊', level: 'repo', scopes: [], handle };
