const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const github = require('../lib/github');
const repoCache = require('../lib/repoCache');
const requireConnected = require('../lib/requireConnected');
const format = require('../lib/format');
const bbtb = require('../keyboards/bbtb');
const activity = require('../lib/activity');
const tags = require('../lib/tags');
const repoView = require('./repoView');
const config = require('../config');
const ephemeral = require('../lib/ephemeral');
const { safeEditMessageText, safeEditMessageTextByRef } = require('../lib/safeEdit');

const PER_PAGE = 8;

function getSelection(ctx) {
  ctx.session.bulkSelected = ctx.session.bulkSelected || [];
  return ctx.session.bulkSelected;
}

async function startBulkSelect(ctx, { page = 1, edit = false } = {}) {
  const token = await requireConnected(ctx);
  if (!token) return;

  ctx.session.bulkPage = page;
  const selected = getSelection(ctx);
  const allRepos = await repoCache.getRepos(ctx.from.id, token);
  ctx.session.bulkAllRepoNames = allRepos.map((r) => r.name); // for Select All / Invert without refetching

  const totalPages = Math.max(1, Math.ceil(allRepos.length / PER_PAGE));
  const pageRepos = allRepos.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const rows = [
    [
      style.callback('✅ Select All', 'bulk:selectall'),
      style.callback('↩️ Invert', 'bulk:invert'),
    ],
    [style.callback('😴 Select Stale (6mo+)', 'bulk:selectstale')],
    [
      style.callback('🔒 Select Private', 'bulk:selectprivate'),
      style.callback('🌐 Select Public', 'bulk:selectpublic'),
    ],
  ];

  const userTags = await tags.listTags(ctx.from.id);
  if (userTags.length > 0) {
    rows.push([style.callback('🏷️ Select by Tag', 'bulk:tagmenu')]);
  }

  for (const r of pageRepos) {
    const checked = selected.includes(r.name) ? '☑️' : '⬜';
    rows.push([style.callback(`${checked} ${r.name}`, `bulk:toggle:${r.name}`)]);
  }

  const pagination = [];
  if (page > 1) pagination.push(style.callback('⬅️ Prev', `bulk:page:${page - 1}`, style.BLUE));
  if (page < totalPages) pagination.push(style.callback('Next ➡️', `bulk:page:${page + 1}`, style.BLUE));
  if (pagination.length) rows.push(pagination);

  const text =
    `${format.sectionHeader('Bulk Select', `${selected.length} selected`)}\n\n` +
    `${selected.length > 0 ? format.escapeMd(previewNames(selected)) : format.escapeMd('None selected yet')}\n\n` +
    `Page ${page} of ${totalPages}`;

  // #33 — every checkbox tap, filter button, and page flip used to resend
  // the whole screen as a brand-new message. Now it edits the same message
  // in place (matching how Notifications already worked), so selecting 10
  // repos doesn't produce 10 messages.
  if (edit) {
    const kb = { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) };
    if (await safeEditMessageText(ctx, text, kb)) return;
    // Message unchanged (Telegram errors on a no-op edit) or too old to
    // edit — fall through to a fresh send so the action never silently fails.
  }

  await ephemeral.sendEphemeral(ctx, '🧹 Bulk Select', bbtb.bulkSelect);
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

function previewNames(names) {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')}, +${names.length - 3} more`;
}

async function toggleRepo(ctx, repoName, page) {
  const selected = getSelection(ctx);
  const idx = selected.indexOf(repoName);
  if (idx === -1) selected.push(repoName);
  else selected.splice(idx, 1);
  return startBulkSelect(ctx, { page, edit: true });
}

async function selectAll(ctx) {
  ctx.session.bulkSelected = [...(ctx.session.bulkAllRepoNames || [])];
  return startBulkSelect(ctx, { page: ctx.session.bulkPage || 1, edit: true });
}

async function invertSelection(ctx) {
  const all = ctx.session.bulkAllRepoNames || [];
  const selected = new Set(getSelection(ctx));
  ctx.session.bulkSelected = all.filter((name) => !selected.has(name));
  return startBulkSelect(ctx, { page: ctx.session.bulkPage || 1, edit: true });
}

