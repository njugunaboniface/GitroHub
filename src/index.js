const config = require('./config');
const { migrate } = require('./db/migrate');
const redisDb = require('./db/redis');
const pgDb = require('./db/postgres');
const createBot = require('./bot');
const createApp = require('./server/app');
const logger = require('./lib/logger');

let bot;
let httpServer;
let shuttingDown = false;
let botMode = null; // 'webhook' | 'polling' — tracks which so shutdown knows whether bot.stop() is even valid

/**
 * Closes everything in order (bot polling/webhook, HTTP server, Redis,
 * Postgres) before the process exits. Used for real SIGTERM/SIGINT from
 * Railway, the voluntary memory-watchdog restart, and an uncaught
 * exception — every path ends here so connections close cleanly instead
 * of the process just disappearing mid-write.
 *
 * Every step below has its own timeout, AND the
 * whole sequence is capped by a hard deadline — httpServer.close() famously
 * hangs waiting for idle keep-alive connections to close on their own (it
 * doesn't force them), and Redis's client.quit() has known hangs under
 * certain reconnect states. Either one hanging would mean process.exit()
 * never runs, silently defeating the entire point of the watchdog: instead
 * of a clean preemptive restart, the process would just sit there — still
 * consuming memory — until Railway's kernel eventually force-killed it anyway.
 */
const SHUTDOWN_STEP_TIMEOUT_MS = 5000;
const SHUTDOWN_HARD_DEADLINE_MS = 8000;

function withStepTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), SHUTDOWN_STEP_TIMEOUT_MS)),
  ]);
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { reason });

  // Absolute last resort: if the graceful sequence below is still running
  // past this deadline for ANY reason, force-exit anyway. A forced exit
  // that skips some cleanup is still strictly better than never exiting —
  // Railway's kernel would eventually force-kill it regardless, just
  // later and after more memory had piled up in the meantime.
  const hardDeadline = setTimeout(() => {
    logger.error('Shutdown exceeded hard deadline — forcing exit', { reason });
    process.exit(1);
  }, SHUTDOWN_HARD_DEADLINE_MS);
  hardDeadline.unref?.();

  // bot.stop() only means something in polling mode (it stops the getUpdates
  // loop). In webhook mode there's no such loop running, so calling it just
  // throws "Bot is not running!" every time — noise that was cluttering the
  // exact logs needed to debug real issues. Skipped entirely in webhook mode.
  if (botMode === 'polling') {
    try {
      if (bot) bot.stop(reason);
    } catch (err) {
      logger.error('Error stopping bot', { message: err.message });
    }
  }
  try {
    if (httpServer) await withStepTimeout(new Promise((resolve) => httpServer.close(resolve)), 'HTTP server close');
  } catch (err) {
    logger.error('Error closing HTTP server', { message: err.message });
  }
  try {
    // Persist the batched click counters before the pool closes.
    await withStepTimeout(require('./lib/users').flushActivity(), 'Activity counter flush');
    await withStepTimeout(require('./lib/wardenBrain/collector').flush(), 'Warden observation flush');
  } catch (err) {
    logger.error('Error flushing activity counters', { message: err.message });
  }
  try {
    await withStepTimeout(redisDb.close(), 'Redis close');
  } catch (err) {
    logger.error('Error closing Redis', { message: err.message });
  }
  try {
    await withStepTimeout(pgDb.close(), 'Postgres pool close');
  } catch (err) {
    logger.error('Error closing Postgres pool', { message: err.message });
  }

  clearTimeout(hardDeadline);
  logger.info('Shutdown complete');
  process.exit(0);
}

/**
 * Checks RSS memory against a self-imposed ceiling comfortably under
 * Railway's hard container limit, and triggers the SAME clean shutdown
 * path above rather than waiting for the kernel to SIGKILL the process.
 *
 * Two design choices worth noting:
 *
 * 1. Adaptive check interval, not just a fixed 2-minute post-boot window.
 *    A flat 30s cadence after boot would leave a real blind spot: a sharp
 *    spike well after startup (e.g. a burst of concurrent GitHub requests)
 *    could blow past the ceiling within that 30s gap before the watchdog
 *    even looks again. Checks every 5s whenever RSS is within 20% of the
 *    ceiling, regardless of how long the process has been up — the fast
 *    cadence follows actual risk, not just a fixed post-boot window.
 *
 * 2. An early-warning log at 80% of the ceiling. I can't verify from
 *    static analysis alone whether MEMORY_WATCHDOG_MB's margin under
 *    --max-old-space-size is actually right — that needs real Railway
 *    telemetry, not more guessing. This doesn't change the threshold
 *    itself; it makes the trend visible in the logs before a restart
 *    happens, so if the margin ever IS wrong, there's real data to look
 *    at instead of another unverified assumption.
 */
function startMemoryWatchdog() {
  const startTime = Date.now();
  const FAST_INTERVAL_MS = 5000;
  const FAST_WINDOW_MS = 2 * 60 * 1000;
  const WARNING_THRESHOLD_MB = config.MEMORY_WATCHDOG_MB * 0.8;
  const PROXIMITY_ZONE_MB = config.MEMORY_WATCHDOG_MB * 0.2; // "close to the ceiling" band
  let lastWarnedAt = 0;

  function check() {
    const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rssMB >= config.MEMORY_WATCHDOG_MB) {
      logger.warn('Memory watchdog threshold crossed — restarting cleanly', { rssMB, ceilingMB: config.MEMORY_WATCHDOG_MB });
      shutdown('memory-watchdog');
      return;
    }
    if (rssMB >= WARNING_THRESHOLD_MB && Date.now() - lastWarnedAt > 60000) {
      // Debounced to once/minute — this is a heads-up, not a per-check spam risk
      logger.warn('Memory approaching watchdog ceiling', { rssMB, ceilingMB: config.MEMORY_WATCHDOG_MB });
      lastWarnedAt = Date.now();
    }

    const inFastWindow = Date.now() - startTime < FAST_WINDOW_MS;
    const nearCeiling = rssMB >= config.MEMORY_WATCHDOG_MB - PROXIMITY_ZONE_MB;
    const nextInterval = (inFastWindow || nearCeiling) ? FAST_INTERVAL_MS : config.MEMORY_WATCHDOG_CHECK_INTERVAL_MS;
    setTimeout(check, nextInterval).unref();
  }
  setTimeout(check, FAST_INTERVAL_MS).unref();
}

