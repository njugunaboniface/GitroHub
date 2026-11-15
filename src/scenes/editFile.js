const { Scenes, Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
// v1.2.4-multi: edits go to the branch picked in ⚡ Manage → Branches (default branch when none)
const { workBranch } = require('../handlers/manage/common');
const github = require('../lib/github');
const repoCache = require('../lib/repoCache');
const requireConnected = require('../lib/requireConnected');
const format = require('../lib/format');
const activity = require('../lib/activity');
const config = require('../config');
const diffLib = require('../lib/diff');
const chrome = require('../lib/chrome');
const resultCard = require('../lib/resultCard');
const esc = format.escapeMd;

/**
 * Returns the user to exactly where they were — the Browse Files folder
 * containing this file — instead of dumping them at Main Menu. Cancel
 * (and every exit path) is scoped to this context rather than
 * hard-resetting to bbtb.mainMenuFor(ctx.state.isAdmin) regardless of where the flow started.
 */
async function returnToFolder(ctx, repoName, filePath) {
  const browseFiles = require('../handlers/browseFiles');
  const parentDir = filePath.split('/').slice(0, -1).join('/');
  return browseFiles.showDirectory(ctx, repoName, parentDir);
}

/**
 * Telegram trims a message's leading/trailing whitespace and always uses "\n",
 * so text typed into the chat would silently strip the file's final newline and
 * turn CRLF files into LF ones. Put back what the original had (v1.2.3-multi).
 * Only applied to text typed as a message — an uploaded file is used byte for byte.
 */
function restoreOriginalFormatting(original, typed) {
  let out = typed;
  if (original.includes('\r\n') && !out.includes('\r')) out = out.replace(/\n/g, '\r\n');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  if (/\r?\n$/.test(original) && !/\r?\n$/.test(out)) out += eol;
  return out;
}

/** A short, readable preview of what a commit will change (plain text). */
function describeChange(oldText, newText) {
  const lineDiff = diffLib.computeLineDiff(oldText, newText);
  if (!lineDiff) {
    const delta = newText.split('\n').length - oldText.split('\n').length;
    return `Large file — ${delta >= 0 ? '+' : ''}${delta} net lines (no line-by-line preview).`;
  }
  const clip = (l) => (l.length > 70 ? `${l.slice(0, 67)}…` : l);
  const lines = [`+${lineDiff.addedCount} added · −${lineDiff.removedCount} removed`];
  lineDiff.removed.slice(0, 6).forEach((l) => lines.push(`− ${clip(l)}`));
  if (lineDiff.removedCount > 6) lines.push(`  …and ${lineDiff.removedCount - 6} more removed`);
  lineDiff.added.slice(0, 6).forEach((l) => lines.push(`+ ${clip(l)}`));
  if (lineDiff.addedCount > 6) lines.push(`  …and ${lineDiff.addedCount - 6} more added`);
  return lines.join('\n');
}

const scene = new Scenes.WizardScene(
  'editFile',

  async (ctx) => {
    const { repoName, filePath } = ctx.scene.state;
    ctx.wizard.state.repoName = repoName;
    ctx.wizard.state.filePath = filePath;

    const token = await requireConnected(ctx);
    if (!token) return ctx.scene.leave();

    try {
      const user = await repoCache.getUser(ctx.from.id, token);
      const { content: contentBuf, sha } = await github.getFileContent(token, user.login, repoName, filePath, { branch: workBranch(ctx, repoName, null) });
      const content = contentBuf.toString('utf8');

      // Only genuine UTF-8 text can be edited here. Decoding a binary file as
      // text is lossy, and saving the result would corrupt it for good.
      if (contentBuf.includes(0) || !Buffer.from(content, 'utf8').equals(contentBuf)) {
        await ctx.reply(format.errorMessage(
          'Can\u2019t edit this file here',
          `${filePath} isn\u2019t a plain-text file`,
          'Use 🔁 Replace to upload a new version of it instead.'
        ));
        await ctx.scene.leave();
        return returnToFolder(ctx, repoName, filePath);
      }

      ctx.wizard.state.originalContent = content;
      ctx.wizard.state.sha = sha;

      await chrome.setBar(ctx, 'cancel', { title: `✏️ Editing ${filePath} — send the new content`, force: true });
      await ctx.reply(`✏️ *Editing* \`${format.escapeCodeBlock(filePath)}\`\nThe current content is below\\. Send the *full new content* as a message \\(up to 4096 characters\\), or upload the new version as a file for anything longer\\.`, { parse_mode: 'MarkdownV2' });
      if (content.length < 3500) {
        await ctx.reply('```\n' + format.escapeCodeBlock(content) + '\n```', { parse_mode: 'MarkdownV2' }).catch(() =>
          ctx.replyWithDocument({ source: Buffer.from(content), filename: filePath.split('/').pop() })
        );
      } else {
        await ctx.replyWithDocument({ source: Buffer.from(content), filename: filePath.split('/').pop() });
      }
      return ctx.wizard.next();
    } catch (err) {
      const errorHelpers = require('../lib/errorHelpers');
      await errorHelpers.replyGithubError(ctx, err, 'Couldn\u2019t load file for editing');
      await ctx.scene.leave();
      return returnToFolder(ctx, repoName, filePath);
    }
  },

  async (ctx) => {
    const { repoName, filePath, originalContent } = ctx.wizard.state;

    if (ctx.message && ctx.message.text === '❌ Cancel') {
      await ctx.reply('Edit cancelled.');
      await ctx.scene.leave();
      return returnToFolder(ctx, repoName, filePath);
    }

    let newContent;
    let formattingRestored = false;
    if (ctx.message && ctx.message.document) {
      // The new version arrives as a file: used exactly as uploaded.
      const doc = ctx.message.document;
      if (doc.file_size && doc.file_size > config.MAX_SINGLE_FILE_BYTES) {
        await ctx.reply(`That file is ${format.formatBytes(doc.file_size)} — the limit for editing is ${format.formatBytes(config.MAX_SINGLE_FILE_BYTES)}. Send a smaller one, or ❌ Cancel.`);
        return;
      }
      try {
        const link = await ctx.telegram.getFileLink(doc.file_id);
        const res = await fetch(link.href, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const text = diffLib.tryDecodeText(buf, config.MAX_SINGLE_FILE_BYTES);
        if (text == null || !Buffer.from(text, 'utf8').equals(buf)) {
          await ctx.reply('That file isn\u2019t plain UTF-8 text, so I can\u2019t use it for an edit. Send a text file, or ❌ Cancel.');
          return;
        }
        newContent = text;
      } catch (err) {
        await ctx.reply(format.errorMessage('Couldn\u2019t read that file', err.message, 'Send it again, or ❌ Cancel.'));
        return;
      }
    } else if (ctx.message && ctx.message.text) {
      newContent = restoreOriginalFormatting(originalContent, ctx.message.text);
      formattingRestored = newContent !== ctx.message.text;
    } else {
      await ctx.reply('Reply with the new file content as text, or upload it as a file — or ❌ Cancel.');
      return;
    }

    if (newContent === originalContent) {
      await ctx.reply('That\u2019s identical to the current content — nothing to commit. Send the changed version, or ❌ Cancel.');
      return;
    }

    ctx.wizard.state.newContent = newContent;
    await ctx.reply(
      `✏️ *Confirm edit*  ·  \`${format.escapeCodeBlock(filePath)}\`\n\n\`\`\`\n${format.escapeCodeBlock(describeChange(originalContent, newContent))}\n\`\`\`` +
      (formattingRestored ? `\n_${esc('Line endings and the final newline were kept from the original.')}_` : ''),
      { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[style.callback('✅ Commit change', 'edit:confirm', style.GREEN)]]) }
    );
    return ctx.wizard.next();
  },

  async (ctx) => {
    const { repoName, filePath, newContent, sha } = ctx.wizard.state;

    if (ctx.message && ctx.message.text === '❌ Cancel') {
      await ctx.reply('Edit cancelled.');
      await ctx.scene.leave();
      return returnToFolder(ctx, repoName, filePath);
    }
    if (!ctx.callbackQuery) {
      await ctx.reply('Tap ✅ Commit change above, or ❌ Cancel.');
      return;
    }
    await ctx.answerCbQuery();
    if (ctx.callbackQuery.data === 'edit:cancel') {
      await ctx.reply('Edit cancelled.');
      await ctx.scene.leave();
      return returnToFolder(ctx, repoName, filePath);
    }
    if (ctx.callbackQuery.data !== 'edit:confirm') {
      // Stray/stale callback from an unrelated old message — don't treat
      // it as a commit confirmation.
      await ctx.reply('Tap ✅ Commit change above, or ❌ Cancel.');
      return;
    }

    const token = await requireConnected(ctx);
    if (!token) return ctx.scene.leave();

    const actionLock = require('../lib/actionLock');
    const { skipped } = await actionLock.withLock(ctx.from.id, 'editFile', async () => {
    try {
      const user = await repoCache.getUser(ctx.from.id, token);
      const current = await github.getFileContent(token, user.login, repoName, filePath, { branch: workBranch(ctx, repoName, null) });
      if (current.sha !== sha) {
        await ctx.reply(format.errorMessage(
          'Edit failed',
          `${filePath} was modified on GitHub since you opened it`,
          'Nothing was committed. View the latest version first, then edit again — your message above is still in this chat to copy from.'
        ));
        return;
      }

      const message = await require('../lib/defaults').commitMessageFor(ctx.from.id, {
        fallback: `Update ${filePath} via GitroHub`,
        filename: filePath.split('/').pop(),
        repo: repoName,
      });
      await github.putFile(token, user.login, repoName, filePath, newContent, message, sha, { branch: workBranch(ctx, repoName, null) });
      repoCache.invalidateRepos(ctx.from.id);
      repoCache.invalidateLanguages(ctx.from.id, repoName);
      repoCache.invalidateTreeStats(ctx.from.id, repoName);
      await activity.log(ctx.from.id, '✏️', `Edited file → ${filePath} (${repoName})`, { isCommit: true });
      await resultCard.send(ctx, { title: 'File updated', subject: `📄 \`${format.escapeCodeBlock(filePath)}\``, details: [`📦 ${repoName}`, `💬 ${message}`] });
    } catch (err) {
      await activity.log(ctx.from.id, '⚠️', `Edit failed → ${filePath}`, { detail: err.message, isError: true });
      const errorHelpers = require('../lib/errorHelpers');
      await errorHelpers.replyGithubError(ctx, err, 'Edit failed');
    }
    });
    if (skipped) await ctx.reply('⏳ Already saving — please wait a moment.');
    await ctx.scene.leave();
    return returnToFolder(ctx, repoName, filePath);
  }
);

module.exports = scene;
module.exports.restoreOriginalFormatting = restoreOriginalFormatting;
module.exports.describeChange = describeChange;
