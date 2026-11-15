const { Scenes, Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const github = require('../lib/github');
const repoCache = require('../lib/repoCache');
const requireConnected = require('../lib/requireConnected');
const format = require('../lib/format');
const bbtb = require('../keyboards/bbtb');
const activity = require('../lib/activity');
const { gitBlobSha } = require('../lib/gitHash');
const { listDirectory } = require('../handlers/browseFiles');
const pathMemory = require('../lib/pathMemory');
const fileBufferCache = require('../lib/fileBufferCache');
const globalConfig = require('../lib/globalConfig');
const ephemeral = require('../lib/ephemeral');
const chrome = require('../lib/chrome');
const resultCard = require('../lib/resultCard');
const ui = require('../handlers/manage/ui');
const esc = format.escapeMd;
const { mapLimit } = require('../lib/pool');
const archive = require('../lib/archive');
const archiveRunner = require('../lib/archiveRunner');
const gate = require('../lib/gate');
const uploadProgress = require('../lib/uploadProgress');
// v1.2.4-multi: uploads go to the branch picked in ⚡ Manage → Branches (default branch when none)
const { workBranch } = require('../handlers/manage/common');

// How many modified files get a line-by-line preview (one GitHub request each) in a single upload summary.
const MAX_DIFF_FETCHES = 8;

const PATH_EXAMPLES =
  'Examples:\n' +
  '• src/index.js\n' +
  '• assets/images/logo.png\n' +
  '• config/settings.json';

/** Ends the flow with a short note that fades by itself, then puts the person back on the page they came from. */
async function endFlow(ctx, note) {
  await ephemeral.sendEphemeral(ctx, note.startsWith('Upload cancelled') ? '❌ Upload cancelled' : note, {}, 2000);
  await chrome.returnFromTyping(ctx);
}

/** Releases every cached file buffer for this wizard session — call at
 * every exit point. Deliberately fire-and-forget: release()/releaseAll()
 * are async now (they also clear the Redis-backed copy), but cleanup
 * doesn't need to block on that completing, and awaiting here would mean
 * awaiting at every one of this function's many call sites too. */
function releasePendingFiles(ctx) {
  const files = ctx.wizard.state.pendingFiles;
  if (files) fileBufferCache.releaseAll(files.map((f) => f.contentRef).filter(Boolean)).catch(() => {});
  if (ctx.wizard.state.pendingZipRef) fileBufferCache.release(ctx.wizard.state.pendingZipRef).catch(() => {});
}

/** Exposed so bot.js's global scene-escape handler can clean up cached
 * buffers even when the person leaves via a nav button instead of Cancel. */
function releaseOnExternalLeave(ctx) {
  if (ctx.wizard && ctx.wizard.state) releasePendingFiles(ctx);
}

const scene = new Scenes.WizardScene(
  'uploadFile',

  async (ctx) => {
    const state = ctx.scene.state || {};
    ctx.wizard.state.repoName = ctx.wizard.state.repoName || state.repoName;
    ctx.wizard.state.presetDir = state.presetDir;
    ctx.wizard.state.suggestedDir = state.suggestedDir;
    ctx.wizard.state.lockedPath = state.lockedPath;
    ctx.wizard.state.mode = state.mode || 'upload';

    // v1.1.0-multi — resolved once per wizard entry rather than re-fetched
    // at every size check below; an admin-set per-user override (or the
    // global default if none) now gates uploads instead of a single
    // config constant everyone shared under single-owner.
    if (!ctx.wizard.state.limits) {
      const users = require('../lib/users');
      const limits = require('../lib/limits');
      const user = await users.getUser(ctx.from.id);
      ctx.wizard.state.limits = limits.getEffectiveLimits(user);
    }

    if (ctx.wizard.state.mode === 'replaceFolder' && !ctx.wizard.state.syncConfirmed) {
      const dirLabel = ctx.wizard.state.presetDir || '(root)';
      await ctx.reply(
        `🔁 Replace ${dirLabel}\n` +
        `This makes the folder match exactly what you upload next:\n` +
        `• Files you send will be added or updated\n` +
        `• Any file already here that you DON'T include will be deleted\n\n` +
        `⚠️ This is a full sync, not a normal upload.`,
        Markup.inlineKeyboard([
          [style.callback('Understood, Continue', 'upload:sync:continue', style.GREEN)],
          [style.callback('❌ Cancel', 'upload:sync:cancel', style.RED)],
        ])
      );
      // Advance the wizard cursor to the step that actually handles the
      // button tap (below). Without this, Telegraf re-runs THIS step on the
      // next update, sees syncConfirmed still false, and resends this same
      // message forever — regardless of which button was tapped.
      return ctx.wizard.selectStep(1);
    }

    return promptForFile(ctx);
  },

  async (ctx) => {
    if (ctx.callbackQuery && ctx.callbackQuery.data === 'upload:sync:continue') {
      await ctx.answerCbQuery();
      ctx.wizard.state.syncConfirmed = true;
      return promptForFile(ctx);
    }
    if (ctx.callbackQuery && ctx.callbackQuery.data === 'upload:sync:cancel') {
      await ctx.answerCbQuery();
      await endFlow(ctx, 'Cancelled.');
      return ctx.scene.leave();
    }

    if (ctx.message && ctx.message.text === '❌ Cancel') {
      releasePendingFiles(ctx);
      await endFlow(ctx, 'Upload cancelled.');
      return ctx.scene.leave();
    }

    // 🔒 Password-protected zip — this step re-enters itself waiting for a
    // password reply rather than advancing, since we're still logically
    // "receiving the file" until extraction actually succeeds.
    if (ctx.wizard.state.awaitingZipPassword) {
      if (!ctx.message || !ctx.message.text) {
        await ctx.reply('Send the zip password as text, or ❌ Cancel.');
        return;
      }
      const password = ctx.message.text.trim();
      const buffer = await fileBufferCache.get(ctx.wizard.state.pendingZipRef);
      delete ctx.wizard.state.awaitingZipPassword;
      if (!buffer) {
        // Cache entry expired (session sat idle past the TTL) — nothing to retry with.
        delete ctx.wizard.state.pendingZipRef;
        await ctx.reply(format.errorMessage('Upload failed', 'the file expired while waiting for a password', 'Please resend the zip.'));
        return promptForFile(ctx);
      }
      return processZip(ctx, buffer, password);
    }

    // 📦 Extract vs upload-as-is — asked BEFORE downloading, since which
    // size limit applies depends on the answer (extracting uses the small
    // archive limit; "as-is" is really just a single file at that point,
    // so it gets the larger single-file limit instead).
    if (ctx.wizard.state.pendingArchiveDoc) {
      const pending = ctx.wizard.state.pendingArchiveDoc;

      if (ctx.callbackQuery && ctx.callbackQuery.data === 'upload:archive:cancel') {
        await ctx.answerCbQuery();
        delete ctx.wizard.state.pendingArchiveDoc;
        releasePendingFiles(ctx);
        await endFlow(ctx, 'Upload cancelled.');
        return ctx.scene.leave();
      }

      if (ctx.callbackQuery && (ctx.callbackQuery.data === 'upload:archive:extract' || ctx.callbackQuery.data === 'upload:archive:asis')) {
        await ctx.answerCbQuery();
        const choice = ctx.callbackQuery.data.split('upload:archive:')[1];
        delete ctx.wizard.state.pendingArchiveDoc;

        const sizeLimit = choice === 'extract' ? ctx.wizard.state.limits.maxZipBytes : ctx.wizard.state.limits.maxFileBytes;
        if (pending.fileSize > sizeLimit) {
          await ctx.reply(format.errorMessage(
            choice === 'extract' ? 'Archive exceeds size limit' : 'File exceeds size limit',
            `${pending.fileName} is ${format.formatBytes(pending.fileSize)}, limit is ${format.formatBytes(sizeLimit)}`,
            choice === 'extract' ? 'Please split or compress further, then resend.' : 'Keep it under the single-file limit, then resend.'
          ));
          return promptForFile(ctx);
        }

        const fileLink = await ctx.telegram.getFileLink(pending.fileId);
        let res;
        try {
          res = await fetch(fileLink.href, { signal: AbortSignal.timeout(20000) });
        } catch (err) {
          await ctx.reply(format.errorMessage(
            'Upload failed',
            err.name === 'TimeoutError' ? 'downloading the file from Telegram took too long' : err.message,
            'Try again.'
          ));
          return promptForFile(ctx);
        }
        if (!res.ok) {
          await ctx.reply(format.errorMessage('Upload failed', `Telegram returned HTTP ${res.status} while downloading the file`, 'Try sending the file again.'));
          return promptForFile(ctx);
        }
        const buffer = Buffer.from(await res.arrayBuffer());

        if (choice === 'asis') return processSingleFile(ctx, buffer, pending.fileName, pending.fileId);
        if (pending.isZip) return processZip(ctx, buffer);
        return processTar(ctx, buffer, pending.isTarGz);
      }

      // Anything else while this choice is pending — re-prompt rather than
      // silently processing a new message on top of a stale pending doc.
      await ctx.reply('Please tap 📦 Extract Contents, 📁 Upload As\u2011Is, or ❌ Cancel above.');
      return;
    }

    if (ctx.message && ctx.message.photo) {
      await ctx.reply(format.errorMessage(
        'Can\u2019t upload this file',
        'it was sent as a compressed photo, not a file attachment — Telegram compresses images sent via the photo picker, which alters the original bytes',
        'Use the 📎 attachment icon and choose "File" (not "Photo/Gallery") to send it unmodified, or ❌ Cancel.'
      ));
      return;
    }

    if (!ctx.message || !ctx.message.document) {
      await ctx.reply('Send a file as a document attachment, or ❌ Cancel.');
      return;
    }

    const doc = ctx.message.document;
    const lowerName = doc.file_name.toLowerCase();

    const isZip = lowerName.endsWith('.zip');
    const isTarGz = lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz');
    const isTar = !isTarGz && lowerName.endsWith('.tar');
    const isArchive = isZip || isTar || isTarGz;

    if (isArchive) {
      ctx.wizard.state.pendingArchiveDoc = {
        fileId: doc.file_id, fileName: doc.file_name, fileSize: doc.file_size, isZip, isTarGz,
      };
      await ctx.reply(
        `📦 ${doc.file_name} (${format.formatBytes(doc.file_size)}) — how should this be uploaded?`,
        Markup.inlineKeyboard([
          [style.callback('📦 Extract Contents', 'upload:archive:extract')],
          [style.callback('📁 Upload As-Is (single file)', 'upload:archive:asis')],
          [style.callback('❌ Cancel', 'upload:archive:cancel')],
        ])
      );
      return;
    }

    // Anything that isn't .zip/.tar/.tar.gz — including .rar/.7z and
    // anything else — is just an opaque single file as far as GitroHub is
    // concerned. It was never able to extract RAR/7z anyway, so there's no
    // reason to refuse them outright instead of storing them as-is, same
    // as a .pdf or .png.
    if (doc.file_size > ctx.wizard.state.limits.maxFileBytes) {
      await ctx.reply(format.errorMessage(
        'File exceeds size limit',
        `${doc.file_name} is ${format.formatBytes(doc.file_size)}, limit is ${format.formatBytes(ctx.wizard.state.limits.maxFileBytes)}`,
        'For larger files, zip them first (as an archive to extract, up to 1MB compressed), then resend.'
      ));
      return;
    }

    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    let res;
    try {
      res = await fetch(fileLink.href, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      await ctx.reply(format.errorMessage(
        'Upload failed',
        err.name === 'TimeoutError' ? 'downloading the file from Telegram took too long' : err.message,
        'Try again.'
      ));
      return;
    }
    if (!res.ok) {
      await ctx.reply(format.errorMessage('Upload failed', `Telegram returned HTTP ${res.status} while downloading the file`, 'Try sending the file again.'));
      return;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return processSingleFile(ctx, buffer, doc.file_name, doc.file_id);
  },

  async (ctx) => {
    const st = ctx.wizard.state;
    const cb = ctx.callbackQuery && ctx.callbackQuery.data;
    const setPath = (dir) => {
      st.pendingFiles[0].path = dir ? `${dir}/${st.pendingFiles[0].filename}` : st.pendingFiles[0].filename;
      delete st.picker;
      return showSummary(ctx);
    };
    if (cb === 'upload:choose:root') { await ctx.answerCbQuery(); return setPath(''); }
    if (cb === 'upload:choose:suggested') { await ctx.answerCbQuery(); return setPath(st.suggestedDir); }
    if (cb === 'upload:choose:default') {
      await ctx.answerCbQuery();
      return setPath(await require('../lib/defaults').uploadPathFor(ctx.from.id, st.repoName));
    }
    if (cb === 'upload:choose:browse') { await ctx.answerCbQuery(); return showFolderPicker(ctx, '', 1); }
    if (cb && cb.startsWith('upload:pick:')) {
      await ctx.answerCbQuery();
      const picker = st.picker || { dir: '', folders: [], page: 1 };
      const [, , action, arg] = cb.split(':');
      if (action === 'here') return setPath(picker.dir);
      if (action === 'up') return showFolderPicker(ctx, picker.dir.split('/').slice(0, -1).join('/'), 1);
      if (action === 'page') return showFolderPicker(ctx, picker.dir, Number(arg) || 1);
      if (action === 'd') {
        const name = picker.folders[Number(arg)];
        if (name) return showFolderPicker(ctx, picker.dir ? `${picker.dir}/${name}` : name, 1);
      }
      return showFolderPicker(ctx, picker.dir, picker.page);
    }
    if (cb === 'upload:choose:back') { await ctx.answerCbQuery(); delete st.picker; return processSingleFile(ctx, null, null, null, true); }
    if (ctx.message && ctx.message.text === '⬅️ Back') {
      if (st.picker) { delete st.picker; return processSingleFile(ctx, null, null, null, true); }
      return;
    }
    if (ctx.message && ctx.message.text === '❌ Cancel') {
      releasePendingFiles(ctx);
      await endFlow(ctx, 'Upload cancelled.');
      return ctx.scene.leave();
    }
    if (ctx.message && ctx.message.text) {
      const path = ctx.message.text.trim();
      if (/\/\/|^\/|\s\/|\/\s/.test(path)) {
        await ctx.reply(format.errorMessage(
          'Invalid path',
          `"${path}" contains a double slash, leading slash, or space around a slash`,
          `${PATH_EXAMPLES}\n\nTry again, or tap 📍 Repo root above.`
        ));
        return;
      }
      st.pendingFiles[0].path = path || st.pendingFiles[0].filename;
      delete st.picker;
      return showSummary(ctx);
    }
  },

  async (ctx) => {
    if (ctx.callbackQuery && ctx.callbackQuery.data === 'upload:summary:list') {
      await ctx.answerCbQuery();
      const list = ctx.wizard.state.pendingFiles
        .map((f) => `${statusIcon(f.status)} ${f.path}${f.status === 'modified' ? ` (${f.oldSize} → ${f.newSize})` : ''}`)
        .join('\n');
      const toDelete = ctx.wizard.state.toDelete || [];
      const delList = toDelete.length ? `\n\n🗑 Will be REMOVED:\n${toDelete.join('\n')}` : '';
      await ctx.reply(`📋 Files:\n${list}${delList}`);
      return;
    }
    if (ctx.callbackQuery && ctx.callbackQuery.data === 'upload:summary:diff') {
      await ctx.answerCbQuery();
      const diffable = ctx.wizard.state.pendingFiles.filter((f) => f.status === 'modified' && f.lineDiff);
      const MAX_SAMPLE_LINES = 8;
      const blocks = diffable.slice(0, 3).map((f) => {
        const { added, removed } = f.lineDiff;
        const sample = [
          ...removed.slice(0, MAX_SAMPLE_LINES).map((l) => `- ${l}`),
          ...added.slice(0, MAX_SAMPLE_LINES).map((l) => `+ ${l}`),
        ].slice(0, MAX_SAMPLE_LINES);
        const omitted = (removed.length + added.length) - sample.length;
        let block = `📄 ${f.path} (+${f.lineDiff.addedCount}/\u2212${f.lineDiff.removedCount})\n${sample.join('\n')}`;
        if (omitted > 0) block += `\n… and ${omitted} more changed line(s)`;
        return block;
      });
      const skipped = diffable.length > 3 ? `\n\n(${diffable.length - 3} more modified file(s) not shown — commit to see the full change on GitHub)` : '';
      await ctx.reply(`🔍 Diff preview:\n\n${blocks.join('\n\n')}${skipped}`);
      return;
    }
    if ((ctx.callbackQuery && ctx.callbackQuery.data === 'upload:cancel') || (ctx.message && ctx.message.text === '❌ Cancel')) {
      if (ctx.callbackQuery) await ctx.answerCbQuery();
      releasePendingFiles(ctx);
      await endFlow(ctx, 'Upload cancelled.');
      return ctx.scene.leave();
    }
    if (ctx.message && ctx.message.text === '⬅️ Back') {
      // one step back: choose the destination again (a single file) — a multi-file set has no destination to change
      if (ctx.wizard.state.pendingFiles.length === 1 && !ctx.wizard.state.lockedPath && !ctx.wizard.state.presetDir) return processSingleFile(ctx, null, null, null, true);
      return;
    }
    if (ctx.callbackQuery && ctx.callbackQuery.data === 'upload:commit') {
      await ctx.answerCbQuery();
      const changed = ctx.wizard.state.pendingFiles.filter((f) => f.status !== 'unchanged');
      const toDelete = ctx.wizard.state.toDelete || [];
      if (changed.length === 0 && toDelete.length === 0) {
        releasePendingFiles(ctx);
        await endFlow(ctx, '➖ Nothing to commit — every file matches what’s already in the repo.');
        return ctx.scene.leave();
      }
      const defaultsLib = require('../lib/defaults');
      const pendingForMessage = ctx.wizard.state.pendingFiles || [];
      ctx.wizard.state.commitMessage = ctx.wizard.state.mode === 'replaceFolder'
        ? 'Sync via GitroHub'
        : await defaultsLib.commitMessageFor(ctx.from.id, {
          fallback: 'Update via GitroHub',
          filename: pendingForMessage[0] ? (pendingForMessage[0].filename || pendingForMessage[0].path || '') : '',
          repo: ctx.wizard.state.repoName || '',
          count: pendingForMessage.length || 1,
        });
      await showCommitCard(ctx);
      return ctx.wizard.next();
    }
    await ctx.reply('Tap ✅ Commit changes below, or ❌ Cancel.');
  },

  async (ctx) => {
    // 📅 Schedule for Later — custom date/time text, after "⌨️ Custom" was tapped.
    if (ctx.wizard.state.awaitingUploadScheduleTime) {
      if (ctx.message && ctx.message.text === '❌ Cancel') {
        delete ctx.wizard.state.awaitingUploadScheduleTime;
        releasePendingFiles(ctx);
        await endFlow(ctx, 'Upload cancelled.');
        return ctx.scene.leave();
      }
      if (!ctx.message || !ctx.message.text) {
        await ctx.reply('Send the date and time as text, or ❌ Cancel.');
        return;
      }
      const users = require('../lib/users');
      const timezone = require('../lib/timezone');
      const user = await users.getUser(ctx.from.id);
      const tz = user.timezone || 'UTC';
      const scheduledFor = timezone.parseFlexibleDateTime(ctx.message.text.trim(), tz);
      if (!scheduledFor) {
        await ctx.reply(format.errorMessage('Couldn\u2019t read that', 'try "14:00", "12-25 09:00", or "2026-09-15 14:00"', '12-hour like "2:30pm" also works, or ❌ Cancel.'));
        return;
      }
      if (scheduledFor.getTime() <= Date.now()) {
        await ctx.reply(format.errorMessage('That time has already passed', `that resolves to the past in ${tz}`, 'Send a future date/time, or ❌ Cancel.'));
        return;
      }
      delete ctx.wizard.state.awaitingUploadScheduleTime;
      return finalizeUploadSchedule(ctx, scheduledFor, tz);
    }

    // 📅 Schedule for Later — quick-pick shown after "📅 Schedule for Later" was tapped.
    if (ctx.wizard.state.awaitingUploadSchedulePick) {
      if (!ctx.callbackQuery || !ctx.callbackQuery.data.startsWith('upload:schedulepick:')) {
        await ctx.reply('Tap a time option above, or ❌ Cancel.');
        return;
      }
      await ctx.answerCbQuery();
      const pick = ctx.callbackQuery.data.split('upload:schedulepick:')[1];
      const users = require('../lib/users');
      const user = await users.getUser(ctx.from.id);
      const tz = user.timezone || 'UTC';

      if (pick === 'custom') {
        delete ctx.wizard.state.awaitingUploadSchedulePick;
        ctx.wizard.state.awaitingUploadScheduleTime = true;
        await ephemeral.sendEphemeral(
          ctx,
          `⌨️ Send a time in your timezone (${tz} — change it in 🤖 Automation → 🌍 Timezone) — just "14:00" works (today, or tomorrow if that's already passed), or add a date: "12-25 09:00", or the full "2026-09-15 14:00" if you want to be exact. 12-hour like "2:30pm" also works.`,
          bbtb.cancelOnly
        );
        return;
      }

      delete ctx.wizard.state.awaitingUploadSchedulePick;
      const now = new Date();
      let scheduledFor;
      if (pick === '1h') scheduledFor = new Date(now.getTime() + 60 * 60 * 1000);
      else if (pick === '3days') scheduledFor = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      else if (pick === 'tomorrow9am') {
        const timezone = require('../lib/timezone');
        const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        const [ty, tm, td] = todayLocal.split('-').map(Number);
        const tomorrowLocal = new Date(Date.UTC(ty, tm - 1, td + 1));
        const y = tomorrowLocal.getUTCFullYear();
        const mo = String(tomorrowLocal.getUTCMonth() + 1).padStart(2, '0');
        const d = String(tomorrowLocal.getUTCDate()).padStart(2, '0');
        scheduledFor = timezone.zonedTimeToUtc(`${y}-${mo}-${d}`, '09:00', tz);
        if (scheduledFor.getTime() <= now.getTime()) scheduledFor = new Date(scheduledFor.getTime() + 24 * 60 * 60 * 1000);
      }
      return finalizeUploadSchedule(ctx, scheduledFor, tz);
    }

    // ✅ Commit Now vs 📅 Schedule for Later — shown after the commit
    // message is already decided, only when this upload is eligible for
    // scheduling at all (see the eligibility check further down).
    if (ctx.wizard.state.awaitingUploadNowOrLater) {
      if (ctx.message && ctx.message.text === '❌ Cancel') {
        delete ctx.wizard.state.awaitingUploadNowOrLater;
        releasePendingFiles(ctx);
        await endFlow(ctx, 'Upload cancelled.');
        return ctx.scene.leave();
      }
      if (ctx.callbackQuery && ctx.callbackQuery.data === 'upload:schedulelater') {
        await ctx.answerCbQuery();
        delete ctx.wizard.state.awaitingUploadNowOrLater;
        ctx.wizard.state.awaitingUploadSchedulePick = true;
        await ui.show(ctx, '📅 *When should this be uploaded?*', { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([
          [style.callback('⏱ In 1 hour', 'upload:schedulepick:1h'), style.callback('🌅 Tomorrow 9am', 'upload:schedulepick:tomorrow9am')],
          [style.callback('📆 In 3 days', 'upload:schedulepick:3days'), style.callback('⌨️ Custom time', 'upload:schedulepick:custom')],
        ]) });
        return;
      }
      if (ctx.callbackQuery && ctx.callbackQuery.data === 'upload:committnow') {
        await ctx.answerCbQuery();
        delete ctx.wizard.state.awaitingUploadNowOrLater;
        return commitPendingUpload(ctx, ctx.wizard.state.pendingCommitMessage);
      }
      await ctx.reply('Tap ✅ Commit Now, 📅 Schedule for Later, or ❌ Cancel above.');
      return;
    }

    // ✍️ Commit message: a pre-filled card. Suggestions and "Use this message" are taps; a typed message becomes a fresh
    // card at the bottom (never committed blind).
    if (ctx.message && ctx.message.text === '❌ Cancel') {
      releasePendingFiles(ctx);
      await endFlow(ctx, 'Upload cancelled.');
      return ctx.scene.leave();
    }
    if (ctx.message && ctx.message.text === '⬅️ Back') { ctx.wizard.state.editingMessage = false; await showSummary(ctx); return; }
    const cb = ctx.callbackQuery && ctx.callbackQuery.data;
    if (cb && cb.startsWith('upload:msgpick:')) {
      await ctx.answerCbQuery();
      ctx.wizard.state.commitMessage = cb.split('upload:msgpick:')[1];
      return showCommitCard(ctx);
    }
    if (cb === 'upload:msg:edit') {
      await ctx.answerCbQuery();
      ctx.wizard.state.editingMessage = true;
      await ctx.reply('✍️ Send the commit message you want\\.', { parse_mode: 'MarkdownV2' });
      return;
    }
    if (ctx.message && ctx.message.text) {
      ctx.wizard.state.commitMessage = ctx.message.text.trim().slice(0, 300);
      ctx.wizard.state.editingMessage = false;
      return showCommitCard(ctx);
    }
    if (cb !== 'upload:msg:use') {
      await ctx.reply('Tap ✅ Commit, pick a suggestion, or type your own message.');
      return;
    }
    await ctx.answerCbQuery();
    const message = ctx.wizard.state.commitMessage || 'Update via GitroHub';

    // 📅 Scheduling — a single self-contained file (has a Telegram
    // fileId to re-download fresh at execution time), OR a multi-file
    // set that came from extracting an archive specifically (bytes are
    // captured now and stored durably — see schema.sql's comment on
    // scheduled_upload_files for why that's safer than re-extracting
    // later). Anything else — a 🔁 Replace Folder sync, or any flow that
    // also deletes files — still isn't eligible: those need to compare
    // against the repo's LIVE state, which could well have changed by
    // the time a schedule fires, and replaying a stale diff later would
    // be a correctness problem, not just a convenience.
    const changed = ctx.wizard.state.pendingFiles.filter((f) => f.status !== 'unchanged');
    const toDelete = ctx.wizard.state.toDelete || [];
    const singleFileEligible = changed.length === 1 && !!changed[0].fileId;
    const multiFileEligible = changed.length > 1 && ctx.wizard.state.fromArchiveExtraction && ctx.wizard.state.mode !== 'replaceFolder';
    const eligibleForScheduling = (singleFileEligible || multiFileEligible) && toDelete.length === 0;

    if (eligibleForScheduling) {
      ctx.wizard.state.pendingCommitMessage = message;
      ctx.wizard.state.awaitingUploadNowOrLater = true;
      const what = changed.length === 1 ? `"${changed[0].path}"` : `${changed.length} files`;
      await ui.show(ctx, `📤 *Ready to upload ${esc(what)}*\n>${esc(message)}\n\nCommit now, or schedule it for later?`, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([
        [style.callback('✅ Commit now', 'upload:committnow', style.GREEN), style.callback('📅 Schedule', 'upload:schedulelater', style.BLUE)],
      ]) });
      return;
    }

    return commitPendingUpload(ctx, message);
  }
);

/** ✍️ The commit-message card: the message is already filled in; one tap commits, suggestions swap it, typing replaces it. */
async function showCommitCard(ctx) {
  const st = ctx.wizard.state;
  const text = `✍️ *Commit message*\n\n>${esc(st.commitMessage)}\n\nTap *Commit* to use it, pick a quick one, or type your own\\.`;
  const rows = [
    [style.callback('✅ Commit', 'upload:msg:use', style.GREEN), style.callback('✏️ Write my own', 'upload:msg:edit', style.BLUE)],
    [style.callback('🐛 Fix bug', 'upload:msgpick:Fix bug'), style.callback('📝 Update README', 'upload:msgpick:Update README')],
    [style.callback('✨ Initial commit', 'upload:msgpick:Initial commit'), style.callback('🔧 Minor changes', 'upload:msgpick:Minor changes')],
  ];
  await ui.show(ctx, text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

/** The actual commit — split out from the step above so both the
 * immediate-commit path and the "✅ Commit Now" tap (after having shown
 * the Now/Later choice) can call the exact same code, rather than two
 * near-duplicate copies of this logic drifting apart over time. */
async function commitPendingUpload(ctx, message) {
  const token = await requireConnected(ctx);
  if (!token) return ctx.scene.leave();

  const st = ctx.wizard.state;
  const userId = ctx.from.id;
  const changed = st.pendingFiles.filter((f) => f.status !== 'unchanged');
  const toDelete = st.toDelete || [];

  if (uploadProgress.getJob(userId)) {
    await ctx.reply('⏳ Already uploading — please wait a moment.');
    releasePendingFiles(ctx);
    return ctx.scene.leave();
  }

  // v2.3.3: the commit runs as a background job, not inside this update. A big upload can take minutes (and wait out a GitHub
  // rate limit), far past Telegram's handler timeout — and while this handler ran, every tap the person made (including
  // ❌ Cancel) had to queue behind it. Everything the job needs is captured NOW as plain data; the scene state and this ctx
  // are gone once the update ends.
  const plan = {
    userId,
    chatId: ctx.chat.id,
    telegram: ctx.telegram,
    token,
    repoName: st.repoName,
    branch: workBranch(ctx, st.repoName, null),
    replaceFolder: st.mode === 'replaceFolder',
    message,
    changed: changed.map((f) => ({ path: f.path, mode: f.mode, status: f.status, contentRef: f.contentRef })),
    toDelete,
    repoUrl: ctx.session.repoUrl && ctx.session.currentRepo === st.repoName ? ctx.session.repoUrl : null,
  };

  // The commit card the person just tapped becomes the live progress card (no stale Commit button left behind).
  const first = uploadProgress.render({ repo: plan.repoName, stage: 'committing', done: 0, total: plan.changed.length });
  const extra = { parse_mode: 'MarkdownV2', ...uploadProgress.keyboardFor(true) };
  let messageId = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.message_id;
  try {
    if (messageId) await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, first.text, extra);
    else messageId = (await ctx.telegram.sendMessage(ctx.chat.id, first.text, extra)).message_id;
  } catch (_) {
    messageId = (await ctx.telegram.sendMessage(ctx.chat.id, first.text, extra)).message_id;
  }
  plan.messageId = messageId;

  const job = uploadProgress.startJob(userId);
  setImmediate(() => {
    runUploadJob(plan, job).catch((err) => require('../lib/logger').error('upload job crashed', { message: err && err.message }));
  });
  return ctx.scene.leave(); // the person is free to keep using the bot; the card keeps itself up to date
}

/**
 * The background half of an upload: commit with live progress, pause/resume through GitHub rate limits, honour Cancel (up
 * to the moment the branch moves), then turn the same card into the result. Never throws.
 */
async function runUploadJob(plan, job) {
  const { userId, chatId, telegram, repoName, changed, toDelete, message } = plan;
  const card = new uploadProgress.ProgressCard({ telegram, chatId, messageId: plan.messageId, userId, repo: repoName, store: uploadProgress.redisStore() });
  job.card = card;
  card.state = { ...card.state, stage: 'committing', done: 0, total: changed.length };
  await card.begin();
  // What error helpers / notices need from a ctx, without touching the (finished) update's session.
  const shim = { from: { id: userId }, chat: { id: chatId }, telegram, reply: (text, extra) => telegram.sendMessage(chatId, text, extra) };
  const refs = changed.map((f) => f.contentRef).filter(Boolean);
  try {
    const actionLock = require('../lib/actionLock');
    const { skipped } = await actionLock.withLock(userId, 'uploadCommit', async () => {
      try {
        const user = await repoCache.getUser(userId, plan.token);
        // v1.2.1-multi: the file bytes are loaded and the multi-call commit runs inside the global "upload" gate (bounded
        // simultaneous commits across all users, one per user), so a crowd of people committing big uploads can't add up
        // to a memory spike or a GitHub burst.
        await gate.uploadGate().run(userId, async () => {
          await card.update({ stage: 'committing', done: 0, total: changed.length });
          const filesToCommit = await Promise.all(changed.map(async (f) => ({ path: f.path, mode: f.mode, content: await fileBufferCache.get(f.contentRef) })));
          await github.commitMultipleFiles(plan.token, user.login, repoName, filesToCommit, message, toDelete, {
            branch: plan.branch,
            onProgress: (info) => card.onCommitProgress(info),
            shouldCancel: () => job.cancelled,
          });
        }, { onQueued: () => card.update({ stage: 'queued' }) });

        repoCache.invalidateRepos(userId);
        repoCache.invalidateLanguages(userId, repoName);
        repoCache.invalidateTreeStats(userId, repoName);
        await activity.log(
          userId,
          '⬆️',
          `${plan.replaceFolder ? 'Synced' : 'Uploaded'} ${changed.length} file(s)${toDelete.length ? `, removed ${toDelete.length}` : ''} → ${repoName}`,
          { isCommit: true }
        );

        if (changed.length > 0) {
          const dir = changed[0].path.split('/').slice(0, -1).join('/');
          await pathMemory.setLastPath(userId, repoName, dir);
          // Feeds the global "learned default upload path" suggestion (lib/defaults.checkUploadPathPattern), separate from
          // this per-repo memory.
          await require('../lib/defaults').bumpUploadPathFrequency(userId, dir).catch(() => {});
        }

        const newN = changed.filter((f) => f.status === 'new').length;
        const modN = changed.filter((f) => f.status === 'modified').length;
        const resultText = resultCard.text({
          title: plan.replaceFolder ? 'Folder synced' : 'Pushed to GitHub',
          subject: `📦 *${esc(repoName)}*${changed.length === 1 ? `  ·  \`${format.escapeCodeBlock(changed[0].path)}\`` : ''}`,
          details: [newN ? `🆕 ${newN} new` : '', modN ? `✏️ ${modN} modified` : '', toDelete.length ? `🗑 ${toDelete.length} removed` : '', `💬 ${message}`],
          link: plan.repoUrl ? `${plan.repoUrl}/commits` : undefined,
        });
        await card.finish(resultText, [[style.callback('📂 Open repo', `repo:open:${repoName}`, style.BLUE), style.callback('📤 Upload more', `upload:start:${repoName}`, style.BLUE)]]);

        await require('../handlers/bulkActions').maybeAddLongOpNotice(shim, changed.length + toDelete.length, { label: 'files' });

        // "Learn from me": after enough uploads to the same non-default folder, offer to make it the default (one tap, and
        // a "no" resets the counter). The suggestion is recomputed when the button is tapped (this job has no session).
        if (changed.length > 0) {
          const suggestedPath = await require('../lib/defaults').checkUploadPathPattern(userId).catch(() => null);
          if (suggestedPath) {
            await telegram.sendMessage(
              chatId,
              `💡 You\u2019ve uploaded to \u201c${suggestedPath}/\u201d several times now. Make it your default upload folder?`,
              Markup.inlineKeyboard([
                [style.callback('✅ Yes, Make It Default', 'upload:learnpath:yes', style.BLUE)],
                [style.callback('➖ No Thanks', 'upload:learnpath:skip')],
              ])
            ).catch(() => {});
          }
        }
      } catch (err) {
        await handleUploadJobError(plan, card, shim, err);
      }
    });
    if (skipped) await card.finish('⏳ Already uploading — please wait a moment\\.');
  } catch (err) {
    await handleUploadJobError(plan, card, shim, err);
  } finally {
    if (refs.length) fileBufferCache.releaseAll(refs).catch(() => {});
    uploadProgress.endJob(userId, job);
  }
}

async function handleUploadJobError(plan, card, shim, err) {
  try {
    if (err && err.code === 'UPLOAD_CANCELLED') {
      await card.finish(`🛑 *Upload cancelled*\n📦 ${esc(plan.repoName)}\n_Nothing was changed\\._`, [[style.callback('📤 Upload again', `upload:start:${plan.repoName}`, style.BLUE)]]);
      return;
    }
    await activity.log(plan.userId, '⚠️', `Upload commit failed → ${plan.repoName}`, { detail: err && err.message, isError: true });
    const unknown = github.isUnknownOutcome(err);
    const finalText = unknown
      ? `⚠️ *Upload status unknown*\n📦 ${esc(plan.repoName)}\n_GitHub didn’t confirm the final step — check the repo before trying again\\._`
      : `❌ *Upload didn’t finish*\n📦 ${esc(plan.repoName)}\n_Nothing was changed\\._`;
    await card.finish(finalText, [[style.callback('📤 Try again', `upload:start:${plan.repoName}`, style.BLUE)]]);
    const errorHelpers = require('../lib/errorHelpers');
    if (errorHelpers.isAuthError(err)) {
      // The reconnect flow needs the person's live session, which a background job doesn't have — point them to Settings.
      await shim.reply('🔑 GitHub rejected your saved connection. Open ⚙️ Settings to reconnect, then send the upload again.');
    } else {
      await errorHelpers.replyGithubError(shim, err, 'Upload failed');
    }
  } catch (_) { /* last resort: never throw out of the job */ }
}

/** Stores the scheduled_uploads row and confirms — called from both the
 * quick-pick and custom-time paths above, once a concrete scheduledFor
 * Date has been produced either way. */
async function finalizeUploadSchedule(ctx, scheduledFor, tz) {
  const changed = ctx.wizard.state.pendingFiles.filter((f) => f.status !== 'unchanged');
  const message = ctx.wizard.state.pendingCommitMessage;
  const repoName = ctx.wizard.state.repoName;
  const scheduledUploads = require('../lib/scheduledUploads');
  const timezone = require('../lib/timezone');
  const users = require('../lib/users');
  const user = await users.getUser(ctx.from.id);

  let summaryLine;
  if (changed.length === 1) {
    const file = changed[0];
    const lowerName = file.filename.toLowerCase();
    const isArchive = lowerName.endsWith('.zip') || lowerName.endsWith('.tar') || lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz');
    await scheduledUploads.create(ctx.from.id, {
      repoName,
      targetPath: file.path,
      commitMessage: message,
      fileId: file.fileId,
      fileName: file.filename,
      isArchive,
      archiveAction: isArchive ? 'asis' : null,
      scheduledFor,
    });
    summaryLine = `"${file.path}"`;
  } else {
    // 📦 Multi-file (extracted archive) schedule — read every file's
    // bytes out of fileBufferCache NOW, while it's still definitely
    // warm (we're seconds/minutes past extraction, well inside its
    // 30-minute TTL), and hand them to scheduledUploads.create() to be
    // stored durably in scheduled_upload_files. This is what lets the
    // poller commit them correctly hours or days later without ever
    // needing to re-download or re-extract the original archive.
    const files = await Promise.all(changed.map(async (f) => ({ path: f.path, content: await fileBufferCache.get(f.contentRef) })));
    await scheduledUploads.create(ctx.from.id, {
      repoName,
      commitMessage: message,
      isArchive: true,
      archiveAction: 'extract',
      scheduledFor,
      files,
    });
    summaryLine = `${changed.length} files`;
  }

  await resultCard.send(ctx, {
    title: 'Upload scheduled',
    subject: `📦 *${esc(repoName)}*  ·  ${esc(summaryLine)}`,
    details: [`🕒 ${timezone.formatInZone(scheduledFor, tz, { hour12: user.time_format === '12h' })} (${tz})`, `💬 ${message}`],
    note: 'Manage it any time in Settings → Automation → Scheduled uploads.',
  });
  releasePendingFiles(ctx);
  return ctx.scene.leave();
}

function statusIcon(status) {
  return { new: '🆕', modified: '✏️', unchanged: '➖' }[status] || '•';
}

async function promptForFile(ctx) {
  const st = ctx.wizard.state;
  const where = st.presetDir ? ` → ${st.presetDir}/` : '';
  const verb = st.mode === 'replaceFolder' ? 'Replace folder' : 'Upload';
  await chrome.setBar(ctx, 'cancel', { title: `📤 ${verb} · ${st.repoName}${where} — waiting for a file…`, force: true });
  const lim = st.limits;
  await ctx.reply(
    `📤 *Send me the file*\n\n` +
    `>📁 Any file — up to ${esc(format.formatBytes(lim.maxFileBytes))}\n` +
    `>📦 \\.zip \\.tar \\.tar\\.gz — I’ll ask whether to extract \\(up to ${esc(format.formatBytes(lim.maxZipBytes))}\\)\n` +
    `>🔒 Password\\-protected zips are fine\n\n` +
    `⚠️ Attach it as a *file* \\(📎 → File\\), not as a photo — photos get compressed and change the bytes\\.`,
    { parse_mode: 'MarkdownV2' }
  );
  return ctx.wizard.selectStep(1);
}

function withPresetDir(ctx, path) {
  const dir = ctx.wizard.state.presetDir;
  return dir ? `${dir}/${path}` : path;
}

async function classifyFiles(ctx, fileRefs) {
  const token = await requireConnected(ctx);
  if (!token) return null;
  const user = await repoCache.getUser(ctx.from.id, token);

  let existingTree = [];
  ctx.wizard.state.treeTruncated = false;
  ctx.wizard.state.treeUnreadable = false;
  try {
    existingTree = await github.getTree(token, user.login, ctx.wizard.state.repoName, workBranch(ctx, ctx.wizard.state.repoName, null));
    ctx.wizard.state.treeTruncated = !!existingTree.truncated;
  } catch (err) {
    // Only "the repo has no commits yet" (404/409) means "everything is new".
    // Any other failure (rate limit, 5xx, network, a revoked token) used to be
    // treated the same way, which produced a confidently WRONG preview — every file
    // "New" and nothing to delete in a folder sync (v1.2.3-multi).
    const status = err && (err.status || (err.response && err.response.status));
    if (status !== 404 && status !== 409) {
      const errorHelpers = require('../lib/errorHelpers');
      if (errorHelpers.isAuthError(err)) {
        await errorHelpers.replyGithubError(ctx, err, 'Couldn\u2019t read the repo');
        return null;
      }
      ctx.wizard.state.treeUnreadable = true;
    }
  }
  const existingByPath = new Map(existingTree.map((e) => [e.path, e.sha]));
  const existingModeByPath = new Map(existingTree.map((e) => [e.path, e.mode]));
  const existingSizeByPath = new Map(existingTree.map((e) => [e.path, e.size]));
  // v2.3.2: the line-by-line preview needs the OLD file's content — one GitHub request per modified file. A zip of a whole
  // project (where nearly everything is "modified") meant hundreds of requests at once, which trips GitHub's secondary
  // rate limit; the bot then holds every request for a minute or more and the upload dies before it reaches the summary.
  // Only the first few modified files get a content preview; the rest are compared by SHA and show their size from the tree.
  let diffBudget = MAX_DIFF_FETCHES;
  let diffsPaused = false;

  const classified = await Promise.all(fileRefs.map(async (f) => {
    const content = await fileBufferCache.get(f.contentRef);
    const existingSha = existingByPath.get(f.path);
    const localSha = gitBlobSha(content);
    let status = 'new';
    let oldSize;
    let lineDiff = null;
    if (existingSha) {
      status = existingSha === localSha ? 'unchanged' : 'modified';
      if (status === 'modified') {
        if (typeof existingSizeByPath.get(f.path) === 'number') oldSize = format.formatBytes(existingSizeByPath.get(f.path));
        if (diffBudget <= 0 || diffsPaused) return { ...f, status, oldSize, newSize: format.formatBytes(f.size), lineDiff, mode: existingModeByPath.get(f.path) === '100755' ? '100755' : undefined };
        diffBudget--;
        try {
          const existing = await github.getFileContent(token, user.login, ctx.wizard.state.repoName, f.path, { branch: workBranch(ctx, ctx.wizard.state.repoName, null) });
          oldSize = format.formatBytes(existing.size);
          // v1.2.0-multi — line-level diff, best-effort: only for files
          // that decode as plain text on both sides and stay under the
          // diff utility's size cap (see lib/diff.js). Binary files, huge
          // files, and anything the decode fails on just keep the
          // existing byte-size-only comparison — never a hard failure.
          const diffLib = require('../lib/diff');
          const oldTextContent = diffLib.tryDecodeText(existing.content);
          const newTextContent = diffLib.tryDecodeText(content);
          if (oldTextContent != null && newTextContent != null) {
            lineDiff = diffLib.computeLineDiff(oldTextContent, newTextContent);
          }
        } catch (err) {
          // best-effort — and if GitHub (or the local hold) says slow down, stop asking for previews altogether
          if (require('../lib/rateLimitFriendly').describe(err)) diffsPaused = true;
        }
      }
    }
    // Keep an existing executable bit when a file is overwritten in place.
    const mode = existingModeByPath.get(f.path) === '100755' ? '100755' : undefined;
    return { ...f, status, oldSize, newSize: format.formatBytes(f.size), lineDiff, mode };
  }));

  if (ctx.wizard.state.mode === 'replaceFolder' && (ctx.wizard.state.treeUnreadable || ctx.wizard.state.treeTruncated)) {
    // A folder sync decides what to delete from the repo's file list. If that list is
    // incomplete or unreadable, deleting is unsafe, so this run only adds and updates.
    ctx.wizard.state.toDelete = [];
  } else if (ctx.wizard.state.mode === 'replaceFolder') {
    const targetDir = ctx.wizard.state.presetDir || '';
    const prefix = targetDir ? `${targetDir}/` : '';
    const uploadedPaths = new Set(fileRefs.map((f) => f.path));
    ctx.wizard.state.toDelete = existingTree
      .filter((e) => e.path.startsWith(prefix) && !uploadedPaths.has(e.path))
      .map((e) => e.path);
  }

  return classified;
}

async function processSingleFile(ctx, buffer, filename, fileId = null, isBackNav = false) {
  if (!isBackNav) {
    // Cache the raw Buffer, not a UTF-8-decoded string — decoding here and
    // re-encoding on commit is lossy for anything that isn't valid UTF-8
    // text (images, PDFs, and other binary files would come out corrupted).
    const contentRef = await fileBufferCache.put(buffer);
    // fileId (the ORIGINAL Telegram file_id, not the buffer cache ref) is
    // kept alongside for 📅 Scheduled Uploads — the buffer cache has a
    // short TTL, so a schedule firing hours or days later needs to
    // re-download from Telegram directly rather than relying on this
    // session's cache still being warm.
    ctx.wizard.state.pendingFiles = [{ filename, contentRef, fileId, size: buffer.length, path: null }];
    delete ctx.wizard.state.pendingFiles[0].status;
  }

  if (ctx.wizard.state.lockedPath && !isBackNav) {
    ctx.wizard.state.pendingFiles[0].path = ctx.wizard.state.lockedPath;
    return showSummary(ctx);
  }

  if (ctx.wizard.state.presetDir && !isBackNav) {
    ctx.wizard.state.pendingFiles[0].path = withPresetDir(ctx, ctx.wizard.state.pendingFiles[0].filename);
    return showSummary(ctx);
  }

  const token = await requireConnected(ctx);
  if (!token) return ctx.scene.leave();

  let structureLine = '';
  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    const tree = await github.getTree(token, user.login, ctx.wizard.state.repoName, workBranch(ctx, ctx.wizard.state.repoName, null));
    const topLevel = listDirectory(tree, '');
    if (topLevel.length > 0) {
      const preview = topLevel.slice(0, 8).map((e) => (e.type === 'tree' ? `📁 ${e.name}/` : `📄 ${e.name}`)).join('\n');
      structureLine = `\n📂 In the repo now:\n${preview}${topLevel.length > 8 ? `\n… and ${topLevel.length - 8} more` : ''}`;
    } else {
      structureLine = '\n📂 This repo is empty right now.';
    }
  } catch (_) { /* best-effort */ }

  const f = ctx.wizard.state.pendingFiles[0];
  const defaultsLib = require('../lib/defaults');
  const defaultDir = await defaultsLib.uploadPathFor(ctx.from.id, ctx.wizard.state.repoName);
  const pathButtons = [
    [style.callback('📁 Browse folders', 'upload:choose:browse', style.BLUE), style.callback('📍 Repo root', 'upload:choose:root', style.BLUE)],
  ];
  if (defaultDir) pathButtons.push([style.callback(`⭐ Default (${defaultDir}/)`, 'upload:choose:default')]);
  if (ctx.wizard.state.suggestedDir && ctx.wizard.state.suggestedDir !== defaultDir) {
    pathButtons.push([style.callback(`🕘 Last used (${ctx.wizard.state.suggestedDir}/)`, 'upload:choose:suggested')]);
  }
  const text = `📄 *${esc(f.filename)}*  ·  ${esc(format.formatBytes(f.size))}\n\n*Where should it go?*\nTap a destination, or just type a path like \`src/utils/${format.escapeCodeBlock(f.filename)}\`\\.${structureLine ? `\n${structureLine.trim().split('\n').map((l) => esc(l)).join('\n')}` : ''}`;
  await ui.show(ctx, text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(pathButtons) });
  return ctx.wizard.selectStep(2);
}

/** Turns an ArchiveError from lib/archive.js into the right user-facing
 * reply (or password re-prompt). Returns true when it handled the error. */
async function handleArchiveError(ctx, err, buffer, kind) {
  // v1.2.1-multi: the extraction gate refused or timed out — say exactly that (nothing was uploaded).
  if (err && err.name === 'GateError') {
    await ctx.reply(format.errorMessage('Upload not started', gate.describeGateError(err, 'Extracting this archive').replace(/\.$/, ''), null));
    return true;
  }
  if (!(err instanceof archive.ArchiveError)) return false;

  if (err.code === 'NEEDS_PASSWORD' || err.code === 'BAD_PASSWORD') {
    if (!ctx.wizard.state.pendingZipRef) ctx.wizard.state.pendingZipRef = await fileBufferCache.put(buffer);
    ctx.wizard.state.awaitingZipPassword = true;
    await ephemeral.sendEphemeral(
      ctx,
      err.code === 'BAD_PASSWORD'
        ? '🔒 That password didn\u2019t work. Send the correct password as text, or ❌ Cancel.'
        : '🔒 This zip is password-protected. Send the password as text, or ❌ Cancel.',
      bbtb.cancelOnly
    );
    return true;
  }
  if (err.code === 'TOO_LARGE') {
    await ctx.reply(format.errorMessage(
      'Upload failed',
      `this ${kind} decompresses to more than the ${format.formatBytes(globalConfig.getMaxZipUncompressedBytes())} limit`,
      'This is usually caused by a highly-compressed or corrupted archive — check it and try again.'
    ));
    return true;
  }
  if (err.code === 'TOO_MANY') {
    await ctx.reply(format.errorMessage('Upload failed', `this ${kind} ${err.message}`, 'Split it into smaller archives and upload them one at a time.'));
    return true;
  }
  if (err.code === 'UNSUPPORTED') {
    await ctx.reply(format.errorMessage('Upload failed', err.message, 'Re-create the archive with standard zip compression (or upload it as-is).'));
    return true;
  }
  await ctx.reply(format.errorMessage('Upload failed', `the ${kind} file appears corrupted or empty`, 'Re-export the archive and try again.'));
  return true;
}

/** Shared tail of processZip/processTar: notes about skipped files, empty
 * check, buffering the contents, classification, summary. */
/**
 * v2.3.3: the "received — extracting…" note is the first stage of the live upload card. It is edited to "Comparing…" once
 * the archive is open, and removed when the summary appears (or when anything fails), so it never lingers saying "…ing".
 */
async function startExtractNote(ctx, text) {
  try {
    const sent = await ctx.reply(text);
    ctx.wizard.state.progressNoteId = sent && sent.message_id;
  } catch (_) { /* cosmetic */ }
}

async function setNoteStage(ctx, stage, extra = {}) {
  const id = ctx.wizard.state.progressNoteId;
  if (!id) return;
  try {
    const { text } = uploadProgress.render({ repo: ctx.wizard.state.repoName, stage, ...extra });
    await ctx.telegram.editMessageText(ctx.chat.id, id, undefined, text, { parse_mode: 'MarkdownV2' });
  } catch (_) { /* cosmetic */ }
}

async function clearNote(ctx) {
  const id = ctx.wizard.state.progressNoteId;
  if (!id) return;
  delete ctx.wizard.state.progressNoteId;
  try { await ctx.telegram.deleteMessage(ctx.chat.id, id); } catch (_) { /* already gone */ }
}

async function finishArchiveExtraction(ctx, prepared) {
  const { entries, junkSkipped, unsafeSkipped } = prepared;

  if (junkSkipped > 0) {
    await ctx.reply(`ℹ️ Skipped ${junkSkipped} macOS system file${junkSkipped === 1 ? '' : 's'} (__MACOSX, .DS_Store, ._*) — they don\u2019t belong in a repo.`);
  }
  if (unsafeSkipped > 0) {
    await ctx.reply(`⚠️ ${unsafeSkipped} file${unsafeSkipped === 1 ? '' : 's'} skipped — unsafe path (absolute, "..", or inside .git).`);
  }
  if (entries.length === 0) {
    await ctx.reply(format.errorMessage('Upload failed', 'the archive contains no uploadable files', 'Check the archive and try again.'));
    return;
  }

  await setNoteStage(ctx, 'comparing');

  // Bounded concurrency: a big archive must not fire thousands of Redis
  // writes at once.
  const fileRefs = await mapLimit(entries, 8, async (e) => {
    // Raw Buffer, never a UTF-8 round-trip — that would corrupt any binary
    // file bundled in the archive (images, fonts, etc.).
    const contentRef = await fileBufferCache.put(e.data);
    return { path: withPresetDir(ctx, e.path), contentRef, size: e.data.length };
  });

  const classified = await classifyFiles(ctx, fileRefs);
  if (!classified) return ctx.scene.leave();

  ctx.wizard.state.pendingFiles = classified;
  ctx.wizard.state.fromArchiveExtraction = true;
  return showSummary(ctx);
}

async function processZip(ctx, buffer, password) {
  try {
    return await processZipInner(ctx, buffer, password);
  } finally {
    await clearNote(ctx); // the live note never outlives the step it describes
  }
}

async function processZipInner(ctx, buffer, password) {
  await startExtractNote(ctx, `📦 Zip received (${format.formatBytes(buffer.length)}) — extracting...`);

  // lib/archive.js reads the zip itself with hard limits: sizes are enforced
  // on the bytes ACTUALLY produced by each (capped) inflate, never on the
  // sizes the archive claims about itself, and password-protected archives
  // are detected/verified there too (ZipCrypto, tested against `zip -P`).
  let result;
  try {
    // v1.2.1-multi: gated (bounded concurrent extractions) and run on a worker
    // thread, so a big archive neither piles up with others nor stalls the bot.
    result = await archiveRunner.readZip(buffer, {
      password,
      maxTotalBytes: globalConfig.getMaxZipUncompressedBytes(),
      maxEntries: globalConfig.getMaxArchiveFiles(),
    }, { userId: ctx.from.id, onQueued: () => ctx.reply('⏳ Other archives are being processed — yours is queued and will start automatically.').catch(() => {}) });
  } catch (err) {
    if (await handleArchiveError(ctx, err, buffer, 'zip')) return;
    throw err;
  }

  if (ctx.wizard.state.pendingZipRef) {
    fileBufferCache.release(ctx.wizard.state.pendingZipRef).catch(() => {});
    delete ctx.wizard.state.pendingZipRef;
  }

  return finishArchiveExtraction(ctx, result);
}

/** .tar and .tar.gz/.tgz — gzip decoding uses Node's built-in zlib with a
 * hard output cap (see lib/archive.js), archive parsing uses
 * lib/tarReader.js (no dependency, see that file for why it's hand-rolled). */
async function processTar(ctx, buffer, gzipped) {
  try {
    return await processTarInner(ctx, buffer, gzipped);
  } finally {
    await clearNote(ctx); // the live note never outlives the step it describes
  }
}

async function processTarInner(ctx, buffer, gzipped) {
  await startExtractNote(ctx, `📦 ${gzipped ? 'tar.gz' : 'tar'} received (${format.formatBytes(buffer.length)}) — extracting...`);

  let raw = buffer;
  if (gzipped) {
    try {
      // Output-capped: a decompression bomb is rejected the instant it would
      // exceed the limit, instead of being fully inflated first.
      raw = await archiveRunner.gunzipBounded(buffer, globalConfig.getMaxZipUncompressedBytes(), { userId: ctx.from.id });
    } catch (err) {
      if (err instanceof archive.ArchiveError && err.code === 'CORRUPT') {
        await ctx.reply(format.errorMessage('Upload failed', 'the file isn\u2019t a valid gzip stream', 'Re-export the archive and try again.'));
        return;
      }
      if (await handleArchiveError(ctx, err, buffer, 'archive')) return;
      throw err;
    }
  }

  // Plain (uncompressed) .tar — same ceiling.
  if (raw.length > globalConfig.getMaxZipUncompressedBytes()) {
    await handleArchiveError(ctx, new archive.ArchiveError('TOO_LARGE', 'too large'), buffer, 'archive');
    return;
  }

  let entries, skippedCount;
  try {
    ({ entries, skippedCount } = await archiveRunner.extractTar(raw, { userId: ctx.from.id }));
  } catch (err) {
    if (await handleArchiveError(ctx, err, buffer, 'archive')) return;
    await ctx.reply(format.errorMessage('Upload failed', 'the tar file appears corrupted', 'Re-export the archive and try again.'));
    return;
  }

  if (entries.length === 0 && skippedCount === 0) {
    await ctx.reply(format.errorMessage('Upload failed', 'the archive contains no readable files', 'Check the archive and try again.'));
    return;
  }
  if (entries.length > globalConfig.getMaxArchiveFiles()) {
    await handleArchiveError(ctx, new archive.ArchiveError('TOO_MANY', `contains ${entries.length} files (limit ${globalConfig.getMaxArchiveFiles()})`), buffer, 'archive');
    return;
  }
  if (skippedCount > 0) {
    await ctx.reply(
      `⚠️ ${skippedCount} file${skippedCount === 1 ? '' : 's'} skipped — ${skippedCount === 1 ? 'it has' : 'they have'} a path too long for this reader to handle safely (GNU long-filename entries). Shorten the path(s) and re-archive if you need ${skippedCount === 1 ? 'it' : 'them'} included.`
    );
  }
  if (entries.length === 0) return; // everything was a long-name entry — nothing left to upload

  const prepared = archive.prepareEntries(entries.map((e) => ({ name: e.name, data: e.data })));
  return finishArchiveExtraction(ctx, prepared);
}

const PICKER_PAGE = 8;

/** 📁 A real folder browser: tap into folders, then "Use this folder". Edits the same card in place. */
async function showFolderPicker(ctx, dir, page) {
  const st = ctx.wizard.state;
  const token = await requireConnected(ctx);
  if (!token) return ctx.scene.leave();
  let folders = [];
  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    const tree = await github.getTree(token, user.login, st.repoName, workBranch(ctx, st.repoName, null));
    folders = listDirectory(tree, dir).filter((e) => e.type === 'tree').map((e) => e.name);
  } catch (_) { /* an empty repo has no tree — the picker just shows no folders */ }
  const pages = Math.max(1, Math.ceil(folders.length / PICKER_PAGE));
  const safePage = Math.min(Math.max(1, page), pages);
  st.picker = { dir, folders, page: safePage };
  const slice = folders.slice((safePage - 1) * PICKER_PAGE, safePage * PICKER_PAGE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map((name, j) => style.callback(`📁 ${name.length > 24 ? `${name.slice(0, 23)}…` : name}`, `upload:pick:d:${(safePage - 1) * PICKER_PAGE + i + j}`, style.BLUE)));
  }
  if (pages > 1) {
    const pager = [];
    if (safePage > 1) pager.push(style.callback('◀️ Prev', `upload:pick:page:${safePage - 1}`));
    pager.push(style.callback(`${safePage} / ${pages}`, 'noop'));
    if (safePage < pages) pager.push(style.callback('Next ▶️', `upload:pick:page:${safePage + 1}`));
    rows.push(pager);
  }
  rows.push([style.callback('📍 Use this folder', 'upload:pick:here', style.GREEN)]);
  if (dir) rows.push([style.callback('⬆️ Up one level', 'upload:pick:up')]);
  rows.push([style.callback('↩️ Other destinations', 'upload:choose:back')]);
  const file = st.pendingFiles[0].filename;
  const text = `📁 *Choose a folder*\n📍 \`/${format.escapeCodeBlock(dir)}\`\n📄 ${esc(file)}${folders.length ? '' : '\n\n_No sub\\-folders here\\._'}`;
  await ui.show(ctx, text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

async function showSummary(ctx) {
  if (ctx.wizard.state.pendingFiles.length === 1 && !ctx.wizard.state.pendingFiles[0].status) {
    const classified = await classifyFiles(ctx, ctx.wizard.state.pendingFiles);
    if (!classified) return ctx.scene.leave();
    ctx.wizard.state.pendingFiles = classified;
  }

  const st = ctx.wizard.state;
  const files = st.pendingFiles;
  const counts = { new: 0, modified: 0, unchanged: 0 };
  files.forEach((f) => counts[f.status]++);
  const toDelete = st.toDelete || [];

  if (counts.new === 0 && counts.modified === 0 && toDelete.length === 0) {
    const names = files.map((f) => f.path).join(', ');
    releasePendingFiles(ctx);
    await resultCard.send(ctx, {
      kind: 'info',
      title: 'Nothing to upload',
      subject: `📦 *${esc(st.repoName)}*`,
      details: [files.length === 1 ? `${names} already matches the repo` : `All ${files.length} files already match the repo`],
    }, [[style.callback('📂 Open repo', `repo:${st.repoName}`, style.BLUE)]]);
    await ctx.scene.leave();
    return chrome.returnFromTyping(ctx);
  }

  const parts = [counts.new ? `🆕 ${counts.new} new` : '', counts.modified ? `✏️ ${counts.modified} modified` : '', counts.unchanged ? `➖ ${counts.unchanged} unchanged (skipped)` : '', toDelete.length ? `🗑 ${toDelete.length} to remove` : ''].filter(Boolean);
  let text = `📤 *Ready to push*  →  *${esc(st.repoName)}*\n\n>${esc(parts.join('   '))}`;
  const where = files.length === 1 ? files[0].path : '';
  if (where) text += `\n\n📍 \`${format.escapeCodeBlock(where)}\``;
  const detail = files.filter((f) => f.status === 'modified').slice(0, 3)
    .map((f) => (f.lineDiff ? `✏️ ${f.path}: +${f.lineDiff.addedCount}/−${f.lineDiff.removedCount} lines` : `✏️ ${f.path}: ${f.oldSize || '?'} → ${f.newSize}`));
  if (detail.length) text += `\n\n${detail.map(esc).join('\n')}`;
  if (toDelete.length) text += `\n\n🗑 *Will be removed*\n${toDelete.slice(0, 5).map(esc).join('\n')}${toDelete.length > 5 ? `\n… and ${toDelete.length - 5} more` : ''}`;
  if (st.treeUnreadable) {
    text += `\n\n⚠️ ${esc(`I couldn’t read the repo’s current files just now, so New / Modified labels may be wrong${st.mode === 'replaceFolder' ? ' and nothing will be deleted in this sync' : ''}. Committing is still safe.`)}`;
  } else if (st.treeTruncated) {
    text += `\n\n⚠️ ${esc(`This repo is too large for GitHub to list every file, so labels may be off${st.mode === 'replaceFolder' ? ' and nothing will be deleted in this sync' : ''}.`)}`;
  }

  const hasDiffableFile = files.some((f) => f.status === 'modified' && f.lineDiff);
  const rows = [[style.callback('✅ Commit changes', 'upload:commit', style.GREEN)]];
  const extras = [files.length > 1 || toDelete.length ? style.callback('📋 File list', 'upload:summary:list') : null, hasDiffableFile ? style.callback('🔍 Diff', 'upload:summary:diff') : null].filter(Boolean);
  if (extras.length) rows.push(extras);
  await ui.show(ctx, text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
  return ctx.wizard.selectStep(3);
}

module.exports = scene;
module.exports.releaseOnExternalLeave = releaseOnExternalLeave;
module.exports.runUploadJob = runUploadJob; // exported for tests
