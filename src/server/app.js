const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const oauth = require('../lib/oauth');
const users = require('../lib/users');
const activity = require('../lib/activity');
const logger = require('../lib/logger');

const PAGE_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'callback.html'), 'utf8');
const STATUS_PAGE_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'status.html'), 'utf8');

const SUCCESS_STEPS = [
  'Verifying request',
  'Exchanging authorization code',
  'Encrypting access token',
  'Saving to secure storage',
  'Linking Telegram session',
];

function renderPage(data) {
  const inject = `<script>window.__GITROHUB__ = ${JSON.stringify(data)};</script>`;
  return PAGE_TEMPLATE.replace('</head>', `${inject}</head>`);
}

/** v1.2.5-multi: the status page is rendered on the server (tiles included), so it is useful with JavaScript off;
 * the page's script only adds live refresh and the theme button. */
function renderStatusPage(data, view) {
  const icons = require('./icons');
  const tile = (t) => `<article class="tile" data-state="${escapeHtml(t.state)}"><div class="top"><span>${icons.svg(t.icon)}${escapeHtml(t.label)}</span><span class="lamp" aria-hidden="true">${icons.stateIcon(t.state)}</span></div><div class="val">${escapeHtml(t.value)}</div><div class="hint">${escapeHtml(t.hint)}</div></article>`;
  const safeJson = (v) => JSON.stringify(v).replace(/</g, () => '\\' + 'u003c');
  const inject = `<script>window.__GITROHUB_STATUS__ = ${safeJson(data)};window.__GITROHUB_ICONS__ = ${safeJson(icons.bundle(view.tiles.map((t) => t.icon)))};</script>`;
  const bannerState = view.overall === 'ok' ? 'ok' : view.overall === 'degraded' ? 'warn' : 'bad';
  return STATUS_PAGE_TEMPLATE
    .replace('/*ICON_CSS*/', () => icons.CSS)
    .replace('<!--STATUS_INJECT-->', () => inject)
    .replace('<!--STATUS_TILES-->', () => view.tiles.map(tile).join(''))
    .replace('{{ICON_THEME}}', () => icons.svg('contrast'))
    .replace('{{ICON_TELEGRAM}}', () => icons.svg('telegram'))
    .replace('{{BANNER_ICON}}', () => icons.stateIcon(bannerState))
    .replace('{{OVERALL}}', () => escapeHtml(view.overall))
    .replace('{{LABEL}}', () => escapeHtml(view.label))
    .replace('{{VERSION}}', () => (view.version ? `v${escapeHtml(view.version)}` : ''))
    .replace('{{CHECKED}}', () => escapeHtml(new Date(view.checkedAt).toUTCString().replace('GMT', 'UTC')));
}

const runtimeMetrics = require('../lib/runtimeMetrics');
const crypto = require('crypto');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Best-effort Telegram profile photo for the confirm page, returned as a
 * data: URI (or null). Fetched server-side and inlined on purpose: the
 * download URL Telegram hands back contains the BOT TOKEN, so it must never
 * be put in a page the browser can read. Everything here is time-boxed and
 * swallows its own errors — a missing/private photo (or a slow Telegram)
 * just means the page shows a coloured initial instead, never a failure and
 * never more than ~2.5s of extra wait. */
async function fetchAvatarDataUri(bot, telegramId) {
  const work = (async () => {
    const photos = await bot.telegram.getUserProfilePhotos(telegramId, 0, 1);
    if (!photos || !photos.total_count || !photos.photos[0] || !photos.photos[0].length) return null;
    const sizes = photos.photos[0]; // same photo in several sizes, smallest first
    const pick = sizes.find((sz) => sz.width >= 160) || sizes[sizes.length - 1];
    const link = await bot.telegram.getFileLink(pick.file_id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const resp = await fetch(String(link), { signal: controller.signal });
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0 || buf.length > 300 * 1024) return null;
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } finally {
      clearTimeout(timer);
    }
  })().catch(() => null);
  let timer;
  const cap = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2500); });
  const result = await Promise.race([work, cap]);
  clearTimeout(timer);
  return result;
}

const GITHUB_MARK_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z';

/** Step-1 page of the OAuth callback: shows WHICH Telegram account is about
 * to be linked (name, @username, ID and — when available — profile photo)
 * and waits for an explicit click. Self-contained HTML (inline style, one
 * tiny inline script that only prevents double-submits) so it works under
 * the strict frame-ancestors header and needs no template.
 *
 * v1.1.21-multi: redesigned. The old page was accurate but read like a
 * warning dialog (amber alarm text, "you're about to give access… including
 * the ability to delete them"). The safety property is unchanged — the
 * account is named up front, nothing is linked until the click, and a
 * forwarded link is easy to walk away from — but it's now framed as a
 * friendly "is this you?" check, with plain-language "what you're allowing"
 * and a calm note instead of a red flag. */
