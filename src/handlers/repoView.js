const github = require('../lib/github');
const config = require('../config');
const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const repoCache = require('../lib/repoCache');
const requireConnected = require('../lib/requireConnected');
const format = require('../lib/format');
const inline = require('../keyboards/inline');
const bbtb = require('../keyboards/bbtb');
const activity = require('../lib/activity');
const users = require('../lib/users');
const pins = require('../lib/pins');
const tags = require('../lib/tags');
const pathMemory = require('../lib/pathMemory');
const recentlyViewed = require('../lib/recentlyViewed');
const repoWebhooks = require('../lib/repoWebhooks');
const notificationMutes = require('../lib/notificationMutes');
const ephemeral = require('../lib/ephemeral');
const chatAction = require('../lib/chatAction');
const chrome = require('../lib/chrome');

/** #2 — undo history now holds up to 5 entries instead of just the single
 * most recent one; each gets its own id so a specific entry can be
 * reversed even if something else happened after it. */
const MAX_UNDO_HISTORY = 5;
function pushUndo(ctx, entry) {
  ctx.session.undoHistory = ctx.session.undoHistory || [];
  ctx.session.undoHistory.unshift({ id: Date.now(), ...entry });
  ctx.session.undoHistory = ctx.session.undoHistory.slice(0, MAX_UNDO_HISTORY);
  return ctx.session.undoHistory[0].id;
}

/**
 * Storage & Data's "auto-delete on repo deletion" setting — when on (the
 * default), removes any pins/tags/path-memory GitroHub kept for a repo the
 * moment it's actually deleted from GitHub, so orphaned data doesn't pile up.
 */
async function cleanupOrphanedData(telegramId, repoName) {
  // Webhook/mute rows are unconditional, regardless of the auto-cleanup
  // preference below — unlike pins/tags (legitimate to keep in case the
  // repo gets recreated), a webhook_id record serves no purpose once
  // GitHub itself has already deleted the webhook along with the repo.
  const repoWebhooks = require('../lib/repoWebhooks');
  const notificationMutes = require('../lib/notificationMutes');
  // v1.2.3-multi: pending scheduled uploads to this repo could only fail later, and Recently Viewed
  // would keep offering a repo that no longer exists — both are dropped with it.
  const [, , cancelledUploads] = await Promise.all([
    repoWebhooks.remove(telegramId, repoName),
    notificationMutes.unmute(telegramId, repoName),
    require('../lib/scheduledUploads').cancelForRepo(telegramId, repoName).catch(() => 0),
    require('../lib/recentlyViewed').removeForRepo(telegramId, repoName).catch(() => {}),
  ]);
  if (cancelledUploads > 0) {
    await activity.log(telegramId, '📅', `Cancelled ${cancelledUploads} scheduled upload${cancelledUploads === 1 ? '' : 's'} → ${repoName} (repo deleted)`, { isAutomated: true });
  }

  const user = await users.getUser(telegramId);
  if (!user || !user.auto_cleanup_on_delete) return;
  await Promise.all([
    pins.removeByRepoName(telegramId, repoName),
    tags.removeAllForRepo(telegramId, repoName),
    pathMemory.removeForRepo(telegramId, repoName),
  ]);
}

// v2.1.4: 📊 Details used to re-run the whole card load (repo, README, commits, tree…) — five GitHub calls just to show
// two more lines. What the card just loaded is now kept for a minute and Details reuses it, so tapping it costs no GitHub calls.
const VIEW_TTL_MS = 90 * 1000;
const { BoundedMap } = require('../lib/boundedMap');
const viewCache = new BoundedMap({ max: 300, name: 'repoViewCache' });
const warmView = (key) => {
  const v = viewCache.get(key);
  return v && Date.now() - v.at < VIEW_TTL_MS ? v : null;
};

