/* Users (list + detail), with filters, load-more and a side-by-side layout on wide screens */
const USER_CHIPS = [['', 'All'], ['admins', 'Admins'], ['blocked', 'Blocked'], ['suspended', 'Suspended'], ['never', 'Never connected'], ['connected', 'Connected']];
const isLive = (until) => until && new Date(until) > new Date();

async function loadUsers(reset) {
  const u = state.users;
  const r = await api('GET', '/users?q=' + encodeURIComponent(u.q) + '&filter=' + encodeURIComponent(u.filter) + '&limit=20&offset=' + (reset ? 0 : u.rows.length));
  u.rows = reset ? r.users : u.rows.concat(r.users);
  u.hasMore = r.hasMore; u.loaded = true;
}
function userRows(selected) {
  const u = state.users;
  if (!u.rows.length) return empty('Nobody found', 'search');
  return '<div class="list">' + u.rows.map((x) => '<a class="row' + (String(x.id) === String(selected) ? ' sel' : '') + '" href="#users/' + x.id + '">' + avatar(x) + '<span class="grow"><span class="t">' + esc(who(x)) + '</span><span class="s">' + (x.username ? '@' + esc(x.username) + ' &middot; ' : '') + x.id + '</span><span class="pills">' +
    (x.isAdmin ? pill('Admin', 'ok', 'shield') : '') + (x.blocked ? pill('Blocked', 'bad', 'ban') : '') + (isLive(x.suspendedUntil) ? pill('Suspended', 'warn', 'pause') : '') + (x.connected ? pill('GitHub', '', 'github') : pill('Not connected', '', 'plug')) + '</span></span>' + ico('chevron-right') + '</a>').join('') + '</div>' + more('umore', state.users.hasMore);
}
function usersListHtml(selected) {
  const u = state.users;
  return '<h2>' + ico('users') + 'Users</h2><div class="search">' + ico('search') + '<input type="search" id="q" placeholder="Telegram ID, @username or GitHub login" value="' + esc(u.q) + '" autocomplete="off"></div>' +
    seg(USER_CHIPS, u.filter, 'data-f') + '<div id="ulist">' + userRows(selected) + '</div><p class="muted small">Tools: <a href="#bulk">Bulk tools</a> &middot; <a href="#team">Admin team</a></p>';
}
function bindUsersList(selected) {
  let t;
  on('#q', (e) => { state.users.q = e.target.value.trim(); clearTimeout(t); t = setTimeout(async () => { try { await loadUsers(true); $('#ulist').innerHTML = userRows(selected); bindMore(selected); } catch (err) { toast(err.message, true); } }, 300); }, 'input');
  onAll('[data-f]', async (b) => { state.users.filter = b.getAttribute('data-f'); try { await loadUsers(true); views.users(cur.arg); } catch (err) { toast(err.message, true); } });
  bindMore(selected);
}
function bindMore(selected) {
  on('#umore', async () => { try { await loadUsers(false); $('#ulist').innerHTML = userRows(selected); bindMore(selected); } catch (err) { toast(err.message, true); } });
}

views.users = async (id, sub, silent) => {
  const paint = painter('users');
  if (!silent) paint(loadingHtml());
  try {
    if (!state.users.loaded) await loadUsers(true);
    const detail = id ? await api('GET', '/users/' + id) : null;
    paint(split(usersListHtml(id), detail ? userDetailHtml(detail) : '', !!id, 'Pick someone from the list'), false);
    bindUsersList(id);
    if (detail) bindUserDetail(detail, id);
  } catch (e) { paint(errHtml(e)); }
};