/** What each OAuth scope means, in plain words (shown in the "details" expander). */
const SCOPE_WORDS = {
  repo: ['Repositories', 'See and change your repositories, files, issues and pull requests'],
  delete_repo: ['Delete repositories', 'Only when you ask for it and confirm in the chat'],
  gist: ['Gists', 'Create and edit your gists'],
  notifications: ['Notifications', 'Read and mark your GitHub notifications'],
  'read:org': ['Organisations', 'See which organisations you belong to (read only)'],
  project: ['Projects', 'Read and update your project boards'],
};

function permissionsBlock(scopes) {
  const list = (Array.isArray(scopes) && scopes.length ? scopes : ['repo', 'delete_repo']).filter((x) => SCOPE_WORDS[x]);
  const extras = list.filter((x) => !['repo', 'delete_repo'].includes(x));
  const summary = extras.length
    ? 'Manage your repos and files, plus gists, notifications, organisations and projects. Anything destructive asks you to confirm first.'
    : 'Manage your repos and files. Anything destructive asks you to confirm first.';
  const rows = list.map((x) => `<li><b>${escapeHtml(SCOPE_WORDS[x][0])}</b><span>${escapeHtml(SCOPE_WORDS[x][1])}</span><code>${escapeHtml(x)}</code></li>`).join('');
  return `<h2 class="can-title">What GitroHub can do</h2>
    <p class="can">${escapeHtml(summary)}</p>
    <details class="more"><summary>See the exact permissions</summary><ul>${rows}</ul></details>`;
}

/** Step-1 page of the OAuth callback: shows WHICH Telegram account is about to be linked (name, @username, ID and,
 * when available, profile photo) and waits for an explicit click. Nothing is exchanged or saved before the click, so a
 * link someone else generated for THEIR account is visible for what it is and can simply be closed.
 *
 * v1.2.5-multi: shorter and two-column. Phones get one compact column with no scrolling on a normal screen; from
 * 900px wide the identity sits on the left and the permissions + button on the right. The permissions are one
 * sentence with an expander for the exact list. Works with JavaScript off (the script only stops double-submits). */