async function selectStale(ctx) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const allRepos = await repoCache.getRepos(ctx.from.id, token);
  const sixMonthsAgo = Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;
  ctx.session.bulkSelected = allRepos
    .filter((r) => new Date(r.updated_at).getTime() < sixMonthsAgo)
    .map((r) => r.name);
  return startBulkSelect(ctx, { page: ctx.session.bulkPage || 1, edit: true });
}

async function selectByVisibility(ctx, isPrivate) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const allRepos = await repoCache.getRepos(ctx.from.id, token);
  ctx.session.bulkSelected = allRepos.filter((r) => r.private === isPrivate).map((r) => r.name);
  return startBulkSelect(ctx, { page: ctx.session.bulkPage || 1, edit: true });
}

async function showTagSelectMenu(ctx) {
  const userTags = await tags.listTags(ctx.from.id);
  const rows = userTags.map((t) => [
    style.callback(`${tags.tagLabel(t)} (${t.repo_count})`, `bulk:selecttag:${t.id}`),
  ]);
  rows.push([style.callback('⬅️ Back', 'bulk:back')]);
  // #29 — single-pick menu: edit briefly, then this whole message gets
  // replaced by the re-rendered Bulk Select screen on pick (selectByTag
  // below calls startBulkSelect with edit:true), so nothing lingers.
  if (!(await safeEditMessageText(ctx, '🏷️ Select all repos with this tag:', Markup.inlineKeyboard(rows)))) {
    await ctx.reply('🏷️ Select all repos with this tag:', Markup.inlineKeyboard(rows));
  }
}

async function selectByTag(ctx, tagId) {
  const repoNames = await tags.reposWithTag(ctx.from.id, Number(tagId));
  ctx.session.bulkSelected = repoNames;
  return startBulkSelect(ctx, { page: ctx.session.bulkPage || 1, edit: true });
}

async function showActionMenu(ctx) {
  const selected = getSelection(ctx);
  if (selected.length === 0) {
    await ctx.reply('⚠️ Select at least one repo first.');
    return startBulkSelect(ctx, { page: ctx.session.bulkPage || 1 });
  }

  const text = `${format.sectionHeader('Selected', `${selected.length} repos`)}\n${format.escapeMd(previewNames(selected))}`;
  const rows = [
    [style.callback('🗑 Delete All', 'bulk:action:delete')],
    [
      style.callback('🔒 Make All Private', 'bulk:action:private'),
      style.callback('🌐 Make All Public', 'bulk:action:public'),
    ],
    [style.callback('⬇️ Download All as Zips', 'bulk:action:download')],
    [style.callback('↩️ Recent Changes (Undo)', 'bulk:undolist', style.BLUE)],
  ];

  await ephemeral.sendEphemeral(ctx, '🧹 Bulk Actions', bbtb.bulkActionMenu);
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

// v1.2.3-multi: Telegram rejects any message over 4096 characters. An unbounded
// selection used to produce progress/summary messages that long, which threw AFTER
// the work was done (no summary, no Retry or Undo buttons). Cap the run and keep
// every message it sends inside a safe budget.
const MAX_BULK_REPOS = 100;
const MESSAGE_BUDGET = 3800;

/** Joins lines but stops before `budget` characters, ending with "…and N more". */
function fitLines(lines, budget = MESSAGE_BUDGET) {
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = lines[i].length + 1;
    if (used + cost > budget - 24) {
      out.push(`…and ${lines.length - i} more`);
      break;
    }
    out.push(lines[i]);
    used += cost;
  }
  return out.join('\n');
}