async function showRepoView(ctx, repoName, { detail = false, edit = false } = {}) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const viewKey = `${ctx.from.id}:${repoName}`;
  const warm = detail ? warmView(viewKey) : null;

  let repo;
  try {
    if (warm) repo = warm.repo;
    else {
      const user = await repoCache.getUser(ctx.from.id, token);
      repo = await github.getRepo(token, user.login, repoName);
    }
  } catch (err) {
    const slow = require('../lib/rateLimitFriendly').describe(err);
    if (slow) {
      return ctx.reply(slow.text, Markup.inlineKeyboard([[style.callback('🔄 Try again', `repo:open:${repoName}`, style.BLUE)]]));
    }
    return ctx.reply(format.errorMessage(
      `Couldn\u2019t open "${repoName}"`,
      err.status === 404 ? 'repository not found or was renamed' : err.message,
      'Go back and refresh your repo list.'
    ));
  }

  // Language % breakdown (all languages, not just the dominant one) and real
  // tree-derived size/file/folder counts — both best-effort, since an empty
  // repo has no tree/languages at all and shouldn't block the rest of the card.
  //
  // v1.1.21-multi: these two used to be awaited one after the other, and only
  // THEN did the pins/tags/README/commits block below start — five
  // independent GitHub/DB reads run back-to-back, so opening a repo cost the
  // sum of all their latencies. They share no inputs, so they now all start
  // together (see the single Promise.all below) and cost the slowest one.
  const languagesP = repoCache.getLanguages(ctx.from.id, repo.owner.login, repo.name, token)
    .then((languages) => format.languageBreakdown(languages))
    .catch(() => repo.language || 'No language detected');
  const treeStatsP = repoCache.getTreeStats(ctx.from.id, repo.owner.login, repo.name, token, repo.default_branch || null, { sizeKb: repo.size })
    .catch(() => null); // empty/new repo — fall back to repo.size below

  const [langBreakdown, treeStats, pinned, repoTags, readmeResult, commits] = await Promise.all([
    languagesP,
    treeStatsP,
    pins.isPinned(ctx.from.id, repo.name),
    tags.tagsForRepo(ctx.from.id, repo.name),
    // README preview (#14) and the health flag's hasReadme (#15) share this
    // one fetch — success means it exists (and gives us preview text),
    // 404 means it doesn't, anything else is treated as "unknown, don't
    // penalize the health flag for a fetch error that isn't really about
    // the repo".
    warm ? warm.readmeResult : github.getFileContent(token, repo.owner.login, repo.name, 'README.md')
      .then((f) => ({ exists: true, content: f.content.toString('utf8') }))
      .catch((err) => ({ exists: err.status === 404 ? false : undefined, content: null })),
    warm ? warm.commits : github.getRecentCommits(token, repo.owner.login, repo.name, 3).catch(() => []),
  ]);
  if (!warm) viewCache.set(viewKey, { repo, readmeResult, commits, at: Date.now() });

  // #56 — language breakdown is also GitHub's own async background scan
  // (linguist), not synchronous with a commit. "No language detected" is
  // only genuinely correct for a truly empty repo (fileCount === 0) — if
  // the repo actually has files but the breakdown still came back empty,
  // that's the specific symptom of detection not having caught up yet
  // (right after Create Repo, Replace Folder, or a first Upload), not a
  // real absence of code. Caveat it instead of stating it as settled fact.
  const langLagNote = (langBreakdown === 'No language detected' && treeStats && treeStats.fileCount > 0)
    ? '\n_\\(GitHub may still be detecting this — check back in a minute if it should have one\\.\\)_'
    : '';

  const tagLine = repoTags.length > 0
    ? `🏷️ ${format.escapeMd(repoTags.map((t) => tags.tagLabel(t)).join(' · '))}`
    : '';

  // Forked-from (#1) — GitHub's single-repo GET already includes `parent`
  // for forks, no extra call needed; the repo LIST endpoint doesn't, which
  // is why list screens only show a plain "🍴 Fork" badge, not the source.
  const forkedFrom = repo.fork && repo.parent ? repo.parent.full_name : undefined;

  const card = format.repoCard(repo, {
    pinned,
    sizeBytes: treeStats ? treeStats.sizeBytes : undefined,
    tagLine,
    forkedFrom,
    hasReadme: readmeResult.exists,
  });

  const fileFolderLine = treeStats
    ? `▸ ${treeStats.fileCount} files · ${treeStats.folderCount} folders${treeStats.sizeIncomplete ? ' (size is a lower bound — some very large files weren\u2019t sized)' : ''}\n`
    : '';

  // #11 — last-synced note, since tree-based sizes are cached (not live)
  const syncedNote = treeStats && treeStats.fetchedAt
    ? `▸ 🕓 Size as of ${format.escapeMd(format.relativeTime(treeStats.fetchedAt))}\n`
    : '';

  // #7 — rename history note, only within the last 2 weeks so it doesn't
  // linger indefinitely once it's no longer useful context
  const renameInfo = await activity.recentRename(ctx.from.id, repo.name, 14).catch(() => null);
  const renameNote = renameInfo
    ? `▸ ✏️ Renamed from *${format.escapeMd(renameInfo.previousName)}* ${format.escapeMd(format.relativeTime(renameInfo.renamedAt))}\n`
    : '';

  // README preview (#14) — first 3 non-empty lines, truncated hard so a huge
  // README can't blow out the message.
  let readmeSection = '';
  if (readmeResult.exists && readmeResult.content) {
    const lines = readmeResult.content.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3);
    const preview = lines.join('\n').slice(0, 240);
    readmeSection = `\n\n📖 *README PREVIEW*\n${format.escapeMd(preview)}${readmeResult.content.length > 240 ? '…' : ''}`;
  }

  // Last commits preview (#5)
  let commitsSection = '';
  if (commits.length) {
    const lines = commits.map((c) => `▸ \`${c.sha}\` ${format.escapeMd(c.message)} — ${format.escapeMd(format.relativeTime(c.date))}`);
    commitsSection = `\n\n📜 *RECENT COMMITS*\n${lines.join('\n')}`;
  }

  // v1.4.0-multi — the default card is a GLANCE: what the repo is, in about six lines. Languages, README preview, recent
  // commits and the small print sit one tap deeper behind 📊 Details instead of making every visit a wall of text.
  const glanceText = glanceCard(repo, { pinned, treeStats, tagLine, forkedFrom, readmeExists: readmeResult.exists });

  const detailText =
    `${card}\n\n` +
    `💻 *LANGUAGES*\n${format.escapeMd(langBreakdown)}${langLagNote}\n\n` +
    `📊 *DETAILS*\n` +
    fileFolderLine +
    syncedNote +
    renameNote +
    `▸ Last commit: ${format.escapeMd(format.relativeTime(repo.pushed_at))}\n` +
    `▸ Created: ${format.escapeMd(format.relativeTime(repo.created_at))}` +
    commitsSection +
    readmeSection;
  const text = detail ? detailText : glanceText;

  ctx.session = ctx.session || {};
  ctx.session.currentRepo = repo.name;
  ctx.session.repoOwner = repo.owner.login;
  ctx.session.repoUrl = repo.html_url; // feeds Clone URL / Open in Browser buttons
  ctx.session.repoHasReadme = !!(readmeResult && readmeResult.exists); // lets ⋯ More show the README button

  // Surprise feature — recently viewed, best-effort, never blocks the view itself
  recentlyViewed.record(ctx.from.id, repo.name).catch(() => {});

  // #1 — webhook/notifications state for this repo
  const webhookReg = await repoWebhooks.get(ctx.from.id, repo.name).catch(() => null);
  let webhookState = 'none';
  if (webhookReg) {
    const muted = await notificationMutes.isMuted(ctx.from.id, repo.name).catch(() => false);
    webhookState = muted ? 'muted' : 'active';
  }

  if (detail) {
    const back = Markup.inlineKeyboard([[style.callback('⬅️ Back to repo', `repo:open:${repo.name}`, style.BLUE)]]);
    await chrome.setBar(ctx, 'repo');
    const edited = ctx.callbackQuery && (await require('../lib/safeEdit').safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...back }));
    if (!edited) await ctx.reply(text, { parse_mode: 'MarkdownV2', ...back });
    return;
  }

  // 🤖 Automation — an unapplied auto-tag rule that matches this repo becomes one extra button on the card itself
  // (a separate message would replace the card as "the live screen").
  let suggestion = null;
  try {
    const matches = await tags.evaluateAutoRules(ctx.from.id, repo);
    const already = new Set(repoTags.map((t) => t.id));
    suggestion = matches.find((m) => !already.has(m.id)) || null;
  } catch (_) { /* non-fatal — Automation suggestions are a bonus, not a dependency */ }

  const actions = inline.repoActions(repo.name, pinned, repo.html_url, webhookState, readmeResult.exists, require('./manage').hasRepoAreas());
  if (suggestion) {
    actions.reply_markup.inline_keyboard.splice(-1, 0, [style.callback(`🤖 Apply tag ${suggestion.emoji} ${suggestion.name}`, `automation:applysuggested:${repo.name}:${suggestion.id}`, style.GREEN)]);
  }
  const extra = { parse_mode: 'MarkdownV2', ...actions };
  await chrome.setBar(ctx, 'repo');
  if ((edit || ctx.callbackQuery) && (await require('../lib/safeEdit').safeEditMessageText(ctx, text, extra))) return;
  await ctx.reply(text, extra);
}

