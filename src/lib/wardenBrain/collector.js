/**
 * Warden's eyes: turns the stream of accepted updates into HOURLY COUNTERS.
 *
 * Privacy by construction: only numbers are kept — actions, errors, repeats,
 * throttle hits, sessions, active minutes, peak burst. The "kind" of an update
 * (which button, which command) is used in memory for one thing only — to see
 * whether the same control was hit again within seconds — and is never stored.
 * No repo names, file names or message text ever reach this table.
 *
 * Writes are batched in memory and flushed once a minute (and on shutdown), so
 * the hot path never touches the database.
 */
const { HOUR, ms } = require('./stats');

const SESSION_GAP_MS = 30 * 60 * 1000;   // 30 idle minutes starts a new session
const REPEAT_MS = 5 * 1000;              // same control again within 5s = a repeat
const BURST_WINDOW_MS = 60 * 1000;
const FLUSH_MS = 60 * 1000;
const MAX_BUCKETS = 20000;               // memory guard
const MAX_LIVE = 20000;

const buckets = new Map();   // "id|hourStart" → counters since the last flush
const live = new Map();      // id → { lastAt, lastKind, recent: [timestamps in the last 60s] }
let timer = null;

function getPool() { return require('../../db/postgres').pool; }

/** Which control was used — compared in memory only, never persisted. */
function kindOf(ctx) {
  const u = (ctx && ctx.update) || {};
  if (u.callback_query) return 'cb:' + String(u.callback_query.data || '').split(':').slice(0, 2).join(':').slice(0, 40);
  const m = u.message;
  if (m) {
    if (m.text) return m.text.startsWith('/') ? 'cmd:' + m.text.split(/[\s@]/)[0].slice(0, 30) : 'text';
    if (m.document) return 'document';
    if (m.photo) return 'photo';
    return 'message';
  }
  return 'other';
}

function bucketFor(id, now) {
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const key = `${id}|${hourStart}`;
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) return null; // shed load rather than grow without bound
    b = { id, hourStart, actions: 0, errors: 0, repeats: 0, capHits: 0, sessions: 0, maxBurst: 0, minutes: new Set(), flushedMinutes: 0, dirty: false };
    buckets.set(key, b);
  }
  return b;
}

function liveFor(id, lastActiveAt) {
  let st = live.get(id);
  if (!st) {
    if (live.size >= MAX_LIVE) return null;
    // Seed from the database's last_active_at so a redeploy doesn't look like
    // everyone starting a fresh session at once.
    st = { lastAt: lastActiveAt ? ms(lastActiveAt) : 0, lastKind: null, recent: [] };
    live.set(id, st);
  }
  return st;
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, FLUSH_MS);
  if (timer.unref) timer.unref();
}

/** An update was accepted for this user. Never throws. */
function recordAction(telegramId, kind, { now = Date.now(), lastActiveAt = null } = {}) {
  try {
    const id = Number(telegramId);
    const b = bucketFor(id, now); const st = liveFor(id, lastActiveAt);
    if (!b || !st) return;
    b.actions += 1; b.dirty = true;
    if (now - st.lastAt > SESSION_GAP_MS) b.sessions += 1;
    if (st.lastKind === kind && now - st.lastAt <= REPEAT_MS) b.repeats += 1;
    st.recent.push(now);
    while (st.recent.length && now - st.recent[0] > BURST_WINDOW_MS) st.recent.shift();
    if (st.recent.length > b.maxBurst) b.maxBurst = st.recent.length;
    b.minutes.add(Math.floor(now / 60000));
    st.lastAt = now; st.lastKind = kind;
    schedule();
  } catch (_) { /* observation must never break a request */ }
}

/** An update was refused by the hourly cap. Counts as activity for session purposes. */
function recordCapHit(telegramId, { now = Date.now() } = {}) {
  try {
    const id = Number(telegramId);
    const b = bucketFor(id, now); const st = liveFor(id, null);
    if (!b) return;
    b.capHits += 1; b.dirty = true;
    if (st) st.lastAt = now;
    schedule();
  } catch (_) { /* never throws */ }
}

/** An operation failed for this user (called from the activity log). */
function recordError(telegramId, { now = Date.now() } = {}) {
  try {
    const b = bucketFor(Number(telegramId), now);
    if (!b) return;
    b.errors += 1; b.dirty = true;
    schedule();
  } catch (_) { /* never throws */ }
}

async function flush(now = Date.now()) {
  if (timer) { clearTimeout(timer); timer = null; }
  const dirty = [...buckets.values()].filter((b) => b.dirty);
  // drop idle per-user state (keeps memory bounded)
  for (const [id, st] of live) if (now - st.lastAt > 2 * HOUR) live.delete(id);
  if (!dirty.length) return 0;

  const snap = dirty.map((b) => ({ b, minutesDelta: b.minutes.size - b.flushedMinutes, a: b.actions, e: b.errors, r: b.repeats, c: b.capHits, s: b.sessions, m: b.maxBurst }));
  try {
    await getPool().query(
      `INSERT INTO warden_activity_buckets AS t (telegram_id, bucket_start, actions, errors, repeats, cap_hits, sessions, active_minutes, max_burst)
       SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[])
       ON CONFLICT (telegram_id, bucket_start) DO UPDATE SET
         actions = t.actions + EXCLUDED.actions, errors = t.errors + EXCLUDED.errors, repeats = t.repeats + EXCLUDED.repeats,
         cap_hits = t.cap_hits + EXCLUDED.cap_hits, sessions = t.sessions + EXCLUDED.sessions,
         active_minutes = t.active_minutes + EXCLUDED.active_minutes, max_burst = GREATEST(t.max_burst, EXCLUDED.max_burst)`,
      [
        snap.map((x) => x.b.id), snap.map((x) => new Date(x.b.hourStart)),
        snap.map((x) => x.a), snap.map((x) => x.e), snap.map((x) => x.r), snap.map((x) => x.c), snap.map((x) => x.s),
        snap.map((x) => x.minutesDelta), snap.map((x) => x.m),
      ]
    );
  } catch (err) {
    schedule(); // keep the counters; try again next window
    throw err;
  }
  // success: subtract what was written (updates that arrived meanwhile are kept)
  for (const x of snap) {
    x.b.actions -= x.a; x.b.errors -= x.e; x.b.repeats -= x.r; x.b.capHits -= x.c; x.b.sessions -= x.s;
    x.b.flushedMinutes += x.minutesDelta; x.b.maxBurst = 0;
    x.b.dirty = x.b.actions > 0 || x.b.errors > 0 || x.b.repeats > 0 || x.b.capHits > 0 || x.b.sessions > 0;
  }
  const currentHour = Math.floor(now / HOUR) * HOUR;
  for (const [key, b] of buckets) if (!b.dirty && b.hourStart < currentHour - HOUR) buckets.delete(key);
  return snap.length;
}

/** Drop everything held in memory about one person (called when their data is erased). */
function forget(telegramId) {
  const id = Number(telegramId);
  for (const [key, b] of buckets) if (b.id === id) buckets.delete(key);
  live.delete(id);
}

/** Test helper: forget everything in memory. */
function _reset() { buckets.clear(); live.clear(); if (timer) { clearTimeout(timer); timer = null; } }

module.exports = { kindOf, recordAction, recordCapHit, recordError, flush, forget, _reset, SESSION_GAP_MS, REPEAT_MS };
