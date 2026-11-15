/**
 * Warden poller — invoked by src/index.js on its scheduled interval,
 * same pattern as every other recurring job in this file (webhookDigest,
 * scheduledBroadcasts, rollups, etc.). Uses a poller lease so only ONE
 * Railway replica ever runs Warden at a time — same "single-instance
 * execution" guarantee all other pollers have.
 *
 * v1.2.0-multi: each tick OBSERVES and EVALUATES (lib/wardenBrain/runner.js);
 * it cannot act on any account. The most it ever does is message the owner.
 */

const pollerLease = require('../pollerLease');
const collector = require('../wardenBrain/collector');
const runner = require('../wardenBrain/runner');
const logger = require('../logger');

const WARDEN_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const WARDEN_LEASE_TTL_SECONDS = 4 * 60; // lease expires before next tick (pollerLease takes SECONDS)

let wardenTimer = null;

async function tick(bot, config) {
  // v1.1.24-multi: this used to pass 240000 (milliseconds' worth) as the TTL of
  // a lease measured in SECONDS — about 2.8 days — and then "released" it with
  // pollerLease.release('warden'), a function that doesn't exist (the module
  // only exports acquire; release lives on the lease it returns) and threw
  // inside the finally block. Net effect: after its first tick the lease was
  // never freed, every later tick found it held and returned, and Warden sat
  // dormant for days, then acted on a whole batch of people at once when it
  // finally expired. That is the "everyone got restricted, one at a time, all
  // of a sudden" pattern.
  const lease = await pollerLease.acquire('warden', WARDEN_LEASE_TTL_SECONDS);
  if (!lease) return; // another replica got it this tick

  try {
    // Make sure the freshest counters are on disk before judging them.
    await collector.flush().catch(() => {});
    const result = await runner.runEvaluation({ bot });
    if (result.skipped) {
      logger.debug({ reason: result.reason }, 'Warden: tick skipped');
    } else {
      logger.info(
        { evaluated: result.evaluated, opened: result.opened, alerts: result.alerts, byStage: result.byStage, systemic: result.fleet && result.fleet.systemic },
        `Warden: evaluated ${result.evaluated} user(s) — observation only`
      );
    }
  } catch (err) {
    logger.error({ err }, 'Warden: tick threw unexpectedly');
    // A single failed tick (e.g. a transient DB hiccup) changes nothing for
    // anyone — Warden only observes — so the next tick simply tries again.
  } finally {
    await lease.release().catch(() => {});
  }
}

function start(bot, config) {
  if (wardenTimer) return; // idempotent
  // Stagger by 90 seconds on boot so Warden's first tick never competes
  // with the startup health check or the very first maintenance poll.
  wardenTimer = setTimeout(() => {
    tick(bot, config);
    wardenTimer = setInterval(() => tick(bot, config), WARDEN_INTERVAL_MS);
  }, 90 * 1000);
  logger.info('Warden: poller started (first tick in 90s)');
}

function stop() {
  if (wardenTimer) { clearTimeout(wardenTimer); clearInterval(wardenTimer); wardenTimer = null; }
}

module.exports = { start, stop, tick };
