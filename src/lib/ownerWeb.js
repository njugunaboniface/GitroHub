/**
 * 🌐 Owner web panel — access control (v2.2.0-multi).
 *
 * How someone gets in (and nobody else can):
 *   1. The OWNER sends /owner to the bot (or taps "Web panel" on the Admin Dashboard). The bot creates a random link token
 *      and replies with a button. The token is stored hashed, works ONCE and expires after 2 minutes.
 *   2. Opening the link only shows a small "Continue" page (a chat app previewing the link must not use it up). Pressing
 *      Continue spends the token and starts a session: a random id in an HttpOnly, SameSite=Strict cookie (Secure on https),
 *      kept server-side for 12 hours.
 *   3. Every request re-checks that the session's person is STILL the owner, so changing the owner role cuts access at once.
 *   4. Dangerous actions (roles, bans, broadcast, switches that affect everyone) need a FRESH session — one started in the
 *      last 10 minutes — so a stolen old session can't do them; the owner just asks the bot for a new link.
 *
 * Nothing here ever stores or shows a GitHub token. Anyone who isn't the owner gets the server's ordinary 404.
 */
const crypto = require('crypto');
const config = require('../config');

const LINK_TTL_S = 120;
const SESSION_TTL_S = 12 * 60 * 60;
const FRESH_MS = 10 * 60 * 1000;
const COOKIE = 'gh_owner';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const rand = (n) => crypto.randomBytes(n).toString('base64url');

/** OWNER_WEB=off (or false/0/no) turns the whole panel off. */
const enabled = () => !/^(off|false|0|no)$/i.test(String(process.env.OWNER_WEB || ''));

// ── tiny key/value store: Redis (shared by every instance), memory when Redis is unavailable ──
const memory = new Map();
function redis() {
  try {
    const { client } = require('../db/redis');
    return client && client.isReady !== false ? client : null;
  } catch (_) { return null; }
}
async function kvSet(key, value, ttlSeconds) {
  const r = redis();
  if (r) { try { await r.set(key, value, { EX: ttlSeconds }); return; } catch (_) { /* fall through */ } }
  memory.set(key, { value, until: Date.now() + ttlSeconds * 1000 });
}
async function kvGet(key) {
  const r = redis();
  if (r) { try { const v = await r.get(key); if (v != null) return v; } catch (_) { /* fall through */ } }
  const m = memory.get(key);
  if (!m) return null;
  if (m.until < Date.now()) { memory.delete(key); return null; }
  return m.value;
}
/** true only for the caller that actually removed it — which is what makes a link single-use even with two racing requests. */
async function kvDel(key) {
  const r = redis();
  if (r) { try { const n = await r.del(key); if (n >= 1) return true; } catch (_) { /* fall through */ } }
  return memory.delete(key);
}

// ── links ──
/** Called by the bot for the owner only. Returns the URL to put behind a button. */
async function issueLink(ownerId) {
  if (!enabled()) throw new Error('The owner web panel is switched off (OWNER_WEB=off).');
  if (!require('./roles').isOwner(ownerId)) throw new Error('not_owner');
  const token = rand(32);
  await kvSet(`ownerweb:link:${sha(token)}`, JSON.stringify({ uid: Number(ownerId), at: Date.now() }), LINK_TTL_S);
  return { url: `${config.BASE_URL}/owner/go/${token}`, expiresInSeconds: LINK_TTL_S };
}

/** Does this link exist right now? Does NOT spend it. */
async function peekLink(token) {
  if (!TOKEN_RE.test(String(token))) return false;
  return (await kvGet(`ownerweb:link:${sha(token)}`)) != null;
}

/** Spends the link. Returns the owner's id, or null (unknown, expired, already used, or not the owner any more). */
async function consumeLink(token) {
  if (!TOKEN_RE.test(String(token))) return null;
  const key = `ownerweb:link:${sha(token)}`;
  const raw = await kvGet(key);
  if (raw == null) return null;
  if (!(await kvDel(key))) return null;
  try {
    const { uid } = JSON.parse(raw);
    return require('./roles').isOwner(uid) ? Number(uid) : null;
  } catch (_) { return null; }
}

// ── sessions ──
const INDEX_KEY = 'ownerweb:index';

