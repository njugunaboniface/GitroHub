/**
 * 🌐 Owner web panel — routes (v2.2.0-multi).
 *
 *   GET  /owner/go/<token>   a valid, unspent link → a small "Open the panel" page (nothing is spent by looking)
 *   POST /owner/go           spends the link, starts the session, redirects to /owner
 *   GET  /owner              the panel (needs a session)
 *   *    /owner/api/...      the JSON API (needs a session; changes also need the CSRF token and the same origin)
 *   POST /owner/logout       ends the session
 *
 * `handle()` is plain data in / data out (so it is easy to test); `mount()` is the thin Express adapter. Whenever the
 * caller isn't a signed-in owner, `handle()` returns null and the server answers with its ordinary 404 — the panel
 * does not announce itself.
 */
const crypto = require('crypto');
const config = require('../config');
const ownerWeb = require('../lib/ownerWeb');
const ownerApi = require('./ownerApi');
const page = require('./ownerPage');

const API_PER_MINUTE = 240;
const BASE_ORIGIN = (() => { try { return new URL(config.BASE_URL).origin; } catch (_) { return null; } })();

/** Lets the phone / desktop install the panel like an app (Add to Home screen). Only served to a signed-in owner. */
const MANIFEST = {
  name: 'GitroHub Owner', short_name: 'Owner', description: 'GitroHub owner panel', id: '/owner', start_url: '/owner', scope: '/owner/',
  display: 'standalone', orientation: 'any', background_color: '#070a12', theme_color: '#070a12',
  icons: [{ src: '/logo.png', sizes: '192x192 512x512', type: 'image/png', purpose: 'any' }],
};

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', // NOT no-referrer: that makes browsers send "Origin: null" on every POST, which looks exactly like a forged request
    'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow', 'Cross-Origin-Opener-Policy': 'same-origin', ...extra,
  };
}
function htmlHeaders(nonce) {
  return securityHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  });
}
/** A download (CSV / JSON / JSONL): never sniffed, never cached, always an attachment. */
const fileRes = (out) => ({
  status: out.status || 200,
  headers: securityHeaders({ 'Content-Type': out.contentType || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${out.filename}"` }),
  body: out.raw,
});
const jsonRes = (status, json, headers = {}) => ({ status, headers: securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...headers }), body: JSON.stringify(json) });
const htmlRes = (status, html, nonce, headers = {}) => ({ status, headers: { ...htmlHeaders(nonce), ...headers }, body: html });

/**
 * Is this request from our own pages?
 * Sec-Fetch-Site is set by the browser itself and cannot be forged by a web page, so when it is present it decides:
 * same-origin (or a direct navigation) passes, everything else is refused. Without it (older browsers) the Origin header
 * must be ours — a literal "null" is refused — and the CSRF token is still required on top of this either way.
 */
function sameOrigin(headers) {
  const site = headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = headers.origin;
  if (!origin) return true;
  const host = headers.host;
  return origin === BASE_ORIGIN || origin === `https://${host}` || origin === `http://${host}`;
}

/**
 * @param req {{method:string, path:string, query?:object, headers?:object, body?:object, ip?:string}}
 * @param deps {{bot?:object}}
 * @returns null (not handled → ordinary 404) or {status, headers, body}
 */
