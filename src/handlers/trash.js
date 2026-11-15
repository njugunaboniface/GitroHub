const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const format = require('../lib/format');
const bbtb = require('../keyboards/bbtb');
const requireConnected = require('../lib/requireConnected');
const trash = require('../lib/trash');
const ephemeral = require('../lib/ephemeral');
const config = require('../config');

/**
 * 🗑️ Trash — lives inline inside 📦 Storage & Data (no new BBTB row), so it
 * inherits whatever BBTB Storage was already showing rather than sending
 * its own marker.
 */
async function showTrash(ctx) {
  const entries = await trash.list(ctx.from.id);
  // v1.2.5-multi: an entry remembers the GitHub account it was deleted from; name it when that isn't the
  // account in use now, so nobody restores into the wrong one by accident.
  const activeLogin = await require('../lib/accounts').activeLoginOf(ctx.from.id).catch(() => null);

  let text = `🗑️ *Trash*\n\nRepos deleted through the bot are backed up here until they expire\\. Backups over 20 MB can be downloaded as a ZIP but not restored in place\\.\n\n`;
  text += entries.length === 0
    ? 'Nothing in Trash right now\\.'
    : entries.map((e, i) => {
        const label = e.expires_at
          ? `${Math.max(0, Math.ceil((new Date(e.expires_at).getTime() - Date.now()) / 86400000))}d left`
          : 'kept indefinitely';
        const zipOnly = e.restorable === false ? ' — 📦 ZIP only' : '';
        const other = e.account_login && activeLogin && String(e.account_login).toLowerCase() !== String(activeLogin).toLowerCase()
          ? ` — 👤 @${format.escapeMd(e.account_login)}` : '';
        return `${i + 1}\\. *${format.escapeMd(e.original_name)}* — ${label}${zipOnly}${other}`;
      }).join('\n');

  // Two rows per entry — Restore/Edit are the safe, common paths; ZIP is
  // informational; Delete Forever is BLUE here (just opens a confirm
  // screen) — only the actual confirm button on that screen is RED, same
  // rule as Delete Repo/File everywhere else in the bot.
  const rows = [];
  entries.forEach((e, i) => {
    // A backup too big for Telegram to hand back to the bot can't be restored in
    // place, so Restore/Edit aren't offered for it — only the ZIP and Delete Forever.
    if (e.restorable !== false) {
      rows.push([
        style.callback(`♻️ ${i + 1}. Restore`, `trash:restore:${e.id}`),
        style.callback('✏️ Edit', `trash:editrestore:${e.id}`),
      ]);
    }
    rows.push([
      style.callback('⬇️ ZIP', `trash:download:${e.id}`),
      style.callback('🗑️ Delete Forever', `trash:deleteforever:${e.id}`, style.BLUE),
    ]);
  });
  rows.push([style.callback('⬅️ Back', 'storage:back', style.BLUE)]);

  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

/** ⬇️ Re-sends the backup document straight from its Telegram file_id — no
 * re-download/re-upload needed, Telegram lets a bot resend a file it
 * already knows the id of. */
async function downloadZip(ctx, trashId) {
  const entry = await trash.get(ctx.from.id, trashId);
  if (!trash.isAvailable(entry)) {
    await ctx.reply('That trash entry is no longer available.');
    return showTrash(ctx);
  }
  await ctx.replyWithDocument(entry.backup_file_id, {
    caption: `📦 ${entry.original_name}`,
  });
}

/** 🗑️ Delete Forever — step 1, just opens the confirm screen (BLUE, per
 * the bot-wide rule that only the actual execute button is RED). */
async function confirmDeleteForever(ctx, trashId) {
  const entry = await trash.get(ctx.from.id, trashId);
  if (!trash.isAvailable(entry)) {
    await ctx.reply('That trash entry is no longer available.');
    return showTrash(ctx);
  }
  await ctx.reply(
    `⚠️ Permanently delete "${format.escapeMd(entry.original_name)}" from Trash\\?\n\nThis removes it from Trash for good — it won\u2019t be recoverable through the bot anymore\\.`,
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [style.callback('✅ Yes, Delete Forever', `trash:deleteforever:confirm:${trashId}`, style.RED)],
        [style.callback('❌ Cancel', `trash:deleteforever:cancel:${trashId}`, style.GREEN)],
      ]),
    }
  );
}

async function executeDeleteForever(ctx, trashId) {
  const removed = await trash.remove(ctx.from.id, trashId);
  await ctx.reply(removed ? format.successMessage('Deleted from Trash for good') : 'That trash entry is no longer available.');
  return showTrash(ctx);
}