/** "Chrome on Android" from a User-Agent string — a label for the sessions list, nothing more. */
function describeDevice(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /(Chrome|CriOS)\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : 'unknown device';
  return `${browser} on ${os}`;
}
/** 203.0.113.45 → 203.0.113.x ; IPv6 keeps its first three groups. Enough to recognise a place, not to track a person. */
function maskIp(ip) {
  const s = String(ip || '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.replace(/\.\d{1,3}$/, '.x');
  if (s.includes(':')) return `${s.split(':').slice(0, 3).join(':')}::`;
  return 'unknown';
}
async function readIndex() {
  const raw = await kvGet(INDEX_KEY);
  try { const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch (_) { return []; }
}
const writeIndex = (list) => kvSet(INDEX_KEY, JSON.stringify(list.slice(-50)), SESSION_TTL_S);

async function createSession(uid, meta = {}) {
  const sid = rand(32);
  const csrf = rand(24);
  const now = Date.now();
  const ref = sha(sid);
  const device = describeDevice(meta.ua);
  const ip = maskIp(meta.ip);
  await kvSet(`ownerweb:sess:${ref}`, JSON.stringify({ uid: Number(uid), csrf, createdAt: now, freshUntil: now + FRESH_MS, device, ip }), SESSION_TTL_S);
  await writeIndex([...(await readIndex()), { ref, createdAt: now, device, ip }]).catch(() => {});
  return { sid, csrf, maxAgeSeconds: SESSION_TTL_S, device, ip };
}

/** Live sessions, newest first; ones that expired or were revoked drop out of the index here. */
async function listSessions(currentSid) {
  const idx = await readIndex();
  const keep = [];
  for (const e of idx) if ((await kvGet(`ownerweb:sess:${e.ref}`)) != null) keep.push(e);
  if (keep.length !== idx.length) await writeIndex(keep).catch(() => {});
  const mine = TOKEN_RE.test(String(currentSid)) ? sha(currentSid) : null;
  return keep.map((e) => ({ ...e, current: e.ref === mine })).sort((a, b) => b.createdAt - a.createdAt);
}
async function revokeRef(ref) {
  if (!/^[a-f0-9]{64}$/.test(String(ref))) return false;
  const gone = await kvDel(`ownerweb:sess:${ref}`);
  await writeIndex((await readIndex()).filter((e) => e.ref !== ref)).catch(() => {});
  return gone;
}
/** Ends every session except the one making the request. Returns how many were ended. */
async function revokeOthers(currentSid) {
  const mine = TOKEN_RE.test(String(currentSid)) ? sha(currentSid) : null;
  let n = 0;
  for (const e of await readIndex()) if (e.ref !== mine && (await revokeRef(e.ref))) n++;
  return n;
}

async function getSession(sid) {
  if (!TOKEN_RE.test(String(sid))) return null;
  const raw = await kvGet(`ownerweb:sess:${sha(sid)}`);
  if (raw == null) return null;
  let data;
  try { data = JSON.parse(raw); } catch (_) { return null; }
  if (!require('./roles').isOwner(data.uid)) { await kvDel(`ownerweb:sess:${sha(sid)}`); return null; }
  return { ...data, sid };
}

async function destroySession(sid) {
  if (TOKEN_RE.test(String(sid))) await revokeRef(sha(sid));
}

const isFresh = (session) => !!session && Number(session.freshUntil) > Date.now();

function csrfOk(session, supplied) {
  if (!session || !supplied) return false;
  const a = Buffer.from(String(session.csrf));
  const b = Buffer.from(String(supplied));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── cookies ──
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const secure = () => String(config.BASE_URL).startsWith('https://');
function sessionCookie(sid, maxAgeSeconds) {
  return `${COOKIE}=${sid}; Path=/owner; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure() ? '; Secure' : ''}`;
}
const clearCookie = () => `${COOKIE}=; Path=/owner; HttpOnly; SameSite=Strict; Max-Age=0${secure() ? '; Secure' : ''}`;

// ── rate limiting (per client, in memory — it only has to blunt guessing and hammering) ──
const buckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n += 1;
  return b.n > max;
}

module.exports = {
  enabled, issueLink, peekLink, consumeLink,
  createSession, getSession, destroySession, isFresh, csrfOk, listSessions, revokeRef, revokeOthers, describeDevice, maskIp,
  parseCookies, sessionCookie, clearCookie, rateLimited,
  COOKIE, LINK_TTL_S, SESSION_TTL_S, FRESH_MS, TOKEN_RE,
  _memory: memory, _buckets: buckets,
};
