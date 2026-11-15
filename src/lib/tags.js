const { pool } = require('../db/postgres');
const ruleEngine = require('./ruleEngine');

// Fixed small palette for tag chip rendering — deliberately not free-form
// hex, so chips stay visually consistent with the rest of the bot's
// outcome-based color system (see design principles in README).
const COLOR_CLASSES = ['default', 'blue', 'green', 'red', 'purple', 'orange'];

// A colour is shown as a small coloured dot in front of the tag chip ('default' = no dot).
const COLOR_DOTS = { default: '', blue: '🔵', green: '🟢', red: '🔴', purple: '🟣', orange: '🟠' };
const COLOR_NAMES = { default: 'None', blue: 'Blue', green: 'Green', red: 'Red', purple: 'Purple', orange: 'Orange' };

/** One tag as it appears in chips and lists: [colour dot] emoji name. */
function tagLabel(t) {
  const dot = COLOR_DOTS[t.color_class] || '';
  return `${dot}${t.emoji} ${t.name}`;
}

async function listTags(telegramId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.emoji, t.parent_id, t.color_class, t.auto_rule_json,
            COUNT(rt.id)::int AS repo_count
     FROM tags t
     LEFT JOIN repo_tags rt ON rt.tag_id = t.id AND rt.telegram_id = t.telegram_id
     WHERE t.telegram_id = $1
     GROUP BY t.id
     ORDER BY t.name ASC`,
    [telegramId]
  );
  return rows;
}

/** Tags as a parent -> children tree, for nested-tag menus. Top-level tags
 * (parent_id NULL) at the root; each carries a `children` array. A repo
 * filtered by a parent tag should also match anything tagged with any of
 * its descendants — see reposWithTag's `includeDescendants` option. */
async function listTagsTree(telegramId) {
  const flat = await listTags(telegramId);
  const byId = new Map(flat.map((t) => [t.id, { ...t, children: [] }]));
  const roots = [];
  for (const t of byId.values()) {
    if (t.parent_id && byId.has(t.parent_id)) byId.get(t.parent_id).children.push(t);
    else roots.push(t);
  }
  return roots;
}

/**
 * Create a tag, or update the fields the caller explicitly passes on an existing
 * one. v1.2.3-multi: this used to overwrite emoji, parent and colour with defaults
 * whenever the name already existed — so typing an existing tag name, or importing
 * a settings file, silently un-nested and re-coloured it. Now a field that isn't
 * passed (emoji null/undefined, no parentId key, no colorClass key) is left alone.
 */
async function createTag(telegramId, name, emoji, opts = {}) {
  const hasParent = Object.prototype.hasOwnProperty.call(opts, 'parentId');
  const hasColor = Object.prototype.hasOwnProperty.call(opts, 'colorClass');
  const parentId = hasParent ? opts.parentId : null;
  const colorClass = hasColor && COLOR_CLASSES.includes(opts.colorClass) ? opts.colorClass : 'default';
  const { rows } = await pool.query(
    `INSERT INTO tags (telegram_id, name, emoji, parent_id, color_class) VALUES ($1, $2, COALESCE($3, '🏷️'), $4, $5)
     ON CONFLICT (telegram_id, name) DO UPDATE SET
       emoji = COALESCE($3, tags.emoji),
       parent_id = CASE WHEN $6::boolean THEN $4 ELSE tags.parent_id END,
       color_class = CASE WHEN $7::boolean THEN $5 ELSE tags.color_class END
     RETURNING id, name, emoji, parent_id, color_class`,
    [telegramId, name.trim(), emoji || null, parentId, colorClass, hasParent, hasColor]
  );
  return rows[0];
}

/**
 * Change one tag's colour and/or parent (the tag screen sends the TARGET value, so
 * repeating a tap is harmless). The parent must belong to the same person and must
 * not be the tag itself or one of its own descendants — that would create a cycle.
 * Returns { ok: true, tag } or { ok: false, error }.
 */
async function updateTag(telegramId, tagId, { colorClass, parentId } = {}) {
  const tagIdNum = Number(tagId);
  const own = await pool.query('SELECT id FROM tags WHERE telegram_id = $1 AND id = $2', [telegramId, tagIdNum]);
  if (!own.rows.length) return { ok: false, error: 'That tag no longer exists.' };

  if (colorClass !== undefined) {
    if (!COLOR_CLASSES.includes(colorClass)) return { ok: false, error: 'Unknown colour.' };
    await pool.query('UPDATE tags SET color_class = $3 WHERE telegram_id = $1 AND id = $2', [telegramId, tagIdNum, colorClass]);
  }
  if (parentId !== undefined) {
    if (parentId === null) {
      await pool.query('UPDATE tags SET parent_id = NULL WHERE telegram_id = $1 AND id = $2', [telegramId, tagIdNum]);
    } else {
      const parentNum = Number(parentId);
      if (parentNum === tagIdNum) return { ok: false, error: 'A tag can\u2019t be nested under itself.' };
      const parent = await pool.query('SELECT id FROM tags WHERE telegram_id = $1 AND id = $2', [telegramId, parentNum]);
      if (!parent.rows.length) return { ok: false, error: 'That parent tag no longer exists.' };
      const descendants = await descendantTagIds(telegramId, tagIdNum);
      if (descendants.includes(parentNum)) return { ok: false, error: 'That would put a tag inside its own sub-tag.' };
      await pool.query('UPDATE tags SET parent_id = $3 WHERE telegram_id = $1 AND id = $2', [telegramId, tagIdNum, parentNum]);
    }
  }
  const { rows } = await pool.query('SELECT id, name, emoji, parent_id, color_class FROM tags WHERE telegram_id = $1 AND id = $2', [telegramId, tagIdNum]);
  return { ok: true, tag: rows[0] };
}

/** One tag by id (must belong to the person), or null. */
async function getTag(telegramId, tagId) {
  const { rows } = await pool.query(
    'SELECT id, name, emoji, parent_id, color_class FROM tags WHERE telegram_id = $1 AND id = $2',
    [telegramId, Number(tagId)]
  );
  return rows[0] || null;
}

/** One tag by exact name, or null. */
async function findByName(telegramId, name) {
  const { rows } = await pool.query(
    'SELECT id, name, emoji, parent_id, color_class FROM tags WHERE telegram_id = $1 AND name = $2',
    [telegramId, String(name).trim()]
  );
  return rows[0] || null;
}

/** All descendant tag ids of a given tag (not including itself), via a
 * recursive CTE — nesting depth is user-created so this stays cheap. */
async function descendantTagIds(telegramId, tagId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM tags WHERE telegram_id = $1 AND parent_id = $2
       UNION ALL
       SELECT t.id FROM tags t JOIN descendants d ON t.parent_id = d.id WHERE t.telegram_id = $1
     )
     SELECT id FROM descendants`,
    [telegramId, tagId]
  );
  return rows.map((r) => r.id);
}

