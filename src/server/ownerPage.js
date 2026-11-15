/**
 * Owner web panel — the pages (v2.3.0-multi). No emoji anywhere: every icon is an inline SVG from server/icons.js.
 * One self-contained HTML document per page (inline style + script, both guarded by a per-response CSP nonce), so the
 * server needs no build step and no other file to serve — the page does not even exist for anyone without a session.
 */
const icons = require('./icons');

const esc = icons.esc;
const safeJson = (v) => JSON.stringify(v).replace(/</g, () => '\\' + 'u003c').replace(/\u2028|\u2029/g, '');

const BASE_CSS = `
:root{color-scheme:dark;--bg:#070a12;--bg2:#0e1424;--panel:#111829;--panel2:#161f35;--line:#202a44;--text:#eaf0ff;--muted:#94a3c4;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;--info:#60a5fa;--brand:#3b82f6;--brand2:#22d3ee}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){color-scheme:light;--bg:#f3f6fc;--bg2:#e6edfb;--panel:#fff;--panel2:#f4f7fd;--line:#d6dfef;--text:#0f172a;--muted:#5b6b8c}}
:root[data-theme=light]{color-scheme:light;--bg:#f3f6fc;--bg2:#e6edfb;--panel:#fff;--panel2:#f4f7fd;--line:#d6dfef;--text:#0f172a;--muted:#5b6b8c}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;color:var(--text);background:radial-gradient(1100px 500px at 50% -10%,var(--bg2),var(--bg) 70%) fixed;font-family:ui-rounded,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;font-size:15px;line-height:1.45}
button,input,select,textarea{font:inherit;color:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:9px 16px;border-radius:12px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{border-color:#3a4770}.btn:active{transform:translateY(1px)}
.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}.btn.danger{background:color-mix(in srgb,var(--bad) 18%,transparent);border-color:color-mix(in srgb,var(--bad) 55%,transparent);color:var(--bad)}
.btn.small{min-height:36px;padding:5px 12px;font-size:14px;border-radius:10px}.btn[disabled]{opacity:.6;cursor:progress}
.btn:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #7fb0ff;outline-offset:2px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px}
.muted{color:var(--muted)}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
`;

/** The small page shown when someone opens a valid link: nothing is spent until they press Continue. */
function renderEnter({ token, nonce, minutes }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="same-origin"><title>GitroHub \u2014 Owner</title>
<style nonce="${nonce}">${icons.CSS}${BASE_CSS}
body{display:flex;align-items:center;justify-content:center;padding:20px}.box{width:100%;max-width:400px;text-align:center}
.mark{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:color-mix(in srgb,var(--brand) 16%,transparent);color:var(--brand);margin-bottom:12px}
.mark .ic{width:32px;height:32px}h1{font-size:22px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}form{margin:0}.btn{width:100%}</style></head>
<body><main class="box card"><span class="mark">${icons.svg('shield', { cls: 'ic-pulse' })}</span>
<h1>Owner panel</h1><p>Use this once. The link expires about ${minutes} minutes after the bot sent it.</p>
<form method="POST" action="/owner/go"><input type="hidden" name="token" value="${esc(token)}"><button class="btn primary" type="submit" id="go">${icons.svg('lock')}Open the panel</button></form></main>
<script nonce="${nonce}">document.querySelector('form').addEventListener('submit',function(){setTimeout(function(){var b=document.getElementById('go');b.disabled=true;},0)})</script></body></html>`;
}

const fs = require('fs');
const path = require('path');

// The panel's browser code and styles live in real files (src/server/ownerClient/*), joined here once at start-up.
const CLIENT_DIR = path.join(__dirname, 'ownerClient');
const readClient = (f) => fs.readFileSync(path.join(CLIENT_DIR, f), 'utf8');
const PANEL_CSS = readClient('styles.css');
const PANEL_JS = `(function(){\n'use strict';\n${fs.readdirSync(CLIENT_DIR).filter((f) => /^\d\d-.*\.js$/.test(f)).sort().map(readClient).join('\n')}\n})();`;

// Sidebar (wide screens) and bottom tabs (phones). Keep in step with PAGES in ownerClient/22-more.js.
const GROUPS = [
  ['Monitor', [['overview', 'activity', 'Overview'], ['charts', 'chart', 'Charts'], ['feed', 'alert', 'Errors & jobs']]],
  ['People', [['users', 'users', 'Users'], ['reports', 'flag', 'Reports'], ['team', 'shield', 'Admin team']]],
  ['Safety', [['warden', 'warden', 'Warden'], ['audit', 'scroll', 'Audit log']]],
  ['System', [['controls', 'sliders', 'Controls'], ['schedule', 'calendar', 'Announcements'], ['webhooks', 'plug', 'Webhooks'], ['bulk', 'wrench', 'Bulk tools'], ['sessions', 'phone', 'Sessions']]],
];
const BOTTOM = [['overview', 'activity', 'Overview'], ['users', 'users', 'Users'], ['warden', 'warden', 'Warden'], ['reports', 'flag', 'Reports'], ['more', 'dots', 'More']];

/** The panel shell. `fresh` = the session was started in the last 10 minutes (dangerous actions allowed). */
function renderPanel({ csrf, version, fresh, nonce }) {
  const bundle = icons.bundle(icons.names().filter((n) => n !== 'logo'));
  const side = GROUPS.map(([g, items]) => `<h4>${esc(g)}</h4>${items.map(([v, i, label]) => `<a href="#${v}" data-v="${v}" aria-current="false">${icons.svg(i)}<span>${esc(label)}</span><span class="badge" data-badge="${v}" hidden></span></a>`).join('')}`).join('');
  const tabs = BOTTOM.map(([v, i, label]) => `<a href="#${v}" data-v="${v}" aria-current="false">${icons.svg(i)}<span>${esc(label)}</span><span class="badge" data-badge="${v}" hidden></span></a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="same-origin"><meta name="color-scheme" content="dark light"><meta name="theme-color" content="#070a12">
<link rel="manifest" href="/owner/manifest.webmanifest" crossorigin="use-credentials"><link rel="apple-touch-icon" href="/logo.png"><title>GitroHub \u2014 Owner</title>
<style nonce="${nonce}">${icons.CSS}${BASE_CSS}${PANEL_CSS}</style>
<script nonce="${nonce}">window.__OWNER__=${safeJson({ csrf, fresh: !!fresh, icons: bundle })};</script></head>
<body><div id="app"><aside id="side" aria-label="Sections"><div class="brand">${icons.svg('logo')}<b>Owner</b><span class="ver">v${esc(version)}</span></div>${side}</aside>
<div id="col"><header><span class="brandm">${icons.svg('logo')}<h1>Owner</h1><span class="ver">v${esc(version)}</span></span><span class="sp"></span>
<button class="iconbtn" id="srch" type="button" title="Search (press /)" aria-label="Search">${icons.svg('search')}</button>
<button class="iconbtn" id="theme" type="button" title="Switch light / dark" aria-label="Switch light or dark theme">${icons.svg('contrast')}</button>
<button class="iconbtn" id="out" type="button" title="Sign out" aria-label="Sign out">${icons.svg('logout')}</button></header>
<main id="main"><div class="empty">${icons.svg('loader', { cls: 'ic-spin' })}Loading</div></main></div>
<nav class="tabs" aria-label="Sections">${tabs}</nav></div><div id="toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}">${PANEL_JS}</script></body></html>`;
}

module.exports = { renderEnter, renderPanel, PANEL_JS, PANEL_CSS };
