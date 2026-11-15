/* Overview */
views.overview = async (arg, sub, silent) => {
  const paint = painter('overview');
  if (!silent) paint(loadingHtml());
  try {
    const [o, ch, b] = await Promise.all([api('GET', '/overview'), api('GET', '/charts?days=14').catch(() => null), api('GET', '/badges').catch(() => null)]);
    const hs = o.health === 'HEALTHY' ? 'ok' : o.health === 'DEGRADED' ? 'warn' : 'bad';
    const f = o.fleet || {}, g = o.github;
    let h = '<h2>' + ico('activity') + 'Overview</h2>';
    if (o.reasons && o.reasons.length) h += '<div class="banner">' + ico('alert') + '<div>' + o.reasons.map(esc).join('<br>') + '</div></div>';
    h += '<div class="grid">' + stat('Health', o.health || '?', 'Bot v' + o.version, hs) + stat('Database', o.postgres ? 'Connected' : 'Down', '', o.postgres ? 'ok' : 'bad') + stat('Cache', o.redis ? 'Connected' : 'Down', '', o.redis ? 'ok' : 'bad') +
      stat('GitHub', g ? (g.circuit === 'open' ? 'Paused' : g.circuit === 'half-open' ? 'Recovering' : 'Normal') : '-', g ? g.active + ' active, ' + g.queued + ' queued' : '', g ? (g.circuit === 'open' ? 'bad' : g.circuit === 'half-open' ? 'warn' : 'ok') : '') +
      stat('Uptime', uptime(o.uptimeSeconds), 'Memory ' + (o.memoryMB || '?') + ' MB', '', 'clock') + stat('Event loop', (o.lagP99Ms == null ? '?' : o.lagP99Ms) + ' ms', 'p99 delay', '', 'activity') + '</div>';

    const needs = [];
    if (b) {
      if (b.reports) needs.push(['#reports', 'flag', b.reports + ' open report' + (b.reports === 1 ? '' : 's'), 'warn']);
      if (b.warden) needs.push(['#warden', 'warden', b.warden + ' for Warden to look at', 'warn']);
      if (b.errors) needs.push(['#feed', 'alert', b.errors + ' error' + (b.errors === 1 ? '' : 's') + ' in the last 24 hours', b.errors > 20 ? 'warn' : '']);
      if (b.scheduled) needs.push(['#schedule', 'calendar', b.scheduled + ' announcement' + (b.scheduled === 1 ? '' : 's') + ' scheduled', '']);
    }
    if (o.maintenance) needs.push(['#controls', 'wrench', 'Maintenance mode is ON', 'warn']);
    if (o.signupsPaused) needs.push(['#controls', 'lock', 'New sign-ups are paused', 'warn']);
    h += '<h3>Needs attention</h3>' + (needs.length ? '<div class="list">' + needs.map((n) => '<a class="row" href="' + n[0] + '">' + ico(n[1]) + '<span class="grow"><span class="t">' + esc(n[2]) + '</span></span>' + (n[3] ? pill('look', n[3]) : '') + ico('chevron-right') + '</a>').join('') + '</div>'
      : '<div class="card calm">' + ico('check-circle', 'ic-draw') + '<span>All clear. Nothing needs you right now.</span></div>');

    h += '<h3>People</h3><div class="grid">' + stat('Users', num(f.users), '+' + (f.newToday || 0) + ' today, +' + (f.newWeek || 0) + ' this week', '', 'users') + stat('Active today', num(f.activeToday), '', '', 'activity') + stat('Connected', num(f.connected), num(f.accounts) + ' GitHub accounts', '', 'github') +
      stat('Blocked', num(f.blocked), num(f.suspended) + ' suspended', f.blocked ? 'warn' : '', 'ban') + stat('Open reports', num(o.openReports), '', o.openReports ? 'warn' : '', 'flag') + stat('Errors today', num(f.errorsToday), '', f.errorsToday > 20 ? 'warn' : '', 'alert') + '</div>';
    if (ch) h += '<h3>Last 14 days</h3><div class="grid2">' + chartCard('Sign-ups', ch.signups, { type: 'bar', cls: 'c-brand', unit: 'new' }) + chartCard('Active people', ch.active, { cls: 'c-ok', unit: 'person-days' }) + '</div><p><a class="btn small" href="#charts">All charts' + ico('chevron-right') + '</a></p>';
    paint(h, silent);
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
views.overview.live = true;

/* Webhooks */
views.webhooks = async (arg, sub, silent) => {
  const paint = painter('webhooks');
  if (!silent) paint(loadingHtml());
  try {
    const r = await api('GET', '/webhooks');
    let h = '<h2>' + ico('plug') + 'Webhooks</h2><div class="grid">' + stat('Registered', r.hooks, '', '', 'plug') + stat('People', r.people, '', '', 'users') + '</div>';
    const live = Object.keys(r.live || {});
    if (live.length) {
      h += '<h3>Live counters</h3><div class="list">' + live.map((k) => {
        const v = r.live[k];
        const n = Array.isArray(v) ? v.map((s) => (s.labels && Object.keys(s.labels).length ? Object.keys(s.labels).map((l) => l + '=' + s.labels[l]).join(' ') + ': ' : '') + (s.value != null ? s.value : '')).join(', ') : String(v);
        return '<div class="row static"><span class="grow"><span class="t">' + esc(k.replace(/_/g, ' ')) + '</span><span class="s">' + esc(n) + '</span></span></div>';
      }).join('') + '</div>';
    }
    h += '<h3>Newest</h3>' + (r.recent.length ? '<div class="list">' + r.recent.map((x) => '<a class="row" href="#users/' + x.id + '"><span class="grow"><span class="t">' + esc(x.repo) + '</span><span class="s">' + x.id + ' &middot; ' + fmt(x.at) + '</span></span>' + ico('chevron-right') + '</a>').join('') + '</div>' : empty('No webhooks registered', 'plug'));
    paint(h, silent);
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
views.webhooks.live = true;
