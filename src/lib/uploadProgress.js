/**
 * Live upload progress (v2.3.3-multi).
 *
 * One message follows an upload from start to finish and is edited in place:
 *
 *   ⬆️ Uploading → SavahBot
 *   ✅ Extracting · ✅ Comparing · ⬆️ Committing
 *   ▰▰▰▰▱▱▱▱▱▱  40 / 300 files
 *   [ ❌ Cancel ]
 *
 * When GitHub asks us to slow down it turns into "⏸ Paused by GitHub — resuming in 60s" and picks up by itself.
 *
 * This file holds three small, separately testable pieces:
 *   • render()        — pure: state → MarkdownV2 text (+ whether a Cancel button belongs on it)
 *   • ProgressCard    — throttled edits of one Telegram message (never more than one edit per `minEditMs`)
 *   • the job registry — who is uploading right now, and the Cancel flag the commit checks before the branch moves;
 *                        plus a Redis heartbeat so an upload cut off by a restart is reported instead of hanging forever
 */
const { Markup } = require('telegraf');
const format = require('./format');
const style = require('../keyboards/buttonStyle');

const esc = format.escapeMd;
const BAR_WIDTH = 10;
const JOB_KEY = (userId) => `upload-job:${userId}`;
const JOB_TTL_SECONDS = 15 * 60;
const STALE_AFTER_MS = 2 * 60 * 1000;   // no heartbeat this long → the process that owned the upload is gone
const SWEEP_EVERY_MS = 60 * 1000;

const STAGES = ['extracting', 'comparing', 'committing'];
const STAGE_LABEL = { extracting: '📦 Extracting', comparing: '🔍 Comparing', committing: '⬆️ Committing' };

/** ▰▰▰▱▱▱▱▱▱▱ for done/total. Always shows at least one filled block once anything is done. */
function bar(done, total) {
  const t = Number(total) || 0;
  if (t <= 0) return '▱'.repeat(BAR_WIDTH);
  const d = Math.min(t, Math.max(0, Number(done) || 0));
  let filled = Math.round((d / t) * BAR_WIDTH);
  if (d > 0 && filled === 0) filled = 1;
  return '▰'.repeat(filled) + '▱'.repeat(BAR_WIDTH - filled);
}

function secondsText(secs) {
  const s = Math.max(1, Math.ceil(Number(secs) || 1));
  if (s < 90) return `${s}s`;
  return `${Math.ceil(s / 60)} min`;
}

/**
 * state: { repo, stage, done, total, pauseSecs, files }
 *   stage: 'extracting' | 'comparing' | 'queued' | 'committing' | 'paused' | 'finalizing' | 'cancelling'
 * Returns { text (MarkdownV2), cancellable }.
 */
function render(state = {}) {
  const repo = state.repo ? ` → ${state.repo}` : '';
  const lines = [`⬆️ *Uploading${esc(repo)}*`];
  const stage = state.stage || 'extracting';

  if (stage === 'queued') {
    lines.push('', '⏳ Other uploads are being committed — yours is queued and starts automatically\\.');
    return { text: lines.join('\n'), cancellable: true };
  }
  if (stage === 'cancelling') {
    lines.push('', '🛑 Cancelling — stopping before anything is changed\\.\\.\\.');
    return { text: lines.join('\n'), cancellable: false };
  }

  // Which of the three phases is the current one (paused / finalizing happen inside "committing").
  const current = STAGES.includes(stage) ? stage : 'committing';
  const idx = STAGES.indexOf(current);
  const steps = STAGES.map((st, i) => {
    const label = STAGE_LABEL[st];
    if (i < idx) return `✅ ${label.replace(/^\S+\s/, '')}`;
    return label + (i === idx ? '...' : '');
  });
  lines.push('', steps.map(esc).join('  ·  '));

  if (current === 'committing' || stage === 'paused' || stage === 'finalizing') {
    const total = Number(state.total) || 0;
    const done = Math.min(total, Math.max(0, Number(state.done) || 0));
    if (total > 0) lines.push('', `${bar(done, total)}  ${esc(`${done} / ${total} file${total === 1 ? '' : 's'}`)}`);
  }
  if (stage === 'paused') {
    lines.push('', `⏸ *Paused by GitHub* — resuming in ${esc(secondsText(state.pauseSecs))}`);
    lines.push('_Nothing is lost: your files are kept and it carries on by itself\\._');
  } else if (stage === 'finalizing') {
    lines.push('', '🔏 Finishing the commit\\.\\.\\.');
  }
  return { text: lines.join('\n'), cancellable: stage !== 'finalizing' };
}

function keyboardFor(cancellable) {
  if (!cancellable) return Markup.inlineKeyboard([]);
  return Markup.inlineKeyboard([[style.callback('❌ Cancel upload', 'upload:job:cancel', style.RED)]]);
}

// ── Job registry ───────────────────────────────────────────────────────────────────────────────────────────────────────
const jobs = new Map(); // userId → { cancelled, startedAt }

function startJob(userId) {
  const job = { cancelled: false, startedAt: Date.now() };
  jobs.set(String(userId), job);
  return job;
}
function getJob(userId) { return jobs.get(String(userId)) || null; }
function endJob(userId, job) { if (jobs.get(String(userId)) === job) jobs.delete(String(userId)); }
/** Marks the person's running upload cancelled. Returns false when there is none. */
function requestCancel(userId) {
  const job = getJob(userId);
  if (!job) return false;
  job.cancelled = true;
  return true;
}