function userDetailHtml(r) {
  const u = r.user;
  let h = isWide() ? '' : back('#users', 'Users');
  h += '<div class="card"><div class="row static flat">' + avatar(u) + '<span class="grow"><span class="t">' + esc(who(u)) + '</span><span class="s">' + (u.username ? '@' + esc(u.username) + ' &middot; ' : '') + u.id + '</span></span></div><div class="pills">' +
    pill(r.isOwner ? 'Owner' : r.role, r.role !== 'guest' ? 'ok' : '', 'shield') + (u.blocked ? pill('Blocked', 'bad', 'ban') : '') + (isLive(u.suspendedUntil) ? pill('Suspended until ' + fmt(u.suspendedUntil), 'warn', 'pause') : '') + (u.trusted ? pill('Trusted', 'ok', 'check-circle') : '') + '</div>' +
    kv([['GitHub', r.accounts.length ? r.accounts.map((a) => esc(a.login) + (a.health && a.health !== 'ok' ? ' (' + esc(a.health) + ')' : '')).join(', ') : 'Not connected', true], ['Joined', fmt(u.createdAt)], ['Last active', fmt(u.lastActiveAt)], ['Commits', r.commits], ['Errors', r.errors], ['Timezone', u.timezone || '-']]) + '</div>';
  if (r.warden) {
    h += '<h3>Warden</h3><div class="card"><div class="inline between"><span class="pill st-' + esc(r.warden.stage) + '">' + esc(stageLabel(r.warden.stage)) + '</span>' + (r.warden.caseId ? '<a class="btn small" href="#warden/' + r.warden.caseId + '">' + ico('warden') + 'Open case</a>' : '<span class="muted small">No open case</span>') + '</div>' +
      '<div class="meterrow"><span>Risk</span>' + meter(r.warden.risk, 'risk') + '<span>' + Math.round((r.warden.risk || 0) * 100) + '%</span></div>' + (r.warden.snoozeUntil && isLive(r.warden.snoozeUntil) ? '<p class="muted small">Snoozed until ' + fmt(r.warden.snoozeUntil) + '</p>' : '') + '</div>';
  }
  if (!r.isOwner) {
    h += '<h3>Role</h3><div class="card"><div class="inline"><select id="role">' + r.roles.filter((x) => x !== 'guest').map((x) => '<option value="' + x + '"' + (x === r.role ? ' selected' : '') + '>' + x.replace('_', ' ') + '</option>').join('') + '</select><button class="btn" id="setrole">' + ico('key') + 'Set role</button>' + (r.role !== 'guest' ? '<button class="btn danger" id="revoke">Revoke</button>' : '') + '</div></div>';
    h += '<h3>Access</h3><div class="card">' + (u.blocked ? '<button class="btn" id="unban">' + ico('check-circle') + 'Unban</button>' : '<div class="inline"><input type="text" id="breason" placeholder="Reason (optional)"><input type="number" id="bdays" min="1" placeholder="Days (empty = permanent)"><button class="btn danger" id="ban">' + ico('ban') + 'Ban</button></div>') +
      '<div style="height:12px"></div>' + (isLive(u.suspendedUntil) ? '<button class="btn" id="unsusp">' + ico('play') + 'Lift suspension</button>' : '<div class="inline"><input type="number" id="shours" min="1" value="24"><input type="text" id="sreason" placeholder="Reason (optional)"><button class="btn" id="susp">' + ico('pause') + 'Suspend (hours)</button></div>') + '</div>';
  }
  h += '<h3>Paused features</h3><div class="card">' + (r.pauses.length ? '<div class="list">' + r.pauses.map((p) => { const f = r.features.filter((x) => x.key === p.key)[0]; return '<div class="row static"><span class="grow"><span class="t">' + esc(f ? f.label : p.key) + '</span><span class="s">' + (p.until ? 'until ' + fmt(p.until) : 'until resumed') + '</span></span><button class="btn small" data-resume="' + esc(p.key) + '">' + ico('play') + 'Resume</button></div>'; }).join('') + '</div>' : '<p class="muted" style="margin:0 0 8px">Nothing paused.</p>') +
    (r.isOwner ? '' : '<div class="inline" style="margin-top:10px"><select id="pkey">' + r.features.map((f) => '<option value="' + esc(f.key) + '">' + esc(f.label) + '</option>').join('') + '</select><button class="btn" id="pause">' + ico('pause') + 'Pause</button></div>') + '</div>';
  if (r.sensitive && r.sensitive.length) h += '<h3>Recent sensitive actions</h3><div class="list">' + r.sensitive.map((s) => '<div class="row static"><span class="grow"><span class="t">' + esc(s.action) + (s.repo ? ' &middot; ' + esc(s.repo) : '') + '</span><span class="s">' + fmt(s.at) + (s.account ? ' &middot; ' + esc(s.account) : '') + '</span></span>' + (s.flagged ? pill('flagged', 'warn', 'flag') : '') + '</div>').join('') + '</div>';
  h += '<h3>Notes</h3><div class="card"><textarea id="notes" maxlength="1000">' + esc(u.notes || '') + '</textarea><div class="inline" style="margin-top:8px"><button class="btn" id="savenotes">' + ico('note') + 'Save notes</button></div></div>';
  h += '<h3>Message</h3><div class="card"><textarea id="msg" maxlength="1500" placeholder="Sent to this person by the bot"></textarea><div class="inline" style="margin-top:8px"><button class="btn" id="sendmsg">' + ico('send') + 'Send</button></div></div>';
  h += '<h3>History</h3><div class="list audit">' + (r.audit.length ? r.audit.map(auditRow).join('') : empty('No admin actions yet', 'scroll')) + '</div>';
  return h;
}

