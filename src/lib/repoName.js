/**
 * One definition of "a repo name GitHub will accept", used by Create Repo,
 * Rename, Scheduled Repos and Trash restore (v1.2.3-multi). The same regex was
 * pasted into five places and still let through names GitHub rejects only at
 * the very last step: '.', '..', anything ending in '.git', and anything over
 * 100 characters.
 */
const MAX_LENGTH = 100;
const ALLOWED = /^[A-Za-z0-9._-]+$/;

/** { ok: true, name } with the trimmed name, or { ok: false, error } — a short reason fit for a "Send a valid name" reply. */
function validateRepoName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) return { ok: false, error: 'A repo name can\u2019t be empty.' };
  if (name.length > MAX_LENGTH) return { ok: false, error: `GitHub repo names can be at most ${MAX_LENGTH} characters (that one is ${name.length}).` };
  if (!ALLOWED.test(name)) return { ok: false, error: 'GitHub repo names can only contain letters, numbers, dots, hyphens and underscores.' };
  if (name === '.' || name === '..') return { ok: false, error: '"." and ".." are reserved names on GitHub.' };
  if (/\.git$/i.test(name)) return { ok: false, error: 'GitHub doesn\u2019t allow repo names that end in ".git".' };
  return { ok: true, name };
}

module.exports = { validateRepoName, MAX_LENGTH };
