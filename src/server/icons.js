/**
 * Web icons (v2.2.0-multi) — every icon on every web page is an inline SVG from this one registry; no emoji characters
 * are used on web pages. (Telegram messages are different: Telegram cannot show SVG, so those keep their emoji.)
 *
 * - Line icons: 24×24, drawn with `currentColor`, so they follow the light/dark theme and the text colour around them.
 * - Brand marks: GitHub and Telegram (single-colour marks, 24×24 paths from the open Simple Icons set, CC0), plus the
 *   GitroHub logo (`/logo.png`). PostgreSQL / Redis use a generic database / cache icon unless the official SVG is dropped
 *   into `public/icons/brands/postgresql.svg` / `redis.svg` — then that file is used instead (see the README in that folder).
 * - Animation is CSS only (see CSS below) and switched off entirely for people who asked their device for reduced motion.
 *
 * Inline (not a <use> sprite) on purpose: the page's CSS can then reach inside an icon to animate its parts.
 */
const fs = require('fs');
const path = require('path');

const GITHUB_PATH = 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';
const TELEGRAM_PATH = 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z';

// Parts that should "draw themselves" carry class="d" and pathLength="1".
const D = 'class="d" pathLength="1"';

const LINE = {
  check: `<path ${D} d="M5 12.5l4.5 4.5L19 7.5"/>`,
  'check-circle': `<circle cx="12" cy="12" r="9"/><path ${D} d="M8 12.4l2.8 2.8 5.2-5.7"/>`,
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  'x-circle': `<circle cx="12" cy="12" r="9"/><path ${D} d="M9 9l6 6M15 9l-6 6"/>`,
  alert: '<path d="M12 3.8l9 15.7H3z"/><path d="M12 10v4.2"/><path d="M12 17.2v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.9v.01"/>',
  dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.7-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.8-7.5-9.5V6z"/><path d="M9 12l2.2 2.2L15.2 10"/>',
  users: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c0-3 2.4-5 5.5-5s5.5 2 5.5 5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16.2 14.2c2.5.2 4.3 1.9 4.3 4.8"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l9-8"/><path d="M17 6l2.5 2.5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 5h11l-2 3.5 2 3.5H5"/>',
  scroll: '<path d="M6 4h12v16H6z"/><path d="M9 9h6M9 13h6M9 17h3"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  megaphone: '<path d="M4 10v4h3l8 4V6L7 10z"/><path d="M18.5 9.5c1.1.9 1.1 4.1 0 5"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path class="hand" d="M12 12V7.5"/><path d="M12 12l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  logout: '<path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  send: '<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3"/><path d="M7 7l1 13h8l1-13M10 11v6M14 11v6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5H5V6h5"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  server: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7v.01M8 17v.01"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  cache: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  queue: '<path d="M12 4l9 4.5-9 4.5-9-4.5z"/><path d="M3 12.5l9 4.5 9-4.5"/><path d="M3 16.5l9 4.5 9-4.5"/>',
  loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  chart: '<path d="M4 19V5M4 19h16"/><path d="M8 15v-4M12 15V8M16 15v-6"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  note: '<path d="M6 3.5h9l3 3V20.5H6z"/><path d="M14.5 3.5v3.5H18"/><path d="M9 12h6M9 16h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  // v2.3.1: Warden's own mark — a shield with a steady pulse line (it looks after the fleet; it is not "watching" anyone).
  warden: '<path d="M12 3l7.5 3v5.5c0 4.7-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.8-7.5-9.5V6z"/><path d="M8 12.5h2l1.5-3 2 6 1.5-3h1"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  undo: '<path d="M9 6L4 11l5 5"/><path d="M4.5 11H15a5 5 0 0 1 0 10h-3"/>',
  download: '<path d="M12 4v11"/><path d="M7.5 11l4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  dots: '<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  repeat: '<path d="M5 11V9.5a3 3 0 0 1 3-3h11"/><path d="M16 3.5l3 3-3 3"/><path d="M19 13v1.5a3 3 0 0 1-3 3H5"/><path d="M8 20.5l-3-3 3-3"/>',
  wrench: '<path d="M14 7a4 4 0 0 0-5.2 5.2L3.5 17.5l3 3 5.3-5.3A4 4 0 0 0 17 10l-2.5 2.5-2-2L15 8z"/>',
  trending: '<path d="M3.5 17l6-6 4 4 7-8"/><path d="M15.5 7h5v5"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4"/><circle cx="12" cy="3.5" r=".8" fill="currentColor"/><circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none"/><path d="M9.5 16.5h5"/>',
};