/** Per-repo progress for a short batch; one compact counter line for a long one. */
function renderProgress(action, selected, results, currentIndex) {
  if (selected.length <= 25) {
    const lines = selected.map((n, idx) => {
      if (idx < currentIndex) return `${results[idx] && !results[idx].ok ? '⚠️' : '✅'} ${n}`;
      if (idx === currentIndex) return `${results[idx] ? (results[idx].ok ? '✅' : '⚠️') : '⏳'} ${n}`;
      return `⏳ ${n}`;
    });
    return `${actionVerb(action)} ${selected.length} repos...\n\n${fitLines(lines)}`;
  }
  const done = results.length;
  const failedCount = results.filter((r) => !r.ok).length;
  const now = selected[Math.min(currentIndex, selected.length - 1)];
  return `${actionVerb(action)} ${selected.length} repos...\n\n✅ ${done - failedCount} done · ⚠️ ${failedCount} failed · ⏳ ${selected.length - done} left\nNow: ${now}`;
}

async function confirmAction(ctx, action) {
  const selected = getSelection(ctx);
  if (selected.length > MAX_BULK_REPOS) {
    return ctx.reply(`⚠️ You selected ${selected.length} repos — a bulk action handles up to ${MAX_BULK_REPOS} at a time. Deselect some (or use a filter) and try again.`);
  }
  const list = fitLines(selected.map((name, i) => `${i + 1}. ${name}`), 3000);

  const labels = {
    delete: { verb: 'Delete', warn: 'A ZIP backup of each repo is sent here and kept in 🗑️ Trash first. A repo that can\u2019t be backed up is NOT deleted.' },
    private: { verb: 'Make Private', warn: 'These repos will no longer be publicly visible.' },
    public: { verb: 'Make Public', warn: 'These repos will become visible to anyone.' },
    download: { verb: 'Download', warn: 'Each repo will be sent as a separate zip file.' },
  };
  const l = labels[action];

  await ctx.reply(
    `⚠️ ${l.verb} ${selected.length} repos${action === 'delete' ? ' permanently' : ''}?\n\n${list}\n\n${l.warn}`,
    Markup.inlineKeyboard([
      // Delete matches single-repo Delete Repo exactly (real loss = red,
      // backing out = green). Private/Public/Download aren't a gain or
      // loss either way — same reasoning as the single-repo Visibility
      // toggle already being blue/blue — so both sides stay blue instead.
      [style.callback(`✅ Yes, ${l.verb} All ${selected.length}`, `bulk:execute:${action}`, action === 'delete' ? style.RED : style.BLUE)],
      [style.callback('❌ Cancel', 'bulk:cancel', action === 'delete' ? style.GREEN : style.BLUE)],
    ])
  );
}

/**
 * v1.2.1-multi — one tap can mean dozens of GitHub operations, so bulk work
 * runs inside the global "bulk" gate: a bounded number of bulk jobs at once
 * across ALL users (the rest queue, bounded, with a truthful message) on top
 * of the existing per-user actionLock that already prevents the same person
 * from running two at the same time (no duplicate execution).
 */
async function runGatedBulk(ctx, lockName, job) {
  const actionLock = require('../lib/actionLock');
  const gate = require('../lib/gate');
  const { skipped } = await actionLock.withLock(ctx.from.id, lockName, async () => {
    try {
      await gate.bulkGate().run(ctx.from.id, job, {
        onQueued: () => ctx.reply('⏳ Other bulk jobs are running — yours is queued and will start automatically.').catch(() => {}),
      });
    } catch (err) {
      if (err && err.name === 'GateError') {
        await ctx.reply(`⚠️ Bulk operation not started: ${gate.describeGateError(err, 'This')}`);
        return;
      }
      throw err;
    }
  });
  if (skipped) await ctx.reply('⏳ Already processing — please wait a moment.');
}

async function execute(ctx, action) {
  return runGatedBulk(ctx, 'bulkExecute', () => _execute(ctx, action));
}

/** #6 — re-runs execute() against just the names that failed last time,
 * reusing the exact same selection-state machinery Bulk Select already has
 * rather than making the person re-select repos by hand. */
async function retryFailed(ctx, action) {
  const queue = ctx.session.bulkRetryQueue;
  if (!queue || queue.action !== action || !queue.names.length) {
    return ctx.reply('Nothing left to retry.');
  }
  ctx.session.bulkSelected = queue.names;
  delete ctx.session.bulkRetryQueue;
  return execute(ctx, action);
}

