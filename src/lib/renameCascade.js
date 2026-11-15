const { pool } = require('../db/postgres');
const logger = require('./logger');

/**
 * Keeps every repo_name-keyed table (tags, pins, path memory,
 * notification mutes, webhooks, recently-viewed, pending scheduled uploads,
 * and the bulk-undo ledger) bound to a repo through a
 * rename — GitHub itself redirects the old URL, but nothing on this side
 * follows automatically otherwise. Without this, a renamed repo would
 * silently lose its tags, pin position, upload path memory, mute state,
 * and live webhook registration, with no error and no visible sign
 * anything was wrong until one of those features quietly stopped working.
 *
 * Run in a single transaction: either every table follows the rename, or
 * none do (a partial cascade — e.g. tags moved but webhooks didn't — would
 * be worse than doing nothing, since it's silently inconsistent).
 *
 * repo_tags has a UNIQUE (telegram_id, repo_name, tag_id) constraint —
 * if the new name somehow already has an identical tag assignment (only
 * possible if a repo was deleted and recreated under a name that used to
 * hold the same tag), ON CONFLICT DO NOTHING keeps this from throwing.
 */
async function cascadeRename(telegramId, oldName, newName) {
  // v1.2.5-multi: pins and tag assignments belong to an OWNER — only the rows visible under the owner the
  // person is working in (their own, plus pre-1.2.5 rows with no owner) follow the rename. A same-named
  // repo under another account keeps its own pin and tags.
  const owner = await require('./ownerScope').current(telegramId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE repo_tags SET repo_name = $3
       WHERE telegram_id = $1 AND repo_name = $2
         AND (owner_login IS NULL OR $4::text IS NULL OR LOWER(owner_login) = $4::text)
         AND NOT EXISTS (
           SELECT 1 FROM repo_tags rt2
           WHERE rt2.telegram_id = $1 AND rt2.repo_name = $3 AND rt2.tag_id = repo_tags.tag_id
             AND COALESCE(LOWER(rt2.owner_login), '') = COALESCE(LOWER(repo_tags.owner_login), '')
         )`,
      [telegramId, oldName, newName, owner]
    );
    // Any leftover rows for oldName are true duplicates against the new
    // name (same tag already applied there) — safe to drop, nothing lost.
    await client.query(
      `DELETE FROM repo_tags WHERE telegram_id = $1 AND repo_name = $2
         AND (owner_login IS NULL OR $3::text IS NULL OR LOWER(owner_login) = $3::text)`,
      [telegramId, oldName, owner]
    );

    await client.query(
      `UPDATE pinned_repos SET repo_name = $3 WHERE telegram_id = $1 AND repo_name = $2
       AND (owner_login IS NULL OR $4::text IS NULL OR LOWER(owner_login) = $4::text)
       AND NOT EXISTS (SELECT 1 FROM pinned_repos p2 WHERE p2.telegram_id = $1 AND p2.repo_name = $3
                         AND COALESCE(LOWER(p2.owner_login), '') = COALESCE(LOWER(pinned_repos.owner_login), ''))`,
      [telegramId, oldName, newName, owner]
    );

    await client.query(
      `UPDATE repo_path_memory SET repo_name = $3 WHERE telegram_id = $1 AND repo_name = $2
       AND NOT EXISTS (SELECT 1 FROM repo_path_memory m2 WHERE m2.telegram_id = $1 AND m2.repo_name = $3)`,
      [telegramId, oldName, newName]
    );

    await client.query(
      `UPDATE notification_mutes SET repo_name = $3 WHERE telegram_id = $1 AND repo_name = $2
       AND NOT EXISTS (SELECT 1 FROM notification_mutes n2 WHERE n2.telegram_id = $1 AND n2.repo_name = $3)`,
      [telegramId, oldName, newName]
    );

    await client.query(
      `UPDATE repo_webhooks SET repo_name = $3 WHERE telegram_id = $1 AND repo_name = $2
       AND NOT EXISTS (SELECT 1 FROM repo_webhooks w2 WHERE w2.telegram_id = $1 AND w2.repo_name = $3)`,
      [telegramId, oldName, newName]
    );

    await client.query(
      'UPDATE recently_viewed SET repo_name = $3 WHERE telegram_id = $1 AND repo_name = $2',
      [telegramId, oldName, newName]
    );

    // v1.2.3-multi: a still-pending scheduled upload follows the repo to its
    // new name instead of failing at fire time with "repo not found".
    await client.query(
      `UPDATE scheduled_uploads SET repo_name = $3
       WHERE telegram_id = $1 AND repo_name = $2 AND status = 'pending'`,
      [telegramId, oldName, newName]
    );

    // v1.2.3-multi: an un-undone bulk change that named the old repo can no
    // longer be reversed against that name, so drop the one-hour undo record
    // rather than leave a button that would act on a name that is gone.
    await client.query(
      `DELETE FROM bulk_action_log
       WHERE telegram_id = $1 AND undone_at IS NULL
         AND position(('"' || $2 || '"') in repo_names) > 0`,
      [telegramId, oldName]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Rename cascade failed — rolled back, GitHub-side rename already succeeded', {
      telegramId, oldName, newName, message: err.message,
    });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { cascadeRename };