/** Evaluates every tag with an auto_rule_json against one repo's data and
 * returns the ids of tags that should apply. Matching itself lives in
 * lib/ruleEngine.js, shared with 🔕 Auto-Mute rules — same rule shape,
 * same fields (language / name / visibility / fork), same wildcard syntax.
 * Caller (myRepos refresh) is responsible for actually assigning + only
 * doing so once per repo (one-time confirmation, not silent re-tagging). */
async function evaluateAutoRules(telegramId, repo) {
  const { rows } = await pool.query(
    'SELECT id, name, emoji, auto_rule_json FROM tags WHERE telegram_id = $1 AND auto_rule_json IS NOT NULL',
    [telegramId]
  );
  const matches = [];
  for (const t of rows) {
    let rule;
    try { rule = JSON.parse(t.auto_rule_json); } catch (_) { continue; }
    if (ruleEngine.matchesRule(rule, repo)) matches.push(t);
  }
  return matches;
}

/** Human-readable one-liner for a rule object (or a null/undefined rule). */
function describeRule(rule) {
  return ruleEngine.describeRule(rule);
}

async function setAutoRule(telegramId, tagId, rawRule /* null clears */) {
  const rule = rawRule ? ruleEngine.assertValidRule(rawRule) : null;
  // v1.3.0-multi: clearing a tag's auto-rule keeps a 30-day copy for 🧯 Restore center.
  const sd = require('./softDelete');
  const old = rule ? null : await sd.safe(async () => (await pool.query('SELECT name, auto_rule_json FROM tags WHERE telegram_id = $1 AND id = $2', [telegramId, tagId])).rows[0]);
  await pool.query('UPDATE tags SET auto_rule_json = $3 WHERE telegram_id = $1 AND id = $2', [
    telegramId, tagId, rule ? JSON.stringify(rule) : null,
  ]);
  if (old && old.auto_rule_json) sd.stash(telegramId, 'rule', `Auto-tag rule for ${old.name}`, { type: 'rule_tag', tagId: Number(tagId), tagName: old.name, rule_json: old.auto_rule_json });
}

/** Per-tag default overrides. Resolution order (see lib/defaults.js
 * resolveForRepo): repo's tag override -> global user default. */
async function getTagDefaults(tagIds) {
  if (!tagIds || tagIds.length === 0) return {};
  const { rows } = await pool.query(
    'SELECT tag_id, key, value FROM tag_defaults WHERE tag_id = ANY($1::bigint[])',
    [tagIds]
  );
  const map = {};
  for (const r of rows) {
    map[r.key] = map[r.key] || [];
    map[r.key].push({ tagId: r.tag_id, value: r.value });
  }
  return map;
}