async function _execute(ctx, action) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const selected = getSelection(ctx);
  if (!selected.length) {
    return ctx.reply('⚠️ Nothing selected.');
  }
  if (selected.length > MAX_BULK_REPOS) {
    return ctx.reply(`⚠️ You selected ${selected.length} repos — a bulk action handles up to ${MAX_BULK_REPOS} at a time.`);
  }
  const user = await repoCache.getUser(ctx.from.id, token);
  if (!user || !user.login) {
    return ctx.reply('❌ I could not determine your GitHub account. Please reconnect and try again.');
  }

  // Snapshot prior state before the batch runs, for undo. Only
  // meaningful for visibility changes; returns null (no-op) otherwise.
  let undoCaptureFailed = false;
  const undoLogId = await captureUndoState(ctx, action, selected).catch(() => { undoCaptureFailed = true; return null; });

  const progressMsg = await ctx.reply(renderProgress(action, selected, [], 0));

  const results = [];
  for (let i = 0; i < selected.length; i++) {
    const name = selected[i];
    try {
      await runAction(token, user.login, name, action, ctx.from.id, ctx);
      results.push({ name, ok: true });
    } catch (err) {
      const errorHelpers = require('../lib/errorHelpers');
      if (errorHelpers.isAuthError(err)) {
        // Token is bad for the whole session, not just this repo — every
        // remaining item would fail the same way, so stop instead of
        // grinding through a doomed loop and reporting the same error N times.
        for (let j = i; j < selected.length; j++) results.push({ name: selected[j], ok: false, error: 'session expired' });
        // Update the progress message one last time BEFORE breaking, or it
        // stays frozen showing "⏳ pending" on items that are actually
        // already known-failed until the summary arrives right after.
        await safeEditMessageTextByRef(
          ctx.telegram,
          ctx.chat.id,
          progressMsg.message_id,
          renderProgress(action, selected, results, selected.length - 1)
        ); // non-fatal either way — the summary below covers it regardless
        await errorHelpers.replyGithubError(ctx, err, `Bulk ${action} stopped`);
        break;
      }
      // v1.2.1-multi: a write GitHub never confirmed is NOT reported as a plain failure or a success.
      results.push({ name, ok: false, unknown: github.isUnknownOutcome(err), error: github.isUnknownOutcome(err) ? 'not confirmed by GitHub — check it before retrying' : err.message });
    }

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        progressMsg.message_id,
        undefined,
        renderProgress(action, selected, results, i)
      );
    } catch (err) {
      // Telegram's own flood control — if it tells us how long to wait,
      // actually wait that long before the next edit instead of just
      // swallowing the error and immediately hitting the same limit again.
      const retryAfter = (err.response && err.response.parameters && err.response.parameters.retry_after)
        || (err.parameters && err.parameters.retry_after);
      if (retryAfter) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      }
      // Any other edit failure is non-fatal — the final summary below covers it regardless.
    }
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  await activity.log(
    ctx.from.id,
    action === 'delete' ? '🗑' : action === 'download' ? '⬇️' : '🔒',
    `Bulk ${action} → ${succeeded.length}/${selected.length} succeeded`,
    { isError: failed.length > 0 }
  );

  let summary = `✅ Bulk ${action} finished — ${succeeded.length} succeeded`;
  if (failed.length > 0) summary += `, ${failed.length} failed`;
  const okNames = succeeded.map((r) => r.name);
  summary += `\n\n✅ ${okNames.length ? fitLines([okNames.join(', ')], 1500) : 'None'}`;
  if (failed.length > 0) {
    const failLines = failed.map((r) => `${r.name}: ${String(r.error).slice(0, 160)}`);
    summary += `\n\n⚠️ ` + fitLines(failLines, 1800);
  }
  const unconfirmed = failed.filter((r) => r.unknown);
  if (unconfirmed.length) {
    summary += `\n\n❓ ${unconfirmed.length} change${unconfirmed.length === 1 ? ' was' : 's were'} not confirmed by GitHub, so I can\u2019t say whether ${unconfirmed.length === 1 ? 'it' : 'they'} happened.`;
  }
  summary = fitLines([summary], 4000);

  ctx.session.bulkSelected = [];
  await maybeAddLongOpNotice(ctx, selected.length);

  // #6 — Retry Failed Only, so a partial failure doesn't mean re-selecting
  // everything by hand. Stores just the failed names for the retry tap.
  if (failed.length > 0) {
    ctx.session.bulkRetryQueue = { action, names: failed.map((r) => r.name) };
    const { Markup } = require('telegraf');
    await ctx.reply(summary, bbtb.bulkComplete);
    await ctx.reply(
      `Retry the ${failed.length} that failed?`,
      Markup.inlineKeyboard([[style.callback('🔁 Retry Failed Only', `bulk:retryfailed:${action}`)]])
    );
  } else {
    await ctx.reply(summary, bbtb.bulkComplete);
  }

  if (undoCaptureFailed && (action === 'private' || action === 'public')) {
    await ctx.reply('ℹ️ I couldn\u2019t record the previous visibility for this run, so Undo isn\u2019t available for it.');
  }

  // Undo offer, only when a reversible snapshot was actually taken.
  if (undoLogId) {
    await ctx.reply(
      `Undo available for 1 hour.`,
      Markup.inlineKeyboard([[style.callback('↩️ Undo This Bulk Change', `bulk:undo:${undoLogId}`)]])
    );
  }
}