async function handle(req, { bot = null } = {}) {
  if (!ownerWeb.enabled()) return null;
  const headers = req.headers || {};
  const method = String(req.method || 'GET').toUpperCase();
  const p = (String(req.path || '/').replace(/\/+$/, '')) || '/';
  const ip = String(req.ip || 'unknown');
  if (p !== '/owner' && !p.startsWith('/owner/')) return null;

  // ── entering with a link ──
  if (p.startsWith('/owner/go/') && method === 'GET') {
    if (ownerWeb.rateLimited(`go:${ip}`, 20, 60 * 1000)) return null;
    const token = p.slice('/owner/go/'.length);
    if (!(await ownerWeb.peekLink(token))) return null;
    const nonce = crypto.randomBytes(16).toString('base64');
    return htmlRes(200, page.renderEnter({ token, nonce, minutes: Math.round(ownerWeb.LINK_TTL_S / 60) }), nonce);
  }
  if (p === '/owner/go' && method === 'POST') {
    if (ownerWeb.rateLimited(`go:${ip}`, 20, 60 * 1000)) return null;
    if (!sameOrigin(headers)) return null;
    const uid = await ownerWeb.consumeLink(String((req.body && req.body.token) || ''));
    if (!uid) return null;
    const session = await ownerWeb.createSession(uid, { ua: headers['user-agent'], ip });
    try { await require('../lib/adminActions').auditLog(uid, null, 'web_login', `owner web panel sign-in (${session.device}, ${session.ip})`); } catch (_) { /* the audit helper never throws, but never block a login on it */ }
    return { status: 303, headers: securityHeaders({ Location: '/owner', 'Set-Cookie': ownerWeb.sessionCookie(session.sid, session.maxAgeSeconds) }), body: '' };
  }

  // ── everything else needs a session ──
  const cookies = ownerWeb.parseCookies(headers.cookie);
  const session = await ownerWeb.getSession(cookies[ownerWeb.COOKIE]);
  if (!session) return null;
  if (ownerWeb.rateLimited(`api:${session.sid.slice(0, 12)}`, API_PER_MINUTE, 60 * 1000)) return jsonRes(429, { error: 'Slow down for a moment.' }, { 'Retry-After': '30' });

  if (p === '/owner' && method === 'GET') {
    const nonce = crypto.randomBytes(16).toString('base64');
    return htmlRes(200, page.renderPanel({ csrf: session.csrf, version: require('../../package.json').version, fresh: ownerWeb.isFresh(session), nonce }), nonce);
  }

  if (p === '/owner/manifest.webmanifest' && method === 'GET') {
    return { status: 200, headers: securityHeaders({ 'Content-Type': 'application/manifest+json; charset=utf-8' }), body: JSON.stringify(MANIFEST) };
  }

  if (p === '/owner/logout' && method === 'POST') {
    if (!sameOrigin(headers) || !ownerWeb.csrfOk(session, headers['x-csrf-token'])) return jsonRes(403, { error: 'Bad request token.' });
    await ownerWeb.destroySession(session.sid);
    return jsonRes(200, { ok: true }, { 'Set-Cookie': ownerWeb.clearCookie() });
  }

  if (p.startsWith('/owner/api/') || p === '/owner/api') {
    if (method === 'POST') {
      if (!sameOrigin(headers)) return jsonRes(403, { error: 'Cross-site request refused.' });
      if (!ownerWeb.csrfOk(session, headers['x-csrf-token'])) return jsonRes(403, { error: 'Your page is out of date \u2014 reload it.' });
    }
    const out = await ownerApi.route({ method, path: p.slice('/owner/api'.length) || '/', query: req.query || {}, body: req.body || {}, session, bot });
    if (out.raw !== undefined) return fileRes(out);
    return jsonRes(out.status, out.json);
  }
  return null;
}

/** Express adapter. Body parsing happens here, but a malformed body from a stranger must look like any other 404. */
function mount(app, bot) {
  const express = require('express');
  const json = express.json({ limit: '32kb' });
  const form = express.urlencoded({ extended: false, limit: '4kb' });
  app.use('/owner', (req, res, next) => {
    if (!ownerWeb.enabled()) return next();
    json(req, res, (e1) => {
      if (e1) return next();
      form(req, res, async (e2) => {
        if (e2) return next();
        try {
          const out = await handle({ method: req.method, path: `/owner${req.path === '/' ? '' : req.path}`, query: req.query, headers: req.headers, body: req.body, ip: clientIp(req) }, { bot });
          if (!out) return next();
          for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
          return res.status(out.status).send(out.body);
        } catch (err) {
          require('../lib/logger').error('Owner panel error', { message: err && err.message });
          return next();
        }
      });
    });
  });
}

/** The platform's proxy appends the real client address LAST in X-Forwarded-For; earlier entries can be forged. */
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { handle, mount, securityHeaders, sameOrigin };