/**
 * Flushes any webhook digest windows that have come due (see
 * lib/webhookDigest.js). A plain setInterval, deliberately separate from
 * the memory watchdog's adaptive-cadence logic above — unrelated concern,
 * unrelated failure modes; tangling them would make both harder to reason
 * about. 30s cadence is frequent enough that a 2-minute digest window
 * never overshoots by more than half a poll cycle.
 *
 * Quiet hours: if the user has a configured quiet_hours_start/end, those
 * hours are in THEIR OWN timezone (set under 🤖 Automation → 🌍
 * Timezone) — converted here via lib/timezone.getHourInZone rather than
 * compared against the server's UTC clock directly, so "quiet after 10pm"
 * actually means 10pm where that person is. If the digest falls inside
 * that window, it's simply left unflushed — it stays in Redis and gets
 * picked up again on the next poll after quiet hours end, rather than
 * being flushed on time and then queued client-side (simpler, and
 * nothing is lost either way).
 */
function startWebhookDigestPoller(bot) {
  const DIGEST_POLL_INTERVAL_MS = 30 * 1000;
  async function poll() {
    try {
      const webhookDigest = require('./lib/webhookDigest');
      const users = require('./lib/users');
      const due = await webhookDigest.flushDue();
      for (const { telegramId, repo, events, eventCount, droppedCount, lockToken } of due) {
        const user = await users.getUser(telegramId).catch(() => null);
        if (require('./lib/quietHours').isQuietNow(user)) {
          // flushDue never removes the buffered events, so do NOT push them
          // back here — that would duplicate every event on every quiet-hour
          // poll. Release the claim and leave the original buffer + due
          // marker intact for the next poll after quiet hours.
          await webhookDigest.release(telegramId, repo, lockToken).catch(() => {});
          continue;
        }
        const message = webhookDigest.composeDigestMessage(repo, events, droppedCount);
        const renewEveryMs = 20 * 1000;
        let renewTimer;
        try {
          renewTimer = setInterval(() => {
            webhookDigest.renew(telegramId, repo, lockToken).catch(() => {});
          }, renewEveryMs);
          if (renewTimer.unref) renewTimer.unref();
          const buttons = await require('./lib/alertLinks').keyboard(telegramId, repo, events).catch(() => null);
          await bot.telegram.sendMessage(telegramId, message, buttons ? { ...buttons } : undefined);
          const acknowledged = await webhookDigest.ack(telegramId, repo, lockToken, eventCount, droppedCount);
          if (!acknowledged) {
            logger.warn('Digest acknowledgement lost lock — buffered events were preserved', { telegramId, repo, eventCount });
          }
        } catch (err) {
          await webhookDigest.release(telegramId, repo, lockToken).catch(() => {});
          logger.error('Digest delivery failed', { telegramId, repo, message: err.message });
        } finally {
          if (renewTimer) clearInterval(renewTimer);
        }
      }
    } catch (err) {
      logger.error('Webhook digest poll failed', { message: err.message });
    }
    setTimeout(poll, DIGEST_POLL_INTERVAL_MS).unref();
  }
  setTimeout(poll, DIGEST_POLL_INTERVAL_MS).unref();
}

/**
 * 🩺 Maintenance Mode's schedule (lib/maintenance.js) — a much finer
 * cadence than the hourly pollers below (every minute, not every hour),
 * since an "auto-ON at 02:00" schedule needs to actually fire within the
 * same minute, not up to 59 minutes late. Plain setInterval-style
 * recursion rather than the durable due-marker pattern used elsewhere in
 * this file — losing a single minute's check across a restart is
 * harmless here (the very next minute's check catches it), unlike a
 * once-a-day digest where missing the window means waiting a full day.
 */
function startMaintenanceScheduler() {
  const MINUTE_MS = 60 * 1000;
  const maintenance = require('./lib/maintenance');

  async function poll() {
    try {
      await maintenance.checkSchedule();
    } catch (err) {
      logger.error('Maintenance schedule check failed', { message: err.message });
    }
    setTimeout(poll, MINUTE_MS).unref();
  }
  setTimeout(poll, MINUTE_MS).unref();
}

/**
 * Daily/weekly rollup delivery. Checked hourly; a Redis marker
 * (not in-memory) records the last date a rollup was sent per user+period,
 * so a bot restart can't cause a duplicate send within the same day/week —
 * same reasoning as the digest poller's "durable due-marker over
 * setTimeout" choice above. Fires at 8am in each person's OWN timezone
 * (set under 🤖 Automation → 🌍 Timezone), not a single shared UTC
 * instant for everyone.
 */