const BRAND = {
  github: { path: GITHUB_PATH },
  telegram: { path: TELEGRAM_PATH },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Official PostgreSQL / Redis logos can be dropped in here; when the file exists it replaces the generic icon.
const BRAND_DIR = path.join(__dirname, '..', '..', 'public', 'icons', 'brands');
const BRAND_OVERRIDES = { database: 'postgresql', cache: 'redis' };
function brandFile(name) {
  const slug = BRAND_OVERRIDES[name];
  if (!slug) return null;
  try { return fs.existsSync(path.join(BRAND_DIR, `${slug}.svg`)) ? `/icons/brands/${slug}.svg` : null; } catch (_) { return null; }
}

/**
 * One icon as inline SVG (or an <img> for the logo / a dropped-in brand file).
 * @param {string} name   a key of LINE or BRAND, or 'logo'
 * @param {{cls?:string, title?:string}} opts   extra classes (e.g. 'ic-spin', 'ic-pulse'); title = accessible name (omit when decorative)
 */
function svg(name, { cls = '', title = '' } = {}) {
  const a11y = title ? `role="img" aria-label="${esc(title)}"` : 'aria-hidden="true" focusable="false"';
  if (name === 'logo') return `<img class="ic logo ${esc(cls)}" src="/logo.png" alt="${esc(title)}" width="24" height="24">`;
  const file = brandFile(name);
  if (file) return `<img class="ic brand ${esc(cls)}" src="${file}" alt="${esc(title)}" width="24" height="24">`;
  if (BRAND[name]) return `<svg class="ic fill ic-${name} ${esc(cls)}" viewBox="0 0 24 24" ${a11y}><path d="${BRAND[name].path}"/></svg>`;
  const body = LINE[name];
  if (!body) throw new Error(`Unknown icon: ${name}`);
  return `<svg class="ic ic-${name} ${esc(cls)}" viewBox="0 0 24 24" ${a11y}>${body}</svg>`;
}

/** The icon for a health state: ok → drawn check, warn → shaking triangle, bad → shaking cross, info → quiet dot. */
function stateIcon(state, cls = '') {
  if (state === 'ok') return svg('check-circle', { cls: `ic-draw ${cls}` });
  if (state === 'warn') return svg('alert', { cls: `ic-shake ${cls}` });
  if (state === 'bad' || state === 'down') return svg('x-circle', { cls: `ic-draw ic-shake ${cls}` });
  return svg('dot', { cls });
}

/** name → markup, for pages whose script re-renders icons after a refresh. */
function bundle(names) {
  const out = {};
  for (const n of names) out[n] = svg(n);
  out.ok = stateIcon('ok'); out.warn = stateIcon('warn'); out.bad = stateIcon('bad'); out.info = stateIcon('info');
  return out;
}

const CSS = `
.ic{width:1.25em;height:1.25em;flex:none;display:inline-block;vertical-align:-.22em;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ic.fill{fill:currentColor;stroke:none}
img.ic{object-fit:contain;border-radius:5px;stroke:none}
@media (prefers-reduced-motion:no-preference){
  .ic-spin{animation:ic-spin .9s linear infinite}
  .ic-pulse{animation:ic-pulse 2.2s ease-in-out infinite}
  .ic-shake{animation:ic-shake 3s ease-in-out infinite;transform-origin:50% 85%}
  .ic-bob{animation:ic-bob 3.2s ease-in-out infinite}
  .ic-draw .d{stroke-dasharray:1;stroke-dashoffset:1;animation:ic-draw .7s .1s ease forwards}
  .ic-clock .hand{transform-box:view-box;transform-origin:12px 12px;animation:ic-spin 60s linear infinite}
  .ic-queue path:nth-child(2){animation:ic-pulse 2.4s .3s ease-in-out infinite}
  .ic-queue path:nth-child(3){animation:ic-pulse 2.4s .6s ease-in-out infinite}
  .ic-cache{animation:ic-pulse 2.8s ease-in-out infinite}
}
@keyframes ic-spin{to{transform:rotate(360deg)}}
@keyframes ic-pulse{50%{opacity:.45}}
@keyframes ic-shake{0%,86%,100%{transform:rotate(0)}89%{transform:rotate(-8deg)}92%{transform:rotate(7deg)}95%{transform:rotate(-4deg)}}
@keyframes ic-bob{50%{transform:translateY(-2px)}}
@keyframes ic-draw{to{stroke-dashoffset:0}}
`.trim();

module.exports = { svg, stateIcon, bundle, CSS, names: () => [...Object.keys(LINE), ...Object.keys(BRAND), 'logo'], esc };
