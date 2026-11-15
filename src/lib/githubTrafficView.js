/**
 * Rendering of the GitHub Traffic admin screen (v1.2.1-multi) as MarkdownV2.
 * Pure (no Telegram/DB imports) so the escaping can be tested directly:
 * Telegram rejects the WHOLE message if a single reserved character is left
 * unescaped, so every dynamic value goes through e() and literal punctuation
 * in the template is escaped by hand.
 */
const format = require('./format');

const e = format.escapeMd;
const STATE_ICON = { NORMAL: '🟢', BUSY: '🟡', DEGRADED: '🟠', OVERLOADED: '🔴', RECOVERING: '🔵' };
const CIRCUIT_ICON = { CLOSED: '🟢', HALF_OPEN: '🟡', OPEN: '🔴' };

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function render(snap) {
  const h = snap.lastHour;
  const f = snap.lastFiveMinutes;
  const lines = [];
  lines.push('🌐 *GitHub Traffic*', '');
  lines.push(`${STATE_ICON[snap.state] || '⚪'} State: *${e(snap.state)}* \\(${e(dur(Date.now() - snap.since))}\\)`);
  lines.push(`⚙️ In flight: ${snap.active}/${snap.limit}${snap.limit < snap.maxConcurrency ? ` \\(lowered from ${snap.maxConcurrency}\\)` : ''} · background ${snap.backgroundActive}/${snap.backgroundConcurrency}`);
  lines.push(`📥 Queued: ${snap.queued}/${snap.maxQueue} \\(${snap.queuedInteractive} interactive, ${snap.queuedBackground} background\\)`);
  lines.push(`${CIRCUIT_ICON[snap.breaker.state] || '⚪'} Circuit: ${e(snap.breaker.state.replace('_', '-').toLowerCase())}${snap.breaker.state === 'OPEN' ? ` — retry in ${e(dur(snap.breaker.retryInMs))}` : ''}`);
  if (snap.backgroundPaused) lines.push('⏸️ Background GitHub work is *paused*');
  lines.push('');
  lines.push('*Last 5 min*');
  lines.push(`${f.req} requests · ${f.ok} ok · ${f.fail} failed · ${f.retry} retries`);
  lines.push(`${f.sec} secondary limits · ${f.pri} primary limits · ${f.timeout} timeouts · ${f.shed} shed`);
  lines.push(`Queue wait ${f.avgQueueWaitMs}ms · request ${f.avgDurationMs}ms${f.unknown ? ` · ⚠️ ${f.unknown} unconfirmed writes` : ''}`);
  lines.push('');
  lines.push('*Last hour*');
  lines.push(`${h.req} requests · ${h.fail} failed · ${h.sec} secondary · ${h.pri} primary`);
  lines.push(`Saved by coalescing/cache: ${snap.totals.coalesced + snap.totals.cacheHits}`);
  if (snap.pausedLanes) {
    lines.push('', `⏳ *${snap.pausedLanes} account${snap.pausedLanes === 1 ? '' : 's'} paused*`);
    for (const p of snap.pausedList.slice(0, 5)) lines.push(`• \\#${e(String(p.user))} — resumes in ${e(dur(p.resumeInMs))}`);
  }
  const core = snap.lowestRemaining.core;
  if (core) lines.push('', `📉 Lowest hourly quota left: ${core.remaining}/${core.limit}`);
  if (snap.topConsumers.length) {
    lines.push('', '*Top consumers \\(last hour\\)*');
    for (const c of snap.topConsumers.slice(0, 5)) lines.push(`• \\#${e(String(c.user))} — ${c.requests} req${c.writes ? `, ${c.writes} writes` : ''}${c.secondaryLimits ? `, ${c.secondaryLimits} limited` : ''}`);
  }
  return lines.join('\n');
}


module.exports = { render, dur };