function startRollupScheduler(bot) {
  const HOURLY_MS = 60 * 60 * 1000;
  const ROLLUP_HOUR_LOCAL = 8; // 8am in EACH person's own timezone — not one shared UTC instant for everyone
  const ROLLUP_LAST_HOUR_LOCAL = 20; // a held rollup is still delivered up to 8pm; after that it waits for tomorrow

  async function poll() {
    try {
      const { pool } = require('./db/postgres');
      const redisDb = require('./db/redis');
      const rollup = require('./lib/rollup');
      const timezone = require('./lib/timezone');
      const now = new Date();

      const { rows: users } = await pool.query("SELECT telegram_id, notif_rollup, timezone, quiet_hours_start, quiet_hours_end FROM users WHERE notif_rollup != 'off'");
      for (const u of users) {
        const tz = u.timezone || 'UTC';
        // Checked per-user rather than gating the whole poll on one shared
        // hour — someone in a very different zone from the server's UTC
        // clock would otherwise get "Daily rollup" in the middle of their
        // night. The hourly poll cadence still comfortably catches this
        // even for half-hour-offset zones (India, Newfoundland, etc.) —
        // the hour component is what's being matched, not the exact minute.
        // From 8am until early evening (not just the 8am hour): if Quiet Hours cover 8am the
        // rollup is HELD and goes out as soon as the window ends, the same day, instead of
        // being skipped. The per-day marker below still guarantees one send.
        const localHour = timezone.getHourInZone(now, tz);
        if (localHour < ROLLUP_HOUR_LOCAL || localHour >= ROLLUP_LAST_HOUR_LOCAL) continue;
        if (require('./lib/quietHours').isQuietNow(u, now)) continue;

        const isMonday = timezone.getWeekdayInZone(now, tz) === 1;
        if (u.notif_rollup === 'weekly' && !isMonday) continue;
        const days = u.notif_rollup === 'weekly' ? 7 : 1;
        // The dedup marker uses THIS person's own calendar date, not the
        // server's UTC date — otherwise someone near their own midnight
        // could be skipped or double-sent depending on which side of
        // UTC's midnight the server happens to be on at the time.
        const dateKey = timezone.getDateKeyInZone(now, tz);
        const marker = `rollup-sent:${u.telegram_id}:${dateKey}:${u.notif_rollup}`;
        const already = await redisDb.client.exists(marker);
        if (already) continue;

        const summary = await rollup.compose(u.telegram_id, days);
        if (summary) {
          // v1.1.23-multi: a TRANSIENT delivery failure (network, Telegram 5xx)
          // no longer burns the day's dedup marker — it stays retryable on the
          // next poll. Handled per person so one failed send can never abort
          // the loop for everyone after them. A PERMANENT failure (they
          // blocked the bot, deactivated, chat not found — 400/403) is
          // treated as done: retrying can never succeed.
          try {
            await bot.telegram.sendMessage(u.telegram_id, summary, { parse_mode: 'MarkdownV2' });
          } catch (sendErr) {
            const code = sendErr && sendErr.response && sendErr.response.error_code;
            if (code !== 400 && code !== 403) {
              logger.warn('Rollup delivery failed — will retry next poll', { telegramId: u.telegram_id, message: sendErr.message });
              continue;
            }
          }
        }
        await redisDb.client.set(marker, '1', { EX: 25 * 60 * 60 }); // outlives the check window comfortably, self-expires
      }
    } catch (err) {
      logger.error('Rollup scheduler failed', { message: err.message });
    }
    setTimeout(poll, HOURLY_MS).unref();
  }
  setTimeout(poll, HOURLY_MS).unref();
}

/**
 * 🤖 Automation's background tasks — daily log pruning, weekly auto-backup
 * runs, and weekly stale-repo nudges. Same hourly-check pattern as the
 * rollup scheduler above, offset by an hour so the two don't hit the
 * database in the same tick.
 *
 * Only the daily prune stays on a single shared UTC hour — it's pure
 * internal housekeeping (sweeping old log rows) with no user-facing
 * "time of day" meaning, nobody experiences when it runs. The weekly
 * part sends actual messages to people, so it's per-user-timezone-aware
 * instead — see runWeeklyAutomation below, which checks each candidate's
 * own local hour/weekday rather than one shared gate for everyone.
 */
function startAutomationScheduler(bot) {
  const HOURLY_MS = 60 * 60 * 1000;
  const TASK_HOUR_UTC = 9;

  async function poll() {
    try {
      const now = new Date();
      // From 09:00 UTC onward, once per UTC date (the marker below is the guard). An exact
      // "hour === 9" test let the hourly timer's drift or a restart skip the whole day.
      if (now.getUTCHours() >= TASK_HOUR_UTC) {
        const redisDb = require('./db/redis');
        const dateKey = now.toISOString().slice(0, 10);

        // Daily: prune activity_log (each person's own retention setting, see
        // dataStore.pruneAllUsersActivity) + access_log (one retention for everyone — the
        // 90-day default, which an admin can change in Global Config; it's a security log,
        // not a per-user preference) — neither table has any other reliable cleanup path.
        const pruneMarker = `automation-prune:${dateKey}`;
        if (!(await redisDb.client.exists(pruneMarker))) {
          const dataStore = require('./lib/dataStore');
          const accessLog = require('./lib/accessLog');
          const trash = require('./lib/trash');
          const prunedActivity = await dataStore.pruneAllUsersActivity();
          const prunedAccess = await accessLog.pruneOlderThan(require('./lib/globalConfig').getLogRetentionDays());
          const prunedTrash = await trash.pruneExpired();
          // v1.2.1-multi: Warden's own tables had NO retention (the hourly activity buckets alone
          // add ~24 rows per active user per day). Bounded, batched, and comfortably longer than
          // the 30-day window the baseline reads.
          const { pruneBatched } = require('./lib/retention');
          const bucketDays = Number(process.env.WARDEN_BUCKET_RETENTION_DAYS) || 90;
          const wardenLogDays = Number(process.env.WARDEN_LOG_RETENTION_DAYS) || 365;
          const prunedWarden = (await pruneBatched('warden_activity_buckets', "bucket_start < now() - ($2 || ' days')::interval", [String(bucketDays)])).deleted
            + (await pruneBatched('warden_action_log', "created_at < now() - ($2 || ' days')::interval AND action_type NOT LIKE 'release_false_restrictions%'", [String(wardenLogDays)])).deleted
            + (await pruneBatched('warden_case_events', "created_at < now() - ($2 || ' days')::interval AND case_id IN (SELECT id FROM warden_cases WHERE status <> 'open')", [String(wardenLogDays)])).deleted
            + (await pruneBatched('warden_evidence', "created_at < now() - ($2 || ' days')::interval AND case_id IN (SELECT id FROM warden_cases WHERE status <> 'open')", [String(wardenLogDays)])).deleted;
          // v1.2.5-multi: Warden Watch + change journal retention (bounded, batched like the rest).
          const prunedWatch = (await pruneBatched('manage_audit', "created_at < now() - interval '30 days'")).deleted
            + (await pruneBatched('sensitive_actions', "created_at < now() - interval '180 days'")).deleted
            + (await pruneBatched('sensitive_approvals', "created_at < now() - interval '30 days'")).deleted
            + (await pruneBatched('change_journal', "created_at < now() - interval '90 days'")).deleted
            + (await require('./lib/softDelete').purgeExpired());
          await require('./lib/sensitiveActions').prune().catch(() => {});
          // Bytes of scheduled uploads that already finished/cancelled/failed.
          const prunedScheduledBytes = await require('./lib/scheduledUploads').purgeFinishedFiles();
          logger.info('Automation: pruned old logs', { prunedActivity, prunedAccess, prunedTrash, prunedScheduledBytes, prunedWarden, prunedWatch });
          await redisDb.client.set(pruneMarker, '1', { EX: 25 * 60 * 60 });
        }
      }

      // Weekly auto-backup + stale-repo nudges — checked every hour, but
      // each candidate's own local hour/weekday decides whether THEY are
      // due this tick (see runWeeklyAutomation), not a shared UTC gate.
      await runWeeklyAutomation(bot);
    } catch (err) {
      logger.error('Automation scheduler failed', { message: err.message });
    }
    setTimeout(poll, HOURLY_MS).unref();
  }
  setTimeout(poll, HOURLY_MS).unref();
}

