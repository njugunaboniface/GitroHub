/* The "More" page (phones) and the navigation map shared with the sidebar and the search palette */
const PAGES = [
  ['overview', 'activity', 'Overview', 'Monitor'], ['charts', 'chart', 'Charts', 'Monitor'], ['feed', 'alert', 'Errors & jobs', 'Monitor'],
  ['users', 'users', 'Users', 'People'], ['reports', 'flag', 'Reports', 'People'], ['team', 'shield', 'Admin team', 'People'],
  ['warden', 'warden', 'Warden', 'Safety'], ['audit', 'scroll', 'Audit log', 'Safety'],
  ['controls', 'sliders', 'Controls', 'System'], ['schedule', 'calendar', 'Announcements', 'System'], ['webhooks', 'plug', 'Webhooks', 'System'], ['bulk', 'wrench', 'Bulk tools', 'System'], ['sessions', 'phone', 'Sessions', 'System'],
];
const BOTTOM = ['overview', 'users', 'warden', 'reports'];
views.more = async () => {
  const groups = ['Monitor', 'People', 'Safety', 'System'];
  let h = '<h2>' + ico('dots') + 'More</h2>';
  groups.forEach((g) => {
    const items = PAGES.filter((p) => p[3] === g && BOTTOM.indexOf(p[0]) === -1);
    if (!items.length) return;
    h += '<h3>' + g + '</h3><div class="list">' + items.map((p) => '<a class="row" href="#' + p[0] + '">' + ico(p[1]) + '<span class="grow"><span class="t">' + esc(p[2]) + '</span></span><span class="badge" data-badge="' + p[0] + '" hidden></span>' + ico('chevron-right') + '</a>').join('') + '</div>';
  });
  h += '<h3>App</h3><div class="list"><button class="row" id="minst">' + ico('download') + '<span class="grow"><span class="t">Install as an app</span></span></button><button class="row" id="mout">' + ico('logout') + '<span class="grow"><span class="t">Sign out</span></span></button></div>';
  paint(h);
  on('#minst', installApp);
  on('#mout', signOut);
  refreshBadges();
};