/** The short repo card (v2.0.0-multi): what it is in about five lines — empty stats and healthy licence never shown. */
function glanceCard(repo, { pinned, treeStats, tagLine, forkedFrom, readmeExists }) {
  const e = format.escapeMd;
  const head = `📦 *${e(repo.name)}*  ${repo.private ? '🔒 Private' : '🌐 Public'}${pinned ? '  📌' : ''}${repo.archived ? '  🗄️ Archived' : ''}`;
  const lines = [head];
  if (forkedFrom || repo.fork) lines.push(`🍴 Fork${forkedFrom ? ` of ${e(forkedFrom)}` : ''}`);
  lines.push(repo.description ? `_${e(repo.description)}_` : '_No description yet_');
  const bytes = treeStats ? treeStats.sizeBytes : (repo.size || 0) * 1024;
  const facts = [
    repo.language ? `💻 ${e(repo.language)}` : '',
    bytes ? `💾 ${e(format.formatBytes(bytes))}` : '',
    repo.stargazers_count ? `⭐ ${repo.stargazers_count}` : '',
    repo.forks_count ? `🍴 ${repo.forks_count}` : '',
  ].filter(Boolean);
  if (facts.length) lines.push('', facts.join('  ·  '));
  const when = repo.pushed_at || repo.updated_at;
  const counts = treeStats ? `📄 ${treeStats.fileCount} files · 📂 ${treeStats.folderCount} folders` : '';
  const meta = [counts, when ? `🕒 ${e(format.relativeTime(when))}` : ''].filter(Boolean).join('  ·  ');
  if (meta) lines.push(meta);
  if (tagLine) lines.push(tagLine);
  const missing = [];
  if (readmeExists === false) missing.push('README');
  if (!repo.description) missing.push('description');
  const hasLicense = repo.license && repo.license.spdx_id && repo.license.spdx_id !== 'NOASSERTION';
  if (!hasLicense) missing.push('license');
  if (missing.length) lines.push(`⚠️ Missing: ${e(missing.join(', '))}`);
  return lines.join('\n');
}

async function askDeleteRepo(ctx, repoName) {
  await ctx.reply(
    `⚠️ Delete "${format.escapeMd(repoName)}" from GitHub? \nA backup is kept in 🗑️ Trash \\(Settings → 📦 Storage\\) for a while in case you change your mind\\.`,
    { parse_mode: 'MarkdownV2', ...inline.deleteRepoConfirm(repoName) }
  );
}

