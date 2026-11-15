const pgDb = require('../db/postgres');
const redisDb = require('../db/redis');

/**
 * Extracted out of server/app.js (v1.1.0-multi's Admin Dashboard needed the
 * exact same Postgres/Redis check the /health HTTP route already does —
 * duplicating the ping calls in two places would have meant they could
 * silently drift apart over time). Anything that wants to know "is the
 * bot actually healthy right now" should call this, not re-implement it.
 *
 * No extra caching added here — pgDb.ping()/redisDb.ping() already cache
 * their own results for 5s each internally, so a second cache layer on
 * top would only have added complexity for zero benefit.
 */
async function getHealthStatus() {
  const [pgStatus, redisStatus] = await Promise.all([pgDb.ping(), redisDb.ping()]);
  return { pgStatus, redisStatus };
}

module.exports = { getHealthStatus };
