/**
 * Which OWNER a person's saved data currently belongs to (v1.2.5-multi).
 *
 * Pins, tag assignments and trash entries used to be keyed by repo name alone, so a same-named repo
 * under another account (or under an organisation) shared them. They now carry an `owner_login` and
 * every read/write goes through this module for "the owner the person is looking at right now":
 * the active organisation if one is selected, otherwise the active account's own login.
 *
 *   • Always returned lower-case (GitHub logins are case-insensitive) — null when not connected.
 *   • Rows written before 1.2.5 have a NULL owner and stay visible under every owner (see
 *     db/schema.sql), so nothing existing changes until something claims it.
 *
 * Kept tiny and dependency-light (accounts.js only) so any lib module can use it without a cycle.
 */
const accounts = require('./accounts');
const { BoundedMap } = require('./boundedMap');

const TTL_MS = 20 * 1000;
const cache = new BoundedMap({ max: 5000, name: 'ownerScope' }); // telegramId -> { owner, at }

async function current(telegramId) {
  const hit = cache.get(telegramId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.owner;
  let owner = null;
  try {
    const [org, login] = await Promise.all([accounts.getActiveOwner(telegramId), accounts.activeLoginOf(telegramId)]);
    owner = String(org || login || '').toLowerCase() || null;
  } catch (_) {
    owner = null; // scope is a convenience — never let a lookup failure break a screen
  }
  cache.set(telegramId, { owner, at: Date.now() });
  return owner;
}

/** { owner, account } — the owner being looked at AND the GitHub account whose token acts (both may be null). */
async function scope(telegramId) {
  const [owner, account] = await Promise.all([current(telegramId), accounts.activeLoginOf(telegramId).catch(() => null)]);
  return { owner: owner || null, account: account || null };
}

const labelCache = new BoundedMap({ max: 5000, name: 'accountLabel' }); // telegramId -> { text, at }

/**
 * "@login" (or "@org · via @login") when the person has MORE than one GitHub account, otherwise ''.
 * Shown as a footer on Manage / Workspace screens so nobody acts on account B thinking it is account A.
 */
async function label(telegramId) {
  const hit = labelCache.get(telegramId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  let text = '';
  try {
    const list = await accounts.list(telegramId);
    if (list.length > 1) {
      const active = list.find((a) => a.active);
      const org = await accounts.getActiveOwner(telegramId);
      if (active) text = org ? `@${org} · via @${active.login}` : `@${active.login}`;
    }
  } catch (_) {
    text = '';
  }
  labelCache.set(telegramId, { text, at: Date.now() });
  return text;
}

function forget(telegramId) { cache.delete(telegramId); labelCache.delete(telegramId); }

/** SQL fragment: rows visible under `$n` (the owner). Bind the owner (lower-case or null) to `$n`. */
function visibleSql(column, n) {
  return `(${column} IS NULL OR $${n}::text IS NULL OR LOWER(${column}) = $${n}::text)`;
}

module.exports = { current, scope, label, forget, visibleSql };