async function executeDeleteRepo(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const actionLock = require('../lib/actionLock');
  const { skipped } = await actionLock.withLock(ctx.from.id, 'deleteRepo', async () => {
    try {
      const user = await repoCache.getUser(ctx.from.id, token);
      const repo = await github.getRepo(token, user.login, repoName);

      // 🗑️ Trash — back up before the real GitHub delete happens. If the
      // backup itself fails for any reason, the person gets a clear
      // warning and a chance to bail rather than silently losing the
      // safety net GitroHub just told them they'd have.
      let backup;
      try {
        backup = await require('../lib/trashBackup').backupRepoToTrash(ctx, { token, owner: user.login, repo });
      } catch (backupErr) {
        await ctx.reply(format.errorMessage(
          'Couldn\u2019t back up before deleting',
          backupErr.message,
          `Nothing was deleted. Open "${repoName}" and tap 🗑️ Delete Repo again to retry, or use ⬇️ Download ZIP and delete it manually on GitHub if this keeps failing.`
        ));
        return;
      }
      const backupNote = ` — backed up to 🗑️ Trash for ${backup.retentionLabel}${backup.restorable ? '' : ' (ZIP only)'}`;

      try {
        await github.deleteRepo(token, user.login, repoName);
        require('../lib/sensitiveActions').note(ctx, { action: 'repo_delete', repo: repoName, owner: user.login }).catch(() => {});
      } catch (deleteErr) {
        // The delete clearly did not happen: don't leave a Trash entry for a
        // repo that still exists (a restore of it would only hit a name clash).
        // If GitHub never confirmed either way, keep the entry — the repo may be gone.
        if (!github.isUnknownOutcome(deleteErr)) {
          await require('../lib/trash').remove(ctx.from.id, backup.trashEntry.id).catch(() => {});
        }
        throw deleteErr;
      }
      repoCache.invalidateRepos(ctx.from.id);
      repoCache.invalidateLanguages(ctx.from.id, repoName);
      repoCache.invalidateTreeStats(ctx.from.id, repoName);
      await activity.log(ctx.from.id, '🗑', `Deleted repo → ${repoName}${backupNote}`);
      await cleanupOrphanedData(ctx.from.id, repoName);
      await require('../lib/resultCard').send(ctx, {
        title: 'Repository deleted',
        subject: `📦 *${format.escapeMd(repoName)}*`,
        details: [backup.restorable
          ? `Recoverable from 🗑️ Trash for ${backup.retentionLabel}.`
          : 'The backup ZIP is in 🗑️ Trash. It\u2019s too large to restore in place — re-create the repo from the ZIP if you need it back.'],
      }, [[style.callback('📁 My Repos', 'nav:repos', style.BLUE)]]);
      await chrome.setBar(ctx, 'repos');
    } catch (err) {
      await activity.log(ctx.from.id, '⚠️', `Delete repo failed → ${repoName}`, { detail: err.message, isError: true });
      // Single reply, not two — this used to ALSO send a hardcoded
      // "check your token permissions" follow-up after replyGithubError
      // had already replied, for literally any non-auth failure
      // (including a rate limit hit, where "check your token
      // permissions" is actively wrong advice). replyGithubError's own
      // generic fallback already surfaces GitHub's real message, which
      // for a delete-permission failure is normally self-explanatory
      // ("Must have admin rights to Repository.").
      const errorHelpers = require('../lib/errorHelpers');
      await errorHelpers.replyGithubError(ctx, err, `Couldn\u2019t delete "${repoName}"`);
    }
  });
  if (skipped) await ctx.reply('⏳ Already processing — please wait a moment.');
}

async function askToggleVisibility(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const user = await repoCache.getUser(ctx.from.id, token);
  const repo = await github.getRepo(token, user.login, repoName);

  const text = repo.private
    ? `🔒 *${format.escapeMd(repoName)}* is currently Private\\.\n\nSwitching to Public will:\n• Make the code visible to anyone\n• Show it in your public GitHub profile`
    : `🌐 *${format.escapeMd(repoName)}* is currently Public\\.\n\nSwitching to Private will:\n• Hide it from search and public listings\n• Revoke access for anyone who isn\u2019t a collaborator`;

  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...inline.visibilityConfirm(repoName, repo.private) });
}

async function executeToggleVisibility(ctx, repoName, target = null) {
  const actionLock = require('../lib/actionLock');
  const { skipped } = await actionLock.withLock(ctx.from.id, 'toggleVisibility', () => _executeToggleVisibility(ctx, repoName, target));
  if (skipped) await ctx.reply('⏳ Already processing — please wait a moment.');
}

