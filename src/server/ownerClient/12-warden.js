/* Warden: cases, Warden Watch, approvals, decision log, settings and lockdown */
const WTABS = [['cases', 'Cases'], ['watch', 'Watch'], ['approvals', 'Approvals'], ['log', 'Log'], ['settings', 'Settings']];
const STAGE_FILTER = [['flag', 'All flagged'], ['enhanced_monitoring', 'Enhanced +'], ['review_candidate', 'Review candidates']];
const stagePill = (s) => '<span class="pill st-' + esc(s) + '">' + esc(stageLabel(s)) + '</span>';
const confidenceWord = (c) => (c >= 0.85 ? 'very high' : c >= 0.7 ? 'high' : c >= 0.5 ? 'moderate' : c >= 0.3 ? 'low' : 'very low');
const prettyKind = (k) => String(k || '').replace(/_/g, ' ');

/** A small readable view of a JSON blob: simple values as lines, lists joined, objects shortened. */
function briefObj(o) {
  if (o == null) return '';
  if (typeof o !== 'object') return String(o);
  return Object.keys(o).filter((k) => k.charAt(0) !== '_').slice(0, 8).map((k) => {
    const v = o[k];
    const t = v == null ? '-' : Array.isArray(v) ? v.slice(0, 6).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v);
    return prettyKind(k) + ': ' + t;
  }).join(' \u00b7 ');
}

function wardenHead(w) {
  const total = Object.values(w.stages || {}).reduce((a, b) => a + b, 0) || 1;
  const order = w.order || ['normal', 'observe', 'flag', 'enhanced_monitoring', 'review_candidate'];
  return '<h2>' + ico('warden') + 'Warden</h2>' + (w.lockdown.active ? '<div class="banner bad">' + ico('lock') + '<div><b>Full lockdown is on.</b> ' + w.lockdown.locked + ' admin' + (w.lockdown.locked === 1 ? ' is' : 's are') + ' locked out of their dashboards.</div></div>' : '') +
    (w.config && !w.config.enabled ? '<div class="banner">' + ico('info') + '<div>Warden is switched off. Cases below are from before.</div></div>' : '') +
    '<div class="stagebar" role="img" aria-label="People by Warden stage">' + order.map((s) => '<span class="seg-st st-' + s + '" style="flex:' + Math.max(0.02, (w.stages[s] || 0) / total) + '" title="' + esc(stageLabel(s) + ': ' + (w.stages[s] || 0)) + '"></span>').join('') + '</div>' +
    '<div class="stagekey">' + order.map((s) => '<span><i class="dotc st-' + s + '"></i>' + esc(stageLabel(s)) + ' <b>' + num(w.stages[s] || 0) + '</b></span>').join('') + '</div>' +
    '<div class="grid">' + stat('Open cases', w.openCases, '', w.openCases ? 'warn' : 'ok') + stat('Flagged actions', w.flaggedOpen, 'to review', w.flaggedOpen ? 'warn' : 'ok') + stat('Approvals', w.approvalsPending, 'waiting for you', w.approvalsPending ? 'warn' : 'ok') + stat('Lockdown', w.lockdown.active ? 'ON' : 'Off', w.lockdown.locked + ' locked', w.lockdown.active ? 'bad' : 'ok') + '</div>' +
    seg(WTABS, state.warden.tab, 'data-wt');
}

views.warden = async (arg, sub, silent) => {
  const paint = painter('warden');
  const isCase = /^\d+$/.test(arg || '');
  const tab = isCase ? 'cases' : (WTABS.some((t) => t[0] === arg) ? arg : 'cases');
  state.warden.tab = tab;
  if (!silent) paint(loadingHtml());
  try {
    const w = await api('GET', '/warden');
    let body = '', after = null;
    if (tab === 'cases') {
      const [list, detail] = await Promise.all([api('GET', '/warden/cases?limit=30&stage=' + state.warden.stage), isCase ? api('GET', '/warden/cases/' + arg) : null]);
      const L = casesListHtml(list, arg);
      body = isWide() ? split(L, detail ? caseDetailHtml(detail) : '', !!detail, 'Pick a case from the list') : (detail ? caseDetailHtml(detail) : L);
      after = () => bindCases(detail, arg);
      if (isCase && !isWide()) { if (paint(body, silent)) after(); return; }
    } else if (tab === 'watch') { const r = await api('GET', '/warden/watch'); body = watchHtml(r); after = () => bindWatch(); }
    else if (tab === 'approvals') { const r = await api('GET', '/warden/approvals'); body = approvalsHtml(r); after = () => bindApprovals(); }
    else if (tab === 'log') { const r = await api('GET', '/warden/log?limit=15&offset=' + (state.warden.logOff || 0)); body = logHtml(r, w); after = () => bindLog(r, w); }
    else { body = settingsHtml(w); after = () => bindSettings(w); }
    const painted = paint(wardenHead(w) + '<div id="wbody">' + body + '</div>', silent);
    if (painted) { bindWTabs(); if (after) after(); }
  } catch (e) { if (!silent) paint(errHtml(e)); }
};
views.warden.live = true;
const bindWTabs = () => onAll('[data-wt]', (b) => { state.warden.logOff = 0; go('#warden' + (b.getAttribute('data-wt') === 'cases' ? '' : '/' + b.getAttribute('data-wt'))); });

