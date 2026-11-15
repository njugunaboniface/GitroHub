/**
 * Structured logger — pino under the hood as of v1.2.0-multi, replacing
 * the original hand-rolled JSON-ish formatter (see CHANGELOG). Every
 * call site across the codebase calls logger.info/warn/error(message,
 * meta) — message first, meta object second — which is the OPPOSITE
 * argument order pino itself wants (meta first, message second). Rather
 * than touch every one of those call sites, this thin wrapper flips the
 * order once, here, so nothing else in the codebase had to change.
 */
const pino = require('pino');

const base = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Railway's log viewer parses each line as its own JSON object already —
  // pino's default output IS one JSON object per line, so no extra
  // transport/formatting is needed here, unlike a typical local-dev setup
  // that might add pino-pretty on top.
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Accepts BOTH argument orders (v1.2.3-multi): (message, meta) — what most of the code
 * uses — and pino's own (meta, message), which about a dozen call sites used. The second
 * form used to lose its message text entirely (the object was logged, the string was
 * dropped), including the main "Bot error" line.
 */
function wrap(level) {
  return (first, second) => {
    if (first && typeof first === 'object' && typeof second === 'string') base[level](first, second);
    else if (second && typeof second === 'object') base[level](second, first);
    else base[level](first);
  };
}

module.exports = {
  debug: wrap('debug'),
  info: wrap('info'),
  warn: wrap('warn'),
  error: wrap('error'),
};
