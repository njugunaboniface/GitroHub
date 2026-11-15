/* Owner panel — dialogs, toasts, shared widgets, charts. */
function toast(msg, opts) {
  const o = typeof opts === 'boolean' ? { bad: opts } : (opts || {});
  const t = $('#toast');
  t.className = 'show' + (o.bad ? ' bad' : '');
  t.innerHTML = ico(o.bad ? 'alert' : 'check-circle') + '<span>' + esc(msg) + '</span>' + (o.action ? '<button class="btn small" id="toastAct">' + esc(o.action.label) + '</button>' : '');
  if (o.action) on('#toastAct', () => { t.className = ''; o.action.fn(); });
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.className = ''; }, o.action ? 9000 : 3500);
}

/** A confirm dialog. Resolves to { vals } (the named fields) when confirmed, or null. `msg` is plain text; `fields` is trusted HTML. */
function dialog(o) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = '<h3>' + esc(o.title) + '</h3>' + (o.msg ? '<p>' + esc(o.msg) + '</p>' : '') + (o.fields || '') +
      '<div class="btns"><button class="btn" value="no" type="button">' + esc(o.cancel || 'Cancel') + '</button>' +
      '<button class="btn ' + (o.danger ? 'danger' : 'primary') + '" value="yes" type="button">' + esc(o.confirm || 'Confirm') + '</button></div>';
    document.body.appendChild(d);
    d.showModal();
    const first = d.querySelector('[name]'); if (first && first.focus) first.focus();
    const done = (res) => { try { d.close(); } catch (_) { /* already closed */ } setTimeout(() => d.remove(), 0); resolve(res); };
    d.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button');
      if (!b) return;
      if (b.value !== 'yes') return done(null);
      const vals = {};
      d.querySelectorAll('[name]').forEach((x) => { vals[x.name] = x.type === 'checkbox' ? x.checked : x.value; });
      done({ vals });
    });
    d.addEventListener('cancel', () => done(null));
  });
}
const freshNeeded = () => dialog({ title: 'Fresh sign-in needed', msg: 'For safety this needs a sign-in from the last 10 minutes. Send /owner to the bot, open the new link, then try again.', confirm: 'OK', cancel: 'Close' });

/** Confirm → call the API → toast. Resolves to the API answer, or null when cancelled / failed. */
async function act(method, path, body, o) {
  const r = await dialog(o);
  if (!r) return null;
  try {
    const j = await api(method, path, typeof body === 'function' ? body(r.vals) : body);
    toast(o.done || 'Done', o.undo ? { action: { label: 'Undo', fn: o.undo } } : undefined);
    refreshBadges();
    return j || {};
  } catch (e) {
    if (e.needFresh) { await freshNeeded(); return null; }
    toast(e.message, true);
    return null;
  }
}
/** A quick call with no dialog (toggles, saves). */
async function quick(method, path, body, done) {
  try { const j = await api(method, path, body); toast(done || 'Saved'); return j || {}; } catch (e) {
    if (e.needFresh) { await freshNeeded(); return null; }
    toast(e.message, true); return null;
  }
}