function casesListHtml(r, sel) {
  let h = seg(STAGE_FILTER, state.warden.stage, 'data-ws');
  if (!r.cases.length) return h + empty('No open cases. Warden has nothing to report.', 'check-circle');
  h += '<div class="list">' + r.cases.map((c) => '<a class="row' + (String(c.id) === String(sel) ? ' sel' : '') + '" href="#warden/' + c.id + '">' + avatar({ id: c.userId, name: c.name, username: c.username }) + '<span class="grow"><span class="t">' + esc(who({ name: c.name, username: c.username, id: c.userId })) + '</span><span class="s">' + stagePill(c.stage) + ' ' + (c.snoozeUntil && isLive(c.snoozeUntil) ? pill('snoozed', '', 'pause') : '') + '</span>' +
    '<span class="meterrow"><span>Risk</span>' + meter(c.risk, 'risk') + '<span>' + Math.round((c.risk || 0) * 100) + '%</span></span></span><span class="muted small">' + esc(ago(c.openedAt)) + '</span>' + ico('chevron-right') + '</a>').join('') + '</div>';
  return h + '<p class="muted small">Showing ' + r.cases.length + ' of ' + r.total + '.</p>';
}
function caseDetailHtml(r) {
  const c = r.case;
  let h = isWide() ? '' : back('#warden', 'Cases');
  h += '<div class="card"><div class="row static flat">' + avatar({ id: c.userId, name: c.name, username: c.username }) + '<span class="grow"><span class="t">' + esc(who({ name: c.name, username: c.username, id: c.userId })) + '</span><span class="s">Case #' + c.id + ' &middot; opened ' + fmt(c.openedAt) + '</span></span></div><div class="pills">' + stagePill(c.stage) + (c.peak !== c.stage ? pill('peak: ' + stageLabel(c.peak)) : '') + (c.status !== 'open' ? pill(c.status + (r.closeReason ? ' (' + prettyKind(r.closeReason) + ')' : ''), 'ok') : '') + (r.snoozeUntil && isLive(r.snoozeUntil) ? pill('snoozed until ' + fmt(r.snoozeUntil), '', 'pause') : '') + '</div>' +
    '<div class="meterrow"><span>Risk</span>' + meter(c.risk, 'risk') + '<span>' + Math.round((c.risk || 0) * 100) + '%</span></div><div class="meterrow"><span>Confidence</span>' + meter(c.confidence, 'conf') + '<span>' + esc(confidenceWord(c.confidence || 0)) + '</span></div>' +
    kv([['Earlier cases', r.prior.priorCases], ['Warnings sent', r.prior.warnings], ['Last update', fmt(c.updatedAt)]]) + '</div>';
  if (c.summary) h += '<h3>Why Warden is watching</h3><div class="card"><p class="plain">' + esc(briefObj(c.summary) || 'No summary recorded.') + '</p></div>';
  if (c.status === 'open') {
    h += '<h3>Decide</h3><div class="card"><div class="inline"><button class="btn" id="cdismiss">' + ico('check-circle') + 'Dismiss (false alarm)</button><button class="btn" id="csnooze">' + ico('pause') + 'Snooze</button><a class="btn" href="#users/' + c.userId + '">' + ico('user') + 'Open user</a></div>' +
      '<div class="inline" style="margin-top:8px"><button class="btn" id="csusp">' + ico('pause') + 'Suspend</button><button class="btn danger" id="cban">' + ico('ban') + 'Ban</button></div><p class="muted small" style="margin:10px 0 0">Warden only reports. Every action here is your decision and is logged.</p></div>';
  }
  h += '<h3>Timeline</h3>' + (r.events.length ? '<div class="list">' + r.events.map((e) => '<div class="row static"><span class="grow"><span class="t">' + esc(prettyKind(e.kind)) + '</span><span class="s">' + esc(briefObj(e.detail)) + '</span><span class="s">' + fmt(e.at) + (e.actor ? ' &middot; by ' + esc(e.actor) : '') + '</span></span></div>').join('') + '</div>' : empty('No events yet', 'scroll'));
  h += '<h3>Evidence</h3>' + (r.evidence.length ? '<div class="list">' + r.evidence.map((e) => '<div class="row static"><span class="grow"><span class="t">' + esc(prettyKind(e.type)) + '</span><span class="s">' + esc(prettyKind(e.class)) + ' &middot; ' + fmt(e.at) + '</span><span class="s">' + esc(briefObj(e.observed)) + '</span></span>' + meter(e.strength, 'risk') + '</div>').join('') + '</div>' : empty('No evidence recorded', 'activity'));
  return h;
}
function bindCases(detail, sel) {
  onAll('[data-ws]', (b) => { state.warden.stage = b.getAttribute('data-ws'); views.warden(sel || '', '', false); });
  if (!detail) return;
  const c = detail.case, id = c.id;
  const days = (d) => field('For how many days?', 'days', { type: 'select', value: d, options: [['1', '1 day'], ['3', '3 days'], ['7', '7 days'], ['14', '14 days'], ['30', '30 days']] });
  const again = (j) => { if (j) views.warden(String(id), '', false); };
  on('#cdismiss', () => act('POST', '/warden/cases/' + id + '/dismiss', (v) => ({ days: v.days }), { title: 'Dismiss this case', msg: 'Mark it a false alarm. Warden won\u2019t raise this person again for a while.', confirm: 'Dismiss', fields: days('7') }).then(again));
  on('#csnooze', () => act('POST', '/warden/cases/' + id + '/snooze', (v) => ({ days: v.days }), { title: 'Snooze this case', msg: 'Warden stays quiet about this person for a while.', confirm: 'Snooze', fields: days('7') }).then(again));
  on('#csusp', () => act('POST', '/users/' + c.userId + '/suspend', (v) => ({ hours: v.hours, reason: v.reason }), { title: 'Suspend this person', msg: 'They are blocked for the hours you choose.', confirm: 'Suspend', fields: field('Hours', 'hours', { type: 'number', value: 24, min: 1 }) + field('Reason (optional)', 'reason', {}) }).then(async (j) => { if (j) { if (j.undoId) toastUndo(j.undoId); else await offerUndo(c.userId, 'suspend'); again(j); } }));
  on('#cban', () => act('POST', '/users/' + c.userId + '/ban', (v) => ({ reason: v.reason }), { title: 'Ban this person', msg: 'They lose access and their GitHub connection is removed.', confirm: 'Ban', danger: true, fields: field('Reason (optional)', 'reason', {}) }).then(async (j) => { if (j) { if (j.undoId) toastUndo(j.undoId); else await offerUndo(c.userId, 'ban'); again(j); } }));
}

