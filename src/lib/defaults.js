const { pool } = require('../db/postgres');

async function getDefaults(telegramId) {
  const { rows } = await pool.query(
    `SELECT default_visibility, default_commit_message, default_upload_path,
            default_sort, default_filter, auto_suggest_defaults, trash_retention_days,
            recently_viewed_enabled
     FROM users WHERE telegram_id = $1`,
    [telegramId]
  );
  return rows[0] || null;
}

const ALLOWED_FIELDS = new Set([
  'default_visibility', 'default_commit_message', 'default_upload_path',
  'default_sort', 'default_filter', 'auto_suggest_defaults', 'trash_retention_days',
  'recently_viewed_enabled',
]);

/**
 * Sets a default AND logs the change to defaults_changelog (old -> new),
 * so "why did my upload path change" is always answerable from Activity
 * instead of being a mystery. `source` distinguishes a manual Settings
 * edit from an accepted learned-suggestion, since those read differently
 * in the audit trail.
 */
const VALID_SORTS = new Set(['updated', 'name', 'stars', 'created', 'language']);
const VALID_FILTERS = new Set(['all', 'public', 'private', 'forks']);
const MAX_COMMIT_TEMPLATE = 200;
const MAX_UPLOAD_PATH = 200;

/**
 * Checks and normalises one default's value (v1.2.3-multi). The Settings screens
 * only ever send valid values, but Import feeds these straight from a file the
 * person edited by hand, so each field is validated here — in one place — before
 * it reaches the database. Throws an Error with code INVALID_DEFAULT.
 */
function validateDefault(field, value) {
  const bad = (msg) => Object.assign(new Error(`${field}: ${msg}`), { code: 'INVALID_DEFAULT' });
  switch (field) {
    case 'default_visibility':
      if (value !== 'private' && value !== 'public') throw bad('must be private or public');
      return value;
    case 'default_sort':
      if (!VALID_SORTS.has(value)) throw bad('unknown sort order');
      return value;
    case 'default_filter':
      if (!VALID_FILTERS.has(value)) throw bad('unknown filter');
      return value;
    case 'default_commit_message': {
      const v = String(value == null ? '' : value).trim();
      if (!v) throw bad('can\u2019t be empty');
      if (v.length > MAX_COMMIT_TEMPLATE) throw bad(`keep it under ${MAX_COMMIT_TEMPLATE} characters`);
      return v;
    }
    case 'default_upload_path': {
      if (value == null || value === '') return ''; // repo root (the column is NOT NULL DEFAULT '')
      const v = String(value).trim().replace(/^\/+|\/+$/g, '');
      if (v.length > MAX_UPLOAD_PATH) throw bad(`keep it under ${MAX_UPLOAD_PATH} characters`);
      if (v.split('/').some((seg) => seg === '..' || seg === '.')) throw bad('\u201c.\u201d and \u201c..\u201d segments aren\u2019t allowed');
      return v;
    }
    case 'auto_suggest_defaults':
    case 'recently_viewed_enabled':
      if (typeof value !== 'boolean') throw bad('must be on or off');
      return value;
    case 'trash_retention_days': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 3650) throw bad('must be a whole number of days from 0 (never) to 3650');
      return n;
    }
    default:
      return value;
  }
}