/** Long Operations notification: for a batch big enough to actually take a
 * noticeable while (3+ items — lowered from 5+, which was unreachable at
 * typical real-world repo counts), send an extra "long operation done"
 * callout before the normal summary, when that preference is on. Shared
 * with Batch Upload (scenes/uploadFile.js), not just Bulk Actions. */
async function maybeAddLongOpNotice(ctx, count, { label = 'repos' } = {}) {
  if (count < 3) return;
  try {
    const users = require('../lib/users');
    const prefs = await users.getNotificationPrefs(ctx.from.id);
    if (prefs && prefs.longOps) {
      await ctx.reply(`🔔 Long operation finished — ${count} ${label} processed.`);
    }
  } catch (_) { /* best-effort */ }
}

function actionVerb(action) {
  return { delete: '🗑 Deleting', private: '🔒 Making Private', public: '🌐 Making Public', download: '⬇️ Downloading' }[action];
}

async function runAction(token, owner, repoName, action, telegramId, ctx) {
  if (action === 'delete') {
    // v1.2.3-multi: same safety net as the single-repo Delete — back the repo up
    // into 🗑️ Trash first, and don't delete anything that couldn't be backed up.
    const trash = require('../lib/trash');
    const repo = await github.getRepo(token, owner, repoName);
    let backup;
    try {
      backup = await require('../lib/trashBackup').backupRepoToTrash(ctx, { token, owner, repo });
    } catch (backupErr) {
      throw Object.assign(new Error(`not deleted — couldn\u2019t back it up first (${backupErr.message})`), { backupFailed: true });
    }
    try {
      await github.deleteRepo(token, owner, repoName);
    } catch (deleteErr) {
      if (!github.isUnknownOutcome(deleteErr)) await trash.remove(telegramId, backup.trashEntry.id).catch(() => {});
      throw deleteErr;
    }
    await repoView.cleanupOrphanedData(telegramId, repoName);
    repoCache.invalidateRepos(telegramId);
    repoCache.invalidateLanguages(telegramId, repoName);
    repoCache.invalidateTreeStats(telegramId, repoName);
    return;
  }
  if (action === 'private' || action === 'public') {
    await github.setVisibility(token, owner, repoName, action === 'private');
    repoCache.invalidateRepos(telegramId);
    return;
  }
}

/**
 * Records prior visibility per-repo BEFORE the bulk change runs,
 * so a full batch can be reversed with one tap. Only visibility is wired
 * up here; delete/download are not reversible candidates (see
 * lib/bulkUndo's REVERSIBLE_ACTIONS).
 */
