/* Reports */
views.reports = async (arg, sub, silent) => {
  const paint = painter('reports');
  if (!silent) paint(loadingHtml());
  try {
    const st = state.reportStatus;
    const r = await api('GET', '/reports?status=' + st + '&limit=20');
    let h = '<h2>' + ico('flag') + 'Reports</h2>' + seg([['open', 'Open'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']], st, 'data-st');
    h += r.reports.length ? '<div class="list">' + r.reports.map((x) => '<div class="card"><div class="inline between"><span class="pill">' + esc(x.category || 'report') + '</span><span class="muted small">' + fmt(x.at) + '</span></div><p class="plain">' + esc(x.message) + '</p><div class="inline"><a class="btn small" href="#users/' + x.userId + '">' + ico('user') + esc(who({ name: x.name, username: x.username, id: x.userId })) + '</a>' +
      (x.status === 'open' ? '<button class="btn small" data-res="' + x.id + '">' + ico('check-circle') + 'Resolve</button><button class="btn small" data-dis="' + x.id + '">' + ico('x') + 'Dismiss</button>' : '') + '</div></div>').join('') + '</div>' + (r.reports.length < r.total ? '<p class="muted small">Showing ' + r.reports.length + ' of ' + r.total + '.</p>' : '') : empty('No ' + st + ' reports', 'flag');
    if (!paint(h, silent)) return;
    onAll('[data-st]', (b) => { state.reportStatus = b.getAttribute('data-st'); views.reports(); });
    const fin = (id, status) => act('POST', '/reports/' + id + '/resolve', { status }, { title: status === 'resolved' ? 'Resolve report' : 'Dismiss report', msg: 'Mark this report as ' + status + '?', confirm: status === 'resolved' ? 'Resolve' : 'Dismiss' }).then((j) => { if (j) views.reports(); });
    onAll('[data-res]', (b) => fin(b.getAttribute('data-res'), 'resolved'));
    onAll('[data-dis]', (b) => fin(b.getAttribute('data-dis'), 'dismissed'));
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
views.reports.live = true;
