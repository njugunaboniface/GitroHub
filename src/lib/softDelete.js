/**
 * Soft-delete (v1.3.0-multi) — the safety net behind 🧯 Restore center.
 *
 * When someone deletes a small thing the bot stores for them (a tag, a pin, a saved view, an automation rule, a
 * scheduled job they cancel), the delete still happens exactly as before — and a copy of just enough data to
 * re-create it is kept for 30 days. Restoring re-creates it, or refuses with a plain reason when the world has moved
 * on (the name is taken again, the scheduled time has passed, …).
 *
 * Best-effort by design: stashing never blocks or fails the real delete (callers do not await it, and it never
 * rejects). Payloads hold names and settings only — never tokens or file contents.
 */
const { pool } = require('../db/postgres');
const logger = require('./logger');

const KEEP_DAYS = 30;
const KINDS = ['tag', 'pin', 'view', 'rule', 'schedule'];
const ICONS = { tag: '🏷️', pin: '📌', view: '🗂️', rule: '⚙️', schedule: '📅' };
const KIND_WORDS = { tag: 'Tag', pin: 'Pin', view: 'Saved view', rule: 'Rule', schedule: 'Schedule' };

/**
 * Remembers one deletion. Never throws, never rejects. `payload.type` names the sub-kind (tag_default, rule_tag, …).
 * @returns {Promise<number|null>} the soft-delete id
 */
async function stash(telegramId, kind, label, payload, { ownerLogin = null } = {}) {
  try {
    if (!telegramId || !KINDS.includes(kind)) return null;
    const { rows } = await pool.query(
      `INSERT INTO soft_deleted (telegram_id, kind, label, payload, owner_login, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval) RETURNING id`,
      [telegramId, kind, String(label || '').replace(/\s+/g, ' ').trim().slice(0, 120), JSON.stringify(payload || {}), ownerLogin ? String(ownerLogin).toLowerCase() : null, String(KEEP_DAYS)]
    );
    return rows && rows[0] ? Number(rows[0].id) : null;
  } catch (err) {
    logger.debug('soft-delete: could not stash', { error: err && err.message });
    return null;
  }
}

const VISIBLE = '(owner_login IS NULL OR $2::text IS NULL OR LOWER(owner_login) = $2::text)';