function bindUserDetail(r, id) {
  const P = '/users/' + id + '/';
  const again = (j) => { if (j) views.users(id, '', true); };
  const undoable = async (j, what) => { if (!j) return; if (j.undoId) toastUndo(j.undoId); else await offerUndo(Number(id), what); views.users(id, '', true); };
  on('#setrole', () => { const v = $('#role').value; act('POST', P + 'role', { role: v }, { title: 'Change role', msg: 'Make this person ' + v.replace('_', ' ') + '?', confirm: 'Change role', danger: true }).then(again); });
  on('#revoke', () => act('POST', P + 'role_revoke', {}, { title: 'Revoke admin role', msg: 'They become a normal user again.', confirm: 'Revoke', danger: true }).then(again));
  on('#ban', () => act('POST', P + 'ban', { reason: $('#breason').value, days: $('#bdays').value }, { title: 'Ban this person', msg: 'They lose access and their GitHub connection is removed.', confirm: 'Ban', danger: true }).then((j) => undoable(j, 'ban')));
  on('#unban', () => act('POST', P + 'unban', {}, { title: 'Unban', msg: 'They can use the bot again (they must reconnect GitHub).', confirm: 'Unban' }).then(again));
  on('#susp', () => act('POST', P + 'suspend', { hours: $('#shours').value, reason: $('#sreason').value }, { title: 'Suspend', msg: 'Block access for ' + $('#shours').value + ' hours?', confirm: 'Suspend' }).then((j) => undoable(j, 'suspend')));
  on('#unsusp', () => act('POST', P + 'unsuspend', {}, { title: 'Lift suspension', msg: 'Allow access again?', confirm: 'Lift' }).then(again));
  on('#pause', () => act('POST', P + 'pause', { key: $('#pkey').value }, { title: 'Pause feature', msg: 'Pause this area for this person only?', confirm: 'Pause' }).then(again));
  onAll('[data-resume]', (b) => act('POST', P + 'unpause', { key: b.getAttribute('data-resume') }, { title: 'Resume feature', msg: 'Let them use it again?', confirm: 'Resume' }).then(again));
  on('#savenotes', async () => { await quick('POST', P + 'notes', { notes: $('#notes').value }, 'Notes saved'); });
  on('#sendmsg', () => { const m = $('#msg').value; if (!m.trim()) return toast('Write a message first', true); act('POST', P + 'message', { text: m }, { title: 'Send message', msg: 'Send this to the person through the bot?', confirm: 'Send' }).then((j) => { if (j) $('#msg').value = ''; }); });
}