function renderConfirmPage({ code, state, firstName, username, telegramId, botDeepLink, avatarDataUri, scopes }) {
  const displayName = firstName || (username ? `@${username}` : 'there');
  const greetingName = firstName || 'there';
  const initial = escapeHtml(Array.from(String(firstName || username || '?'))[0].toUpperCase());
  const hue = Math.abs(Number(telegramId) || 0) % 360;
  const handle = username ? `@${escapeHtml(username)}` : 'No username set';

  const avatar = avatarDataUri
    ? `<img class="node avatar" src="${avatarDataUri}" alt="Profile photo of ${escapeHtml(displayName)}">`
    : `<div class="node avatar initial" style="background:linear-gradient(135deg,hsl(${hue} 65% 52%),hsl(${(hue + 40) % 360} 70% 40%))" aria-hidden="true">${initial}</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0e1a">
<title>Connect GitHub — GitroHub</title>
<style>
  :root { color-scheme:dark; --night:#0a0e1a; --panel:#121829; --line:#222b44; --text:#eef2ff; --muted:#9aa7c7; --blue:#2563eb; --blue-hi:#1d4ed8; --mint:#34d399; }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; min-height:100vh; min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:16px; padding-bottom:max(16px, env(safe-area-inset-bottom));
    background:radial-gradient(ellipse at 50% 0%, #131c38 0%, var(--night) 62%); color:var(--text);
    font-family:ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; font-size:15px; line-height:1.45; }
  .card { width:100%; max-width:440px; background:var(--panel); border:1px solid var(--line); border-radius:20px; padding:20px 18px 18px; box-shadow:0 24px 60px rgba(0,0,0,.45); }
  .cols { display:block; }

  .link { display:flex; align-items:center; justify-content:center; margin:0 0 14px; }
  .node { width:56px; height:56px; border-radius:50%; flex:none; display:block; object-fit:cover; }
  .avatar { border:2px solid var(--line); }
  .initial { display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:700; color:#fff; }
  .mid { width:44px; height:44px; border-radius:50%; flex:none; border:2px solid var(--blue); box-shadow:0 0 0 4px rgba(37,99,235,.16); background:#05070d; overflow:hidden; }
  .mid img { width:100%; height:100%; display:block; }
  .gh { background:#f0f3fa; color:#0a0e1a; display:flex; align-items:center; justify-content:center; border:2px solid var(--line); }
  .gh svg { width:32px; height:32px; fill:currentColor; }
  .wire { flex:1 1 auto; min-width:14px; max-width:36px; height:0; border-top:2px dashed #3a4770; }

  h1 { font-size:21px; line-height:1.2; font-weight:700; margin:0 0 6px; text-align:center; letter-spacing:-.01em; }
  .lead { margin:0 auto 12px; max-width:36ch; text-align:center; color:var(--muted); font-size:14px; }

  .acct { background:var(--night); border:1px solid var(--line); border-radius:12px; padding:2px 12px; margin:0 0 14px; }
  .acct div { display:flex; justify-content:space-between; gap:12px; padding:7px 0; font-size:14px; }
  .acct div + div { border-top:1px solid var(--line); }
  .acct dt { color:var(--muted); margin:0; flex:none; }
  .acct dd { margin:0; font-weight:600; text-align:right; word-break:break-word; min-width:0; }

  .can-title { margin:0 0 4px; font-size:14.5px; font-weight:650; }
  .can { margin:0 0 8px; font-size:14px; color:#cfd7ee; }
  .more { margin:0 0 14px; font-size:13.5px; }
  .more summary { cursor:pointer; color:#8fb4ff; padding:4px 0; list-style-position:inside; }
  .more ul { list-style:none; margin:6px 0 0; padding:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .more li { display:grid; grid-template-columns:1fr auto; gap:2px 10px; padding:8px 12px; background:var(--night); }
  .more li + li { border-top:1px solid var(--line); }
  .more li span { grid-column:1; color:var(--muted); font-size:12.5px; }
  .more li code { grid-row:1 / span 2; grid-column:2; align-self:center; font-size:11.5px; color:var(--mint); }

  .btn { display:flex; align-items:center; justify-content:center; width:100%; min-height:48px; padding:11px 16px; border-radius:13px; font:inherit; font-size:16px; font-weight:650; text-decoration:none; cursor:pointer; -webkit-tap-highlight-color:transparent; }
  .btn.primary { background:var(--blue); color:#fff; border:0; }
  .btn.primary:hover { background:var(--blue-hi); }
  .btn.primary:active { transform:translateY(1px); }
  .btn.primary[disabled] { opacity:.7; cursor:progress; }
  .btn.quiet { margin-top:8px; min-height:44px; background:transparent; color:var(--muted); border:1px solid var(--line); font-size:15px; }
  .btn.quiet:hover { color:var(--text); border-color:#3a4770; }
  .btn:focus-visible, .more summary:focus-visible { outline:3px solid #7fb0ff; outline-offset:2px; }

  .note { margin:12px 2px 0; color:var(--muted); font-size:12.5px; line-height:1.45; }
  .note b { color:#c3cde8; font-weight:600; }

  @media (min-width:900px) {
    body { padding:32px; }
    .card { max-width:880px; padding:36px 40px; border-radius:24px; }
    .cols { display:grid; grid-template-columns:1fr 1fr; gap:44px; align-items:center; }
    .left { border-right:1px solid var(--line); padding-right:44px; }
    h1 { font-size:26px; text-align:left; }
    .lead { text-align:left; margin-left:0; font-size:15px; }
    .link { justify-content:flex-start; margin-bottom:20px; }
    .node { width:64px; height:64px; } .mid { width:50px; height:50px; }
    .acct { margin-bottom:0; }
    .acct div { font-size:15px; padding:9px 0; }
    .can { font-size:15px; }
  }
  @media (max-width:360px) { .card { padding:16px 14px; } h1 { font-size:19px; } }
  @media (max-height:640px) and (max-width:899px) { .lead { display:none; } .link { margin-bottom:8px; } }
</style></head>
<body><main class="card">
  <div class="cols">
    <section class="left">
      <div class="link" role="img" aria-label="Your Telegram account, linked through GitroHub to GitHub">
        ${avatar}<span class="wire"></span>
        <span class="mid"><img src="/logo.png" alt=""></span>
        <span class="wire"></span>
        <span class="node gh"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${GITHUB_MARK_PATH}"/></svg></span>
      </div>
      <h1>Hi ${escapeHtml(greetingName)}, connect GitHub?</h1>
      <p class="lead">This links your GitHub to the Telegram account below, so you can manage your repos from the chat.</p>
      <dl class="acct">
        <div><dt>Name</dt><dd>${escapeHtml(displayName)}</dd></div>
        <div><dt>Username</dt><dd>${handle}</dd></div>
        <div><dt>Telegram ID</dt><dd>${escapeHtml(telegramId)}</dd></div>
      </dl>
    </section>
    <section class="right">
      ${permissionsBlock(scopes)}
      <form method="POST" action="/callback/confirm" id="f">
        <input type="hidden" name="code" value="${escapeHtml(code)}">
        <input type="hidden" name="state" value="${escapeHtml(state)}">
        <button class="btn primary" type="submit" id="go">Yes, that’s me. Connect GitHub</button>
      </form>
      <a class="btn quiet" href="${escapeHtml(botDeepLink)}">Cancel</a>
      <p class="note"><b>Not your account?</b> If someone else sent you this link, just close the page. Nothing is connected until you tap the button, and you can disconnect any time in Settings. <b>Signed in to the wrong GitHub account?</b> Tap Cancel and start again — GitHub will let you pick a different one.</p>
    </section>
  </div>
</main>
<script>
  (function () {
    var f = document.getElementById('f'), b = document.getElementById('go');
    f.addEventListener('submit', function () { setTimeout(function () { b.disabled = true; b.textContent = 'Connecting…'; }, 0); });
    window.addEventListener('pageshow', function (e) { if (e.persisted) { b.disabled = false; b.textContent = 'Yes, that’s me. Connect GitHub'; } });
  })();
</script>
</body></html>`;
}


