/**
 * One short, friendly sentence for every kind of GitHub "slow down" (v2.1.4-multi): GitHub's own primary/secondary limits and
 * the bot's local traffic manager holding requests back. Replaces the three long, technical messages people used to see
 * ("secondary rate limit — requests are paused for about 41s (held locally)", "…longer than I can hold this open…").
 */
function waitSeconds(err) {
  try {
    if (err && Number(err.retryAfterMs) > 0) return Math.ceil(Number(err.retryAfterMs) / 1000);
    const h = (err && err.response && err.response.headers) || {};
    if (h['retry-after'] && Number(h['retry-after']) > 0) return Math.ceil(Number(h['retry-after']));
    if (h['x-ratelimit-reset'] && String(h['x-ratelimit-remaining']) === '0') {
      const s = Math.ceil(Number(h['x-ratelimit-reset']) - Date.now() / 1000);
      if (s > 0) return s;
    }
    const m = /about (\d+)\s*(s|min)/i.exec(String((err && err.message) || ''));
    if (m) return m[2].toLowerCase() === 'min' ? Number(m[1]) * 60 : Number(m[1]);
  } catch (_) { /* no estimate */ }
  return null;
}

function human(secs) {
  if (!secs) return '';
  if (secs < 60) return `${Math.max(5, Math.ceil(secs / 5) * 5)}s`; // "about 41s" reads as precise; 45s is honest
  const m = Math.ceil(secs / 60);
  return `${m} min`;
}

/** { text, secs, local } for a rate-limit-type error, or null for anything else. `local` = the bot held it back, GitHub never saw it. */
function describe(err) {
  if (!err) return null;
  const code = err.code;
  const local = code === 'GITHUB_RATE_LIMITED' || code === 'GITHUB_QUEUE_TIMEOUT';
  let limited = local;
  if (!limited) {
    try {
      const github = require('./github');
      limited = github.isSecondaryRateLimitError(err) || github.isRateLimitError(err);
    } catch (_) { limited = false; }
  }
  if (!limited) return null;
  const secs = waitSeconds(err);
  const when = human(secs);
  const text = `⏳ GitHub needs a short break${when ? ` — try again in about ${when}` : ' — try again in a moment'}.${local ? ' Nothing was changed.' : ''}`;
  return { text, secs, local };
}

module.exports = { describe, waitSeconds, human };