const TAG_DEFAULT_KEYS = ['default_visibility', 'default_upload_path', 'default_commit_message'];

/**
 * Per-tag override of one default (v1.2.3-multi: now reachable from the tag screen
 * and applied by lib/defaults.resolveForRepo). The tag must belong to `telegramId`
 * and the value passes the same validation as the global default it overrides.
 */
async function setTagDefault(telegramId, tagId, key, rawValue) {
  if (!TAG_DEFAULT_KEYS.includes(key)) throw new Error(`Unknown tag default: ${key}`);
  const value = require('./defaults').validateDefault(key, rawValue);
  const { rowCount } = await pool.query(
    `INSERT INTO tag_defaults (tag_id, key, value)
     SELECT t.id, $3, $4 FROM tags t WHERE t.id = $2 AND t.telegram_id = $1
     ON CONFLICT (tag_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [telegramId, tagId, key, value == null ? '' : String(value)]
  );
  return rowCount > 0;
}

async function clearTagDefault(telegramId, tagId, key) {
  // v1.3.0-multi: keep a 30-day copy so 🧯 Restore center can bring the setting back (best-effort, never blocks the delete).
  const sd = require('./softDelete');
  const had = await sd.safe(async () => (await pool.query(
    `SELECT t.name, td.value FROM tag_defaults td JOIN tags t ON t.id = td.tag_id WHERE t.telegram_id = $1 AND td.tag_id = $2 AND td.key = $3`,
    [telegramId, tagId, key])).rows[0]);
  await pool.query(
    `DELETE FROM tag_defaults WHERE tag_id = $2 AND key = $3
       AND EXISTS (SELECT 1 FROM tags t WHERE t.id = $2 AND t.telegram_id = $1)`,
    [telegramId, tagId, key]
  );
  if (had) sd.stash(telegramId, 'tag', `${had.name}: ${key.replace(/^default_/, '').replace(/_/g, ' ')} setting`, { type: 'tag_default', tagId: Number(tagId), tagName: had.name, key, value: had.value });
}

/** Every override this person has set, with its tag's name (for the tag screen and for export). */
async function listTagDefaultsForUser(telegramId) {
  const { rows } = await pool.query(
    `SELECT td.tag_id, t.name AS tag_name, td.key, td.value
     FROM tag_defaults td JOIN tags t ON t.id = td.tag_id
     WHERE t.telegram_id = $1 ORDER BY t.name, td.key`,
    [telegramId]
  );
  return rows;
}

async function listTagDefaults(telegramId, tagId) {
  const { rows } = await pool.query(
    `SELECT td.key, td.value FROM tag_defaults td JOIN tags t ON t.id = td.tag_id
     WHERE t.telegram_id = $1 AND td.tag_id = $2 ORDER BY td.key`,
    [telegramId, tagId]
  );
  return rows;
}

async function deleteTag(telegramId, tagId) {
  // v1.3.0-multi: a 30-day copy (tag, its settings, which repos had it, its sub-tags) for 🧯 Restore center.
  const sd = require('./softDelete');
  const snap = await sd.safe(async () => {
    const { rows } = await pool.query('SELECT name, emoji, color_class, auto_rule_json, parent_id FROM tags WHERE telegram_id = $1 AND id = $2', [telegramId, tagId]);
    if (!rows[0]) return null;
    const [defs, assigned, kids] = await Promise.all([
      pool.query('SELECT key, value FROM tag_defaults WHERE tag_id = $1', [tagId]),
      pool.query('SELECT repo_name, owner_login FROM repo_tags WHERE telegram_id = $1 AND tag_id = $2 LIMIT 500', [telegramId, tagId]),
      pool.query('SELECT id FROM tags WHERE telegram_id = $1 AND parent_id = $2', [telegramId, tagId]),
    ]);
    return { type: 'tag', tag: rows[0], defaults: defs.rows, assignments: assigned.rows, children: kids.rows.map((r) => r.id) };
  });
  await pool.query('DELETE FROM tags WHERE telegram_id = $1 AND id = $2', [telegramId, tagId]);
  if (snap) sd.stash(telegramId, 'tag', `${snap.tag.emoji} ${snap.tag.name}${snap.assignments.length ? ` · on ${snap.assignments.length} repo${snap.assignments.length === 1 ? '' : 's'}` : ''}`, snap);
}

// v1.2.5-multi: tag ASSIGNMENTS (tag → repo) are scoped to the owner the person is looking at, so a
// same-named repo under another account or organisation no longer inherits them. The tags themselves
// stay per-person. Rows written before 1.2.5 have no owner and stay visible under every owner.
const ownerScope = require('./ownerScope');
const RT_VISIBLE = '(rt.owner_login IS NULL OR $2::text IS NULL OR LOWER(rt.owner_login) = $2::text)';

async function tagsForRepo(telegramId, repoName) {
  const owner = await ownerScope.current(telegramId);
  const { rows } = await pool.query(
    `SELECT DISTINCT t.id, t.name, t.emoji, t.color_class, t.parent_id FROM repo_tags rt
     JOIN tags t ON t.id = rt.tag_id
     WHERE rt.telegram_id = $1 AND rt.repo_name = $3 AND ${RT_VISIBLE}
     ORDER BY t.name ASC`,
    [telegramId, owner, repoName]
  );
  return rows;
}

async function assignTag(telegramId, repoName, tagId) {
  const owner = await ownerScope.current(telegramId);
  // Already visible (a legacy row, or this owner's own)? Then it IS assigned — nothing to add.
  const have = await pool.query(
    `SELECT 1 FROM repo_tags rt WHERE rt.telegram_id = $1 AND rt.repo_name = $3 AND rt.tag_id = $4 AND ${RT_VISIBLE} LIMIT 1`,
    [telegramId, owner, repoName, tagId]
  );
  if (have.rows.length > 0) return;
  await pool.query(
    `INSERT INTO repo_tags (telegram_id, repo_name, tag_id, owner_login) VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id, repo_name, tag_id, (COALESCE(LOWER(owner_login), ''))) DO NOTHING`,
    [telegramId, repoName, tagId, owner]
  );
}

async function removeTagFromRepo(telegramId, repoName, tagId) {
  const owner = await ownerScope.current(telegramId);
  await pool.query(
    `DELETE FROM repo_tags rt WHERE rt.telegram_id = $1 AND rt.repo_name = $3 AND rt.tag_id = $4 AND ${RT_VISIBLE}`,
    [telegramId, owner, repoName, tagId]
  );
}

async function reposWithTag(telegramId, tagId, { includeDescendants = true } = {}) {
  let tagIds = [Number(tagId)];
  if (includeDescendants) {
    tagIds = tagIds.concat(await descendantTagIds(telegramId, tagId));
  }
  const owner = await ownerScope.current(telegramId);
  const { rows } = await pool.query(
    `SELECT DISTINCT repo_name FROM repo_tags rt WHERE rt.telegram_id = $1 AND rt.tag_id = ANY($3::bigint[]) AND ${RT_VISIBLE}`,
    [telegramId, owner, tagIds]
  );
  return rows.map((r) => r.repo_name);
}

/** Bulk fetch: { repoName: [{id,name,emoji}, ...] } for a set of repos in one query */
async function tagsForRepos(telegramId, repoNames) {
  if (repoNames.length === 0) return {};
  const owner = await ownerScope.current(telegramId);
  const { rows } = await pool.query(
    `SELECT DISTINCT rt.repo_name, t.id, t.name, t.emoji, t.color_class FROM repo_tags rt
     JOIN tags t ON t.id = rt.tag_id
     WHERE rt.telegram_id = $1 AND rt.repo_name = ANY($3::text[]) AND ${RT_VISIBLE}`,
    [telegramId, owner, repoNames]
  );
  const map = {};
  for (const row of rows) {
    if (!map[row.repo_name]) map[row.repo_name] = [];
    map[row.repo_name].push({ id: row.id, name: row.name, emoji: row.emoji, color_class: row.color_class });
  }
  return map;
}

/** Cleanup hook for Storage & Data's auto-cleanup-on-delete setting */
async function removeAllForRepo(telegramId, repoName) {
  const owner = await ownerScope.current(telegramId);
  await pool.query(
    `DELETE FROM repo_tags rt WHERE rt.telegram_id = $1 AND rt.repo_name = $3 AND ${RT_VISIBLE}`,
    [telegramId, owner, repoName]
  );
}

module.exports = {
  listTags,
  listTagsTree,
  createTag,
  updateTag,
  getTag,
  tagLabel,
  COLOR_DOTS,
  COLOR_NAMES,
  findByName,
  deleteTag,
  tagsForRepo,
  assignTag,
  removeTagFromRepo,
  reposWithTag,
  tagsForRepos,
  removeAllForRepo,
  descendantTagIds,
  evaluateAutoRules,
  describeRule,
  setAutoRule,
  getTagDefaults,
  setTagDefault,
  clearTagDefault,
  listTagDefaultsForUser,
  listTagDefaults,
  TAG_DEFAULT_KEYS,
  COLOR_CLASSES,
};
