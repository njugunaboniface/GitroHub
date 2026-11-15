/* Audit log, with one-tap Undo for the last hour's reversible actions */
function auditRow(a) {
  const who1 = a.adminName || (a.admin_id ? String(a.admin_id) : '');
  const who2 = a.targetName || (a.target_telegram_id ? String(a.target_telegram_id) : '');
  return '<div class="row static"><span class="grow"><span class="t">' + esc(String(a.action || '').replace(/_/g, ' ')) + '</span><span class="s">' + esc(a.detail || '') + '</span><span class="s">' + fmt(a.created_at) + (who2 ? ' &middot; ' + (a.target_telegram_id ? '<a href="#users/' + a.target_telegram_id + '">' + esc(who2) + '</a>' : esc(who2)) : '') + (who1 ? ' &middot; by ' + esc(who1) : '') + '</span></span></div>';
}
const UNDO_NAME = { ban: 'Ban', suspend: 'Suspension', bulk_mute: 'Mute all', bulk_suspend: 'Bulk suspension', bulk_delete_banned: 'Delete banned', unban: 'Unban' };
async function doUndo(id) {
  try { await api('POST', '/undo/' + id, {}); toast('Undone'); refreshBadges(); if (cur.name === 'audit') views.audit('', '', false); } catch (e) { if (e.needFresh) await freshNeeded(); else toast(e.message, true); }
}
const toastUndo = (id) => toast('Done. You can undo this for 1 hour.', { action: { label: 'Undo', fn: () => doUndo(id) } });
/** Right after a ban / suspend: offer the matching one-hour undo as a toast button (the API returns its id; this looks it up only as a fallback). */
async function offerUndo(targetId, what) {
  try {
    const r = await api('GET', '/undo');
    const hit = r.entries.filter((e) => e.targets.some((t) => t.id === targetId) && String(e.action).indexOf(what) !== -1)[0];
    if (hit) toast('Done. You can undo this for 1 hour.', { action: { label: 'Undo', fn: () => doUndo(hit.id) } });
  } catch (_) { /* the action itself succeeded; the Audit page still lists the undo */ }
}

views.audit = async (arg, sub, silent) => {
  const paint = painter('audit');
  const f = state.audit;
  if (!silent) paint(loadingHtml());
  try {
    const [r, u] = await Promise.all([api('GET', '/audit?limit=20&offset=' + f.off + (f.action ? '&action=' + encodeURIComponent(f.action) : '') + (f.admin ? '&admin=' + f.admin : '')), api('GET', '/undo').catch(() => ({ entries: [] }))]);
    let h = '<h2>' + ico('scroll') + 'Audit log</h2>';
    if (u.entries.length) h += '<div class="card undo"><div class="ch"><span class="t">' + ico('undo') + 'Can be undone (1 hour)</span></div><div class="list">' + u.entries.map((e) => '<div class="row static flat"><span class="grow"><span class="t">' + esc(UNDO_NAME[e.action] || String(e.action).replace(/_/g, ' ')) + (e.count > 1 ? ' &middot; ' + e.count + ' people' : '') + '</span><span class="s">' + esc(e.targets.map((t) => t.name).join(', ')) + ' &middot; ' + esc(ago(e.at)) + ', expires ' + esc(ago(e.expiresAt)) + '</span></span><button class="btn small" data-undo="' + e.id + '">' + ico('undo') + 'Undo</button></div>').join('') + '</div></div>';
    h += '<div class="inline"><select id="fa"><option value="">All actions</option>' + r.actions.map((a) => '<option' + (a === f.action ? ' selected' : '') + '>' + esc(a) + '</option>').join('') + '</select><select id="fb"><option value="">All admins</option>' + r.admins.map((a) => '<option value="' + a.id + '"' + (String(a.id) === String(f.admin) ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select></div>' +
      '<div class="list audit" style="margin-top:12px">' + (r.rows.length ? r.rows.map(auditRow).join('') : empty('Nothing here', 'scroll')) + '</div><div class="more inline center">' + (f.off ? '<button class="btn small" id="newer">Newer</button>' : '') + (f.off + r.rows.length < r.total ? '<button class="btn small" id="older">Older</button>' : '') + '</div><p class="muted small center">' + num(r.total) + ' entries</p>';
    if (!paint(h, silent)) return;
    on('#fa', (e) => { f.action = e.target.value; f.off = 0; views.audit(); }, 'change');
    on('#fb', (e) => { f.admin = e.target.value; f.off = 0; views.audit(); }, 'change');
    on('#older', () => { f.off += 20; views.audit(); });
    on('#newer', () => { f.off = Math.max(0, f.off - 20); views.audit(); });
    onAll('[data-undo]', (b) => act('POST', '/undo/' + b.getAttribute('data-undo'), {}, { title: 'Undo this', msg: 'Put things back the way they were?', confirm: 'Undo', done: 'Undone' }).then((j) => { if (j) views.audit(); }));
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
views.audit.live = true;
