/**
 * GitHub OAuth scopes (v1.2.4-multi) — what each feature needs and what a
 * person has actually granted.
 *
 * Everyone connects with BASE_SCOPES. A feature that needs more (gists,
 * organisations, …) never fails halfway: the dispatcher checks the person's
 * stored `users.github_scope` first and, if something is missing, shows a
 * one-tap "grant one more permission" button (handlers/manage/index.js).
 * GitHub OAuth Apps accumulate grants, so reconnecting with an extra scope
 * keeps everything granted before.
 */
const BASE_SCOPES = Object.freeze(['repo', 'delete_repo']);

// Extra scopes GitroHub may ever ask for. Anything else is refused so a typo
// in a feature definition can't silently widen what we request.
const ALLOWED_EXTRA_SCOPES = Object.freeze(['gist', 'notifications', 'read:org', 'project']);

// A granted scope on the right satisfies the one on the left.
const IMPLIED_BY = Object.freeze({
  'read:org': ['write:org', 'admin:org'],
  'write:org': ['admin:org'],
  notifications: ['repo'],
  project: [],
});

/** "repo, delete_repo" / "repo,delete_repo" / null → Set of scope names. */
function parse(scopeString) {
  return new Set(String(scopeString == null ? '' : scopeString).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
}

function hasScope(granted, needed) {
  const set = granted instanceof Set ? granted : parse(granted);
  if (set.has(needed)) return true;
  return (IMPLIED_BY[needed] || []).some((s) => set.has(s));
}

/** Which of `needed` the person does NOT have. A blank/unknown stored scope is
 * treated as the base grant (what every connection gets). */
function missing(grantedString, needed = []) {
  const parsed = parse(grantedString);
  const set = parsed.size ? parsed : new Set(BASE_SCOPES);
  return needed.filter((s) => !hasScope(set, s));
}

/** Comma-joined scope string for the authorize URL: base + validated extras. */
function authorizeScope(extra = []) {
  extra = extra.filter((s) => !BASE_SCOPES.includes(s)); // base scopes are always requested anyway
  const bad = extra.filter((s) => !ALLOWED_EXTRA_SCOPES.includes(s));
  if (bad.length) throw new Error(`Refusing to request unknown OAuth scope: ${bad.join(', ')}`);
  return Array.from(new Set([...BASE_SCOPES, ...extra])).join(',');
}

/**
 * v1.2.5-multi: what EVERY new connection asks for (first time, reconnect after Disconnect or a revoke, adding
 * another account) — everything at once, so no feature ever has to interrupt them later with "grant one more
 * permission". An already-connected person's on-demand "grant one extra permission" button is the only minimal request. Set FIRST_CONNECT_ALL_SCOPES=off to go back to base-only.
 */
function firstConnectExtras() {
  return String(process.env.FIRST_CONNECT_ALL_SCOPES || 'on').toLowerCase() === 'off' ? [] : [...ALLOWED_EXTRA_SCOPES];
}

module.exports = { BASE_SCOPES, ALLOWED_EXTRA_SCOPES, firstConnectExtras, parse, hasScope, missing, authorizeScope };