async function setDefault(telegramId, field, rawValue, { source = 'manual' } = {}) {
  if (!ALLOWED_FIELDS.has(field)) throw new Error(`Unknown default field: ${field}`);
  const value = validateDefault(field, rawValue);
  const before = await getDefaults(telegramId);
  const oldValue = before ? before[field] : null;
  await pool.query(`UPDATE users SET ${field} = $1 WHERE telegram_id = $2`, [value, telegramId]);
  if (String(oldValue) !== String(value)) {
    await pool.query(
      `INSERT INTO defaults_changelog (telegram_id, field, old_value, new_value, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [telegramId, field, oldValue == null ? null : String(oldValue), String(value), source]
    );
  }
}

async function getChangelog(telegramId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT field, old_value, new_value, source, changed_at FROM defaults_changelog
     WHERE telegram_id = $1 ORDER BY changed_at DESC LIMIT $2`,
    [telegramId, limit]
  );
  return rows;
}

/**
 * "Learn from me" check — looks at the last 3 activity_log entries recording
 * a repo-creation visibility choice and, if all 3 agree and disagree with
 * the current default, returns the suggested value. Returns null if there's
 * no clear pattern yet, or the pattern already matches the current default.
 */
async function checkVisibilityPattern(telegramId) {
  const { rows } = await pool.query(
    `SELECT detail FROM activity_log
     WHERE telegram_id = $1 AND icon = '➕' AND detail LIKE 'visibility:%'
     ORDER BY created_at DESC LIMIT 3`,
    [telegramId]
  );
  if (rows.length < 3) return null;

  const choices = rows.map((r) => r.detail.replace('visibility:', ''));
  const allSame = choices.every((c) => c === choices[0]);
  if (!allSame) return null;

  const defaults = await getDefaults(telegramId);
  if (!defaults || !defaults.auto_suggest_defaults) return null;
  if (defaults.default_visibility === choices[0]) return null; // already matches

  return choices[0]; // 'private' or 'public'
}

/**
 * Learned upload-path suggestion — the global counterpart to per-repo
 * pathMemory. Looks at upload_path_frequency (bumped by
 * pathMemory.setLastPath's caller on every successful upload — see
 * lib/pathMemory.js) and, if one path clearly dominates and differs from
 * the current default, returns it as a suggestion. Never applied silently;
 * callers present it as a one-tap confirm, same UX as checkVisibilityPattern.
 */
async function checkUploadPathPattern(telegramId) {
  const defaults = await getDefaults(telegramId);
  if (!defaults || !defaults.auto_suggest_defaults) return null;

  const { rows } = await pool.query(
    `SELECT path, count FROM upload_path_frequency
     WHERE telegram_id = $1 ORDER BY count DESC, last_used_at DESC LIMIT 1`,
    [telegramId]
  );
  if (!rows[0] || rows[0].count < 5) return null; // needs a real pattern, not one lucky repeat
  if (rows[0].path === defaults.default_upload_path) return null;
  return rows[0].path;
}

/** "No thanks" to a suggested upload folder: reset its counter so it is only offered again after a fresh run of uses. */
async function dismissUploadPathSuggestion(telegramId, path) {
  await pool.query('UPDATE upload_path_frequency SET count = 0 WHERE telegram_id = $1 AND path = $2', [telegramId, path]);
}

async function bumpUploadPathFrequency(telegramId, path) {
  if (!path) return; // root uploads aren't a "path preference" worth counting
  await pool.query(
    `INSERT INTO upload_path_frequency (telegram_id, path, count, last_used_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (telegram_id, path) DO UPDATE SET count = upload_path_frequency.count + 1, last_used_at = now()`,
    [telegramId, path]
  );
}

/**
 * Placeholder expansion for default_commit_message templates.
 * Supported: {filename}, {repo}, {date} (YYYY-MM-DD), {count} (file count).
 * Unrecognized placeholders are left as-is rather than stripped, so a typo
 * is visible in the resulting commit message instead of silently vanishing.
 */
function expandCommitTemplate(template, { filename = '', repo = '', count = 1 } = {}) {
  const date = new Date().toISOString().slice(0, 10);
  return template
    .replace(/\{filename\}/g, filename)
    .replace(/\{repo\}/g, repo)
    .replace(/\{date\}/g, date)
    .replace(/\{count\}/g, String(count));
}

/**
 * Resolves the effective default for one field, applying per-tag overrides
 * (lib/tags.getTagDefaults) on top of the global user default. Resolution
 * order: first tag (by id ascending) carrying an override for `key` wins —
 * deliberately simple (no priority system) since multi-tag conflicts are
 * expected to be rare and a user can always remove a tag's override.
 */
async function resolveForRepo(telegramId, key, tagIds) {
  const globalDefaults = await getDefaults(telegramId);
  const globalValue = globalDefaults ? globalDefaults[key] : null;
  if (!tagIds || tagIds.length === 0) return globalValue;

  const tags = require('./tags');
  const tagDefaultsMap = await tags.getTagDefaults(tagIds);
  const overrides = tagDefaultsMap[key];
  if (overrides && overrides.length > 0) return overrides[0].value;
  return globalValue;
}

/**
 * The commit message to use for a write the person didn't type one for
 * (v1.2.3-multi). Order: the repo's tag override, then the person's global
 * default_commit_message, then `fallback`; {filename} / {repo} / {date} / {count}
 * placeholders are expanded. Before this, placeholders were committed literally and
 * Edit File / Delete File ignored the default entirely.
 */
async function commitMessageFor(telegramId, { fallback, filename = '', repo = '', count = 1 } = {}) {
  let tagIds = [];
  try {
    if (repo) {
      const tags = require('./tags');
      tagIds = (await tags.tagsForRepo(telegramId, repo)).map((t) => t.id);
    }
  } catch (_) { /* tag lookup is a bonus, never a reason to lose the commit */ }
  let template = null;
  try {
    template = await resolveForRepo(telegramId, 'default_commit_message', tagIds);
  } catch (_) { /* fall through to the fallback */ }
  const base = template && String(template).trim() ? String(template) : fallback;
  return expandCommitTemplate(base, { filename, repo, count }).slice(0, 1000);
}

/** The upload folder to suggest for one repo: its tag's override if it has one, else the global default ('' = root). */
async function uploadPathFor(telegramId, repo) {
  let tagIds = [];
  try {
    if (repo) tagIds = (await require('./tags').tagsForRepo(telegramId, repo)).map((t) => t.id);
  } catch (_) { /* a tag lookup problem just means no override */ }
  try {
    const v = await resolveForRepo(telegramId, 'default_upload_path', tagIds);
    return v == null ? '' : String(v);
  } catch (_) {
    return '';
  }
}

module.exports = {
  uploadPathFor,
  getDefaults, setDefault, getChangelog, checkVisibilityPattern,
  checkUploadPathPattern, bumpUploadPathFrequency, dismissUploadPathSuggestion, expandCommitTemplate, resolveForRepo, commitMessageFor, validateDefault,
};