async function _executeToggleVisibility(ctx, repoName, target = null) {
  const token = await requireConnected(ctx);
  if (!token) return;

  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    const repo = await github.getRepo(token, user.login, repoName);
    const wasPrivate = repo.private;
    // The confirm button names the visibility it was rendered for. Acting on
    // THAT (not "the opposite of whatever it is right now") makes a repeated
    // or stale tap a harmless no-op instead of silently flipping it back.
    const wantPrivate = target ? target === 'private' : !repo.private;
    if (wasPrivate === wantPrivate) {
      await ctx.reply(`ℹ️ ${repoName} is already ${wantPrivate ? '🔒 Private' : '🌐 Public'} — nothing to change.`);
      return;
    }
    const updated = await github.setVisibility(token, user.login, repoName, wantPrivate);
    require('../lib/sensitiveActions').note(ctx, { action: 'visibility_change', repo: repoName, owner: user.login, detail: wantPrivate ? 'to private' : 'to public' }).catch(() => {});
    repoCache.invalidateRepos(ctx.from.id);
    await activity.log(ctx.from.id, '🔒', `Visibility changed → ${repoName} (${repo.private ? 'Private→Public' : 'Public→Private'})`);
    // #2 — Undo, now pushed into a short history list instead of a single slot
    const undoId = pushUndo(ctx, { type: 'visibility', repoName, previousValue: wasPrivate });
    await ctx.reply(format.successMessage(
      `Visibility updated: ${repoName} is now ${updated.private ? '🔒 Private' : '🌐 Public'}`
    ));
    await ctx.reply('You can undo this if it was a mistake:', Markup.inlineKeyboard([[style.callback('↩️ Undo', `undo:action:${undoId}`)]]));
  } catch (err) {
    await activity.log(ctx.from.id, '⚠️', `Visibility change failed → ${repoName}`, { detail: err.message, isError: true });
    const errorHelpers = require('../lib/errorHelpers');
    const github = require('../lib/github');
    // A plain permission-scope 403 — checked BEFORE calling
    // replyGithubError (and returning instead of also calling it), not
    // calling replyGithubError AND then unconditionally replying again
    // for anything that wasn't specifically an auth error. The old code
    // did both, which meant a rate limit hit here (primary or
    // secondary — also 403s) showed its own correct message immediately
    // followed by a second, unrelated "check your token permissions"
    // one. Excludes rate-limit 403s explicitly since those already have
    // their own correct, specific handling in replyGithubError. The
    // check itself used to be `err.message.includes('403')` — looking
    // for the literal digits "403" in GitHub's error text, which it
    // essentially never contains (GitHub's message for this is usually
    // just "Must have admin rights to Repository."), so this hint could
    // never actually fire; `err.status === 403` is the real signal.
    if (err.status === 403 && !github.isRateLimitError(err) && !github.isSecondaryRateLimitError(err) && !errorHelpers.isAuthError(err)) {
      await ctx.reply(format.errorMessage(
        'Couldn\u2019t change visibility',
        'your token may not have admin rights on this repo',
        'Try reconnecting GitHub with full scope.'
      ));
      return;
    }
    await errorHelpers.replyGithubError(ctx, err, 'Couldn\u2019t change visibility');
  }
}

/** ✏️ Description — low-risk/instantly-reversible, unlike
 * Rename (which affects clone URLs), so no confirm step, matching how
 * Description is entered during Create Repo (type it, move on). */
async function askEditDescription(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;

  ctx.session.editingDescription = repoName;
  const user = await repoCache.getUser(ctx.from.id, token);
  const repo = await github.getRepo(token, user.login, repoName);
  ctx.session.editingDescriptionPrevious = repo.description || ''; // feeds #11 Undo
  await ctx.reply(
    `✏️ Current description: ${repo.description ? `"${repo.description}"` : '(none)'}\n\nSend a new description, or ⏭️ Skip to clear it.`,
    bbtb.cancelWithSkip
  );
}

/** Called from the text router when ctx.session.editingDescription is set */
async function handleDescriptionInput(ctx, text) {
  const repoName = ctx.session.editingDescription;
  delete ctx.session.editingDescription;
  if (!repoName) return;

  const token = await requireConnected(ctx);
  if (!token) return;

  const description = text === '⏭️ Skip' ? '' : text.trim();
  const previousDescription = ctx.session.editingDescriptionPrevious || '';
  delete ctx.session.editingDescriptionPrevious;
  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    await github.updateDescription(token, user.login, repoName, description);
    repoCache.invalidateRepos(ctx.from.id);
    await activity.log(ctx.from.id, '✏️', `Description updated → ${repoName}`);
    // #2 — Undo. Colorless: a value pick, same as any other adjustment.
    const undoId = pushUndo(ctx, { type: 'description', repoName, previousValue: previousDescription });
    await require('../lib/resultCard').send(ctx, {
      title: 'Description updated',
      subject: `📦 *${format.escapeMd(repoName)}*`,
      details: [description || 'Description cleared'],
    }, [[style.callback('↩️ Undo', `undo:action:${undoId}`), style.callback('📂 Open repo', `repo:open:${repoName}`, style.BLUE)]]);
  } catch (err) {
    await activity.log(ctx.from.id, '⚠️', `Description update failed → ${repoName}`, { detail: err.message, isError: true });
    // v1.1.22 — the flag was cleared above, so a rejected description (too
    // long, GitHub hiccup) used to leave the NEXT message with nothing
    // listening and the person stuck until Cancel. Keep the prompt open so
    // the corrected text is actually read. Auth errors are the exception —
    // retrying can't help, so those fall through to the normal repo view.
    const errorHelpers = require('../lib/errorHelpers');
    if (!errorHelpers.isAuthError(err)) {
      ctx.session.editingDescription = repoName;
      ctx.session.editingDescriptionPrevious = previousDescription;
      await ctx.reply(format.errorMessage(
        'Couldn\u2019t update description',
        err.message,
        'Send a new description (GitHub allows up to 350 characters), tap \u23ed\ufe0f Skip to clear it, or \u274c Cancel.'
      ));
      return;
    }
    await ctx.reply(require('../lib/friendlyErrors').message('Couldn\u2019t update description', err));
  }
  return showRepoView(ctx, repoName);
}

const LICENSE_OPTIONS = [
  ['mit', 'MIT'],
  ['apache-2.0', 'Apache 2.0'],
  ['gpl-3.0', 'GPL v3'],
  ['bsd-3-clause', 'BSD'],
];

