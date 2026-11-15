/**
 * Admin-only entries in Telegram's "/" menu (v2.1.3-multi).
 *
 * The default command list (index.js) is the same for everyone. Admins additionally get /admin, set per chat with
 * Telegram's chat-scoped command lists, so nobody else ever sees it in their menu. Best-effort everywhere: a failed
 * call must never break a role change or a boot.
 */
const BASE = [
  { command: 'start', description: '🏠 Main menu' },
  { command: 'report', description: '🚩 Report a problem to admins' },
  { command: 'help', description: '❓ Features, FAQ & contact' },
  { command: 'legal', description: '📜 Terms, privacy & more' },
  { command: 'cancel', description: '❌ Cancel & return to menu' },
];
// /start stays first; /admin goes right under it, then the rest.
const ADMIN = [BASE[0], { command: 'admin', description: '🛡️ Admin dashboard' }, ...BASE.slice(1)];

/** Gives this person the admin menu, or takes it away again (their menu then falls back to the default list). */
// The owner's menu also lists /owner (the web panel link), right under /admin.
const OWNER = [BASE[0], { command: 'admin', description: '🛡️ Admin dashboard' }, { command: 'owner', description: '🌐 Owner web panel' }, ...BASE.slice(1)];

async function syncFor(telegram, telegramId, isAdmin) {
  const scope = { type: 'chat', chat_id: Number(telegramId) };
  const isOwner = require('./roles').isOwner(telegramId);
  try {
    if (isAdmin || isOwner) await telegram.setMyCommands(isOwner ? OWNER : ADMIN, { scope });
    else await telegram.deleteMyCommands({ scope });
    return true;
  } catch (_) {
    return false;
  }
}

/** At boot: everyone who currently holds any admin role gets /admin in their menu. */
async function syncAll(telegram) {
  try {
    const admins = await require('./roles').listAdmins();
    let n = 0;
    const ids = new Set(admins.map((a) => Number(a.telegram_id)));
    const ownerId = Number(require('../config').OWNER_ID);
    if (ownerId) ids.add(ownerId); // the owner always gets the menu, even if they hold no admin_roles row
    for (const id of ids) if (await syncFor(telegram, id, true)) n++;
    return n;
  } catch (_) {
    return 0;
  }
}

module.exports = { BASE, ADMIN, OWNER, syncFor, syncAll };
