/* Charts */
views.charts = async (arg, sub, silent) => {
  const paint = painter('charts');
  if (!silent) paint(loadingHtml());
  try {
    const days = state.chartsDays;
    const r = await api('GET', '/charts?days=' + days);
    const h = '<h2>' + ico('chart') + 'Charts</h2>' + seg([['14', '14 days'], ['30', '30 days'], ['90', '90 days']], String(days), 'data-d') +
      '<div class="grid2">' + chartCard('Sign-ups', r.signups, { type: 'bar', cls: 'c-brand', unit: 'new people' }) + chartCard('Active people', r.active, { cls: 'c-ok', unit: 'person-days' }) +
      chartCard('Bot actions', r.actions, { cls: 'c-brand', unit: 'actions' }) + chartCard('Commits', r.commits, { type: 'bar', cls: 'c-ok', unit: 'commits' }) +
      chartCard('Errors', r.errors, { type: 'bar', cls: 'c-bad', unit: 'errors' }) + chartCard('Rate-limited actions', r.rateLimited, { type: 'bar', cls: 'c-warn', unit: 'hits' }) + '</div>' +
      '<p class="muted small">GitHub\u2019s own request history is not stored; the live GitHub state is on the Overview page.</p>';
    if (!paint(h, silent)) return;
    onAll('[data-d]', (b) => { state.chartsDays = Number(b.getAttribute('data-d')); views.charts(); });
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
views.charts.live = true;

/* Errors, anomalies and scheduled jobs */
const FEED_TABS = [['errors', 'Errors'], ['anomalies', 'Anomalies'], ['jobs', 'Scheduled jobs']];
state.feedRows = [];
views.feed = async (arg, sub, silent) => {
  const paint = painter('feed');
  const tab = FEED_TABS.some((t) => t[0] === arg) ? arg : state.feedTab;
  if (tab !== state.feedTab) { state.feedTab = tab; state.feedRows = []; }
  if (!silent) paint(loadingHtml());
  try {
    const r = await api('GET', '/feed/' + tab + '?limit=15&offset=0');
    state.feedRows = r.rows;
    paint(feedHtml(tab, r), silent) && bindFeed(tab, r);
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
function feedRow(tab, e) {
  const u = '<a href="#users/' + e.userId + '">' + esc(e.username ? '@' + e.username : e.userId) + '</a>';
  if (tab === 'errors') return '<div class="row static"><span class="grow"><span class="t">' + esc(e.summary) + '</span><span class="s">' + (e.detail ? esc(snippet(e.detail, 160)) + ' &middot; ' : '') + u + ' &middot; ' + fmt(e.at) + '</span></span></div>';
  if (tab === 'anomalies') return '<div class="row static"><span class="grow"><span class="t">' + esc(String(e.event).replace(/_/g, ' ')) + '</span><span class="s">' + esc(e.reason || '') + ' &middot; ' + u + ' &middot; ' + fmt(e.at) + '</span></span>' + pill('unusual', 'warn', 'alert') + '</div>';
  return '<div class="row static"><span class="grow"><span class="t">' + esc(e.kind) + ' &middot; ' + esc(e.label) + '</span><span class="s">' + u + ' &middot; ' + fmt(e.at) + (e.error ? ' &middot; ' + esc(snippet(e.error, 120)) : '') + '</span></span>' + pill(e.status, e.status === 'failed' ? 'bad' : 'warn') + '</div>';
}
function feedHtml(tab, r) {
  return '<h2>' + ico('alert') + 'Errors &amp; jobs</h2>' + seg(FEED_TABS, tab, 'data-ft') + (state.feedRows.length ? '<div class="list" id="feedlist">' + state.feedRows.map((e) => feedRow(tab, e)).join('') + '</div>' + (tab !== 'jobs' ? '<p class="muted small center">' + num(r.total) + ' in total</p>' : '') + (tab !== 'jobs' && state.feedRows.length < r.total ? more('fmore', 1) : '') : empty(tab === 'errors' ? 'No errors recorded.' : tab === 'anomalies' ? 'Nothing unusual.' : 'No scheduled jobs.', 'check-circle'));
}
function bindFeed(tab, r) {
  onAll('[data-ft]', (b) => go('#feed/' + b.getAttribute('data-ft')));
  on('#fmore', async () => { try { const x = await api('GET', '/feed/' + tab + '?limit=15&offset=' + state.feedRows.length); state.feedRows = state.feedRows.concat(x.rows); $('#feedlist').innerHTML = state.feedRows.map((e) => feedRow(tab, e)).join(''); if (state.feedRows.length >= r.total) { const m = $('#fmore'); if (m) m.remove(); } } catch (e) { toast(e.message, true); } });
}
