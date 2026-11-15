/* Start-up: layout, badges, search palette, theme, live refresh, keyboard */
function signOut() {
  fetch('/owner/logout', { method: 'POST', headers: { 'x-csrf-token': S.csrf }, credentials: 'same-origin' }).then(signedOut, signedOut);
}

/* badges (small counts on the tabs and the sidebar) */
const BADGE_MAP = { reports: 'reports', warden: 'warden', feed: 'errors', schedule: 'scheduled', audit: 'undo' };
async function refreshBadges() {
  try {
    const b = await api('GET', '/badges');
    const set = (key, n) => $$('[data-badge="' + key + '"]').forEach((e) => { e.textContent = n > 99 ? '99+' : String(n); e.hidden = !n; });
    Object.keys(BADGE_MAP).forEach((k) => set(k, b[BADGE_MAP[k]] || 0));
    set('more', (b.errors > 0 ? 1 : 0) + (b.scheduled > 0 ? 1 : 0) + (b.undo > 0 ? 1 : 0));
    document.title = (b.reports + b.warden ? '(' + (b.reports + b.warden) + ') ' : '') + 'GitroHub Owner';
  } catch (_) { /* badges are a convenience; a failed call is not worth a message */ }
}

/* search palette: Ctrl/Cmd+K, "/" or the search button */
function openPalette() {
  if ($('dialog.pal')) return;
  const d = document.createElement('dialog');
  d.className = 'pal';
  d.innerHTML = '<div class="search">' + ico('search') + '<input type="search" id="pq" placeholder="Search people, cases, reports or pages" autocomplete="off"></div><div id="pres" class="list"></div><p class="muted small center">Up and down to choose, Enter to open, Esc to close</p>';
  document.body.appendChild(d); d.showModal();
  const input = d.querySelector('#pq'), res = d.querySelector('#pres');
  let items = [], sel = 0, t, seq = 0;
  const draw = () => {
    res.innerHTML = items.length ? items.map((it, i) => '<a class="row' + (i === sel ? ' sel' : '') + '" href="' + it.href + '" data-i="' + i + '">' + ico(it.icon) + '<span class="grow"><span class="t">' + esc(it.title) + '</span><span class="s">' + esc(it.sub || '') + '</span></span><span class="pill">' + esc(it.kind) + '</span></a>').join('') : '<div class="empty">' + ico('search') + 'No matches</div>';
  };
  const close = () => { try { d.close(); } catch (_) { /* closed */ } d.remove(); };
  const pages = (q) => PAGES.filter((p) => !q || p[2].toLowerCase().indexOf(q.toLowerCase()) !== -1).map((p) => ({ href: '#' + p[0], icon: p[1], title: p[2], sub: p[3], kind: 'page' }));
  const run = async () => {
    const q = input.value.trim(), my = ++seq;
    items = pages(q).slice(0, q ? 4 : 13); sel = 0; draw();
    if (q.length < 2) return;
    try {
      const r = await api('GET', '/search?q=' + encodeURIComponent(q));
      if (my !== seq) return;
      items = r.users.map((u) => ({ href: '#users/' + u.id, icon: 'user', title: who(u), sub: (u.username ? '@' + u.username + ' - ' : '') + u.id + (u.github ? ' - ' + u.github : ''), kind: u.blocked ? 'blocked' : 'person' }))
        .concat(r.cases.map((c) => ({ href: '#warden/' + c.id, icon: 'warden', title: 'Case #' + c.id + ': ' + c.name, sub: stageLabel(c.stage), kind: 'case' })))
        .concat(r.reports.map((x) => ({ href: '#reports', icon: 'flag', title: x.message, sub: 'Report #' + x.id + ' - ' + x.status, kind: 'report' })))
        .concat(items);
      sel = 0; draw();
    } catch (_) { /* the pages list is still usable */ }
  };
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 200); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[sel]) { go(items[sel].href); close(); }
  });
  res.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a')) close(); });
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  d.addEventListener('close', () => d.remove());
  run();
}

/* theme */
(function theme() {
  const root = document.documentElement;
  try { const sv = localStorage.getItem('gh-theme'); if (sv === 'light' || sv === 'dark') root.setAttribute('data-theme', sv); } catch (e) { /* no storage: follow the device */ }
  on('#theme', () => {
    const cur2 = root.getAttribute('data-theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur2 === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('gh-theme', next); } catch (e) { /* ignore */ }
  });
})();

on('#out', signOut);
on('#srch', openPalette);
$$('[data-install]').forEach((b) => b.addEventListener('click', installApp));
window.addEventListener('hashchange', () => route());
if (window.matchMedia) { const mq = window.matchMedia('(min-width: 900px)'); if (mq.addEventListener) mq.addEventListener('change', () => route()); }
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
  if (((e.ctrlKey || e.metaKey) && e.key === 'k') || (!typing && e.key === '/' && !$('dialog[open]'))) { e.preventDefault(); openPalette(); }
});

/* a quiet refresh every 30 seconds while the page is visible */
setInterval(() => {
  if (document.visibilityState === 'hidden') return;
  refreshBadges();
  const v = views[cur.name];
  if (v && v.live) v(cur.arg, cur.sub, true);
}, 30000);

if (!S.fresh) {
  const b = document.createElement('div');
  b.className = 'banner topnote';
  b.innerHTML = ico('lock') + '<div>This sign-in is older than 10 minutes. Everyday actions work; for roles, bans, announcements, exports and switches that affect everyone, send /owner to the bot for a new link.</div>';
  main.parentNode.insertBefore(b, main);
}

if (S.test) window.__OWNER_TEST__ = { chartSvg, fmt, ago, uptime, esc, briefObj, localInput, views, state, PAGES };
route();
refreshBadges();
