/* Admin team: roster, roles, dashboard locks */
views.team = async (arg, sub, silent) => {
  const paint = painter('team');
  if (!silent) paint(loadingHtml());
  try {
    const r = await api('GET', '/team');
    const roleOpts = r.roles.map((x) => [x, x.replace('_', ' ')]);
    let h = '<h2>' + ico('users') + 'Admin team</h2>' + (r.lockdownActive ? '<div class="banner bad">' + ico('lock') + '<div><b>Full lockdown is on.</b> Admins are locked out. <a href="#warden/settings">Manage</a></div></div>' : '');
    h += '<div class="card"><div class="row static flat">' + avatar(r.owner) + '<span class="grow"><span class="t">' + esc(who(r.owner)) + '</span><span class="s">' + r.owner.id + '</span></span>' + pill('Owner', 'ok', 'shield') + '</div></div>';
    h += '<h3>Admins</h3>' + (r.admins.length ? '<div class="list">' + r.admins.map((a) => '<div class="card"><div class="row static flat">' + avatar(a) + '<span class="grow"><span class="t">' + esc(who(a)) + '</span><span class="s">' + a.id + (a.grantedAt ? ' &middot; since ' + esc(fmt(a.grantedAt)) : '') + '</span></span>' + pill(a.role.replace('_', ' '), 'ok', 'shield') + (a.locked ? pill('locked', 'bad', 'lock') : '') + '</div>' +
      '<div class="inline" style="margin-top:8px"><a class="btn small" href="#users/' + a.id + '">' + ico('user') + 'Open</a><button class="btn small" data-role="' + a.id + '" data-cur="' + esc(a.role) + '">' + ico('key') + 'Change role</button>' + (a.locked ? '<button class="btn small" data-unlock="' + a.id + '">' + ico('play') + 'Unlock</button>' : '<button class="btn small" data-lock="' + a.id + '">' + ico('lock') + 'Lock out</button>') + '<button class="btn small danger" data-revoke="' + a.id + '">Revoke</button></div></div>').join('') + '</div>' : empty('No other admins', 'users'));
    h += '<h3>Add an admin</h3><div class="card"><div class="inline"><input type="number" id="nid" placeholder="Telegram ID"><select id="nrole">' + roleOpts.map((x) => '<option value="' + x[0] + '">' + esc(x[1]) + '</option>').join('') + '</select><button class="btn" id="nadd">' + ico('plus') + 'Add</button></div><p class="muted small" style="margin:8px 0 0">The person must have started the bot. Needs a fresh sign-in.</p></div>';
    if (!paint(h, silent)) return;
    const again = (j) => { if (j) views.team(); };
    on('#nadd', () => { const id = $('#nid').value, role = $('#nrole').value; if (!id) return toast('Enter a Telegram ID', true); act('POST', '/team/add', { id, role }, { title: 'Add admin', msg: 'Make ' + id + ' ' + role.replace('_', ' ') + '?', confirm: 'Add', danger: true }).then(again); });
    onAll('[data-role]', (b) => act('POST', '/team/' + b.getAttribute('data-role') + '/role', (v) => ({ role: v.role }), { title: 'Change role', confirm: 'Change', danger: true, fields: field('Role', 'role', { type: 'select', options: roleOpts, value: b.getAttribute('data-cur') }) }).then(again));
    onAll('[data-revoke]', (b) => act('POST', '/team/' + b.getAttribute('data-revoke') + '/revoke', {}, { title: 'Revoke admin', msg: 'They become a normal user.', confirm: 'Revoke', danger: true }).then(again));
    onAll('[data-lock]', (b) => act('POST', '/team/' + b.getAttribute('data-lock') + '/lock', {}, { title: 'Lock this admin out', msg: 'They lose access to their dashboard until you unlock them.', confirm: 'Lock out', danger: true }).then(again));
    onAll('[data-unlock]', (b) => act('POST', '/team/' + b.getAttribute('data-unlock') + '/unlock', {}, { title: 'Unlock', msg: 'Give them their dashboard back?', confirm: 'Unlock' }).then(again));
  } catch (e) { if (!silent) paint(errHtml(e)); }
};

/* Sessions + install */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $$('[data-install]').forEach((x) => { x.hidden = false; }); });
async function installApp() {
  if (installPrompt) { installPrompt.prompt(); try { await installPrompt.userChoice; } catch (_) { /* dismissed */ } installPrompt = null; return; }
  dialog({ title: 'Install the panel', msg: /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'Tap the Share button, then Add to Home Screen.' : 'Open your browser menu and choose Install app (or Add to Home screen).', confirm: 'OK', cancel: 'Close' });
}
views.sessions = async (arg, sub, silent) => {
  const paint = painter('sessions');
  if (!silent) paint(loadingHtml());
  try {
    const r = await api('GET', '/sessions');
    let h = '<h2>' + ico('phone') + 'Sessions</h2><p class="muted">A sign-in lasts ' + r.ttlHours + ' hours. Risky actions need a sign-in from the last ' + r.freshMinutes + ' minutes.</p><div class="list">' +
      r.sessions.map((s) => '<div class="card"><div class="inline between"><span><b>' + esc(s.device) + '</b> ' + (s.current ? pill('this device', 'ok', 'check-circle') : '') + '<br><span class="muted small">' + esc(s.ip) + ' &middot; signed in ' + esc(fmt(s.createdAt)) + '</span></span>' + (s.current ? '' : '<button class="btn small danger" data-rev="' + esc(s.ref) + '">' + ico('logout') + 'Sign out</button>') + '</div></div>').join('') + '</div>';
    if (r.sessions.filter((s) => !s.current).length) h += '<p><button class="btn danger" id="revall">' + ico('logout') + 'Sign out every other device</button></p>';
    h += '<h3>App</h3><div class="card"><div class="inline between"><span><b>Install as an app</b><br><span class="muted small">Opens full screen from your home screen.</span></span><button class="btn" id="inst">' + ico('download') + 'Install</button></div></div>';
    h += '<h3>Sign-in history</h3>' + (r.history.length ? '<div class="list">' + r.history.map((x) => '<div class="row static"><span class="grow"><span class="t">' + esc(x.detail.replace(/^owner web panel sign-in\s*/, 'Sign-in ')) + '</span><span class="s">' + fmt(x.at) + '</span></span></div>').join('') + '</div>' : empty('No sign-ins recorded yet', 'scroll'));
    if (!paint(h, silent)) return;
    on('#inst', installApp);
    on('#revall', () => act('POST', '/sessions/revoke_others', {}, { title: 'Sign out other devices', msg: 'Every other browser is signed out at once.', confirm: 'Sign them out', danger: true }).then((j) => { if (j) views.sessions(); }));
    onAll('[data-rev]', (b) => act('POST', '/sessions/revoke', { ref: b.getAttribute('data-rev') }, { title: 'Sign out this device', msg: 'That browser loses access now.', confirm: 'Sign out', danger: true }).then((j) => { if (j) views.sessions(); }));
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
views.sessions.live = true;
