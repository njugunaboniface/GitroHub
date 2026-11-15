/**
 * GitHub-traffic signals for Warden (v1.2.1-multi) — OBSERVATION ONLY.
 *
 * Warden reads a snapshot of the GitHub traffic layer and uses it in two ways,
 * neither of which touches any account or any traffic setting:
 *
 *  1. As an INNOCENT EXPLANATION. If GitHub itself is degraded (circuit open,
 *     overload, many accounts rate-limited at once), a user's failures and
 *     throttling are not evidence about the user — the fleet check says so.
 *  2. As a new evidence class, "github": a user who accounts for a
 *     disproportionate share of the fleet's GitHub traffic, or who keeps
 *     triggering GitHub's secondary limit. Weak on its own (reliability 0.4)
 *     and NEVER counted as behavioural corroboration — heavy GitHub use alone
 *     is not misuse (bulk operations, big uploads).
 *
 * The traffic manager enforces limits; this module only reads a plain object.
 */
const { clamp } = require('./stats');

const MIN_FLEET_REQUESTS = 200;  // below this the "share" is meaningless
const SHARE_FLOOR = 0.35;        // a user must account for ≥35% of recent traffic to count
const MIN_USER_REQUESTS = 120;
const MIN_ACTIVE_USERS = 4;      // with 1–3 users, someone always has "most" of the traffic

/** Fleet-level read: is GitHub (or our link to it) the likely cause of failures right now? */
function githubFleetState(snapshot) {
  if (!snapshot) return { degraded: false, reason: null };
  const circuitOpen = snapshot.breaker && snapshot.breaker.state !== 'CLOSED';
  const overloaded = snapshot.state === 'OVERLOADED' || snapshot.state === 'DEGRADED';
  const manyLimited = (snapshot.pausedLanes || 0) >= 3;
  const degraded = !!(circuitOpen || overloaded || manyLimited);
  const reason = circuitOpen ? 'GitHub circuit breaker is not closed'
    : overloaded ? `GitHub traffic is ${String(snapshot.state).toLowerCase()}`
      : manyLimited ? `${snapshot.pausedLanes} accounts are paused by GitHub rate limits` : null;
  return { degraded, reason };
}

/** Per-user evidence items from `topConsumers` rows ({user, requests, writes, secondaryLimits, shed}). */
function githubEvidenceFor(userId, snapshot, { reliability = 0.4 } = {}) {
  if (!snapshot || !Array.isArray(snapshot.topConsumers)) return null;
  const rows = snapshot.topConsumers;
  const total = (snapshot.lastHour && snapshot.lastHour.req) || rows.reduce((s, r) => s + r.requests, 0);
  const me = rows.find((r) => String(r.user) === String(userId));
  if (!me || total < MIN_FLEET_REQUESTS || rows.length < MIN_ACTIVE_USERS) return null;
  const share = me.requests / total;
  const limited = me.secondaryLimits || 0;
  let strength = 0; const facts = [];
  if (share >= SHARE_FLOOR && me.requests >= MIN_USER_REQUESTS) {
    strength = Math.max(strength, clamp((share - SHARE_FLOOR) / 0.4) * 0.8 + 0.2);
    facts.push(`${Math.round(share * 100)}% of the fleet's GitHub requests in the last hour (${me.requests} of ${total})`);
  }
  if (limited >= 2) {
    strength = Math.max(strength, clamp(limited / 6) * 0.9 + 0.1);
    facts.push(`triggered GitHub's secondary rate limit ${limited}×`);
  }
  if (strength < 0.12) return null;
  return {
    type: 'github_load_anomaly', class: 'github',
    strength: Number(strength.toFixed(3)), raw_strength: Number(strength.toFixed(3)), reliability, firing_hours: 0,
    observed: { share: Number(share.toFixed(3)), requests: me.requests, writes: me.writes || 0, secondary_limits: limited, fleet_requests: total },
    baseline: { source: 'fleet' },
    fact: facts.join('; '),
  };
}

module.exports = { githubFleetState, githubEvidenceFor, SHARE_FLOOR, MIN_FLEET_REQUESTS };
