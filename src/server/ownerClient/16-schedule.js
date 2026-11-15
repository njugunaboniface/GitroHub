/* Announcements: send now, schedule (once or repeating), cancel, repost, history */
const STATUS_KIND = { sent: 'ok', failed: 'bad', cancelled: '', processing: 'warn', pending: 'warn' };
const snippet = (t, n) => { t = String(t || ''); return t.length > (n || 140) ? t.slice(0, n || 140) + '\u2026' : t; };
const localInput = (d) => { const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
const recText = (r) => (!r ? '' : r.type === 'daily' ? 'daily' : r.type === 'weekly' ? 'weekly' : 'every ' + r.days + ' days');

views.schedule = async (arg, sub, silent) => {
  const paint = painter('schedule');
  if (!silent) paint(loadingHtml());
  try {
    const off = state.histOff || 0;
    const r = await api('GET', '/schedule?limit=8&offset=' + off);
    const soon = localInput(new Date(Date.now() + 10 * 60 * 1000));
    let h = '<h2>' + ico('calendar') + 'Announcements</h2><div class="card"><p class="muted" style="margin:0 0 8px">Goes to ' + num(r.recipients) + ' people through the bot.' + (r.running ? ' <b>One is being sent right now.</b>' : '') + '</p>' +
      '<textarea id="bc" maxlength="3500" placeholder="Write the announcement"></textarea>' +
      '<div class="inline" style="margin-top:10px"><select id="when"><option value="now">Send now</option><option value="later">Schedule for later</option></select></div>' +
      '<div id="later" hidden><div class="inline" style="margin-top:10px"><input type="datetime-local" id="at" value="' + soon + '" min="' + localInput(new Date(Date.now() + 2 * 60 * 1000)) + '"><select id="rep"><option value="">Once</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="interval">Every few days</option></select><input type="number" id="repd" min="2" max="90" value="3" hidden placeholder="Days"></div>' +
      '<div class="inline" id="endrow" hidden style="margin-top:8px"><span class="muted small">Stop repeating after</span><input type="datetime-local" id="endat"></div><p class="muted small" id="tzn"></p></div>' +
      '<div class="inline" style="margin-top:10px"><button class="btn danger" id="bsend"' + (r.running ? ' disabled' : '') + '>' + ico('megaphone') + '<span id="blabel">Send to everyone</span></button></div></div>';
    h += '<h3>Scheduled</h3>' + (r.pending.length ? '<div class="list">' + r.pending.map((p) => '<div class="card"><div class="inline between"><span class="pill warn">' + ico('clock') + esc(fmt(p.sendAt)) + '</span><span class="muted small">' + esc(ago(p.sendAt)) + (p.recurrence ? ' &middot; repeats ' + esc(recText(p.recurrence)) : '') + '</span></div><p class="plain">' + esc(snippet(p.text)) + '</p><div class="inline"><button class="btn small" data-cancel="' + p.id + '">' + ico('x') + 'Cancel</button></div></div>').join('') + '</div>' : empty('Nothing scheduled', 'calendar'));
    h += '<h3>History</h3>' + (r.history.length ? '<div class="list">' + r.history.map((x) => '<div class="card"><div class="inline between"><span class="pill ' + (STATUS_KIND[x.status] || '') + '">' + esc(x.status) + '</span><span class="muted small">' + esc(fmt(x.sentAt || x.sendAt || x.createdAt)) + (x.sent != null ? ' &middot; ' + x.sent + '/' + x.total + ' delivered' : '') + (x.viaWarden ? ' &middot; by Warden' : '') + '</span></div><p class="plain">' + esc(snippet(x.text)) + '</p>' + (x.error ? '<p class="muted small">' + esc(x.error) + '</p>' : '') + '<div class="inline"><button class="btn small" data-repost="' + x.id + '">' + ico('repeat') + 'Send again</button></div></div>').join('') + '</div>' +
      '<div class="more inline center">' + (off ? '<button class="btn small" id="hnew">Newer</button>' : '') + (off + r.history.length < r.total ? '<button class="btn small" id="hold">Older</button>' : '') + '</div>' : empty('No announcements yet', 'megaphone'));
    if (!paint(h, silent)) return;
    $('#tzn').textContent = 'Times are in your device\u2019s time zone (' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'local') + ').';
    const sync = () => { const later = $('#when').value === 'later'; $('#later').hidden = !later; $('#blabel').textContent = later ? 'Schedule it' : 'Send to everyone'; const rv = $('#rep').value; $('#repd').hidden = rv !== 'interval'; $('#endrow').hidden = !rv; };
    on('#when', sync, 'change'); on('#rep', sync, 'change'); sync();
    on('#bsend', async () => {
      const text = $('#bc').value;
      if (!text.trim()) return toast('Write the announcement first', true);
      if ($('#when').value === 'now') {
        const j = await act('POST', '/broadcast', { text }, { title: 'Send announcement', msg: 'Send this to ' + num(r.recipients) + ' people now? This cannot be undone.', confirm: 'Send', danger: true, done: 'Sending. You will get a message when it is done.' });
        if (j) { $('#bc').value = ''; setTimeout(() => views.schedule(), 800); }
        return;
      }
      const at = new Date($('#at').value);
      if (Number.isNaN(at.getTime())) return toast('Pick a date and time', true);
      const rep = $('#rep').value;
      const body = { text, sendAt: at.toISOString() };
      if (rep) { body.recurrence = { type: rep }; if (rep === 'interval') body.recurrence.days = Number($('#repd').value); if ($('#endat').value) body.recurrence.endAt = new Date($('#endat').value).toISOString(); }
      const j = await act('POST', '/schedule', body, { title: 'Schedule announcement', msg: 'Send on ' + fmt(at) + (rep ? ', repeating ' + (rep === 'interval' ? 'every ' + body.recurrence.days + ' days' : rep) : '') + '?', confirm: 'Schedule', danger: true, done: 'Scheduled' });
      if (j) { $('#bc').value = ''; views.schedule(); }
    });
    onAll('[data-cancel]', (b) => act('POST', '/schedule/' + b.getAttribute('data-cancel') + '/cancel', {}, { title: 'Cancel this announcement', msg: 'It will not be sent.', confirm: 'Cancel it', done: 'Cancelled' }).then((j) => { if (j) views.schedule(); }));
    onAll('[data-repost]', (b) => act('POST', '/schedule/' + b.getAttribute('data-repost') + '/repost', {}, { title: 'Send this again', msg: 'Send it to ' + num(r.recipients) + ' people now?', confirm: 'Send', danger: true, done: 'Sending. You will get a message when it is done.' }).then((j) => { if (j) setTimeout(() => views.schedule(), 800); }));
    on('#hold', () => { state.histOff = off + 8; views.schedule(); });
    on('#hnew', () => { state.histOff = Math.max(0, off - 8); views.schedule(); });
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
