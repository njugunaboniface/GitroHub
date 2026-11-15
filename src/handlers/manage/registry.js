/**
 * Registry of feature areas (v1.2.4-multi). Each area (Pull Requests, Gists, …)
 * registers itself once; the ⚡ Manage hub (per repo) and 💼 Workspace
 * (account-level) are built from whatever is registered, so a screen can never
 * show a button that leads nowhere, and adding an area never means editing the
 * hub or the callback router.
 *
 * An area is:
 *   key      lowercase id, also the feature-switch name and callback segment
 *   label    short button text WITHOUT emoji, ≤ 18 chars
 *   emoji    one emoji
 *   level    'repo' (shown in ⚡ Manage, gets a repo name) | 'account' (💼 Workspace)
 *   scopes   extra OAuth scopes it needs beyond the base grant ([] = none)
 *   handle   async (ctx, { action, args, repoName }) — runs one callback
 *
 * Callback shape (dispatcher in ./index.js):
 *   repo level     manage:<key>:<action>:<repo>[:<arg>…]
 *   account level  manage:<key>:<action>[:<arg>…]
 * Colons never occur in repo names, branch names, or numeric ids, so the split
 * is unambiguous; oversized data is shortened for Telegram's 64-byte limit
 * automatically by keyboards/buttonStyle.js.
 */
const KEY_RE = /^[a-z][a-z_]{1,29}$/;
const SEGMENT_RE = /^[a-z][a-z0-9_]{0,23}$/;
const LEVELS = ['repo', 'account'];

const areas = new Map();

function register(area) {
  const problems = [];
  if (!area || typeof area !== 'object') throw new Error('Area must be an object');
  if (!KEY_RE.test(String(area.key))) problems.push('key');
  if (!area.label || String(area.label).length > 18) problems.push('label (1-18 chars)');
  if (!area.emoji) problems.push('emoji');
  if (!LEVELS.includes(area.level)) problems.push('level');
  if (!Array.isArray(area.scopes)) problems.push('scopes');
  if (typeof area.handle !== 'function') problems.push('handle');
  if (problems.length) throw new Error(`Invalid manage area "${area && area.key}": ${problems.join(', ')}`);
  if (areas.has(area.key)) throw new Error(`Manage area already registered: ${area.key}`);
  areas.set(area.key, Object.freeze({ ...area }));
}

const get = (key) => areas.get(key) || null;
const list = (level) => Array.from(areas.values()).filter((a) => !level || a.level === level);
const hasLevel = (level) => list(level).length > 0;
const _resetForTests = () => areas.clear();

module.exports = { register, get, list, hasLevel, SEGMENT_RE, _resetForTests };