/** ⚖️ License — GitHub has no "set license" API field; a
 * repo's detected license comes from GitHub actually scanning a LICENSE
 * file (licensee). Same mechanism as the visibility flow otherwise:
 * show current state, confirm before changing. */
async function showLicenseMenu(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const user = await repoCache.getUser(ctx.from.id, token);
  const repo = await github.getRepo(token, user.login, repoName);
  const current = repo.license ? (repo.license.name || repo.license.spdx_id) : 'No license';

  const rows = LICENSE_OPTIONS.map(([key, label]) =>
    [style.callback(label, `repo:license:confirm:${repoName}:${key}`, style.GREEN)]
  );
  rows.push([style.callback('🚫 None', `repo:license:confirm:${repoName}:none`, style.GREEN)]);
  rows.push([style.callback('❌ Cancel', `repo:license:cancel:${repoName}`, style.RED)]);

  await ctx.reply(
    `⚖️ *${format.escapeMd(repoName)}* — current license: ${format.escapeMd(current)}\n\nChoose a new one, or ❌ Cancel:`,
    { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) }
  );
}

async function executeSetLicense(ctx, repoName, licenseKey) {
  const actionLock = require('../lib/actionLock');
  const { skipped } = await actionLock.withLock(ctx.from.id, 'setLicense', () => _executeSetLicense(ctx, repoName, licenseKey));
  if (skipped) await ctx.reply('⏳ Already processing — please wait a moment.');
}

async function _executeSetLicense(ctx, repoName, licenseKey) {
  const token = await requireConnected(ctx);
  if (!token) return;

  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    if (licenseKey === 'none') {
      // Remove the existing LICENSE file, if any — this is what makes the
      // repo show "No license" again (GitHub can't be told directly).
      try {
        const existing = await github.getFileContent(token, user.login, repoName, 'LICENSE');
        await github.deleteFile(token, user.login, repoName, 'LICENSE', existing.sha, 'Remove license');
      } catch (_) { /* no LICENSE file existed — nothing to remove */ }
    } else {
      const body = await github.getLicenseText(token, licenseKey);
      let existingSha = null;
      try {
        const existing = await github.getFileContent(token, user.login, repoName, 'LICENSE');
        existingSha = existing.sha;
      } catch (_) { /* no existing LICENSE file — creating fresh */ }
      await github.putFile(token, user.login, repoName, 'LICENSE', body, 'Update license', existingSha);
    }
    repoCache.invalidateRepos(ctx.from.id);
    repoCache.invalidateTreeStats(ctx.from.id, repoName);
    await activity.log(ctx.from.id, '⚖️', `License updated → ${repoName} (${licenseKey})`);
    // #55 — GitHub's license detection is an async background scan
    // (licensee), not synchronous with the commit. Re-showing the repo
    // card immediately would display GitHub's still-stale answer as if it
    // were current — misleading, since it visibly "catches up" a minute
    // later with no action from the person. Confirm the commit succeeded
    // without claiming the shown license is already accurate, and let
    // them check back on their own terms instead of auto-rendering it.
    await ctx.reply(
      `✅ License commit pushed to ${repoName}.\n\n⏳ GitHub can take a moment to actually detect the new license from the file — if it still shows the old one when you check, give it a minute and look again.`,
      Markup.inlineKeyboard([[style.callback(`📦 View ${repoName}`, `repo:${repoName}`)]])
    );
  } catch (err) {
    await activity.log(ctx.from.id, '⚠️', `License update failed → ${repoName}`, { detail: err.message, isError: true });
    await ctx.reply(require('../lib/friendlyErrors').message('Couldn\u2019t update license', err));
    return showRepoView(ctx, repoName);
  }
}

/** #3 — Clone URL, sent as its own message so the ```code block``` is
 * easily tap-to-copy in Telegram. */
async function showCloneUrl(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const user = await repoCache.getUser(ctx.from.id, token);
  const repo = await github.getRepo(token, user.login, repoName);
  // SSH and gh-cli variants alongside HTTPS, each its own code
  // block so any one of the three is independently tap-to-copy.
  const sshUrl = `git@github.com:${user.login}/${repoName}.git`;
  await ctx.reply(
    `📋 *Clone ${format.escapeMd(repoName)}*\n\n` +
    `HTTPS:\n\`\`\`\ngit clone ${format.escapeCodeBlock(repo.clone_url)}\n\`\`\`\n` +
    `SSH:\n\`\`\`\ngit clone ${format.escapeCodeBlock(sshUrl)}\n\`\`\`\n` +
    `GitHub CLI:\n\`\`\`\ngh repo clone ${format.escapeCodeBlock(user.login + '/' + repoName)}\n\`\`\``,
    { parse_mode: 'MarkdownV2' }
  );
}

/** #2 — undo by specific id, since undo history now holds up to 5 entries
 * rather than a single slot; reversing an older entry doesn't require
 * reversing everything after it too. */