// v1.2.4-multi: event → summary mapping lives in lib/webhookEvents.js (testable, covers stars/forks/push commit lists…)
const webhookEvents = require('../lib/webhookEvents');

const WEBHOOK_BODY_LIMIT = '5mb';

function createApp(bot) {
  const app = express();
  // express.static() serves a DIRECTORY, not a single file path — mounting
  // the whole public/ directory at root future-proofs any static assets
  // added to public/ later. The callback page's logo used to point at a
  // raw.githubusercontent.com copy instead of this local one — fixed in
  // v1.0.0-multi: that only rendered once this exact code was pushed to a
  // public GitHub repo at that exact path/branch, so it silently 404'd
  // for anyone who deployed straight from the zip (Railway's other
  // supported path, see README Setup) without ever pushing to GitHub at
  // all. `/logo.png`, served by this same middleware, works regardless
  // of whether/where the code lives on GitHub.
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // Railway can poll this to detect a degraded instance and restart it
  // proactively, rather than only reacting after a hard OOM kill. Also
  // consumed client-side by public/status.html (the / page below) so
  // that page has one real source of truth instead of its own logic.
  app.get('/health', async (req, res) => {
    // v1.2.1-multi: HEALTHY / DEGRADED / UNAVAILABLE instead of "the process is alive".
    //   UNAVAILABLE (Postgres or Redis down)  → 503, so the platform may restart us
    //   DEGRADED (serving, but under pressure) → 200, so a merely BUSY process is not killed
    // Cheap by construction: cached pings + in-memory counters, no scans.
    const h = await runtimeMetrics.getHealth();
    const mem = process.memoryUsage();
    res.status(h.status === 'UNAVAILABLE' ? 503 : 200).json({
      status: h.status === 'HEALTHY' ? 'ok' : h.status.toLowerCase(),
      health: h.status,
      reasons: h.reasons,
      postgres: h.pgStatus.ok,
      redis: h.redisStatus.ok,
      github: h.traffic ? { state: h.traffic.state, circuit: h.traffic.breaker.state, active: h.traffic.active, queued: h.traffic.queued } : undefined,
      eventLoopLagP99Ms: h.lag.p99,
      memoryMB: Math.round(mem.rss / 1024 / 1024),
      uptimeSeconds: Math.round(process.uptime()),
      version: require('../../package.json').version,
    });
  });

  // v1.2.1-multi: Prometheus-format metrics. DISABLED unless METRICS_TOKEN is
  // set (usage numbers are operational data, not public), and then requires
  // `Authorization: Bearer <token>`, compared in constant time. Contains
  // counters/gauges only — never tokens, user content or per-repo names.
  app.get('/metrics', (req, res) => {
    const expected = process.env.METRICS_TOKEN;
    if (!expected) return res.status(404).end();
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = crypto.createHash('sha256').update(supplied).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (!crypto.timingSafeEqual(a, b)) return res.status(401).end();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(runtimeMetrics.renderAll());
  });

  // v1.1.8: previously a bare plain-text string with nothing to look at.
  // Now a real branded live-status page — same visual language as the
  // OAuth callback page (dark theme, particle canvas, GitroHub logo),
  // but lighter: no multi-step sequence, just a live pulse. It polls the
  // /health route above every few seconds client-side rather than this
  // route computing anything itself, so there's exactly one source of
  // truth for "is this deployment healthy."
  const statusView = async () => require('./statusTiles').build(await runtimeMetrics.getHealth(), { version: require('../../package.json').version, uptimeSeconds: process.uptime() });

  app.get('/', async (req, res) => {
    const botDeepLink = `https://t.me/${config.BOT_USERNAME}`;
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.send(renderStatusPage({ botDeepLink }, await statusView()));
  });

  // The status page's live refresh. Same mapping as the server-rendered page; states and plain words only.
  app.get('/status.json', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await statusView());
  });

  // ── OAuth callback (v1.1.7-multi: two steps) ──────────────────────────
  //
  // Step 1 — GET /callback (GitHub redirects here). Validates the state and
  //   shows WHICH Telegram account is about to be linked, then waits for a
  //   click. Nothing is exchanged or saved yet, so a link that someone else
  //   generated for THEIR Telegram account and talked you into opening is
  //   visible for what it is and can simply be closed — the authorization
  //   code is never redeemed.
  // Step 2 — POST /callback/confirm. Burns the state's one-time id (a state
  //   can complete exactly once), exchanges the code, saves the encrypted
  //   token, notifies the chat. The previous code did all of this on the GET.
  const confirmBody = express.urlencoded({ extended: false, limit: '8kb' });

  function noFrame(res) {
    // The confirm button must never be clickjackable from another origin.
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
  }

  function invalidLinkPage(res, botDeepLink) {
    return res.send(renderPage({
      status: 'error',
      steps: ['Verifying request'],
      failStepIndex: 0,
      error: 'The authorization link was invalid, expired, or already used. Go back to the bot and tap Connect GitHub again for a fresh link.',
      botDeepLink,
    }));
  }

  app.get('/callback', async (req, res) => {
    noFrame(res);
    const { code, state, error: oauthError } = req.query;
    const botDeepLink = `https://t.me/${config.BOT_USERNAME}`;

    // GitHub itself reported denial/cancellation
    if (oauthError) {
      return res.send(renderPage({
        status: 'error',
        steps: ['Verifying request'],
        failStepIndex: 0,
        error: 'Authorization cancelled: you didn\u2019t approve access on GitHub, or closed the page before finishing.',
        botDeepLink,
      }));
    }

    let telegramId; let stateScopes = [];
    try {
      ({ telegramId, scopes: stateScopes } = oauth.inspectState(state));
    } catch (err) {
      return invalidLinkPage(res, botDeepLink);
    }
    if (typeof code !== 'string' || !code) return invalidLinkPage(res, botDeepLink);

    // Profile lookup and photo fetch run together so the photo costs no extra
    // wait on top of the DB read (and is capped at ~2.5s either way).
    const [target, avatarDataUri] = await Promise.all([
      users.getUser(telegramId).catch(() => null),
      fetchAvatarDataUri(bot, telegramId),
    ]);

    res.send(renderConfirmPage({
      code,
      state,
      firstName: target ? target.telegram_first_name : null,
      username: target ? target.telegram_username : null,
      telegramId,
      botDeepLink,
      avatarDataUri,
      scopes: stateScopes,
    }));
  });

  app.post('/callback/confirm', confirmBody, async (req, res) => {
    noFrame(res);
    const botDeepLink = `https://t.me/${config.BOT_USERNAME}`;
    const { code, state } = req.body || {};

    let telegramId;
    try {
      let jti;
      ({ telegramId, jti } = oauth.inspectState(state));
      if (typeof code !== 'string' || !code) throw new Error('missing code');
      // Single use: the same state can never complete twice. Fails closed if
      // Redis is unreachable (consumeState throws → invalid-link page).
      if (!(await oauth.consumeState(jti))) throw new Error('state already used');
    } catch (err) {
      return invalidLinkPage(res, botDeepLink);
    }

    // 🚦 Signups-paused gate — mirrors handlers/start.js's check exactly,
    // but enforced HERE too, because this endpoint is the actual linking
    // choke point. Every bot-side "Connect GitHub" button/link is only a
    // best-effort UI prompt — some paths (the persistent BBTB button, an
    // already-issued link still sitting in someone's chat, /help, error
    // fallbacks) don't re-check the flag before generating a fresh
    // authorize URL. None of that matters if the token exchange below
    // completes regardless: a brand-new person could tap any lingering
    // Connect button while signups were paused and still end up fully
    // linked. Fails OPEN on an unexpected error here (never block a
    // legitimate reconnect over a transient config-read hiccup) — the
    // worst case if this check itself fails is identical to before this
    // fix existed, not worse.
    try {
      const globalConfig = require('../lib/globalConfig');
      const existingUserPreCheck = await users.getUser(telegramId).catch(() => null);
      const isBrandNewSignup = !existingUserPreCheck || !existingUserPreCheck.connected_at;
      if (isBrandNewSignup && globalConfig.isSignupsPaused()) {
        return res.send(renderPage({
          status: 'error',
          steps: ['Verifying request'],
          failStepIndex: 0,
          error: 'New signups are paused right now — please check back soon. If you\u2019ve connected before, this doesn\u2019t affect you.',
          botDeepLink,
        }));
      }
    } catch (_) { /* best-effort gate — see comment above */ }

    try {
      const tokenData = await oauth.exchangeCodeForToken(code);
      const repoCache = require('../lib/repoCache');
      // v1.2.4-multi: `personal` — the REAL account login, never the organisation currently being browsed.
      const ghUser = await repoCache.getUser(telegramId, tokenData.access_token, { personal: true });

      const existingUser = await users.getUser(telegramId);
      const isReconnect = !!(existingUser && existingUser.connected_at);
      const accountsLib = require('../lib/accounts');
      const hadAccounts = (await accountsLib.list(telegramId).catch(() => [])).map((a) => a.login.toLowerCase());
      const isAdditionalAccount = hadAccounts.length > 0 && !hadAccounts.includes(String(ghUser.login).toLowerCase());
      // v1.2.6-multi: GitHub signs in as whoever is logged in at github.com, so "Add another account" can come back
      // with an account that is already linked. Say so plainly (the token and permissions are still refreshed).
      const alreadyLinked = !!(existingUser && existingUser.github_token_enc && !existingUser.disconnected_at) && hadAccounts.includes(String(ghUser.login).toLowerCase());

      try {
        await users.saveConnection(telegramId, {
          accessToken: tokenData.access_token,
          scope: tokenData.scope,
          githubUsername: ghUser.login,
        });
      } catch (saveErr) {
        if (saveErr && saveErr.code === 'ACCOUNT_LIMIT') {
          return res.send(renderPage({
            status: 'error',
            steps: SUCCESS_STEPS.slice(0, 2),
            failStepIndex: 1,
            error: saveErr.message,
            botDeepLink,
          }));
        }
        throw saveErr;
      }

      await activity.log(telegramId, '🔗', `${alreadyLinked ? 'Refreshed GitHub account' : isAdditionalAccount ? 'Added GitHub account' : 'Connected GitHub account'} (@${ghUser.login})`, {});

      const accessLog = require('../lib/accessLog');
      await accessLog.record(telegramId, isReconnect ? 'reconnected' : 'connected', `scope: ${tokenData.scope}`);

      // Proactively push the confirmation into the chat (per design: bot pushes
      // this automatically, no need for the user to tap anything back in Telegram)
      const { escapeMd } = require('../lib/format');
      const bbtb = require('../keyboards/bbtb');
      const updatedUser = await users.getUser(telegramId);
      const alertLine = updatedUser.alert_on_new_connection
        ? '\n\n🔐 New session started — logged in 🔑 Access Log (Settings).'
        : '';
      // The scope line reports what GitHub actually GRANTED (tokenData.scope),
      // not a hard-coded string — kept dynamic even though the requested
      // scope is fixed (repo,delete_repo) since GitHub can still grant a
      // narrower set than requested in edge cases (revoked org policy, etc).
      const grantedScope = escapeMd(String(tokenData.scope || 'repo').split(',').join(', '));
      if (alreadyLinked) {
        await bot.telegram.sendMessage(
          telegramId,
          `ℹ️ *@${escapeMd(ghUser.login)} was already connected*\nNothing new was added — I just refreshed its permissions\\.\n\nTo add a *different* GitHub account, tap ➕ Add another account again and choose *Use a different account* on GitHub’s account picker\\.`,
          { parse_mode: 'MarkdownV2', reply_markup: bbtb.mainMenuFor(updatedUser.is_admin).reply_markup }
        ).then(() => require('../lib/chrome').syncBarFromOutside(telegramId, 'home')).catch(() => {});
        return res.send(renderPage({
          status: 'success',
          steps: SUCCESS_STEPS,
          username: ghUser.login,
          title: 'Already connected',
          detail: `@${ghUser.login} was already linked — permissions refreshed`,
          botDeepLink,
        }));
      }
      await bot.telegram.sendMessage(
        telegramId,
        `✅ *GitHub ${isAdditionalAccount ? 'Account Added' : 'Connected'}*\nLinked as: ${escapeMd(ghUser.login)}\nScope: ${grantedScope} \\(includes repo delete access\\)` +
          `${isAdditionalAccount ? '\n\n🔀 It is now your active account\\. Switch any time in 💼 Workspace → Accounts\\.' : ''}${escapeMd(alertLine)}`,
        { parse_mode: 'MarkdownV2', reply_markup: bbtb.mainMenuFor(updatedUser.is_admin).reply_markup }
      );
      await require('../lib/chrome').syncBarFromOutside(telegramId, 'home'); // the saved session must know the Home bar is up

      return res.send(renderPage({
        status: 'success',
        steps: SUCCESS_STEPS,
        username: ghUser.login,
        botDeepLink,
      }));
    } catch (err) {
      logger.error('OAuth callback error', { message: err.message });
      await activity.log(telegramId, '⚠️', 'GitHub connection failed', { detail: err.message, isError: true }).catch(() => {});

      return res.send(renderPage({
        status: 'error',
        steps: SUCCESS_STEPS.slice(0, 2),
        failStepIndex: 1,
        error: `Couldn\u2019t complete the token exchange with GitHub: ${err.message}. This is usually temporary — go back to the bot and tap Connect GitHub for a fresh link.`,
        botDeepLink,
      }));
    }
  });

  // GitHub webhook receiver — per-repo notifications (Settings toggles).
  // Raw body needed (not JSON-parsed) since HMAC verification is computed
  // over the exact bytes GitHub sent; this route is scoped to raw parsing
  // only, no global express.json() exists elsewhere to conflict with.
  // v1.1.7-multi: explicit 5mb body limit. express.raw()'s default is 100kb,
  // which rejected (HTTP 413) any push event with a large commit file list
  // — GitHub deliveries carry up to 25MB, though real payloads are almost
  // always well under 5mb, and keeping this bounded keeps an unauthenticated
  // endpoint from buffering huge bodies on a 512MB host.
  // v1.2.1-multi: shape-check → (bounded) parse → registration → signature → dedupe →
  // rate cap → bounded processing. Unregistered repos and bad signatures return the SAME
  // response (and do the same HMAC work), so the route can't be used to discover which
  // repositories are registered.
  const webhookGuard = require('../lib/webhookGuard');
  const webhookDeduper = new webhookGuard.Deduper({ redis: () => require('../db/redis').client });
  const webhookRate = new webhookGuard.RateWindow({ max: Number(process.env.WEBHOOK_MAX_EVENTS_PER_MIN) || 60 });
  const webhookLimiter = new webhookGuard.Limiter({ concurrency: Number(process.env.WEBHOOK_CONCURRENCY) || 8, maxBacklog: Number(process.env.WEBHOOK_MAX_BACKLOG) || 500 });
  const webhookMetrics = {
    received: require('../lib/metrics').counter('webhook_received', 'GitHub webhook deliveries received, by result'),
    backlog: require('../lib/metrics').gauge('webhook_backlog', 'Webhook events waiting for processing'),
  };
  const DUMMY_SECRET = crypto.randomBytes(32);

  app.post('/webhook/github', express.raw({ type: 'application/json', limit: WEBHOOK_BODY_LIMIT }), async (req, res) => {
    const repoWebhooks = require('../lib/repoWebhooks');
    const notificationMutes = require('../lib/notificationMutes');
    const users = require('../lib/users');

    const pre = webhookGuard.precheck(req.headers);
    if (!pre.ok) { webhookMetrics.received.inc({ result: 'malformed' }); return res.status(pre.status).send('Rejected'); }
    if (!Buffer.isBuffer(req.body) || !req.body.length) { webhookMetrics.received.inc({ result: 'malformed' }); return res.status(400).send('Empty body'); }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch (err) {
      webhookMetrics.received.inc({ result: 'malformed' });
      return res.status(400).send('Invalid JSON');
    }

    const repoName = payload && payload.repository && payload.repository.name;
    const ownerLogin = payload && payload.repository && payload.repository.owner && payload.repository.owner.login;
    if (typeof repoName !== 'string' || typeof ownerLogin !== 'string' || !repoName || !ownerLogin || repoName.length > 100 || ownerLogin.length > 60) {
      webhookMetrics.received.inc({ result: 'malformed' });
      return res.status(400).send('Missing repository');
    }

    // Scoped by owner login AND repo name — repo name alone is not an identity once more than
    // one person's GitHub account can be connected (see repoWebhooks.getByRepo).
    const candidates = await repoWebhooks.getAllByRepo(repoName, ownerLogin).catch(() => []);

    // Verify the signature against OUR stored secrets — never trust anything about identity claimed
    // by the payload. Every candidate is checked (constant work per candidate); with none, a dummy
    // key keeps timing/response identical. Only the registration whose secret signed it can match.
    const signature = pre.signature.toLowerCase();
    const sigBuf = Buffer.from(signature);
    let registration = null;
    for (const cand of (candidates.length ? candidates : [{ secret: DUMMY_SECRET, dummy: true }])) {
      const expBuf = Buffer.from('sha256=' + crypto.createHmac('sha256', cand.secret).update(req.body).digest('hex'));
      if (!cand.dummy && !registration && sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) registration = cand;
    }
    const valid = !!registration;
    if (!valid) {
      webhookMetrics.received.inc({ result: 'rejected' });
      logger.warn('Webhook rejected', { reason: candidates.length ? 'signature' : 'unregistered' });
      return res.status(401).send('Invalid signature');
    }

    // Authenticated from here on. A redelivery of the same delivery id is acknowledged, not re-processed.
    if (await webhookDeduper.seen(pre.delivery)) {
      webhookMetrics.received.inc({ result: 'duplicate' });
      return res.status(200).send('OK');
    }
    const rate = webhookRate.hit(`${registration.telegram_id}:${repoName}`);
    if (!rate.allowed) {
      webhookMetrics.received.inc({ result: 'rate_limited' });
      // Not processed, so it must not stay marked "seen" (a manual Redeliver would be
      // dropped), and the person is told about it in their next digest ("+N more").
      await webhookDeduper.forget(pre.delivery);
      require('../lib/webhookDigest').noteDropped(registration.telegram_id, repoName, 1).catch(() => {});
      return res.status(200).send('OK'); // acked so GitHub doesn't retry into the same flood; counted above
    }

    res.status(200).send('OK'); // ack immediately, don't make GitHub wait on Telegram delivery

    const event = pre.event;
    const accepted = webhookLimiter.submit(async () => {
      try {
        const muted = await notificationMutes.isMuted(registration.telegram_id, repoName);
        if (muted) return;

        const user = await users.getUser(registration.telegram_id);
        if (!user || !user.notif_github_activity) return;

        const described = webhookEvents.describe(event, payload);
        if (!described) return; // event type we don't have a message for
        // v1.2.4-multi: per-person choice of which kinds of alert they want (defaults in lib/webhookEvents.js)
        if (!(await require('../lib/alertPrefs').isEnabled(registration.telegram_id, described.key))) return;
        const summary = described.summary;

        await activity.log(registration.telegram_id, '🔔', `${summary} → ${repoName}`, {});

        // Digest buffering instead of an immediate send (bounded — see webhookDigest.push).
        // Quiet hours widen the effective window: the event buffers immediately, delivery is
        // deferred until quiet hours end (checked by the flush poller).
        const webhookDigest = require('../lib/webhookDigest');
        await webhookDigest.push(registration.telegram_id, repoName, summary, described.link || null);
        webhookMetrics.received.inc({ result: 'processed' });
      } catch (err) {
        webhookMetrics.received.inc({ result: 'failed' });
        logger.error('Webhook post-processing failed', { message: err.message });
      } finally {
        webhookMetrics.backlog.set({}, webhookLimiter.stats().backlog);
      }
    });
    if (!accepted) {
      webhookMetrics.received.inc({ result: 'shed' });
      await webhookDeduper.forget(pre.delivery);
      require('../lib/webhookDigest').noteDropped(registration.telegram_id, repoName, 1).catch(() => {});
    }
    webhookMetrics.backlog.set({}, webhookLimiter.stats().backlog);
  });

  // Catch-all for anything unexpected in a route that wasn't already
  // handled by its own try/catch — fails clean with a generic 500 instead
  // of an unpredictable Express default error page or a hung response.
  // 🌐 v2.2.0: the owner web panel (/owner) — private to the owner, answers 404 to everyone else (see ownerPanel.js)
  require('./ownerPanel').mount(app, bot);

  app.use((err, req, res, next) => {
    // Client errors raised by body parsers (413 payload too large, 400 bad
    // body) keep their real status instead of being reported as a 500.
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    (status >= 500 ? logger.error : logger.warn)('Express request error', { path: req.path, status, message: err.message });
    if (res.headersSent) return next(err);
    res.status(status).send(status >= 500 ? 'Something went wrong. Please try again.' : 'Bad request.');
  });

  return app;
}

module.exports = createApp;
module.exports.renderStatusPage = renderStatusPage; // exported for tests
