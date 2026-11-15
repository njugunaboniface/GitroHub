/**
 * Guard used at the top of every handler that touches GitHub.
 * Returns the decrypted token if connected, otherwise sends the shared
 * connect prompt (which also resets BBTB to the disconnected-state bar,
 * so stale buttons from before a disconnect stop offering dead actions)
 * and returns null so the caller can bail out.
 *
 * Fetches the user row once — a single getUser() call rather than an
 * isConnected() + getDecryptedToken() pair that would each independently
 * call getUser() and cost two full Postgres queries where one suffices.
 * This function is called at the top of nearly every gated handler in the
 * bot, so keeping it to one query matters even though each query is cheap.
 */
async function requireConnected(ctx) {
  const telegramId = ctx.from.id;
  const users = require('./users');
  const user = await users.getUser(telegramId);
  const connected = !!(user && user.github_token_enc && !user.disconnected_at);

  if (!connected) {
    // Lazy require to avoid a circular dependency with handlers/start.js
    const { sendConnectPrompt } = require('../handlers/start');
    await sendConnectPrompt(ctx, {
      intro: '🔒 You need to connect your GitHub account first.',
    });
    return null;
  }

  const { tryDecrypt } = require('./crypto');
  const token = tryDecrypt(user.github_token_enc);
  if (!token) {
    // The saved token exists but can't be opened (the server's encryption key
    // changed, or the row is damaged). Treat it exactly like a disconnect:
    // offer the connect prompt so a fresh OAuth login replaces it.
    const logger = require('./logger');
    logger.warn('Stored GitHub token could not be decrypted — prompting reconnect', { telegramId });
    const { sendConnectPrompt } = require('../handlers/start');
    await sendConnectPrompt(ctx, {
      intro: '🔑 Your saved GitHub connection can\u2019t be read any more — please reconnect.',
    });
    return null;
  }
  return token;
}

module.exports = requireConnected;