/** Only visits users who could actually have something to do this week —
 * at least one backup rule, or the stale nudge toggled on — rather than
 * looping every connected account regardless of whether automation is
 * configured at all. Fires at 9am on Monday in each person's OWN
 * timezone (set under 🤖 Automation → 🌍 Timezone) — checked and
 * deduped per-candidate rather than as one shared gate for everyone,
 * same reasoning as the rollup scheduler above. */
async function runWeeklyAutomation(bot) {
  const { pool } = require('./db/postgres');
  const users = require('./lib/users');
  const backupRules = require('./lib/automationBackupRules');
  const github = require('./lib/github');
  const activity = require('./lib/activity');
  const redisDb = require('./db/redis');
  const timezone = require('./lib/timezone');

  const WEEKLY_HOUR_LOCAL = 9;
  const now = new Date();

  const { rows: candidates } = await pool.query(
    `SELECT DISTINCT u.telegram_id, u.timezone, u.quiet_hours_start, u.quiet_hours_end FROM users u
     LEFT JOIN automation_backup_rules abr ON abr.telegram_id = u.telegram_id
     WHERE u.notif_stale_nudge = TRUE OR abr.id IS NOT NULL`
  );

  for (const candidate of candidates) {
    const { telegram_id: telegramId, timezone: tzRaw } = candidate;
    const tz = tzRaw || 'UTC';
    // Monday 9am in THEIR zone, delivered any time that day until 8pm: Quiet Hours that
    // cover 9am hold the run until the window ends instead of skipping the week.
    const localHour = timezone.getHourInZone(now, tz);
    if (localHour < WEEKLY_HOUR_LOCAL || localHour >= 20) continue;
    if (timezone.getWeekdayInZone(now, tz) !== 1) continue;
    if (require('./lib/quietHours').isQuietNow(candidate, now)) continue;

    // Per-candidate marker (not one shared one) — each person's own
    // calendar date decides "have I already run for them this week",
    // consistent with how the rollup scheduler dedupes.
    const dateKey = timezone.getDateKeyInZone(now, tz);
    const weekMarker = `automation-weekly:${telegramId}:${dateKey}`;
    if (await redisDb.client.exists(weekMarker)) continue;

    try {
      // v1.2.5-multi: every connected GitHub account is a source, not just the active one.
      const sources = await require('./lib/weeklyAccounts').sourcesFor(telegramId);
      if (sources.length === 0) continue;
      const multi = sources.length > 1;
      const prefs = await users.getNotificationPrefs(telegramId);
      const staleAll = [];
      let backedUp = 0;

      for (const src of sources) {
        let allRepos;
        try {
          allRepos = await src.loadRepos();
        } catch (err) {
          logger.warn('Weekly automation could not list one account', { telegramId, account: src.accountLogin, message: err.message });
          continue;
        }
        const tag = multi ? ` (@${src.accountLogin})` : '';

        // Auto-Backup
        const matches = await backupRules.matchingRepos(telegramId, allRepos);
        for (const repo of matches) {
          try {
            const zipBuffer = await github.downloadZip(src.token, src.ownerOf(repo), repo.name, repo.default_branch);
            await bot.telegram.sendDocument(
              telegramId,
              { source: zipBuffer, filename: `${repo.name}-backup-${new Date().toISOString().slice(0, 10)}.zip` },
              { caption: `💾 Weekly backup: ${repo.name}${tag}` }
            );
            backedUp++;
          } catch (err) {
            logger.error('Weekly backup failed for one repo', { telegramId, repo: repo.name, account: src.accountLogin, message: err.message });
          }
        }

        // Stale-repo nudge (collected across accounts, sent once)
        if (prefs && prefs.staleNudge) {
          const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
          for (const r of allRepos) {
            if (new Date(r.pushed_at).getTime() < cutoff) staleAll.push({ name: r.name, account: src.accountLogin });
          }
        }
      }
      if (backedUp > 0) {
        await activity.log(telegramId, '💾', `Weekly auto-backup → ${backedUp} repo(s) sent`, { isAutomated: true });
      }
      if (staleAll.length > 0) {
        const names = staleAll.slice(0, 10).map((r) => `• ${r.name}${multi ? ` (@${r.account})` : ''}`).join('\n');
        const message =
          `🗂️ Weekly nudge: ${staleAll.length} repo(s) haven't been pushed to in 90+ days:\n\n${names}` +
          `${staleAll.length > 10 ? `\n… and ${staleAll.length - 10} more` : ''}` +
          `\n\nOpen 🤖 Automation → 🗂️ Stale Repos for details.`;
        await bot.telegram.sendMessage(telegramId, message).catch(() => {});
      }
      await redisDb.client.set(weekMarker, '1', { EX: 25 * 60 * 60 });
    } catch (err) {
      logger.error('Weekly automation failed for user', { telegramId, message: err.message });
    }
  }
}