// ── Throttled message edits ────────────────────────────────────────────────────────────────────────────────────────────
class ProgressCard {
  /**
   * @param {{telegram:object, chatId:number|string, messageId:number, userId:number, repo?:string, minEditMs?:number,
   *          now?:Function, store?:object}} o   `store` = { set(key,value,ttl), del(key) } (Redis in production; tests pass a fake)
   */
  constructor({ telegram, chatId, messageId, userId, repo = '', minEditMs = 2000, now = Date.now, store = null }) {
    Object.assign(this, { telegram, chatId, messageId, userId, repo, minEditMs, now, store });
    this.state = { repo, stage: 'extracting', done: 0, total: 0 };
    this.lastEditAt = 0;
    this.lastText = '';
    this.timer = null;
    this.closed = false;
    this.edits = 0;
  }

  /** Merges `patch` into the state and edits the message — immediately if the throttle allows, otherwise once later. */
  async update(patch = {}) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    const wait = this.lastEditAt + this.minEditMs - this.now();
    if (wait <= 0) return this._edit();
    this._later(wait); // one edit at the end of the throttle window, showing the latest state
  }

  _later(ms) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this._edit().catch(() => {}); }, Math.max(50, ms));
    if (this.timer.unref) this.timer.unref();
  }

  async _edit() {
    if (this.closed) return;
    const { text, cancellable } = render(this.state);
    if (text === this.lastText) return;
    this.lastEditAt = this.now();
    this.lastText = text;
    this.edits++;
    try {
      await this.telegram.editMessageText(this.chatId, this.messageId, undefined, text, { parse_mode: 'MarkdownV2', ...keyboardFor(cancellable) });
    } catch (err) {
      const msg = String((err && (err.description || err.message)) || '');
      if (/message is not modified/i.test(msg)) return;
      if (/too many requests|retry after|429/i.test(msg)) this.minEditMs = Math.min(10000, this.minEditMs * 2); // back off, never hammer
    }
    await this._heartbeat();
  }

  async _heartbeat() {
    if (!this.store) return;
    try {
      await this.store.set(JOB_KEY(this.userId), JSON.stringify({ chatId: this.chatId, messageId: this.messageId, repo: this.repo, at: this.now() }), JOB_TTL_SECONDS);
    } catch (_) { /* a heartbeat is a convenience */ }
  }

  /** Called by the commit's onProgress. Maps its stages onto the card's. */
  onCommitProgress(info = {}) {
    const stage = info.stage === 'preparing' || info.stage === 'resumed' ? 'committing' : info.stage;
    return this.update({ stage, done: info.done || 0, total: info.total || this.state.total, pauseSecs: info.pauseSecs }).catch(() => {});
  }

  /** Replaces the card with its final text (keeps the message, drops the Cancel button) and stops all further edits. */
  async finish(text, rows = []) {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.hb) { clearInterval(this.hb); this.hb = null; }
    if (this.store) { try { await this.store.del(JOB_KEY(this.userId)); } catch (_) { /* ignore */ } }
    const extra = { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true }, ...(rows.length ? Markup.inlineKeyboard(rows) : Markup.inlineKeyboard([])) };
    try {
      await this.telegram.editMessageText(this.chatId, this.messageId, undefined, text, extra);
      return true;
    } catch (_) {
      try { await this.telegram.sendMessage(this.chatId, text, extra); return true; } catch (__) { return false; }
    }
  }

  /** Starts the Redis heartbeat: one write now, then every 30s until finish(). */
  async begin() {
    await this._heartbeat();
    this.hb = setInterval(() => { this._heartbeat().catch(() => {}); }, 30000);
    if (this.hb.unref) this.hb.unref();
  }
}

// ── Restart recovery ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * An upload runs inside this process. If the process dies (deploy, crash) the progress message would say "Committing…"
 * forever. Each card leaves a Redis heartbeat; any record that has gone quiet is edited to say what really happened.
 * Nothing is committed until the very last step, so "interrupted" always means "nothing was changed" unless the
 * heartbeat stopped during the final branch update — which the text covers honestly ("check the repository").
 */
async function sweepStale({ telegram, redis, now = Date.now, staleAfterMs = STALE_AFTER_MS }) {
  let fixed = 0;
  try {
    for await (const key of redis.scanIterator({ MATCH: 'upload-job:*', COUNT: 50 })) {
      const raw = await redis.get(key);
      if (!raw) continue;
      let rec; try { rec = JSON.parse(raw); } catch (_) { await redis.del(key); continue; }
      if (now() - Number(rec.at || 0) < staleAfterMs) continue; // someone is still working on it
      await redis.del(key);
      const text = `⚠️ *Upload interrupted*\n${rec.repo ? `📦 ${esc(rec.repo)}\n` : ''}The bot restarted before this upload finished\\. It is only committed in the very last step, so most likely *nothing was changed* — open the repo to check, then send it again if needed\\.`;
      try { await telegram.editMessageText(rec.chatId, rec.messageId, undefined, text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([]) }); fixed++; } catch (_) { /* message gone */ }
    }
  } catch (_) { /* Redis hiccup: try again next sweep */ }
  return fixed;
}

let sweeper = null;
function startSweeper(bot) {
  if (sweeper) return;
  const { client } = require('../db/redis');
  const run = () => sweepStale({ telegram: bot.telegram, redis: client }).catch(() => {});
  setTimeout(run, 5000).unref();
  sweeper = setInterval(run, SWEEP_EVERY_MS);
  if (sweeper.unref) sweeper.unref();
}

/** The Redis-backed store a production card uses. */
function redisStore() {
  const { client } = require('../db/redis');
  return {
    set: (key, value, ttl) => client.set(key, value, { EX: ttl }),
    del: (key) => client.del(key),
  };
}

module.exports = { render, bar, ProgressCard, startJob, getJob, endJob, requestCancel, sweepStale, startSweeper, redisStore, keyboardFor, STALE_AFTER_MS };
