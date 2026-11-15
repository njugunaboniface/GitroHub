/**
 * Telegram send with flood-control awareness (v1.2.1-multi).
 *
 * Telegram answers 429 with `retry_after` seconds. The broadcast loop used to swallow EVERY send
 * error, so a flood-control response silently lost the message for that user while the count looked
 * fine. This waits out `retry_after` (bounded: at most `maxRetries` times, never longer than
 * `maxWaitMs` per wait) and classifies the final result so callers can report honestly:
 *
 *   'sent'     delivered
 *   'blocked'  the user blocked the bot / chat gone (403, 400 chat not found) — expected, not retried
 *   'failed'   anything else after bounded retries (flood control, 5xx, network)
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryAfterSeconds(err) {
  const p = (err && err.response && err.response.parameters) || (err && err.parameters) || null;
  return p && Number(p.retry_after) > 0 ? Number(p.retry_after) : null;
}

function isBlocked(err) {
  const code = err && ((err.response && err.response.error_code) || err.code);
  const desc = String((err && ((err.response && err.response.description) || err.description || err.message)) || '');
  return code === 403 || /bot was blocked|user is deactivated|chat not found|bot can't initiate/i.test(desc);
}

async function sendWithRetry(fn, { maxRetries = 2, maxWaitMs = 30000, sleepFn = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fn();
      return 'sent';
    } catch (err) {
      if (isBlocked(err)) return 'blocked';
      const ra = retryAfterSeconds(err);
      if (attempt >= maxRetries) return 'failed';
      if (ra != null) {
        if (ra * 1000 > maxWaitMs) return 'failed';
        await sleepFn(ra * 1000 + Math.floor(Math.random() * 250)); // jitter so a paused loop doesn't resume on a boundary
        continue;
      }
      // Non-flood error: one short, jittered retry for transient network/5xx, none for 4xx.
      const code = err && ((err.response && err.response.error_code) || err.code);
      if (typeof code === 'number' && code >= 400 && code < 500) return 'failed';
      await sleepFn(300 * 2 ** attempt + Math.floor(Math.random() * 200));
    }
  }
}

module.exports = { sendWithRetry, retryAfterSeconds, isBlocked };