async function undoAction(ctx, undoId) {
  const history = ctx.session.undoHistory || [];
  const idx = history.findIndex((h) => String(h.id) === String(undoId));
  if (idx === -1) {
    return ctx.reply('That undo has expired or was already used.');
  }
  const undo = history[idx];
  ctx.session.undoHistory = history.filter((_, i) => i !== idx);
  const token = await requireConnected(ctx);
  if (!token) return;

  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    if (undo.type === 'visibility') {
      await github.setVisibility(token, user.login, undo.repoName, undo.previousValue);
      repoCache.invalidateRepos(ctx.from.id);
      await activity.log(ctx.from.id, '↩️', `Undid visibility change → ${undo.repoName}`);
    } else if (undo.type === 'description') {
      await github.updateDescription(token, user.login, undo.repoName, undo.previousValue);
      repoCache.invalidateRepos(ctx.from.id);
      await activity.log(ctx.from.id, '↩️', `Undid description change → ${undo.repoName}`);
    }
    await ctx.reply(format.successMessage('Undone — reverted to the previous value.'));
    return showRepoView(ctx, undo.repoName);
  } catch (err) {
    await ctx.reply(format.errorMessage('Couldn\u2019t undo', require('../lib/friendlyErrors').oneLine(err).replace(/\.$/, ''), 'You can change it back manually from Repo View.'));
  }
}

/** #1 — first tap on a repo registers a real GitHub webhook pointed at our
 * /webhook/github endpoint; subsequent taps just toggle mute (the webhook
 * itself stays registered, we just skip sending while muted, avoiding a
 * delete+recreate round trip with GitHub for something reversible locally). */
async function toggleWebhookEnable(ctx, repoName) {
  // Locked, same as every other write action here — without this, a fast
  // double-tap before the screen re-renders (the button only disappears
  // once Repo View redraws) could register two live webhooks on GitHub for
  // the same repo. Only the second's id/secret would ever get saved, so
  // the first becomes an orphan that keeps firing and failing signature
  // verification forever, with no way to clean it up from inside the bot.
  const actionLock = require('../lib/actionLock');
  const { skipped } = await actionLock.withLock(ctx.from.id, 'webhookEnable', () => _toggleWebhookEnable(ctx, repoName));
  if (skipped) await ctx.reply('⏳ Already processing — please wait a moment.');
}

async function _toggleWebhookEnable(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  try {
    // Already registered (a repeated tap, or an old button): never create a
    // second GitHub webhook — just redraw the screen.
    const user = await repoCache.getUser(ctx.from.id, token);
    const existingHook = await repoWebhooks.get(ctx.from.id, repoName);
    if (existingHook) {
      // v1.2.4-multi: alerts are stored per repo NAME. If that name is already registered for a different
      // owner (another account or organisation with a same-named repo), refuse instead of overwriting it.
      if (existingHook.owner_login && String(existingHook.owner_login).toLowerCase() !== String(user.login).toLowerCase()) {
        await ctx.reply(format.errorMessage(
          'Live alerts are already on for a different repo with this name',
          `“${repoName}” is already registered under ${existingHook.owner_login}`,
          `Turn those alerts off first (open ${existingHook.owner_login}/${repoName} → Live alerts), then enable them here.`
        ));
      }
      return showRepoView(ctx, repoName);
    }
    const crypto = require('crypto');
    const secret = crypto.randomBytes(24).toString('hex');
    const hook = await github.createWebhook(token, user.login, repoName, `${config.BASE_URL}/webhook/github`, secret);
    await repoWebhooks.save(ctx.from.id, repoName, hook.id, secret, { ownerLogin: user.login, accountLogin: user.personalLogin || user.login });
    await activity.log(ctx.from.id, '🔔', `Live alerts enabled → ${repoName}`);

    // 🤖 Automation — check Auto-Mute rules immediately against this repo,
    // same as they'd apply on the next ▶️ Run Rules Now, so a repo that
    // matches (e.g. "mute all forks") never sits un-muted just because it
    // happened to have alerts enabled between now and the next manual run.
    let mutedNote = '';
    try {
      const muteRules = require('../lib/automationMuteRules');
      const repo = await github.getRepo(token, user.login, repoName);
      const matches = await muteRules.evaluateMuteRules(ctx.from.id, repo);
      if (matches.length > 0) {
        await notificationMutes.mute(ctx.from.id, repoName);
        await activity.log(ctx.from.id, '🔕', `Auto-mute rule applied → ${repoName}`, { isAutomated: true });
        mutedNote = ' (auto-muted — matches an Auto-Mute rule)';
      }
    } catch (_) { /* non-fatal — Auto-Mute is a bonus check, not a dependency of enabling alerts */ }

    await ephemeral.sendEphemeral(ctx, format.successMessage(`Live alerts enabled for ${repoName}${mutedNote}.`));
  } catch (err) {
    await ctx.reply(format.errorMessage('Couldn\u2019t enable live alerts', require('../lib/friendlyErrors').oneLine(err).replace(/\.$/, ''), 'Check the bot has admin access to this repo, then try again.'));
  }
  return showRepoView(ctx, repoName);
}

async function toggleWebhookMute(ctx, repoName, target = null) {
  const muted = await notificationMutes.isMuted(ctx.from.id, repoName);
  // target = 'mute' | 'unmute' when the button said which one it meant; if the
  // repo is already in that state the tap is a no-op (see rapidTap.js).
  if ((target === 'mute' && muted) || (target === 'unmute' && !muted)) return showRepoView(ctx, repoName);
  if (muted) {
    await notificationMutes.unmute(ctx.from.id, repoName);
    await ephemeral.sendEphemeral(ctx, format.successMessage(`Unmuted — you\u2019ll get alerts for ${repoName} again.`));
  } else {
    await notificationMutes.mute(ctx.from.id, repoName);
    await ephemeral.sendEphemeral(ctx, format.successMessage(`Muted — ${repoName} won\u2019t send alerts until you unmute it.`));
  }
  return showRepoView(ctx, repoName);
}

