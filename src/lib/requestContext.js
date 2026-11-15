/**
 * Request-scoped context (v1.2.1-multi) — one place that answers "which
 * Telegram update / which user / which priority is this work for?" without
 * threading extra parameters through ~100 call sites.
 *
 * Backed by AsyncLocalStorage, so the context follows awaits, timers and
 * promise chains started inside `run()`, and CANNOT leak between users: two
 * updates processed at the same time each see only their own store.
 *
 * Correlation chain (spec §25):
 *   Telegram update (opId "op_…")  →  GitHub request ("ghreq_…", parent=opId)
 *   →  retry attempts  →  final outcome
 *
 * Nothing secret ever goes in here — only ids, a priority and a label.
 */
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const als = new AsyncLocalStorage();

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/** The active context ({ opId, userId, priority, operation }) or {}. */
function current() {
  return als.getStore() || {};
}

/** Runs fn with `patch` merged over the current context. */
function run(patch, fn) {
  return als.run({ ...current(), ...patch }, fn);
}

/** Start a fresh operation context (e.g. one Telegram update). */
function runOperation({ userId = null, priority = 'interactive', operation = null } = {}, fn) {
  return als.run({ opId: newId('op'), userId, priority, operation }, fn);
}

/** Marks everything inside fn as BACKGROUND work (pollers, scheduled jobs). */
function runBackground(operation, fn, userId = null) {
  return als.run({ opId: newId('op'), userId, priority: 'background', operation }, fn);
}

/**
 * For long-lived loops (pollers): marks the REST of the current async chain as
 * background work for `userId`. Unlike run(), it doesn't need a callback — a
 * poller's per-item code is written inline. Scoped to the async execution it
 * is called from, so it can't leak into updates handled elsewhere.
 */
function enterBackground(operation, userId = null) {
  als.enterWith({ opId: newId('op'), userId, priority: 'background', operation });
}

module.exports = { current, run, runOperation, runBackground, enterBackground, newId };