/**
 * 🩺 Account health — once a day, every person with MORE than one GitHub account has each account's token
 * probed (lib/accountHealth.js), so an extra account that was revoked on GitHub is noticed and cleaned up
 * instead of lingering until the person switches to it. One run per day across instances (lease + marker).
 */
function startAccountHealthPoller(bot) {
  const CHECK_MS = 3 * 60 * 60 * 1000;

  async function poll() {
    const lease = await require('./lib/pollerLease').acquire('account-health', 600).catch(() => null);
    if (lease) {
      try {
        const redisDb = require('./db/redis');
        const marker = `account-health:${new Date().toISOString().slice(0, 10)}`;
        if (!(await redisDb.client.exists(marker))) {
          await redisDb.client.set(marker, '1', { EX: 26 * 60 * 60 });
          const swept = await require('./lib/accountHealth').sweepAll(bot);
          if (swept) logger.info('Account health sweep finished', { people: swept });
        }
      } catch (err) {
        logger.error('Account health sweep failed', { message: err.message });
      } finally {
        await lease.release();
      }
    }
    setTimeout(poll, CHECK_MS).unref();
  }
  setTimeout(poll, 10 * 60 * 1000).unref();
}

/**
 * ☀️ Optional daily "while you were away" summary (lib/needsDigest.js). Checked every 20 minutes; the module itself
 * only sends around 8:00 on each person's own clock, outside quiet hours, once per day.
 */
function startNeedsDigestPoller(bot) {
  const CHECK_MS = 20 * 60 * 1000;
  async function poll() {
    const lease = await require('./lib/pollerLease').acquire('needs-digest', 300).catch(() => null);
    if (lease) {
      try {
        const sent = await require('./lib/needsDigest').runOnce(bot);
        if (sent) logger.info('Daily summaries sent', { count: sent });
        await require('./lib/wardenBriefing').runOnce(bot).catch(() => {});
      } catch (err) {
        logger.error('Daily summary run failed', { message: err.message });
      } finally {
        await lease.release();
      }
    }
    setTimeout(poll, CHECK_MS).unref();
  }
  setTimeout(poll, 4 * 60 * 1000).unref();
}

/**
 * 📅 Scheduled Repos — checked every minute rather than the hourly
 * fixed-UTC-hour pattern the other schedulers use, since a person picking
 * a specific time for repo creation has some reasonable expectation of
 * precision an hourly check can't give. Mirrors the exact same success
 * path as the manual Create Repo flow (scenes/createRepo.js) — same
 * README-removal behavior, same activity log shape — so a scheduled repo
 * looks no different from one created by hand once it exists.
 */
