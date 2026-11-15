/* Owner panel — core (v2.3.0-multi). Plain browser JavaScript; the files in this folder are joined into one script. */
const S = window.__OWNER__;
const I = S.icons;
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const main = $('#main');
const views = {};
const state = { users: { q: '', filter: '', rows: [], hasMore: false, loaded: false }, reportStatus: 'open', audit: { action: '', admin: '', off: 0 }, warden: { tab: 'cases', stage: 'flag' }, chartsDays: 14, feedTab: 'errors' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (n, cls) => { const s = I[n] || ''; return cls ? s.replace('class="ic', 'class="ic ' + cls) : s; };
const num = (n) => (n == null || Number.isNaN(Number(n)) ? '-' : Number(n).toLocaleString());
const isWide = () => !!(window.matchMedia && window.matchMedia('(min-width: 900px)').matches);

function fmt(t) {
  if (!t) return '-';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function ago(t) {
  const d = new Date(t).getTime();
  if (!d) return '';
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 0) return 'in ' + span(-s);
  if (s < 45) return 'just now';
  return span(s) + ' ago';
}
function span(s) {
  const m = Math.round(s / 60), h = Math.round(s / 3600), dd = Math.round(s / 86400);
  return s < 3600 ? Math.max(1, m) + ' min' : s < 86400 ? h + ' h' : dd + ' d';
}
function uptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm';
}
const hue = (id) => Math.abs(Number(id) || 0) % 360;
const who = (o) => o.name || (o.username ? '@' + o.username : String(o.id || o.userId || ''));
function avatar(o) {
  const n = String(who(o) || '?').replace(/^@/, '').charAt(0).toUpperCase();
  const h = hue(o.id || o.userId);
  return '<span class="avatar" style="background:linear-gradient(135deg,hsl(' + h + ' 65% 52%),hsl(' + ((h + 40) % 360) + ' 70% 40%))">' + esc(n) + '</span>';
}
const pill = (t, k, i) => '<span class="pill ' + (k || '') + '">' + (i ? ico(i) : '') + esc(t) + '</span>';
const empty = (t, i) => '<div class="empty">' + ico(i || 'info') + esc(t) + '</div>';
const loadingHtml = () => '<div class="empty">' + ico('loader', 'ic-spin') + 'Loading</div>';
const errHtml = (e) => '<div class="banner">' + ico('alert') + '<div>' + esc((e && e.message) || 'Could not load') + '</div></div>';
const stageLabel = (s) => ({ normal: 'Normal', observe: 'Observing', flag: 'Flagged', enhanced_monitoring: 'Enhanced monitoring', review_candidate: 'Review candidate' }[s] || s);

/* ── talking to the server ── */
async function api(method, path, body) {
  const o = { method, headers: { 'x-csrf-token': S.csrf, accept: 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch('/owner/api' + path, o);
  let j = {};
  try { j = await r.json(); } catch (_) { j = {}; }
  if (r.status === 404 && !j.error) { signedOut(); throw new Error('Signed out'); } // the server's plain 404 = no session
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.needFresh = !!j.needFresh; e.status = r.status; throw e; }
  return j;
}
async function download(path, fallbackName) {
  try {
    const r = await fetch('/owner/api' + path, { credentials: 'same-origin' });
    if (!r.ok) {
      let j = {};
      try { j = await r.json(); } catch (_) { j = {}; }
      if (r.status === 404 && !j.error) return signedOut();
      if (j.needFresh) return freshNeeded();
      throw new Error(j.error || 'The download failed');
    }
    const blob = await r.blob();
    const m = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = (m && m[1]) || fallbackName || 'download';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Download started');
  } catch (e) { toast(e.message, true); }
}
function signedOut() {
  document.body.innerHTML = '<main class="card" style="max-width:420px;margin:15vh auto;text-align:center">' + ico('lock') + '<h2 style="justify-content:center">Signed out</h2><p class="muted">Send /owner to the bot for a new link.</p></main>';
}

/* ── painting (a quiet refresh never replaces the page while you are typing or a dialog is open) ── */
let lastHtml = '';
function busyEditing() {
  if ($('dialog[open]')) return true;
  const a = document.activeElement;
  return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && main.contains && main.contains(a));
}
function paint(html, silent) {
  if (silent && (html === lastHtml || busyEditing())) return false;
  main.innerHTML = html; lastHtml = html;
  return true;
}
const on = (sel, fn, ev) => { const e = $(sel); if (e) e.addEventListener(ev || 'click', fn); return e; };
const onAll = (sel, fn, ev) => $$(sel).forEach((e) => e.addEventListener(ev || 'click', (x) => fn(e, x)));

/* ── routing ── */
const cur = { name: '', arg: '', sub: '' };
let navSeq = 0;
/**
 * A paint function for ONE page load. It only paints while that page is still the one on screen and the person hasn't
 * navigated since it started — so a slow answer, or a delayed refresh after an action, can never draw an old page over a new one.
 */
function painter(name) {
  const seq = navSeq;
  return (html, silent) => (cur.name === name && seq === navSeq ? paint(html, silent) : false);
}
function route(silent) {
  navSeq++;
  const parts = (location.hash || '#overview').slice(1).split('/');
  let name = parts[0] || 'overview';
  if (!views[name]) name = 'overview';
  const changed = name !== cur.name || (parts[1] || '') !== cur.arg || (parts[2] || '') !== cur.sub;
  cur.name = name; cur.arg = parts[1] || ''; cur.sub = parts[2] || '';
  $$('[data-v]').forEach((a) => a.setAttribute('aria-current', a.getAttribute('data-v') === navFor(name) ? 'page' : 'false'));
  if (!silent && changed) window.scrollTo(0, 0);
  return views[name](cur.arg, cur.sub, !!silent);
}
function navFor(name) { // which tab is highlighted for a page
  if (['overview', 'users', 'warden', 'reports'].includes(name)) return name;
  return isWide() ? name : 'more';
}
const go = (h) => { location.hash = h; };
