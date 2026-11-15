/**
 * Owner panel — announcements (v2.3.0-multi): send now, schedule (once or repeating), cancel, repost, history.
 * Rows live in the same `scheduled_broadcasts` table as the bot's own, so the every-minute poller delivers scheduled
 * ones and History shows web and bot broadcasts together.
 */
const { pool } = require('../../db/postgres');
const { ok, fail, int, idOf, text } = require('./util');

let running = false;
const isRunning = () => running;
const setRunning = (v) => { running = !!v; };

const mapRow = (r) => ({
  id: Number(r.id), text: r.text, sendAt: r.send_at, status: r.status, sent: r.sent_count == null ? null : Number(r.sent_count), total: r.total_count == null ? null : Number(r.total_count),
  error: r.error_message || null, sentAt: r.sent_at || null, createdAt: r.created_at, byAdmin: r.admin_id == null ? null : Number(r.admin_id), viaWarden: !!r.via_warden,
  recurrence: r.recurrence_type ? { type: r.recurrence_type, days: r.recurrence_interval_days || null, endAt: r.recurrence_end_at || null, fired: Number(r.recurrence_fired_count || 0) } : null,
});

/**
 * Sends one announcement in the background, one at a time, recording it in the shared broadcast history; the owner is
 * told how it went in their chat. `row` is a 'processing' scheduled_broadcasts row created by the caller.
 */
function runBroadcast({ owner, bot, msg, row }) {
  const actions = require('../../lib/adminActions');
  const sb = require('../../lib/scheduledBroadcasts');
  running = true;
  actions.broadcast(owner, bot, msg)
    .then(async (r) => {
      if (row) await sb.markSent(row.id, r.sent, r.total).catch(() => {});
      return bot.telegram.sendMessage(owner, `Broadcast finished: ${r.sent}/${r.total} delivered, ${r.blocked} blocked the bot, ${r.failed} failed.`).catch(() => {});
    })
    .catch(async (err) => {
      if (row) await sb.markFailed(row.id, String((err && err.message) || err).slice(0, 300)).catch(() => {});
      return bot.telegram.sendMessage(owner, 'The broadcast stopped with an error. Check the audit log.').catch(() => {});
    })
    .finally(() => { running = false; });
}

async function recipients() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE is_blocked = FALSE');
  return rows[0].n;
}

async function handle(method, parts, ctx) {
  if (parts[0] !== 'schedule') return undefined;
  const { owner, bot, body, query, need } = ctx;
  const sb = require('../../lib/scheduledBroadcasts');

  if (method === 'GET' && parts.length === 1) {
    const limit = int(query.limit, 8, 1, 30); const offset = int(query.offset, 0, 0, 100000);
    const [pending, hist, n] = await Promise.all([sb.listPending(), sb.history(limit, offset), recipients().catch(() => 0)]);
    return ok({ pending: pending.map(mapRow), history: hist.rows.map(mapRow), total: hist.total, limit, offset, recipients: n, running });
  }
  if (method !== 'POST') return fail(405, 'Method not allowed');

  if (parts.length === 1) { // create a scheduled (or repeating) announcement
    const blocked = need('broadcast'); if (blocked) return blocked;
    const msg = text(body.text, 3500);
    if (!msg) return fail(400, 'Write the announcement first.');
    const at = new Date(body.sendAt);
    if (Number.isNaN(at.getTime())) return fail(400, 'Pick a date and time.');
    if (at.getTime() < Date.now() + 60 * 1000) return fail(400, 'Pick a time at least a minute from now.');
    if (at.getTime() > Date.now() + 366 * 86400000) return fail(400, 'Pick a time within the next year.');
    const opts = {};
    const rec = body.recurrence && body.recurrence.type;
    if (rec) {
      if (!['daily', 'weekly', 'interval'].includes(rec)) return fail(400, 'Unknown repeat.');
      opts.recurrenceType = rec;
      if (rec === 'interval') opts.recurrenceIntervalDays = int(body.recurrence.days, 2, 2, 90);
      if (body.recurrence.endAt) {
        const end = new Date(body.recurrence.endAt);
        if (Number.isNaN(end.getTime()) || end <= at) return fail(400, 'The end date must be after the first send.');
        opts.recurrenceEndAt = end;
      }
    }
    const row = await sb.create(owner, msg, null, at, opts);
    await ctx.audit(null, 'broadcast_scheduled', `#${row.id} for ${at.toISOString()}${rec ? `, repeats ${rec}` : ''}`);
    return ok({ ok: true, id: Number(row.id) });
  }
  if (parts.length === 3 && parts[2] === 'cancel') {
    const id = idOf(parts[1]); if (!id) return fail(400, 'Bad id');
    const r = await sb.cancel(id);
    if (!r) return fail(409, 'That announcement already went out or was cancelled.');
    await ctx.audit(null, 'broadcast_cancelled', `#${id}`);
    return ok();
  }
  if (parts.length === 3 && parts[2] === 'repost') {
    const blocked = need('broadcast'); if (blocked) return blocked;
    const id = idOf(parts[1]); if (!id) return fail(400, 'Bad id');
    if (!bot) return fail(503, 'The bot connection isn\u2019t available.');
    if (running) return fail(409, 'A broadcast is already being sent.');
    const src = await sb.get(id);
    if (!src) return fail(404, 'No such announcement.');
    const row = await sb.repost(id, owner, new Date());
    await ctx.audit(null, 'broadcast_repost', `#${id} as #${row.id}`);
    runBroadcast({ owner, bot, msg: src.text, row });
    return ok({ ok: true, recipients: await recipients().catch(() => 0) });
  }
  return fail(404, 'Not found');
}

module.exports = { handle, runBroadcast, recipients, isRunning, setRunning };