function startScheduledReposPoller(bot) {
  // 1 minute, not the original 5 — a scheduled repo showing up "eventually,
  // sometime in the next 5 minutes" reads as broken even though it isn't;
  // GitHub calls only happen when something's actually due, so the tighter
  // interval costs nothing but a cheap DB check most of the time.
  const POLL_MS = 60 * 1000;

  async function poll() {
    // One instance per tick (lib/pollerLease.js) — no double-commits when two
    // instances overlap during a deploy.
    const lease = await require('./lib/pollerLease').acquire('scheduled-repos', 120);
    if (!lease) {
      setTimeout(poll, POLL_MS).unref();
      return;
    }
    try {
      const scheduledRepos = require('./lib/scheduledRepos');
      const due = await scheduledRepos.getDue();

      for (const item of due) {
        // v1.2.1-multi: scheduled work is BACKGROUND traffic for the GitHub
        // traffic layer — it can never starve a user who is tapping buttons.
        require('./lib/requestContext').enterBackground('scheduled-repos', item.telegram_id);
        const heartbeat = setInterval(() => {
          scheduledRepos.touchProcessing(item.id).catch((err) =>
            logger.warn('Scheduled repo heartbeat failed', { id: item.id, message: err.message })
          );
        }, 60 * 1000);
        heartbeat.unref();

        try {
          const github = require('./lib/github');
          const repoCache = require('./lib/repoCache');
          const activity = require('./lib/activity');

          const jobAccount = require('./lib/jobAccount');
          const creds = await jobAccount.resolve(item);
          if (creds.gone) {
            await scheduledRepos.markFailed(item.id, `The GitHub account @${creds.accountLogin} was removed before this could run`);
            await bot.telegram.sendMessage(item.telegram_id, jobAccount.goneMessage(`Scheduled repo "${item.name}"`, creds.accountLogin)).catch(() => {});
            continue;
          }
          const token = creds.token;
          if (!token) {
            await scheduledRepos.markFailed(item.id, 'GitHub disconnected before this could run');
            await bot.telegram.sendMessage(
              item.telegram_id,
              `⚠️ Scheduled repo "${item.name}" couldn't be created — GitHub isn't connected anymore.`
            ).catch(() => {});
            continue;
          }

          let repo;
          let resumed = false;
          try {
            repo = await github.createRepo(token, {
              name: item.name,
              isPrivate: item.visibility === 'private',
              description: item.description,
              licenseTemplate: item.license,
              gitignoreTemplate: item.gitignore,
              // v1.2.5-multi: a job made under an explicit account keeps the organisation it was made for
              // (null = that account's own repos); an older row follows the active organisation as before.
              org: creds.legacy
                ? await require('./lib/accounts').getActiveOwner(item.telegram_id).catch(() => null)
                : (item.owner_login || null),
            });
          } catch (createErr) {
            // A run that was interrupted AFTER GitHub created the repo is re-claimed later and
            // would fail with "already exists" although the repo is exactly the one asked for.
            // If a repo of that name was created in the last 30 minutes, finish the job on it.
            const taken = createErr && createErr.status === 422 && /already exists|name already/i.test(String(createErr.message));
            const owner = taken ? (creds.legacy ? (await repoCache.getUser(item.telegram_id, token)).login : (item.owner_login || creds.accountLogin)) : null;
            const existing = taken ? await github.getRepo(token, owner, item.name).catch(() => null) : null;
            if (!existing || Date.now() - new Date(existing.created_at).getTime() > 30 * 60 * 1000) throw createErr;
            repo = existing;
            resumed = true;
          }
          repoCache.invalidateRepos(item.telegram_id);

          if (!item.include_readme) {
            try {
              const existing = await github.getFileContent(token, repo.owner.login, repo.name, 'README.md');
              await github.deleteFile(token, repo.owner.login, repo.name, 'README.md', existing.sha, 'Remove default README');
            } catch (_) { /* best-effort, same as the manual flow */ }
          }

          if (item.template) {
            try {
              const repoTemplates = require('./lib/repoTemplates');
              const templateFiles = repoTemplates.getTemplateFiles(item.template, repo.name);
              // On a resumed run, don't commit the template a second time if it already landed.
              const alreadyHasFiles = resumed && (await github.getTree(token, repo.owner.login, repo.name).catch(() => [])).some((f) => !/^readme(\.md)?$/i.test(f.path));
              if (templateFiles && !alreadyHasFiles) {
                await github.commitMultipleFiles(token, repo.owner.login, repo.name, templateFiles, `Initial commit from ${item.template} template`);
              }
            } catch (err) {
              logger.warn('Scheduled repo template commit failed', {
                telegramId: item.telegram_id, name: item.name, message: err.message,
              });
            }
          }

          await scheduledRepos.markCompleted(item.id);
          await activity.log(item.telegram_id, '📅', `Scheduled repo created → ${repo.name}`, {
            detail: `visibility:${item.visibility}`, isAutomated: true,
          });
          await bot.telegram.sendMessage(
            item.telegram_id,
            `✅ Scheduled repo created: ${repo.name}${resumed ? ' (finished after an interrupted earlier attempt)' : ''}\n🔗 ${repo.html_url}`
          ).catch(() => {});
        } catch (err) {
          await scheduledRepos.markFailed(item.id, err.message);
          logger.error('Scheduled repo creation failed', {
            telegramId: item.telegram_id, name: item.name, message: err.message,
          });
          const errorHelpers = require('./lib/errorHelpers');
          const reason = errorHelpers.isNameCollisionError(err)
            ? `"${item.name}" already exists on your account`
            : errorHelpers.describeForUser(err);
          if (await require('./lib/revokedToken').handleBackgroundAuthFailure(bot, item.telegram_id, err)) continue;
          await bot.telegram.sendMessage(
            item.telegram_id,
            `⚠️ Scheduled repo "${item.name}" failed to create: ${reason}`
          ).catch(() => {});
        } finally {
          clearInterval(heartbeat);
        }
      }
    } catch (err) {
      logger.error('Scheduled commits poller failed', { message: err.message });
    } finally {
      await lease.release();
    }
    setTimeout(poll, POLL_MS).unref();
  }
  setTimeout(poll, POLL_MS).unref();
}

/**
 * 📤 Scheduled Uploads — same cadence and shape as 🆕 Scheduled Repos'
 * poller above, deliberately kept as its own separate loop (not merged
 * into one "check both tables" poller) since the two features have
 * different failure modes and error messages; keeping them apart makes
 * each easier to reason about on its own.
 */
