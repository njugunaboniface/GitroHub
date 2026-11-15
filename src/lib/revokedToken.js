/**
 * Revoked-token handling (v1.2.4-multi).
 *
 * When someone revokes GitroHub on GitHub (Settings → Applications), the
 * token we stored keeps "working" locally but every GitHub call fails with
 * 401 "Bad credentials". Before this module that surfaced as a raw
 * "⚠️ Something went wrong: Bad credentials" and the person stayed
 * "connected" forever. Now, whenever a 401 reaches us we:
 *
 *   1. PROBE — one cheap GET /user with the stored token. Only a clear 401
 *      counts as revoked; a 200 means the token is fine (the 401 was a
 *      fluke) and a timeout/5xx means "can't tell" — in both cases nobody
 *      is disconnected, so a GitHub hiccup can never log anyone out.
 *   2. DISCONNECT — run the shared teardown in `tokenDead` mode (local
 *      cleanup only: GitHub calls would just fail again).
 *   3. RECONNECT — send the standard "connect your GitHub" prompt with the
 *      disconnected keyboard, exactly like a fresh /start.
 *
 * One in-flight check per person: ten failing taps at once cause one probe
 * and one prompt, not ten.
 */
const users = require('./users');
const logger = require('./logger');

const PROBE_TIMEOUT_MS = 8000;
const inFlight = new Map(); // telegramId -> Promise<result>

/** 'revoked' | 'valid' | 'unknown' */
async function probeToken(token) {
  try {
    const res = await fetch('https://api.github.com/user', {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitroHub',
      },
    });
    if (res.status === 401) return 'revoked';
    if (res.ok) return 'valid';
    return 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

async function _check(telegramId) {
  const token = await users.getDecryptedToken(telegramId).catch(() => null);
  if (!token) {
    // Already disconnected (e.g. by a parallel request): nothing to tear
    // down, but the person still needs the connect flow.
    const connected = await users.isConnected(telegramId).catch(() => true);
    return connected ? { revoked: false, probe: 'no-token' } : { revoked: true, alreadyDisconnected: true, probe: 'no-token' };
  }

  const probe = await probeToken(token);
  if (probe !== 'revoked') return { revoked: false, probe };

  const { teardownGithubConnection } = require('./connectionTeardown');
  const teardown = await teardownGithubConnection(telegramId, { tokenDead: true });
  try { require('./repoCache').invalidateUser(telegramId); } catch (_) { /* cache only */ }
  try {
    // 'token_rejected' (not 'disconnected'): accessLog's anomaly rule flags a
    // reconnect right after a 'disconnected' event, which would wrongly mark
    // this person's perfectly normal re-authorisation as suspicious.
    await require('./accessLog').record(telegramId, 'token_rejected', 'GitHub access was revoked on GitHub — automatically disconnected');
  } catch (_) { /* best-effort */ }
  try {
    await require('./activity').log(telegramId, '🔌', 'GitHub access revoked on GitHub — disconnected automatically', { isAutomated: true });
  } catch (_) { /* best-effort */ }
  logger.info('Revoked GitHub token detected — connection ended', { telegramId, switchedTo: teardown.switchedTo || null });
  return { revoked: true, probe, switchedTo: teardown.switchedTo || null, removedLogin: teardown.removedLogin || null };
}

/**
 * If `err` is a 401 and the token is confirmed dead, disconnect the person
 * locally. Safe to call with ANY error: non-auth errors return
 * { revoked:false } without touching anything. Never throws.
 */
async function disconnectIfRevoked(telegramId, err) {
  try {
    if (!require('./errorHelpers').isAuthError(err)) return { revoked: false, probe: 'not-auth' };
    if (inFlight.has(telegramId)) return await inFlight.get(telegramId);
    const work = _check(telegramId);
    inFlight.set(telegramId, work);
    try { return await work; } finally { inFlight.delete(telegramId); }
  } catch (e) {
    logger.warn('Revoked-token check failed', { telegramId, message: e && e.message });
    return { revoked: false, probe: 'error' };
  }
}

/** Drops any half-finished wizard/typing state so the first thing the person
 * does after reconnecting isn't answering a prompt from before. */
async function resetConversationState(ctx) {
  try { if (ctx.scene && typeof ctx.scene.leave === 'function') await ctx.scene.leave(); } catch (_) { /* nothing to leave */ }
  if (ctx.session) {
    for (const key of ['awaitingSearch', 'awaitingPublicRepo', 'awaitingFileSearch', 'adminZone']) {
      if (key in ctx.session) ctx.session[key] = false;
    }
  }
}

/**
 * For a live chat: returns true when the person was found revoked, has been
 * disconnected, and has been sent the connect prompt (caller should stop).
 * Returns false when nothing was done (caller shows its normal error).
 */
async function handleAuthFailure(ctx, err) {
  if (!ctx || !ctx.from) return false;
  const result = await disconnectIfRevoked(ctx.from.id, err);
  if (!result.revoked) return false;
  await resetConversationState(ctx);
  // v1.2.4-multi: another connected account takes over — no need to reconnect.
  if (result.switchedTo) {
    try {
      await ctx.reply(
        `🔌 GitHub access for @${result.removedLogin || 'that account'} was removed (revoked on GitHub), so I switched you to @${result.switchedTo}.`
      );
    } catch (e) {
      logger.warn('Could not announce account switch', { telegramId: ctx.from.id, message: e && e.message });
    }
    return true;
  }
  try {
    const { sendConnectPrompt } = require('../handlers/start');
    await sendConnectPrompt(ctx, {
      intro: '🔌 GitHub access was removed (you revoked GitroHub on GitHub, or the login expired), so I disconnected this account. Connect again to keep going.',
    });
  } catch (e) {
    logger.warn('Could not send reconnect prompt', { telegramId: ctx.from.id, message: e && e.message });
  }
  return true;
}

/** For background jobs (no chat): disconnect if revoked and tell the person
 * once, with the reconnect button. Returns true when it handled the error. */
async function handleBackgroundAuthFailure(bot, telegramId, err) {
  const result = await disconnectIfRevoked(telegramId, err);
  if (!result.revoked) return false;
  if (result.switchedTo) {
    try {
      await bot.telegram.sendMessage(telegramId, `🔌 GitHub access for @${result.removedLogin || 'one account'} was removed (revoked on GitHub), so I switched you to @${result.switchedTo} and skipped a scheduled task.`);
    } catch (_) { /* person may have blocked the bot */ }
  } else if (!result.alreadyDisconnected) {
    try {
      const inline = require('../keyboards/inline');
      const url = await require('./oauth').connectUrl(telegramId);
      await bot.telegram.sendMessage(
        telegramId,
        '🔌 GitHub access was removed (you revoked GitroHub on GitHub), so I disconnected this account and skipped a scheduled task. Connect again to continue.',
        inline.connectButton(url)
      );
    } catch (_) { /* person may have blocked the bot */ }
  }
  return true;
}

module.exports = { probeToken, disconnectIfRevoked, handleAuthFailure, handleBackgroundAuthFailure, resetConversationState };