const field = (label, name, o) => {
  o = o || {};
  const tag = o.type === 'textarea' ? '<textarea name="' + name + '" maxlength="' + (o.max || 500) + '" placeholder="' + esc(o.ph || '') + '">' + esc(o.value || '') + '</textarea>'
    : o.type === 'select' ? '<select name="' + name + '">' + o.options.map((x) => '<option value="' + esc(x[0]) + '"' + (x[0] === o.value ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select>'
    : '<input name="' + name + '" type="' + (o.type || 'text') + '" value="' + esc(o.value == null ? '' : o.value) + '" placeholder="' + esc(o.ph || '') + '"' + (o.min != null ? ' min="' + o.min + '"' : '') + ' autocomplete="off">';
  return '<div class="field"><label>' + esc(label) + '</label>' + tag + '</div>';
};
const stat = (k, v, h, s, i) => '<div class="stat" data-s="' + (s || '') + '"><div class="k"><span>' + esc(k) + '</span>' + (s ? ico(s === 'ok' ? 'check-circle' : s === 'warn' ? 'alert' : 'x-circle', s === 'ok' ? '' : 'ic-shake') : ico(i || 'info')) + '</div><div class="v">' + esc(v) + '</div><div class="h">' + esc(h || '') + '</div></div>';
const sw = (id, on, label) => '<label class="switch"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><span></span><b class="sr">' + esc(label) + '</b></label>';
const back = (href, label) => '<p><a href="' + href + '" class="btn small"><span class="flip">' + ico('chevron-right') + '</span>' + esc(label || 'Back') + '</a></p>';
const seg = (items, active, attr) => '<div class="seg">' + items.map((x) => '<button class="btn small" ' + attr + '="' + esc(x[0]) + '" aria-pressed="' + (x[0] === active) + '">' + esc(x[1]) + '</button>').join('') + '</div>';
const more = (id, n, label) => (n ? '<div class="more"><button class="btn small" id="' + id + '">' + esc(label || 'Load more') + '</button></div>' : '');
const meter = (v, cls) => '<span class="meter ' + (cls || '') + '"><i style="width:' + Math.round(Math.max(0, Math.min(1, v || 0)) * 100) + '%"></i></span>';
const kv = (rows) => '<dl class="kv">' + rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + (r[2] ? r[1] : esc(r[1])) + '</dd>').join('') + '</dl>';

/** Master / detail: side by side on a wide screen, one at a time on a phone. */
function split(listHtml, detailHtml, hasDetail, placeholder) {
  if (isWide()) return '<div class="split"><section class="pane">' + listHtml + '</section><section class="pane detail">' + (hasDetail ? detailHtml : '<div class="empty">' + ico('chevron-right') + esc(placeholder || 'Pick one from the list') + '</div>') + '</section></div>';
  return hasDetail ? detailHtml : listHtml;
}

/* ── SVG charts (animated with CSS; they stay still for reduced motion) ── */
function chartSvg(points, o) {
  o = o || {};
  const W = 320, H = 128, padL = 6, padR = 6, padT = 12, padB = 20;
  const vals = points.map((p) => Number(p.count) || 0);
  const max = Math.max(1, ...vals);
  const n = points.length || 1;
  const x = (i) => padL + (n === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (n - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const labels = points.length ? [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i) : [];
  let body = '';
  if (o.type === 'bar') {
    const slot = (W - padL - padR) / n, bw = Math.max(2, slot * 0.66);
    body = points.map((p, i) => {
      const h = Math.max(vals[i] ? 2 : 0, (H - padT - padB) * (vals[i] / max));
      return '<rect class="bar" style="--i:' + i + '" x="' + (padL + i * slot + (slot - bw) / 2).toFixed(1) + '" y="' + (H - padB - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"><title>' + esc(p.label) + ': ' + vals[i] + '</title></rect>';
    }).join('');
  } else {
    const pts = points.map((p, i) => x(i).toFixed(1) + ',' + y(vals[i]).toFixed(1));
    body = '<path class="area" d="M' + x(0).toFixed(1) + ',' + (H - padB) + ' L' + pts.join(' L') + ' L' + x(n - 1).toFixed(1) + ',' + (H - padB) + ' Z"/>' +
      '<polyline class="line" pathLength="1" points="' + pts.join(' ') + '"/>' +
      points.map((p, i) => '<circle class="dot' + (i === n - 1 ? ' last' : '') + '" cx="' + x(i).toFixed(1) + '" cy="' + y(vals[i]).toFixed(1) + '" r="' + (i === n - 1 ? 3.5 : 6) + '"><title>' + esc(p.label) + ': ' + vals[i] + '</title></circle>').join('');
  }
  const axis = labels.map((i) => '<text x="' + (o.type === 'bar' ? padL + ((i + 0.5) * (W - padL - padR)) / n : x(i)).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '">' + esc(points[i].label) + '</text>').join('');
  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || 'Chart') + '"><line class="base" x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '"/>' + body + axis + '</svg>';
}
const sum = (pts) => pts.reduce((a, p) => a + (Number(p.count) || 0), 0);
const peak = (pts) => pts.reduce((a, p) => Math.max(a, Number(p.count) || 0), 0);
function chartCard(title, pts, o) {
  o = o || {};
  return '<div class="card chartcard ' + (o.cls || 'c-brand') + '"><div class="ch"><span class="t">' + esc(title) + '</span><span class="muted">' + esc(o.sub || '') + '</span></div>' +
    '<div class="big">' + num(o.total != null ? o.total : sum(pts)) + '<span class="muted"> ' + esc(o.unit || 'total') + '</span></div>' + chartSvg(pts, { type: o.type, label: title }) +
    '<div class="muted small">Peak ' + num(peak(pts)) + ' in a day</div></div>';
}