function startScheduledUploadsPoller(bot) {
  const POLL_MS = 60 * 1000;

  async function poll() {
    // One instance per tick (lib/pollerLease.js) — no double-commits when two
    // instances overlap during a deploy.
    const lease = await require('./lib/pollerLease').acquire('scheduled-uploads', 120);
    if (!lease) {
      setTimeout(poll, POLL_MS).unref();
      return;
    }
    try {
      const scheduledUploads = require('./lib/scheduledUploads');
      const due = await scheduledUploads.getDue();

      for (const item of due) {
        // v1.2.1-multi: scheduled work is BACKGROUND traffic for the GitHub
        // traffic layer — it can never starve a user who is tapping buttons.
        require('./lib/requestContext').enterBackground('scheduled-uploads', item.telegram_id);
        const heartbeat = setInterval(() => {
          scheduledUploads.touchProcessing(item.id).catch((err) =>
            logger.warn('Scheduled upload heartbeat failed', { id: item.id, message: err.message })
          );
        }, 60 * 1000);
        heartbeat.unref();

        try {
          const github = require('./lib/github');
          const repoCache = require('./lib/repoCache');
          const activity = require('./lib/activity');

          const jobAccount = require('./lib/jobAccount');
          const creds = await jobAccount.resolve(item);
          const token = creds.token;
          const isMultiFile = item.file_count > 1;
          const label = isMultiFile ? `${item.file_count} files` : `"${item.file_name}"`;

          if (creds.gone) {
            await scheduledUploads.markFailed(item.id, `The GitHub account @${creds.accountLogin} was removed before this could run`);
            await bot.telegram.sendMessage(item.telegram_id, jobAccount.goneMessage(`Scheduled upload ${label}`, creds.accountLogin)).catch(() => {});
            continue;
          }
          if (!token) {
            await scheduledUploads.markFailed(item.id, 'GitHub disconnected before this could run');
            await bot.telegram.sendMessage(
              item.telegram_id,
              `⚠️ Scheduled upload ${label} couldn't be committed — GitHub isn't connected anymore.`
            ).catch(() => {});
            continue;
          }

          let filesToCommit;
          if (isMultiFile) {
            // 📦 Multi-file (extracted archive) schedule — every file's
            // bytes were already captured and stored durably at
            // schedule-creation time (see scenes/uploadFile.js's
            // finalizeUploadSchedule), so this reads them straight back
            // rather than re-downloading and re-extracting the original
            // archive from Telegram again.
            const rows = await scheduledUploads.getFiles(item.id);
            filesToCommit = rows.map((r) => ({ path: r.path, content: r.content }));
          } else {
            // Re-downloaded from Telegram fresh, not read from any local
            // cache — a schedule can fire hours or days after it was
            // set, long past any reasonable in-memory buffer TTL.
            const fileLink = await bot.telegram.getFileLink(item.file_id);
            const res = await fetch(fileLink.href, { signal: AbortSignal.timeout(20000) });
            if (!res.ok) throw new Error(`Telegram returned HTTP ${res.status} while downloading the scheduled file`);
            const buffer = Buffer.from(await res.arrayBuffer());
            filesToCommit = [{ path: item.target_path || item.file_name, content: buffer }];
          }

          const ownerLogin = creds.legacy ? (await repoCache.getUser(item.telegram_id, token)).login : creds.owner;
          await github.commitMultipleFiles(
            token,
            ownerLogin,
            item.repo_name,
            filesToCommit,
            item.commit_message || 'Update via GitroHub',
            []
          );
          repoCache.invalidateRepos(item.telegram_id);
          repoCache.invalidateLanguages(item.telegram_id, item.repo_name);
          repoCache.invalidateTreeStats(item.telegram_id, item.repo_name);

          await scheduledUploads.markCompleted(item.id);
          await activity.log(item.telegram_id, '📤', `Scheduled upload committed → ${item.repo_name}`, {
            detail: isMultiFile ? `${item.file_count} files` : (item.target_path || item.file_name),
            isAutomated: true, isCommit: true,
          });
          await bot.telegram.sendMessage(
            item.telegram_id,
            `✅ Scheduled upload committed: ${isMultiFile ? label : `"${item.target_path || item.file_name}"`} → ${item.repo_name}`
          ).catch(() => {});
        } catch (err) {
          await scheduledUploads.markFailed(item.id, err.message);
          logger.error('Scheduled upload commit failed', {
            telegramId: item.telegram_id, repo: item.repo_name, message: err.message,
          });
          if (await require('./lib/revokedToken').handleBackgroundAuthFailure(bot, item.telegram_id, err)) continue;
          await bot.telegram.sendMessage(
            item.telegram_id,
            `⚠️ Scheduled upload "${item.file_count > 1 ? `${item.file_count} files` : item.file_name}" failed to commit to ${item.repo_name}: ${require('./lib/errorHelpers').describeForUser(err)}`
          ).catch(() => {});
        } finally {
          clearInterval(heartbeat);
        }
      }
    } catch (err) {
      logger.error('Scheduled uploads poller failed', { message: err.message });
    } finally {
      await lease.release();
    }
    setTimeout(poll, POLL_MS).unref();
  }
  setTimeout(poll, POLL_MS).unref();
}

/**
 * 📢 Scheduled Broadcasts — same 60s poll cadence as Scheduled Repos/
 * Uploads above, for the same reason (a schedule implies real timing
 * precision, not "eventually"). Reuses adminActions.broadcast() itself
 * rather than re-implementing the send loop, so a scheduled broadcast
 * and an immediate one go out through EXACTLY the same code path —
 * handlers/admin.js's executeBroadcast does the equivalent inline for
 * "Send Now," this poller is just the deferred half of the same flow.
 *
 * v1.1.23-multi: rows are CLAIMED (pending → processing) by getDue() so a
 * row can only ever be picked up once; a heartbeat keeps a long send from
 * looking stale, and rows abandoned by a crash are re-claimed after 10 min.
 */
function startScheduledBroadcastsPoller(bot) {
  const POLL_MS = 60 * 1000;

  async function poll() {
    // One instance per tick (lib/pollerLease.js) — no double-commits when two
    // instances overlap during a deploy.
    const lease = await require('./lib/pollerLease').acquire('scheduled-broadcasts', 120);
    if (!lease) {
      setTimeout(poll, POLL_MS).unref();
      return;
    }
    try {
      const scheduledBroadcasts = require('./lib/scheduledBroadcasts');
      const adminActions = require('./lib/adminActions');
      const due = await scheduledBroadcasts.getDue();

      for (const item of due) {
        const heartbeat = setInterval(() => {
          scheduledBroadcasts.touchProcessing(item.id).catch((err) =>
            logger.warn('Scheduled broadcast heartbeat failed', { id: item.id, message: err.message })
          );
        }, 60 * 1000);
        heartbeat.unref();

        try {
          const entities = item.entities ? JSON.parse(item.entities) : null;
          const { sent, total } = await adminActions.broadcast(item.admin_id, bot, item.text, entities);
          await scheduledBroadcasts.markSent(item.id, sent, total);
          if (item.admin_id) {
            await bot.telegram.sendMessage(
              item.admin_id,
              `✅ Scheduled broadcast delivered to ${sent}/${total} recipients.`
            ).catch(() => {});
          }
        } catch (err) {
          await scheduledBroadcasts.markFailed(item.id, err.message);
          logger.error('Scheduled broadcast failed', {
            id: item.id, adminId: item.admin_id, message: err.message,
          });
          if (item.admin_id) {
            await bot.telegram.sendMessage(
              item.admin_id,
              `⚠️ A scheduled broadcast failed to send: ${err.message}`
            ).catch(() => {});
          }
        } finally {
          clearInterval(heartbeat);
        }
      }
    } catch (err) {
      logger.error('Scheduled broadcasts poller failed', { message: err.message });
    } finally {
      await lease.release();
    }
    setTimeout(poll, POLL_MS).unref();
  }
  setTimeout(poll, POLL_MS).unref();
}