async function captureUndoState(ctx, action, repoNames) {
  if (action !== 'private' && action !== 'public') return null;
  const bulkUndo = require('../lib/bulkUndo');
  const token = await requireConnected(ctx);
  if (!token) return null;
  const allRepos = await repoCache.getRepos(ctx.from.id, token);
  const byName = new Map(allRepos.map((r) => [r.name, r]));
  const previousState = {};
  for (const name of repoNames) {
    const r = byName.get(name);
    if (r) previousState[name] = r.private;
  }
  return bulkUndo.record(ctx.from.id, action, repoNames, previousState);
}

/** Reverses a logged bulk visibility change by writing each repo's prior
 * `private` boolean straight back. */
/** ↩️ The last few bulk visibility changes that can still be reversed (each for an hour after it ran). */
async function showRecentChanges(ctx) {
  const bulkUndo = require('../lib/bulkUndo');
  const entries = await bulkUndo.listRecent(ctx.from.id, 5);
  if (entries.length === 0) {
    return ctx.reply('↩️ Nothing to undo right now. Bulk visibility changes can be reversed for an hour after they run.');
  }
  const ago = (d) => {
    const mins = Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 60000));
    return mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  };
  const rows = entries.map((e) => [style.callback(
    `↩️ ${e.action_type === 'private' ? '🔒 Private' : '🌐 Public'} · ${e.repoNames.length} repo${e.repoNames.length === 1 ? '' : 's'} · ${ago(e.created_at)}`,
    `bulk:undo:${e.id}`
  )]);
  await ctx.reply(
    '↩️ Recent bulk changes\nTap one to put those repos back the way they were. Each can be undone for an hour after it ran.',
    Markup.inlineKeyboard(rows)
  );
}

async function undoBulkAction(ctx, logId) {
  const bulkUndo = require('../lib/bulkUndo');
  const entry = await bulkUndo.getUndoable(ctx.from.id, Number(logId));
  if (!entry || entry.status !== 'ok') {
    const msg = entry && entry.status === 'already-undone' ? 'Already undone.' : 'This undo has expired.';
    return ctx.reply(msg);
  }
  const token = await requireConnected(ctx);
  if (!token) return;
  const user = await repoCache.getUser(ctx.from.id, token);

  const names = Object.keys(entry.previousState);
  let restored = 0;
  for (const name of names) {
    try {
      await github.setVisibility(token, user.login, name, entry.previousState[name]);
      restored++;
    } catch (_) { /* best-effort — summary below reflects the real count */ }
  }
  repoCache.invalidateRepos(ctx.from.id);
  if (restored === names.length) {
    await bulkUndo.markUndone(entry.id);
  }
  await activity.log(ctx.from.id, '↩️', `Undid bulk ${entry.action_type} → restored ${restored}/${names.length}`);
  await ctx.reply(
    restored === names.length
      ? `↩️ Restored ${restored}/${names.length} repos to their prior visibility.`
      : `⚠️ Restored ${restored}/${names.length}. The undo remains available so you can try the failed repos again.`
  );
}

// ─── Composable filter builder (shared engine — lib/filterClauses.js) ────

function getFilterClauses(ctx) {
  ctx.session.bulkFilterClauses = ctx.session.bulkFilterClauses || [];
  return ctx.session.bulkFilterClauses;
}

/** Applies the session's filter clauses on top of the full repo list and
 * sets bulkSelected to the matching names — same end result as the
 * existing one-shot selectStale/selectByVisibility buttons, but composable:
 * clauses AND together, so "private AND stale AND tag:X" is expressible. */
async function applyFilterBuilder(ctx) {
  const filterClauses = require('../lib/filterClauses');
  const token = await requireConnected(ctx);
  if (!token) return;
  const clauses = getFilterClauses(ctx);
  const allRepos = await repoCache.getRepos(ctx.from.id, token);
  const filterCtx = await filterClauses.buildTagContext(ctx.from.id, clauses);
  const matched = filterClauses.applyClauses(allRepos, clauses, filterCtx);
  ctx.session.bulkSelected = matched.map((r) => r.name);
  return startBulkSelect(ctx, { page: 1, edit: true });
}

function addFilterClause(ctx, type, value) {
  const clauses = getFilterClauses(ctx);
  clauses.push({ type, value });
  return applyFilterBuilder(ctx);
}