/** #12 — dumps everything GitroHub itself knows about a repo (not a GitHub
 * data export) as a downloadable JSON file: tags, pin status, and whatever
 * local metadata exists, for backup/review purposes. */
async function exportRepoJson(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    const repo = await github.getRepo(token, user.login, repoName);
    const [pinned, repoTags] = await Promise.all([
      pins.isPinned(ctx.from.id, repoName),
      tags.tagsForRepo(ctx.from.id, repoName),
    ]);
    const exportData = {
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      private: repo.private,
      html_url: repo.html_url,
      clone_url: repo.clone_url,
      license: repo.license ? repo.license.spdx_id : null,
      created_at: repo.created_at,
      pushed_at: repo.pushed_at,
      gitrohub: {
        pinned,
        tags: repoTags.map((t) => ({ name: t.name, emoji: t.emoji })),
        exported_at: new Date().toISOString(),
      },
    };
    // v1.2.1-multi: sent straight from memory. The old code wrote /tmp/<repoName>-export.json —
    // two users exporting repos with the SAME NAME at the same moment shared (and overwrote) one
    // file, so one could be sent the other's data — and used a blocking sync write.
    await ctx.replyWithDocument({ source: Buffer.from(JSON.stringify(exportData, null, 2), 'utf8'), filename: `${repoName}-export.json` });
  } catch (err) {
    await ctx.reply(require('../lib/friendlyErrors').message('Couldn\u2019t export repo data', err));
  }
}

/** #8 — sends the full README as a document, alongside the truncated
 * preview already shown inline (reuses browseFiles' send-as-document idea). */
async function sendFullReadme(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    const file = await github.getFileContent(token, user.login, repoName, 'README.md');
    // v1.2.1-multi: from memory, not a shared /tmp/<repoName>-README.md (same-name collision across users).
    await ctx.replyWithDocument({ source: file.content, filename: 'README.md' });
  } catch (err) {
    await ctx.reply(require('../lib/friendlyErrors').message('Couldn\u2019t send README', err));
  }
}

async function downloadRepo(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;

  await ctx.reply(`📦 Preparing zip of ${format.escapeMd(repoName)}\\.\\.\\.`, { parse_mode: 'MarkdownV2' });
  // Keeps Telegram's "sending a file…" indicator alive for the whole zip
  // build + upload, which routinely outlasts the 5s a single chat action lasts.
  const stopChatAction = chatAction.startChatAction(ctx, 'upload_document');
  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    const repo = await github.getRepo(token, user.login, repoName);
    const buffer = await github.downloadZip(token, user.login, repoName, repo.default_branch);

    if (buffer.length > config.TELEGRAM_UPLOAD_LIMIT_BYTES) {
      const fallbackUrl = github.zipDownloadUrl(user.login, repoName, repo.default_branch);
      return ctx.reply(format.errorMessage(
        'Download failed',
        `repo is ${format.formatBytes(buffer.length)} — exceeds Telegram's ${format.formatBytes(config.TELEGRAM_UPLOAD_LIMIT_BYTES)} limit for files a bot can send`,
        `Here's a direct download link instead:\n${fallbackUrl}`
      ));
    }

    await ctx.replyWithDocument({ source: buffer, filename: `${repoName}.zip` });
    await activity.log(ctx.from.id, '⬇️', `Downloaded repo → ${repoName}`);
  } catch (err) {
    await activity.log(ctx.from.id, '⚠️', `Download failed → ${repoName}`, { detail: err.message, isError: true });
    const errorHelpers = require('../lib/errorHelpers');
    await errorHelpers.replyGithubError(ctx, err, 'Download failed');
  } finally {
    stopChatAction();
  }
}

async function togglePin(ctx, repoName, target = null) {
  // Gated behind requireConnected — checked first, before any DB write, so
  // a stale button can't pin/unpin a repo with zero warning if the account
  // is disconnected. Check first, write second.
  const token = await requireConnected(ctx);
  if (!token) return;

  const telegramId = ctx.from.id;
  const isPinned = await pins.isPinned(telegramId, repoName);
  // target = 'on' | 'off' when the button said which one it meant; already
  // there means the tap is a repeat — just redraw.
  if ((target === 'on' && isPinned) || (target === 'off' && !isPinned)) return showRepoView(ctx, repoName);

  if (isPinned) {
    await pins.unpin(telegramId, repoName);
    await ephemeral.sendEphemeral(ctx, `📌 Unpinned — removed from ⭐ Pinned.`);
  } else {
    await pins.pin(telegramId, repoName);
    await ephemeral.sendEphemeral(ctx, `📌 Pinned — added to ⭐ Pinned for quick access.`);
  }
  // Re-render so the 📌 tag on the info card and the button label both update immediately
  return showRepoView(ctx, repoName);
}

module.exports = {
  showRepoView,
  showCloneUrl,
  undoAction,
  toggleWebhookEnable,
  toggleWebhookMute,
  exportRepoJson,
  sendFullReadme,
  askDeleteRepo,
  executeDeleteRepo,
  askToggleVisibility,
  executeToggleVisibility,
  askEditDescription,
  handleDescriptionInput,
  showLicenseMenu,
  executeSetLicense,
  downloadRepo,
  cleanupOrphanedData,
  togglePin,
};