/**
 * Process-level safety net. An uncaught exception leaves Node in an
 * undefined state — best practice is to log it clearly and exit via the
 * same clean shutdown path. Unhandled promise rejections are logged but
 * don't trigger a restart on their own — most are already recoverable
 * errors caught one level up (e.g. bot.catch).
 */
function installCrashHandlers() {
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — shutting down', { message: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: reason && reason.message ? reason.message : String(reason) });
  });
}

async function main() {
  installCrashHandlers();
  // v1.2.1-multi: event-loop lag / CPU / memory / pool sampling (observe-only, timers unref'd).
  require('./lib/runtimeMetrics').start();

  logger.info('Running database migrations...');
  await migrate();

  // 👑 Idempotent — fills in admin_roles rows for anyone in ADMIN_IDS who
  // doesn't have one yet (ON CONFLICT DO NOTHING), so this is safe to run
  // on every boot. See lib/roles.js's seedFromConfig for why this is what
  // makes the roles system a no-op upgrade for an existing deployment.
  logger.info('Seeding admin roles...');
  await require('./lib/roles').seedFromConfig();

  logger.info('Connecting to Redis...');
  await redisDb.connect();

  logger.info('Starting Telegram bot...');
  bot = createBot();

  // Kept short — Telegram's own command list UI is a compact popup, long
  // descriptions get truncated or crowd out the command names.
  await bot.telegram.setMyCommands([
    { command: 'start', description: '🏠 Main menu' },
    // /repos and /new still work when typed (see bot.js) but are deliberately NOT listed here:
    // the Main Menu buttons already cover them. This call replaces Telegram's stored command
    // list, so they disappear from the "/" menu on the next boot.
    // /settings still works when typed (v1.3.0-multi) but is no longer listed: Settings lives inside 💼 Workspace.
    { command: 'report', description: '🚩 Report a problem to admins' },
    { command: 'help', description: '❓ Features, FAQ & contact' },
    { command: 'legal', description: '📜 Terms, privacy & more' },
    { command: 'cancel', description: '❌ Cancel & return to menu' },
  ]);
  // v2.1.3: admins also get /admin in their own "/" menu (chat-scoped, so nobody else sees it). Never blocks boot.
  require('./lib/adminCommands').syncAll(bot.telegram).catch(() => {});

  logger.info('Starting web server (OAuth callback + health check)...');
  const app = createApp(bot);

  const useWebhook = process.env.NODE_ENV === 'production';

  if (useWebhook) {
    botMode = 'webhook';
    const webhookPath = '/telegram-webhook';
    app.use(bot.webhookCallback(webhookPath, { secretToken: config.TELEGRAM_WEBHOOK_SECRET }));
    httpServer = app.listen(config.PORT, async () => {
      logger.info('Server listening', { port: config.PORT });

      // Log how many updates were actually pending before discarding them —
      // turns "I think there's a backlog" into hard evidence in the logs.
      try {
        const info = await bot.telegram.getWebhookInfo();
        if (info.pending_update_count > 0) {
          logger.warn('Discarding pending update backlog on startup', { count: info.pending_update_count });
        }
      } catch (err) {
        logger.error('Could not check webhook backlog before clearing', { message: err.message });
      }

      // drop_pending_updates: without this, any updates that queued up on
      // Telegram's side while the bot was down all got delivered in a burst
      // the instant the webhook came back — each spinning up its own DB/
      // GitHub work roughly at once. Every boot now starts genuinely clean
      // instead of inheriting whatever piled up during any downtime.
      await bot.telegram.setWebhook(`${config.BASE_URL}${webhookPath}`, {
        secret_token: config.TELEGRAM_WEBHOOK_SECRET,
        drop_pending_updates: true,
      });
      logger.info('Telegram webhook set', { url: `${config.BASE_URL}${webhookPath}` });
    });
  } else {
    botMode = 'polling';
    httpServer = app.listen(config.PORT, () => {
      logger.info('Server listening (OAuth callback + health check)', { port: config.PORT });
    });
    await bot.launch({ dropPendingUpdates: true });
    logger.info('Bot running in polling mode (development)');
  }

  startMemoryWatchdog();
  require('./lib/uploadProgress').startSweeper(bot); // v2.3.3: reports uploads cut off by a restart instead of leaving "Committing…" forever
  startWebhookDigestPoller(bot);
  startRollupScheduler(bot);
  startAutomationScheduler(bot);
  startMaintenanceScheduler();
  startScheduledReposPoller(bot);
  startScheduledUploadsPoller(bot);
  startScheduledBroadcastsPoller(bot);
  startAccountHealthPoller(bot);
  startNeedsDigestPoller(bot);
  require('./lib/globalConfig').startRefreshLoop();
  // v1.1.8 — Warden poller. Same lease/single-instance guarantees as
  // every other poller above. Starts with a deliberate 90s delay so its
  // first tick never competes with the startup health check.
  // v1.1.24 — lift restrictions Warden applied under its old, over-eager
  // rules (once, guarded by a marker row). Runs before the first Warden tick
  // so it can't immediately re-apply anything.
  await require('./lib/wardenRecovery').releaseFalseRestrictions(bot)
    .then((r) => { if (!r.skipped) logger.info({ released: r.released }, 'Warden: lifted false restrictions'); })
    .catch((err) => logger.warn({ err }, 'Warden: false-restriction recovery failed (will retry next boot)'));
  require('./lib/pollers/warden').start(bot, config);

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// Guarded so requiring this file (e.g. from tooling — smoke-test.js walks
// every file in src/ to catch require-time errors) never has the side
// effect of actually starting the bot. Only running it directly
// (`node src/index.js`, which is what `npm start` does) triggers main().
if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal startup error', { message: err.message, stack: err.stack });
    process.exit(1);
  });
}
