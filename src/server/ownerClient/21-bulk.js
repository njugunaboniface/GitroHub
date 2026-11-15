/* Bulk tools and exports */
views.bulk = async (arg, sub, silent) => {
  const paint = painter('bulk');
  if (!silent) paint(loadingHtml());
  try {
    const p = await api('GET', '/bulk/preview');
    const tool = (icon, title, text, count, btn, id, danger) => '<div class="card"><div class="inline between nowrap"><span class="grow"><span class="t strong">' + ico(icon) + esc(title) + '</span><br><span class="muted small">' + esc(text) + '</span></span><span class="pill">' + num(count) + '</span></div><div class="inline" style="margin-top:10px"><button class="btn ' + (danger ? 'danger' : '') + '" id="' + id + '">' + esc(btn) + '</button></div></div>';
    const h = '<h2>' + ico('wrench') + 'Bulk tools</h2><p class="muted">These affect many people at once and need a fresh sign-in. Admins are never included. The ones that can be reversed show an Undo in the <a href="#audit">audit log</a> for an hour.</p>' +
      tool('pause', 'Suspend people', 'Block access for a number of hours. Everyone who isn\u2019t an admin, or only people inactive for 30 days.', p.activeNonAdmins, 'Suspend\u2026', 'bsusp') +
      tool('bell', 'Mute or unmute all', 'Turn GitHub activity messages off (or back on) for everyone.', p.webhookPairs, 'Mute or unmute\u2026', 'bmute') +
      tool('mail', 'Nudge people who never connected', 'Send one friendly reminder to people who started the bot but never linked GitHub.', p.neverConnected, 'Send nudge\u2026', 'bnudge') +
      tool('trash', 'Remove never-connected accounts', 'Delete accounts that never connected GitHub. Older than a number of days, or all.', p.neverConnected, 'Remove\u2026', 'bpurge', true) +
      tool('trash', 'Delete banned people\u2019s data', 'Permanently remove the records of everyone who is banned.', p.banned, 'Delete\u2026', 'bdel', true) +
      '<h3>Exports</h3><div class="card"><div class="inline between nowrap"><span class="grow"><span class="t strong">' + ico('download') + 'All users (JSON)</span><br><span class="muted small">Every user record without tokens. Personal data, so it needs a fresh sign-in.</span></span><button class="btn" id="bexp">Download</button></div></div>';
    if (!paint(h, silent)) return;
    const again = (j) => { if (j) { if (j.undoId) toastUndo(j.undoId); views.bulk(); } };
    const typed = field('Type DELETE to confirm', 'confirm', { ph: 'DELETE' });
    on('#bsusp', () => act('POST', '/bulk/suspend', (v) => ({ scope: v.scope, hours: v.hours }), { title: 'Suspend people', confirm: 'Suspend', danger: true, msg: 'Admins are skipped.', fields: field('Who', 'scope', { type: 'select', value: 'stale', options: [['stale', 'Inactive for 30 days (' + p.stale30d + ')'], ['all', 'Everyone (' + p.activeNonAdmins + ')']] }) + field('Hours', 'hours', { type: 'number', value: 24, min: 1 }) }).then(again));
    on('#bmute', () => act('POST', '/bulk/mute', (v) => ({ mute: v.mute === 'mute' }), { title: 'Mute or unmute all', confirm: 'Apply', danger: true, fields: field('Action', 'mute', { type: 'select', value: 'mute', options: [['mute', 'Mute everyone'], ['unmute', 'Unmute everyone']] }) }).then(again));
    on('#bnudge', () => act('POST', '/bulk/nudge', {}, { title: 'Send the nudge', msg: 'One message each to ' + num(p.neverConnected) + ' people.', confirm: 'Send', danger: true }).then(again));
    on('#bpurge', () => act('POST', '/bulk/purge', (v) => ({ days: v.days === '' ? null : v.days, confirm: v.confirm }), { title: 'Remove never-connected accounts', confirm: 'Remove', danger: true, msg: 'This cannot be undone.', fields: field('Only those older than (days) - empty for all', 'days', { type: 'number', value: 30, min: 1 }) + typed }).then(again));
    on('#bdel', () => act('POST', '/bulk/delete_banned', (v) => ({ confirm: v.confirm }), { title: 'Delete banned people\u2019s data', confirm: 'Delete', danger: true, msg: 'This permanently removes ' + num(p.banned) + ' records and cannot be undone.', fields: typed }).then(again));
    on('#bexp', () => download('/export/users', 'users.json'));
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