function clearFilterClauses(ctx) {
  ctx.session.bulkFilterClauses = [];
}

/** Offers to save the current filter-clause set as a named Smart Folder
 * (lib/savedViews.js) — the direct link between Bulk Actions' ephemeral
 * filters and My Repos' persistent quick-access views. */
async function promptSaveAsView(ctx) {
  const clauses = getFilterClauses(ctx);
  if (clauses.length === 0) return ctx.reply('Build a filter first, then save it as a view.');
  ctx.session.awaitingSaveViewName = true;
  await ctx.reply('📁 Name this Smart Folder (or ❌ Cancel):');
}

async function handleSaveViewNameInput(ctx, name) {
  ctx.session.awaitingSaveViewName = false;
  const savedViews = require('../lib/savedViews');
  const clauses = getFilterClauses(ctx);
  await savedViews.create(ctx.from.id, name, clauses);
  await ctx.reply(`✅ Saved "${name}" as a Smart Folder — find it above My Repos.`);
}

async function executeDownloads(ctx) {
  return runGatedBulk(ctx, 'bulkDownloads', () => _executeDownloads(ctx));
}

async function _executeDownloads(ctx) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const selected = getSelection(ctx);
  if (selected.length > MAX_BULK_REPOS) {
    return ctx.reply(`⚠️ You selected ${selected.length} repos — a bulk action handles up to ${MAX_BULK_REPOS} at a time.`);
  }
  const user = await repoCache.getUser(ctx.from.id, token);
  if (!user || !user.login) {
    return ctx.reply('❌ I could not determine your GitHub account. Please reconnect and try again.');
  }

  await ctx.reply(`⬇️ Preparing ${selected.length} zips — sent one at a time...`);

  let sent = 0;
  const failed = [];
  let stoppedForAuth = false;
  for (const name of selected) {
    if (stoppedForAuth) {
      failed.push({ name, error: 'session expired' });
      continue;
    }
    try {
      const repo = await github.getRepo(token, user.login, name);
      const buffer = await github.downloadZip(token, user.login, name, repo.default_branch);
      if (buffer.length > config.TELEGRAM_UPLOAD_LIMIT_BYTES) {
        failed.push({ name, error: `exceeds ${format.formatBytes(config.TELEGRAM_UPLOAD_LIMIT_BYTES)} (${format.formatBytes(buffer.length)})` });
        continue;
      }
      await ctx.replyWithDocument({ source: buffer, filename: `${name}.zip` });
      sent++;
    } catch (err) {
      const errorHelpers = require('../lib/errorHelpers');
      if (errorHelpers.isAuthError(err)) {
        stoppedForAuth = true;
        await errorHelpers.replyGithubError(ctx, err, 'Bulk download stopped');
        failed.push({ name, error: 'session expired' });
        continue;
      }
      failed.push({ name, error: err.message });
    }
  }

  await activity.log(ctx.from.id, '⬇️', `Bulk download → ${sent}/${selected.length} succeeded`, { isError: failed.length > 0 });

  let summary = `✅ Bulk download finished — ${sent} sent`;
  if (failed.length > 0) {
    summary += `, ${failed.length} failed\n\n⚠️ ` + fitLines(failed.map((f) => `${f.name}: ${String(f.error).slice(0, 160)}`), 3000);
  }
  ctx.session.bulkSelected = [];
  await maybeAddLongOpNotice(ctx, selected.length);
  await ctx.reply(summary, bbtb.bulkComplete);
}

module.exports = {
  startBulkSelect,
  toggleRepo,
  selectAll,
  invertSelection,
  selectStale,
  selectByVisibility,
  showTagSelectMenu,
  selectByTag,
  showActionMenu,
  confirmAction,
  execute,
  retryFailed,
  executeDownloads,
  maybeAddLongOpNotice,
  undoBulkAction,
  showRecentChanges,
  fitLines,
  renderProgress,
  MAX_BULK_REPOS,
  addFilterClause,
  clearFilterClauses,
  applyFilterBuilder,
  promptSaveAsView,
  handleSaveViewNameInput,
};
