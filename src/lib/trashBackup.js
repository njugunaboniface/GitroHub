/**
 * Backs a repo up into 🗑️ Trash before it is deleted (v1.2.3-multi).
 *
 * Shared by the single-repo 🗑️ Delete Repo flow and by Bulk Delete, which used
 * to skip Trash entirely even though Help promises that a repo deleted through
 * the bot stays recoverable.
 *
 * The backup is GitHub's own zipball, sent to the person's own chat as a
 * document; the Telegram file_id is what Trash stores. Two Telegram limits
 * shape this (see config.js): a bot can SEND up to 50MB, but can only DOWNLOAD
 * up to 20MB — and Restore has to download the file again. So:
 *   - over 50MB      -> the backup can't be made at all -> throws, nothing is deleted
 *   - 20MB to 50MB   -> backed up, but flagged restorable=false: it can be
 *                       re-sent as a ZIP, never restored in place
 *   - up to 20MB     -> fully restorable
 */
const config = require('../config');
const github = require('./github');
const users = require('./users');
const trash = require('./trash');
const format = require('./format');

/**
 * @returns {{ trashEntry, retentionLabel: string, restorable: boolean, sizeBytes: number }}
 * @throws Error with a person-readable message when no backup could be made.
 */
async function backupRepoToTrash(ctx, { token, owner, repo }) {
  const dbUser = await users.getUser(ctx.from.id);
  const retentionDays = dbUser && dbUser.trash_retention_days != null ? dbUser.trash_retention_days : config.DEFAULT_TRASH_RETENTION_DAYS;
  const retentionLabel = retentionDays === 0 ? 'indefinitely' : `${retentionDays}d`;

  const zipBuffer = await github.downloadZip(token, owner, repo.name, repo.default_branch);
  if (zipBuffer.length > config.TELEGRAM_UPLOAD_LIMIT_BYTES) {
    throw new Error(`the backup would be ${format.formatBytes(zipBuffer.length)}, over the ${format.formatBytes(config.TELEGRAM_UPLOAD_LIMIT_BYTES)} Telegram lets a bot send`);
  }
  const restorable = zipBuffer.length <= config.TELEGRAM_DOWNLOAD_LIMIT_BYTES;

  const backupMsg = await ctx.replyWithDocument(
    { source: zipBuffer, filename: `${repo.name}-trash-backup.zip` },
    { caption: `🗑️ Trash backup: ${repo.name} (kept ${retentionLabel})${restorable ? '' : ' — ZIP only: too large to restore in place'}` }
  );
  const trashEntry = await trash.add(ctx.from.id, {
    originalName: repo.name,
    description: repo.description,
    visibility: repo.private ? 'private' : 'public',
    backupFileId: backupMsg.document.file_id,
    retentionDays,
    restorable,
  });
  return { trashEntry, retentionLabel, restorable, sizeBytes: zipBuffer.length };
}

module.exports = { backupRepoToTrash };