/** ✏️ Edit & Restore — lets someone change the name/description/visibility
 * a repo will be restored under BEFORE committing to the restore, instead
 * of only finding out about a name collision after the fact. Edits land
 * directly on the trash entry itself (see lib/trash.js's update) so
 * requestRestore, which always re-fetches fresh, naturally picks them up. */
async function showEditRestore(ctx, trashId) {
  const entry = await trash.get(ctx.from.id, trashId);
  if (!trash.isAvailable(entry)) {
    await ctx.reply('That trash entry is no longer available.');
    return showTrash(ctx);
  }

  const text =
    `✏️ *Edit before restoring*\n\n` +
    `📛 Name: ${format.escapeMd(entry.original_name)}\n` +
    `📝 Description: ${entry.description ? format.escapeMd(entry.description) : '_None_'}\n` +
    `${format.visibilityLine(entry.visibility === 'private')}`;

  const rows = [
    [style.callback('📛 Edit Name', `trash:editname:${trashId}`), style.callback('📝 Edit Description', `trash:editdesc:${trashId}`)],
    [style.callback(entry.visibility === 'private' ? '🌐 Make Public' : '🔒 Make Private', `trash:togglevis:${trashId}`)],
    [style.callback('♻️ Restore Now', `trash:restore:${trashId}`, style.GREEN)],
    [style.callback('⬅️ Back', 'trash:back', style.BLUE)],
  ];
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

async function toggleEditRestoreVisibility(ctx, trashId) {
  const entry = await trash.get(ctx.from.id, trashId);
  if (!trash.isAvailable(entry)) {
    await ctx.reply('That trash entry is no longer available.');
    return showTrash(ctx);
  }
  await trash.update(ctx.from.id, trashId, 'visibility', entry.visibility === 'private' ? 'public' : 'private');
  return showEditRestore(ctx, trashId);
}

/** Text-input flows for editing name/description before restore, driven by
 * ctx.session.editingTrashRestore (see bot.js text router). */
async function startEditRestoreName(ctx, trashId) {
  ctx.session.editingTrashRestore = { trashId, field: 'name' };
  await ephemeral.sendEphemeral(ctx, '📛 Send the new name to restore this repo under.', bbtb.cancelOnly);
}

async function startEditRestoreDescription(ctx, trashId) {
  ctx.session.editingTrashRestore = { trashId, field: 'description' };
  await ephemeral.sendEphemeral(ctx, '📝 Send the new description (or "none" to clear it).', bbtb.cancelOnly);
}

async function handleEditRestoreTextInput(ctx) {
  const state = ctx.session.editingTrashRestore;
  delete ctx.session.editingTrashRestore;
  if (!state) return;

  if (ctx.message.text === '❌ Cancel') {
    await ctx.reply('Cancelled.');
    return showEditRestore(ctx, state.trashId);
  }

  const text = ctx.message.text.trim();
  if (state.field === 'name') {
    const nameCheck = require('../lib/repoName').validateRepoName(text);
    if (!nameCheck.ok) {
      await ctx.reply(format.errorMessage('Invalid repo name', nameCheck.error, 'Send a valid name, or ❌ Cancel.'));
      ctx.session.editingTrashRestore = state;
      return;
    }
    await trash.update(ctx.from.id, state.trashId, 'originalName', nameCheck.name);
  } else if (state.field === 'description') {
    const desc = text.toLowerCase() === 'none' ? null : text;
    await trash.update(ctx.from.id, state.trashId, 'description', desc);
  }

  await ephemeral.sendEphemeral(ctx, '✅ Updated.');
  return showEditRestore(ctx, state.trashId);
}

/** v1.2.5-multi: a repo deleted from account A must be restored into account A. True = refused (and explained). */
async function refuseOtherAccount(ctx, entry) {
  const target = await trash.restoreTarget(ctx.from.id, entry);
  if (target.ok) return false;
  await ctx.reply(
    `↩️ "${entry.original_name}" was deleted from @${target.account}, but you're using a different GitHub account right now.\n\n` +
    `Switch to @${target.account} first (💼 Workspace → Accounts), then restore it — it will go back where it came from.`
  );
  return true;
}

async function requestRestore(ctx, trashId) {
  const entry = await trash.get(ctx.from.id, trashId);
  if (!trash.isAvailable(entry)) {
    await ctx.reply('That trash entry is no longer available (already restored, or expired).');
    return showTrash(ctx);
  }

  const token = await requireConnected(ctx);
  if (!token) return;
  if (await refuseOtherAccount(ctx, entry)) return;

  const github = require('../lib/github');
  const repoCache = require('../lib/repoCache');
  const user = await repoCache.getUser(ctx.from.id, token);

  // Name-collision check — the whole point of asking first instead of just
  // trying and handling the 422: a person restoring something explicitly
  // wants their old repo back, not to accidentally learn mid-restore that
  // it collides with something newer they created under the same name.
  let exists = false;
  try {
    await github.getRepo(token, user.login, entry.original_name);
    exists = true;
  } catch (err) {
    if (err.status !== 404) {
      await ctx.reply(require('../lib/friendlyErrors').message('Couldn\u2019t check for a name conflict', err));
      return;
    }
  }

  if (exists) {
    ctx.session.awaitingTrashRestoreName = { trashId: entry.id };
    await ctx.reply(
      format.errorMessage(
        `"${entry.original_name}" already exists`,
        'a repo with this name is already in your account',
        'Send a different name to restore it under, or ❌ Cancel.'
      ),
      bbtb.cancelOnly
    );
    return;
  }

  return performRestore(ctx, entry, entry.original_name);
}

/** Called from the global text router (bot.js) once a replacement name
 * arrives after a collision was detected above. */
async function handleRestoreNameInput(ctx) {
  const state = ctx.session.awaitingTrashRestoreName;
  delete ctx.session.awaitingTrashRestoreName;
  if (!state) return;

  if (ctx.message.text === '❌ Cancel') {
    await ctx.reply('Restore cancelled.');
    return showTrash(ctx);
  }

  const entry = await trash.get(ctx.from.id, state.trashId);
  if (!trash.isAvailable(entry)) {
    await ctx.reply('That trash entry is no longer available.');
    return showTrash(ctx);
  }

  const nameCheck = require('../lib/repoName').validateRepoName(ctx.message.text);
  if (!nameCheck.ok) {
    await ctx.reply(format.errorMessage('Invalid repo name', nameCheck.error, 'Send a valid name, or ❌ Cancel.'));
    ctx.session.awaitingTrashRestoreName = state;
    return;
  }
  const newName = nameCheck.name;

  const token = await requireConnected(ctx);
  if (!token) return;
  if (await refuseOtherAccount(ctx, entry)) return;
  const github = require('../lib/github');
  const repoCache = require('../lib/repoCache');
  const user = await repoCache.getUser(ctx.from.id, token);
  try {
    await github.getRepo(token, user.login, newName);
    await ctx.reply(format.errorMessage(`"${newName}" also already exists`, 'pick a name that isn\u2019t already in your account', 'Send another name, or ❌ Cancel.'));
    ctx.session.awaitingTrashRestoreName = state;
    return;
  } catch (err) {
    if (err.status !== 404) {
      await ctx.reply(require('../lib/friendlyErrors').message('Couldn\u2019t check for a name conflict', err));
      ctx.session.awaitingTrashRestoreName = state;
      return;
    }
  }

  return performRestore(ctx, entry, newName);
}

/**
 * Restores a trashed repo (v1.2.3-multi flow):
 *   1. read the backup ZIP back from Telegram FIRST — if that fails, nothing has
 *      been created on GitHub, so there is nothing to clean up and a retry is clean;
 *   2. create the repo and commit every file in one commit;
 *   3. if anything fails after the repo exists, remove the placeholder repo we
 *      just made — but only after confirming it still holds nothing of the
 *      backup, so a restore that actually landed is never deleted.
 *
 * What a restore brings back: the files, the description and the visibility.
 * It does NOT bring back commit history, issues, stars, webhooks, topics or the
 * tags/pins GitroHub kept for the repo (those are removed when a repo is deleted).
 */
async function performRestore(ctx, entry, newName) {
  const token = await requireConnected(ctx);
  if (!token) return;

  if (entry.restorable === false) {
    await ctx.reply(
      `📦 "${entry.original_name}" was too large to restore in place (Telegram only lets a bot read back backups up to ${format.formatBytes(config.TELEGRAM_DOWNLOAD_LIMIT_BYTES)}). The backup is still safe — tap ⬇️ ZIP to get the file and re-create the repo from it.`
    );
    return showTrash(ctx);
  }

  await ctx.reply(`♻️ Restoring "${newName}"...`);

  const github = require('../lib/github');
  const repoCache = require('../lib/repoCache');
  const logger = require('../lib/logger');

  // Step 1 — read the backup before touching GitHub.
  let files;
  try {
    const fileLink = await ctx.telegram.getFileLink(entry.backup_file_id);
    const res = await fetch(fileLink.href, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`couldn\u2019t download the backup from Telegram (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());

    // Safe reader (lib/archive.js): decompression is hard-capped on the bytes
    // actually produced, not on sizes the zip declares about itself. The
    // backup is GitHub's own zipball, so it gets a larger ceiling than user
    // uploads, and macOS-junk filtering is off — a restore should be a
    // faithful copy. GitHub's zipball puts everything under a single
    // "<owner>-<repo>-<sha>/" folder; prepareEntries strips it.
    const { entries: zipEntries } = await require('../lib/archiveRunner').readZip(buffer, {
      maxTotalBytes: config.MAX_RESTORE_UNCOMPRESSED_BYTES,
      maxEntries: 10000,
      dropJunk: false,
    }, { userId: ctx.from.id });

    // README.md is intentionally included here — it overwrites auto_init's placeholder with the real backed-up one
    files = zipEntries.map((e) => ({ path: e.path, content: e.data })).filter((f) => f.path);
  } catch (err) {
    await ctx.reply(format.errorMessage(
      `Couldn\u2019t restore "${newName}"`,
      err.message,
      'Nothing was created on GitHub. Try again, or tap ⬇️ ZIP in 🗑️ Trash to get the backup file.'
    ));
    return;
  }

  // Step 2 — create the repo and commit.
  let repo = null;
  try {
    repo = await github.createRepo(token, {
      name: newName,
      isPrivate: entry.visibility === 'private',
      description: entry.description,
      org: await require('../lib/accounts').getActiveOwner(ctx.from.id).catch(() => null),
    });
    repoCache.invalidateRepos(ctx.from.id);

    if (files.length > 0) {
      await github.commitMultipleFiles(token, repo.owner.login, repo.name, files, 'Restore from Trash');
    }
  } catch (err) {
    // Step 3 — leave GitHub as we found it when we can prove the restore didn't land.
    let note = 'Try again, or use 🗑️ Trash to retry later.';
    if (repo) {
      const cleaned = await cleanupFailedRestore(token, repo.owner.login, repo.name, files);
      repoCache.invalidateRepos(ctx.from.id);
      if (cleaned === 'removed') note = 'I removed the empty repo I had just created, so you can simply try again.';
      else if (cleaned === 'landed') note = 'The files did reach GitHub though — check the repo before retrying.';
      else note = `I couldn\u2019t confirm what state "${repo.name}" is in — check it on GitHub (delete it if it\u2019s empty) before retrying.`;
    } else if (github.isUnknownOutcome(err)) {
      note = 'GitHub didn\u2019t confirm whether the repo was created — check your repo list before retrying.';
    }
    logger.warn('Trash restore failed', { telegramId: ctx.from.id, repo: newName, message: err.message });
    await ctx.reply(format.errorMessage(`Couldn\u2019t restore "${newName}"`, require('../lib/friendlyErrors').oneLine(err).replace(/\.$/, ''), note));
    return;
  }

  try {
    await trash.markRestored(ctx.from.id, entry.id);
  } catch (err) {
    logger.warn('Trash entry could not be marked restored (repo restored fine)', { telegramId: ctx.from.id, message: err.message });
  }
  const activity = require('../lib/activity');
  await activity.log(ctx.from.id, '♻️', `Restored from Trash → ${newName}`);

  await require('../lib/resultCard').send(ctx, {
    title: 'Repository restored',
    subject: `📦 *${format.escapeMd(repo.name)}*`,
    details: ['Brought back: all files, the description and the visibility.', 'Not brought back: commit history, issues, stars, webhooks, topics and your GitroHub tags/pins.'],
    link: repo.html_url,
  }, [[style.callback('📂 Open repo', `repo:open:${repo.name}`, style.BLUE)]]);
}

/**
 * After a failed restore: delete the repo we just created, but only if it
 * demonstrably still holds none of the backup. Returns 'removed' | 'landed' | 'unknown'.
 */
async function cleanupFailedRestore(token, owner, name, files) {
  try {
    const github = require('../lib/github');
    const { gitBlobSha } = require('../lib/gitHash');
    const tree = await github.getTree(token, owner, name);
    const placeholderOnly = tree.length === 0 || (
      tree.length === 1 && /^readme(\.md)?$/i.test(tree[0].path) &&
      !files.some((f) => f.path === tree[0].path && gitBlobSha(f.content) === tree[0].sha)
    );
    if (!placeholderOnly) return 'landed';
    await github.deleteRepo(token, owner, name);
    return 'removed';
  } catch (_) {
    return 'unknown';
  }
}

module.exports = {
  showTrash,
  downloadZip,
  confirmDeleteForever,
  executeDeleteForever,
  showEditRestore,
  toggleEditRestoreVisibility,
  startEditRestoreName,
  startEditRestoreDescription,
  handleEditRestoreTextInput,
  requestRestore,
  handleRestoreNameInput,
};
