/**
 * Token health for EVERY connected GitHub account (v1.2.5-multi).
 *
 * The revoked-token handling (lib/revokedToken.js) only ever looks at the ACTIVE account, because that is
 * the only token a live request uses. An extra account whose token was revoked therefore stayed listed as
 * connected until the person switched to it and hit "Bad credentials". This sweep probes each account:
 *
 *   • 'ok'      — GitHub accepted the token
 *   • 'revoked' — a clear 401. An EXTRA account is removed and the person told; the ACTIVE account goes
 *                 through the normal disconnect-and-reconnect flow (another account takes over if there is one)
 *   • 'unknown' — GitHub didn't answer clearly (timeout, 5xx): nothing is changed, so a GitHub hiccup can
 *                 never remove anyone
 *
 * Results are stored (github_accounts.health_*) so admins and the Accounts screen can show them.
 */
const accounts = require('./accounts');
const revokedToken = require('./revokedToken');
const logger = require('./logger');

const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Probes every account of one person. Returns { checked, ok, revoked: [logins removed], unknown: [logins],
 * activeRevoked: bool }. `bot` (optional) is used to tell the person about an extra account that was removed.
 */
async function sweepUser(telegramId, { bot = null, probe = revokedToken.probeToken } = {}) {
  const result = { checked: 0, ok: 0, revoked: [], unknown: [], activeRevoked: false, switchedTo: null };
  const list = await accounts.listWithTokens(telegramId).catch(() => []);
  const activeLogin = await accounts.activeLoginOf(telegramId).catch(() => null);

  for (const acc of list) {
    result.checked++;
    const verdict = await probe(acc.token);
    if (verdict === 'valid') {
      result.ok++;
      await accounts.setHealth(telegramId, acc.login, 'ok').catch(() => {});
    } else if (verdict === 'revoked') {
      if (same(acc.login, activeLogin)) {
        // The active account has a full, well-tested path: disconnect (switching to another account when
        // there is one) and, for a chat, the reconnect prompt. Here we only do the data part.
        result.activeRevoked = true;
        const out = await revokedToken.disconnectIfRevoked(telegramId, { status: 401, message: 'Bad credentials' });
        if (out && out.switchedTo) result.switchedTo = out.switchedTo;
        result.revoked.push(acc.login);
      } else {
        const { removeDeadAccount } = require('./connectionTeardown');
        await removeDeadAccount(telegramId, acc.login, acc.token);
        result.revoked.push(acc.login);
        try { await require('./accessLog').record(telegramId, 'token_rejected', `Extra account @${acc.login} was revoked on GitHub — removed automatically`); } catch (_) { /* best-effort */ }
        try { await require('./activity').log(telegramId, '🔌', `GitHub access for @${acc.login} was revoked — account removed automatically`, { isAutomated: true }); } catch (_) { /* best-effort */ }
      }
    } else {
      result.unknown.push(acc.login);
      await accounts.setHealth(telegramId, acc.login, 'unknown').catch(() => {});
    }
  }

  if (bot && result.activeRevoked) {
    try {
      if (result.switchedTo) {
        await bot.telegram.sendMessage(telegramId, `🔌 GitHub access for your active account was removed on GitHub, so I switched you to @${result.switchedTo}.`);
      } else {
        const inline = require('../keyboards/inline');
        const url = await require('./oauth').connectUrl(telegramId);
        await bot.telegram.sendMessage(telegramId, '🔌 GitHub access was removed (revoked on GitHub), so I disconnected this account. Connect again to continue.', inline.connectButton(url));
      }
    } catch (_) { /* the person may have blocked the bot */ }
  }
  if (bot && result.revoked.length) {
    const extras = result.revoked.filter((l) => !same(l, activeLogin));
    if (extras.length) {
      const names = extras.map((l) => `@${l}`).join(', ');
      await bot.telegram.sendMessage(
        telegramId,
        `🔌 GitHub access for ${names} was removed on GitHub, so I disconnected ${extras.length > 1 ? 'those accounts' : 'that account'} here too. ` +
        `Your other accounts are unaffected. You can connect ${extras.length > 1 ? 'them' : 'it'} again any time from 💼 Workspace → Accounts.`
      ).catch(() => {});
    }
  }
  return result;
}

/** Daily sweep: only people with MORE than one account (a single account is covered by normal use). */
async function sweepAll(bot, { limit = 500, probe } = {}) {
  const { pool } = require('../db/postgres');
  const { rows } = await pool.query(
    `SELECT telegram_id FROM github_accounts GROUP BY telegram_id HAVING COUNT(*) > 1 ORDER BY telegram_id LIMIT $1`,
    [limit]
  );
  let swept = 0;
  for (const r of rows) {
    try {
      await sweepUser(Number(r.telegram_id), { bot, probe });
      swept++;
    } catch (err) {
      logger.warn('Account health sweep failed for one user', { telegramId: r.telegram_id, message: err && err.message });
    }
  }
  return swept;
}

module.exports = { sweepUser, sweepAll };
