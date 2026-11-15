/**
 * Classifies "an infrastructure dependency is down" errors (v1.2.1-multi).
 *
 * Before this, bot.catch() put `err.message` straight into the chat, so during a Postgres or Redis
 * outage users saw raw driver text — including internal hostnames/IPs ("connect ECONNREFUSED
 * 10.0.0.5:5432") — and no hint that the problem was temporary. This maps those errors to a short,
 * truthful, non-leaky message. It deliberately does NOT claim "nothing was changed": a database
 * failure can happen AFTER a GitHub write already succeeded, so the message says what is known
 * (this could not be completed) and tells the user to check before repeating a change.
 */
const PG_CLASS = /^(08|53|57P|58)/; // connection exception, insufficient resources, operator intervention, system error

function text(err) {
  return `${err && err.name || ''} ${err && err.code || ''} ${err && err.message || ''}`;
}

function isDatabaseError(err) {
  if (!err) return false;
  if (typeof err.code === 'string' && PG_CLASS.test(err.code)) return true;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|the database system is (starting up|shutting down|in recovery)|terminating connection|too many clients|remaining connection slots/i.test(text(err))
    && !/redis/i.test(text(err));
}

function isRedisError(err) {
  if (!err) return false;
  return /ClientClosedError|ClientOfflineError|ConnectionTimeoutError|SocketClosedUnexpectedlyError|The client is closed|Socket closed unexpectedly|Connection timeout|Redis connection|redis/i.test(text(err))
    && !/\bpostgres|\bpg\b/i.test(text(err));
}

/** @returns {{kind:'database'|'redis', message:string}|null} */
function describeDependencyError(err) {
  if (isRedisError(err)) return { kind: 'redis', message: 'the bot\u2019s session store is temporarily unreachable' };
  if (isDatabaseError(err)) return { kind: 'database', message: 'the bot\u2019s database is temporarily unreachable' };
  return null;
}

module.exports = { isDatabaseError, isRedisError, describeDependencyError };