/** Newest-first things that can still be restored. `owner` (lower-case login or null) narrows owner-scoped items. */
async function list(telegramId, { kind = null, owner = null, limit = 8, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, kind, label, payload, owner_login, deleted_at, expires_at
       FROM soft_deleted
      WHERE telegram_id = $1 AND ${VISIBLE} AND restored_at IS NULL AND expires_at > now()
        AND ($3::text IS NULL OR kind = $3::text)
      ORDER BY deleted_at DESC, id DESC LIMIT $4 OFFSET $5`,
    [telegramId, owner ? String(owner).toLowerCase() : null, kind, limit + 1, offset]
  );
  return { items: rows.slice(0, limit), hasNext: rows.length > limit };
}

async function get(telegramId, id) {
  const { rows } = await pool.query(`SELECT * FROM soft_deleted WHERE telegram_id = $1 AND id = $2`, [telegramId, id]);
  return rows[0] || null;
}

/** Throws a Refuse (never an Error) when the restore cannot go ahead; the message is shown to the person as-is. */
class Refuse extends Error {}
const refuse = (msg) => { throw new Refuse(msg); };
const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || {};

// ── per-kind restorers ─────────────────────────────────────────────────────────────────────────────────────
const RESTORERS = {
  async tag(telegramId, p) {
    if (p.type === 'tag_default') {
      const { rows } = await pool.query('SELECT id FROM tags WHERE telegram_id = $1 AND (id = $2 OR name = $3) ORDER BY (id = $2) DESC LIMIT 1', [telegramId, p.tagId || 0, p.tagName || '']);
      if (!rows[0]) refuse('That tag no longer exists, so its setting has nowhere to go. Restore the tag first.');
      const { rows: have } = await pool.query('SELECT 1 FROM tag_defaults WHERE tag_id = $1 AND key = $2', [rows[0].id, p.key]);
      if (have[0]) refuse('That tag setting has been set again since, so I left it alone.');
      await pool.query('INSERT INTO tag_defaults (tag_id, key, value) VALUES ($1, $2, $3)', [rows[0].id, p.key, String(p.value == null ? '' : p.value)]);
      return;
    }
    const t = p.tag || {};
    if (!t.name) refuse('Nothing to restore here.');
    const { rows: dup } = await pool.query('SELECT 1 FROM tags WHERE telegram_id = $1 AND name = $2', [telegramId, t.name]);
    if (dup[0]) refuse(`A tag called “${t.name}” already exists. Rename or delete it first, then restore.`);
    let parent = null;
    if (t.parent_id) {
      const { rows } = await pool.query('SELECT id FROM tags WHERE telegram_id = $1 AND id = $2', [telegramId, t.parent_id]);
      parent = rows[0] ? t.parent_id : null;
    }
    const { rows: made } = await pool.query(
      `INSERT INTO tags (telegram_id, name, emoji, color_class, auto_rule_json, parent_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [telegramId, t.name, t.emoji || '🏷️', t.color_class || 'default', t.auto_rule_json || null, parent]
    );
    const id = made[0].id;
    for (const d of p.defaults || []) await pool.query('INSERT INTO tag_defaults (tag_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (tag_id, key) DO NOTHING', [id, d.key, String(d.value == null ? '' : d.value)]);
    for (const a of p.assignments || []) await pool.query('INSERT INTO repo_tags (telegram_id, repo_name, tag_id, owner_login) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [telegramId, a.repo_name, id, a.owner_login || null]);
    const kids = (p.children || []).filter(Boolean);
    for (const childId of kids) await pool.query('UPDATE tags SET parent_id = $3 WHERE telegram_id = $1 AND id = $2 AND parent_id IS NULL', [telegramId, childId, id]);
  },

  async pin(telegramId, p) {
    const rows = p.rows || [];
    if (!rows.length) refuse('Nothing to restore here.');
    let added = 0;
    for (const r of rows) {
      const { rows: pos } = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM pinned_repos WHERE telegram_id = $1', [telegramId]);
      const { rowCount } = await pool.query(
        `INSERT INTO pinned_repos (telegram_id, repo_name, position, pin_section, owner_login) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [telegramId, r.repo_name, pos[0].next, r.pin_section || null, r.owner_login || null]
      );
      added += rowCount || 0;
    }
    if (!added) refuse(rows.length === 1 ? 'That repo is already pinned again.' : 'Those repos are already pinned again.');
  },

  async view(telegramId, p) {
    if (!p.name) refuse('Nothing to restore here.');
    const { rows: dup } = await pool.query('SELECT 1 FROM saved_views WHERE telegram_id = $1 AND name = $2', [telegramId, p.name]);
    if (dup[0]) refuse(`A saved view called “${p.name}” already exists. Rename it first, then restore.`);
    const { rows: pos } = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM saved_views WHERE telegram_id = $1', [telegramId]);
    await pool.query('INSERT INTO saved_views (telegram_id, name, filter_json, position) VALUES ($1, $2, $3, $4)', [telegramId, p.name, p.filter_json, pos[0].next]);
  },

  async rule(telegramId, p) {
    if (p.type === 'rule_tag') {
      const { rows } = await pool.query('SELECT id, auto_rule_json FROM tags WHERE telegram_id = $1 AND (id = $2 OR name = $3) ORDER BY (id = $2) DESC LIMIT 1', [telegramId, p.tagId || 0, p.tagName || '']);
      if (!rows[0]) refuse('That tag no longer exists, so its rule has nowhere to go.');
      if (rows[0].auto_rule_json) refuse('That tag has a rule again since, so I left it alone.');
      await pool.query('UPDATE tags SET auto_rule_json = $3 WHERE telegram_id = $1 AND id = $2', [telegramId, rows[0].id, p.rule_json]);
      return;
    }
    const table = p.type === 'rule_mute' ? 'automation_mute_rules' : p.type === 'rule_backup' ? 'automation_backup_rules' : null;
    if (!table) refuse('Nothing to restore here.');
    const { rows: dup } = await pool.query(`SELECT 1 FROM ${table} WHERE telegram_id = $1 AND field = $2 AND op = $3 AND value = $4`, [telegramId, p.field, p.op, p.value]);
    if (dup[0]) refuse('That same rule exists again, so there is nothing to bring back.');
    await pool.query(`INSERT INTO ${table} (telegram_id, field, op, value) VALUES ($1, $2, $3, $4)`, [telegramId, p.field, p.op, p.value]);
  },

  async schedule(telegramId, p) {
    const table = p.table === 'scheduled_repos' ? 'scheduled_repos' : p.table === 'scheduled_uploads' ? 'scheduled_uploads' : null;
    if (!table || !Number.isInteger(Number(p.id))) refuse('Nothing to restore here.');
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE telegram_id = $1 AND id = $2`, [telegramId, Number(p.id)]);
    const row = rows[0];
    if (!row) refuse('That schedule has been cleared away, so it can’t come back. Schedule it again.');
    if (row.status === 'pending') return; // already running again (restored some other way) — fine
    if (row.status !== 'cancelled') refuse(`That schedule already ${row.status === 'completed' ? 'ran' : 'finished'}, so there is nothing to bring back.`);
    if (new Date(row.scheduled_for).getTime() <= Date.now()) refuse('Its scheduled time has passed. Schedule it again for a new time.');
    if (table === 'scheduled_uploads' && !row.file_id) refuse('Its files were cleared when it was cancelled. Upload and schedule it again.');
    await pool.query(`UPDATE ${table} SET status = 'pending', error_message = NULL WHERE telegram_id = $1 AND id = $2 AND status = 'cancelled'`, [telegramId, Number(p.id)]);
  },
};

/**
 * Puts one thing back. Idempotent: the row is claimed first, so a double tap (or two devices) restores once and the
 * second call answers `{ ok: true, already: true }`. If the restorer refuses, the claim is released so it can be retried
 * (for instance after renaming the clashing tag).
 * @returns {Promise<{ok:boolean, already?:boolean, label?:string, kind?:string, reason?:string}>}
 */
async function restore(telegramId, id) {
  const row = await get(telegramId, id);
  if (!row) return { ok: false, reason: 'That item is gone — it may have expired (items are kept for 30 days).' };
  if (row.restored_at) return { ok: true, already: true, label: row.label, kind: row.kind };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'That item expired (items are kept for 30 days).' };
  const claim = await pool.query('UPDATE soft_deleted SET restored_at = now() WHERE telegram_id = $1 AND id = $2 AND restored_at IS NULL RETURNING id', [telegramId, id]);
  if (!claim.rows.length) return { ok: true, already: true, label: row.label, kind: row.kind };
  try {
    const fn = RESTORERS[row.kind];
    if (!fn) refuse('This kind of item can’t be restored.');
    await fn(telegramId, asObj(row.payload));
    return { ok: true, label: row.label, kind: row.kind };
  } catch (err) {
    await pool.query('UPDATE soft_deleted SET restored_at = NULL WHERE telegram_id = $1 AND id = $2', [telegramId, id]).catch(() => {});
    if (err instanceof Refuse) return { ok: false, reason: err.message };
    logger.warn('soft-delete: restore failed', { error: err && err.message, kind: row.kind });
    return { ok: false, reason: 'Something went wrong while restoring that. Nothing was changed — please try again.' };
  }
}

/** Removes one entry for good ("🗑 Forget"). */
async function forget(telegramId, id) {
  const { rowCount } = await pool.query('DELETE FROM soft_deleted WHERE telegram_id = $1 AND id = $2', [telegramId, id]);
  return rowCount > 0;
}

/** Daily prune: expired entries, and restored ones a week after the fact. Batched like the other retention jobs. */
async function purgeExpired() {
  const { pruneBatched } = require('./retention');
  return (await pruneBatched('soft_deleted', "expires_at < now() OR (restored_at IS NOT NULL AND restored_at < now() - interval '7 days')")).deleted;
}

// ── capture helpers used by the delete paths (all best-effort; null on any problem) ────────────────────────
const safe = async (fn) => { try { return await fn(); } catch (_) { return null; } };

module.exports = { stash, list, get, restore, forget, purgeExpired, safe, ICONS, KIND_WORDS, KINDS, KEEP_DAYS };
