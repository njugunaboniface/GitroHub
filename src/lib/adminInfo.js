const config = require('../config');
const logger = require('./logger');

/**
 * v1.3.0-multi — /help → 📞 Contact Admin needs to show a real, current
 * @username, not a hardcoded one baked in at deploy time (which silently
 * goes stale the moment an admin changes their Telegram username). The
 * bot already has everything it needs for this: config.ADMIN_IDS plus
 * Telegram's own getChat() call. Cached for an hour, since a username
 * lookup on every single /help tap would be a wasted API call almost
 * every time — usernames don't change often enough to justify that.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache = { usernames: null, fetchedAt: 0 };

/** Returns an array of "@username" (or "admin #12345" if that admin has
 * no public username / the lookup fails) for every configured admin. */
async function getAdminContacts(telegram) {
  if (cache.usernames && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.usernames;
  }
  const usernames = await Promise.all(
    config.ADMIN_IDS.map(async (id) => {
      try {
        const chat = await telegram.getChat(id);
        return chat.username ? `@${chat.username}` : `admin #${id}`;
      } catch (err) {
        logger.warn('Could not look up admin username for /help', { adminId: id, message: err.message });
        return `admin #${id}`;
      }
    })
  );
  cache = { usernames, fetchedAt: Date.now() };
  return usernames;
}

module.exports = { getAdminContacts };