function watchHtml(r) {
  let h = '<h3>Flagged sensitive actions</h3>';
  h += r.flagged.length ? '<div class="list">' + r.flagged.map((s) => '<div class="row static"><span class="grow"><span class="t">' + esc(s.label) + (s.repo ? ' &middot; ' + esc(s.repo) : '') + '</span><span class="s"><a href="#users/' + s.userId + '">' + esc(who({ name: s.name, username: s.username, id: s.userId })) + '</a>' + (s.account ? ' &middot; ' + esc(s.account) : '') + ' &middot; ' + fmt(s.at) + '</span></span>' + pill('score ' + s.score, 'warn', 'flag') + '<button class="btn small" data-review="' + s.id + '">' + ico('check') + 'Reviewed</button></div>').join('') + '</div>' : '<div class="card calm">' + ico('check-circle', 'ic-draw') + '<span>Nothing flagged.</span></div>';
  h += '<h3>Recent changes people made</h3>' + (r.changes.length ? '<div class="list">' + r.changes.map((a) => '<div class="row static"><span class="grow"><span class="t">' + esc(a.area) + ' &middot; ' + esc(a.action) + (a.repo ? ' &middot; ' + esc(a.repo) : '') + '</span><span class="s"><a href="#users/' + a.userId + '">' + esc(who({ name: a.name, username: a.username, id: a.userId })) + '</a> &middot; ' + fmt(a.at) + '</span></span></div>').join('') + '</div>' : empty('No changes yet', 'scroll'));
  return h;
}
function bindWatch() {
  onAll('[data-review]', async (b) => { const j = await quick('POST', '/warden/watch/' + b.getAttribute('data-review') + '/review', {}, 'Marked reviewed'); if (j) views.warden('watch', '', false); });
}
function approvalsHtml(r) {
  return '<h3>Held actions waiting for you</h3>' + (r.approvals.length ? '<div class="list">' + r.approvals.map((a) => '<div class="row static"><span class="grow"><span class="t">' + esc(a.label) + (a.repo ? ' &middot; ' + esc(a.repo) : '') + '</span><span class="s"><a href="#users/' + a.userId + '">' + esc(who({ name: a.name, username: a.username, id: a.userId })) + '</a> &middot; ' + esc(ago(a.at)) + '</span></span><button class="btn small" data-allow="' + a.id + '">' + ico('check-circle') + 'Approve</button><button class="btn small danger" data-deny="' + a.id + '">' + ico('x') + 'Deny</button></div>').join('') + '</div>' : '<div class="card calm">' + ico('check-circle', 'ic-draw') + '<span>Nothing is waiting for approval.</span></div>');
}
function bindApprovals() {
  const decide = (id, allow) => act('POST', '/warden/approvals/' + id + '/decide', { allow }, { title: allow ? 'Approve this action' : 'Deny this action', msg: allow ? 'They can go ahead for the next 15 minutes and are told.' : 'The action stays blocked and they are told.', confirm: allow ? 'Approve' : 'Deny', danger: !allow }).then((j) => { if (j) views.warden('approvals', '', false); });
  onAll('[data-allow]', (b) => decide(b.getAttribute('data-allow'), true));
  onAll('[data-deny]', (b) => decide(b.getAttribute('data-deny'), false));
}
function logHtml(r, w) {
  const off = r.offset || 0;
  let h = '<h3>What Warden decided</h3>' + (r.rows.length ? '<div class="list">' + r.rows.map((l) => '<div class="row static"><span class="grow"><span class="t">' + esc(prettyKind(l.action)) + (l.dryRun ? ' (dry run)' : '') + '</span><span class="s"><a href="#users/' + l.userId + '">' + esc(who({ name: l.name, username: l.username, id: l.userId })) + '</a> &middot; ' + fmt(l.at) + '</span><span class="s">' + esc(l.reason) + '</span></span></div>').join('') + '</div>' : empty('Warden hasn\u2019t taken any action.', 'scroll'));
  h += '<div class="more inline center">' + (off ? '<button class="btn small" id="lnew">Newer</button>' : '') + (off + r.rows.length < r.total ? '<button class="btn small" id="lold">Older</button>' : '') + '</div>';
  if (w.datasets && w.datasets.length) h += '<h3>Export (needs a fresh sign-in)</h3><div class="inline">' + w.datasets.map((d) => '<button class="btn small" data-export="' + esc(d) + '">' + ico('download') + esc(prettyKind(d)) + '</button>').join('') + '</div>';
  return h;
}
function bindLog(r) {
  on('#lold', () => { state.warden.logOff = (r.offset || 0) + 15; views.warden('log', '', false); });
  on('#lnew', () => { state.warden.logOff = Math.max(0, (r.offset || 0) - 15); views.warden('log', '', false); });
  onAll('[data-export]', (b) => download('/warden/export/' + encodeURIComponent(b.getAttribute('data-export')) + '?days=90', 'warden.jsonl'));
}
function settingsHtml(w) {
  const c = w.config || {};
  return '<h3>Warden</h3><div class="card"><div class="inline between nowrap"><span><b>Warden is on</b><br><span class="muted small">Watches for unusual activity and reports to you.</span></span>' + sw('wen', c.enabled, 'Warden on') + '</div>' +
    '<div class="inline between nowrap" style="margin-top:14px"><span><b>Tell me about cases</b><br><span class="muted small">Send a message when a case reaches review.</span></span>' + sw('wal', c.alertsReview, 'Case alerts') + '</div></div>' +
    '<h3>Emergency lockdown</h3><div class="card"><p style="margin-top:0">' + (w.lockdown.active ? '<b>Full lockdown is ON.</b> All admins except you are locked out of their dashboards.' : 'Locks every admin and moderator out of their dashboards at once. You keep full access. Needs a fresh sign-in.') + '</p>' +
    '<div class="inline">' + (w.lockdown.active ? '<button class="btn primary" id="lockoff">' + ico('lock') + 'End lockdown</button>' : '<button class="btn danger" id="lockon">' + ico('lock') + 'Lock all admins</button>') + '<a class="btn" href="#team">Admin team</a></div></div>';
}
function bindSettings() {
  on('#wen', async (e) => { const j = await quick('POST', '/warden/config', { enabled: e.target.checked }, 'Saved'); if (!j) e.target.checked = !e.target.checked; }, 'change');
  on('#wal', async (e) => { const j = await quick('POST', '/warden/config', { alertsReview: e.target.checked }, 'Saved'); if (!j) e.target.checked = !e.target.checked; }, 'change');
  on('#lockon', () => act('POST', '/warden/lockdown', { on: true }, { title: 'Lock all admins', msg: 'Every admin and moderator is locked out of their dashboard now. You are not affected.', confirm: 'Lock everyone out', danger: true }).then((j) => { if (j) views.warden('settings', '', false); }));
  on('#lockoff', () => act('POST', '/warden/lockdown', { on: false }, { title: 'End lockdown', msg: 'Admins get their dashboards back.', confirm: 'End lockdown' }).then((j) => { if (j) views.warden('settings', '', false); }));
}
