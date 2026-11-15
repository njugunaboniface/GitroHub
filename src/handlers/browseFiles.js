const github = require('../lib/github');
const repoCache = require('../lib/repoCache');
const requireConnected = require('../lib/requireConnected');
const callbackRefs = require('../lib/callbackRefs');
const format = require('../lib/format');
const inline = require('../keyboards/inline');
const activity = require('../lib/activity');
const config = require('../config');
const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const { workBranch } = require('./manage/common');
const chrome = require('../lib/chrome');
// v1.2.4-multi: the branch picked in ⚡ Manage → Branches (null = the repo's default branch)
const branchOf = (ctx, repoName) => workBranch(ctx, repoName, null);

const TEXT_EXTENSIONS = new Set([
  // Code
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'py', 'java', 'kt', 'kts',
  'swift', 'dart', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
  'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'jl', 'nim', 'lua', 'r', 'pl', 'pm',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'vim', 'm', 'mm',
  // Data / config
  'json', 'jsonc', 'yml', 'yaml', 'xml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'env', 'lock', 'csv', 'tsv', 'sql', 'graphql', 'gql', 'proto',
  // Docs / markup
  'md', 'mdx', 'txt', 'rst', 'tex', 'adoc', 'log', 'diff', 'patch',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg',
  // Misc
  'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'babelrc', 'eslintrc',
  'prettierrc', 'dockerignore', 'gemfile', 'rakefile', 'podfile', 'ipynb',
]);

// Filenames the extension check alone would miss — no dot, or the dot isn't
// really an extension (Dockerfile, Makefile, and friends).
const TEXT_FILENAMES = new Set([
  'dockerfile', 'makefile', 'rakefile', 'gemfile', 'podfile', 'procfile',
  'license', 'licence', 'readme', 'changelog', 'authors', 'contributing',
  'notice', 'copying', 'vagrantfile', 'brewfile', 'jenkinsfile',
]);

// Raster formats Telegram's sendPhoto actually accepts — SVG is deliberately
// excluded here (it's XML text, not a raster image Telegram can render as a
// photo) and instead flows through the text-preview path above.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const MAX_INLINE_PHOTO_BYTES = 10 * 1024 * 1024; // Telegram's own ceiling for photo uploads

function isTextFile(filename) {
  const base = filename.toLowerCase();
  if (TEXT_FILENAMES.has(base)) return true;
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return TEXT_EXTENSIONS.has(ext);
}

function isImageFile(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  return IMAGE_EXTENSIONS.has(ext);
}

/** Renders a Jupyter notebook (.ipynb, which is really just JSON) as a
 * readable cell-by-cell transcript instead of a wall of raw JSON — GitHub
 * renders these specially too, this is the text-mode equivalent. */
function renderNotebookPreview(jsonText) {
  const nb = JSON.parse(jsonText);
  const cells = nb.cells || [];
  if (cells.length === 0) return '(empty notebook)';
  return cells
    .map((c, i) => {
      const src = Array.isArray(c.source) ? c.source.join('') : (c.source || '');
      const label = c.cell_type === 'markdown' ? '📝 Markdown' : c.cell_type === 'code' ? '💻 Code' : '▪️ Cell';
      return `── ${label} [${i + 1}] ──\n${src}`;
    })
    .join('\n\n');
}

/** Builds a one-level directory listing from the full recursive tree */
function listDirectory(tree, dirPath) {
  const prefix = dirPath ? `${dirPath}/` : '';
  const seen = new Map();

  for (const entry of tree) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    if (!rest) continue;
    const [first, ...remainder] = rest.split('/');
    if (remainder.length === 0) {
      seen.set(first, { name: first, path: entry.path, type: 'blob' });
    } else if (!seen.has(first)) {
      seen.set(first, { name: first, path: `${prefix}${first}`, type: 'tree' });
    }
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function showDirectory(ctx, repoName, dirPath = '', page = 1) {
  const token = await requireConnected(ctx);
  if (!token) return;

  ctx.session = ctx.session || {};
  ctx.session.currentBrowseDir = dirPath; // used by "Upload Here" / "Replace Folder" BBTB buttons

  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    const tree = await github.getTree(token, user.login, repoName, branchOf(ctx, repoName));

    if (tree.length === 0) {
      return ctx.reply(
        '📭 Nothing here yet\\. Tap 📤 Upload to add your first file\\.',
        { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[style.callback('📤 Upload', `upload:start:${repoName}`, style.BLUE)]]) }
      );
    }

    const allEntries = listDirectory(tree, dirPath);
    const perPage = config.FILES_PER_PAGE;
    const totalPages = Math.max(1, Math.ceil(allEntries.length / perPage));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const entries = allEntries.slice((safePage - 1) * perPage, safePage * perPage);

    const folders = allEntries.filter((e) => e.type === 'tree').length;
    const filesN = allEntries.length - folders;
    const e = format.escapeMd;
    let text = `📂 *${e(repoName)}*${dirPath ? ` / ${e(dirPath)}` : ''}\n`;
    const facts = [folders ? `📁 ${folders} folder${folders === 1 ? '' : 's'}` : '', filesN ? `📄 ${filesN} file${filesN === 1 ? '' : 's'}` : ''];
    if (branchOf(ctx, repoName)) facts.push(`🌿 ${branchOf(ctx, repoName)}`);
    if (totalPages > 1) facts.push(`page ${safePage}/${totalPages}`);
    text += e(facts.filter(Boolean).join('  ·  '));
    if (tree.truncated) text += '\n⚠️ Repo too large — showing a partial tree\\.';

    await chrome.setBar(ctx, 'files');
    await require('./manage/ui').show(ctx, text, {
      parse_mode: 'MarkdownV2',
      ...inline.fileTree(
        entries.map((en) => ({ ...en, type: en.type === 'tree' ? 'tree' : 'blob' })),
        dirPath,
        { page: safePage, totalPages },
        ctx.session.repoUrl || null,
        repoName
      ),
    });
  } catch (err) {
    // v2.3.2: a GitHub "slow down" is one short friendly line, not a red error (and not a second one right after the first).
    const slow = require('../lib/rateLimitFriendly').describe(err);
    if (slow) return ctx.reply(slow.text);
    await ctx.reply(format.errorMessage(
      `Couldn\u2019t load files for "${repoName}"`,
      err.message,
      'Try again, or go back to the repo.'
    ));
  }
}

async function showFileActions(ctx, repoName, filePath) {
  const fileName = filePath.split('/').pop();
  await require('./manage/ui').show(ctx,
    `📄 *${format.escapeMd(fileName)}*\n📍 \`${format.escapeMd(filePath)}\``,
    { parse_mode: 'MarkdownV2', ...inline.fileActions(filePath, repoName) }
  );
}

async function viewFileContent(ctx, repoName, filePath) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const fileName = filePath.split('/').pop();
  // Deep-links straight to GitHub's own file view for whatever this bot
  // can't render inline (PDFs, 3D models, Office docs, etc.) — GitHub can
  // preview far more formats than fit in a Telegram message, so rather
  // than dead-ending on "can't show this", hand off to the real thing.
  const githubUrl = ctx.session.repoUrl ? `${ctx.session.repoUrl}/blob/HEAD/${filePath}` : null;

  try {
    const user = await repoCache.getUser(ctx.from.id, token);

    if (isImageFile(fileName)) {
      let content;
      let size;
      try {
        ({ content, size } = await github.getFileContent(token, user.login, repoName, filePath, { allowLarge: true, maxBytes: MAX_INLINE_PHOTO_BYTES, branch: branchOf(ctx, repoName) }));
      } catch (imgErr) {
        if (imgErr.code !== 'FILE_TOO_LARGE') throw imgErr;
        content = null;
        size = imgErr.size;
      }
      if (content === null || size > MAX_INLINE_PHOTO_BYTES) {
        await ctx.reply(
          format.errorMessage('Image too large to preview inline', `${format.formatBytes(size)} exceeds Telegram's inline photo limit`, 'Use "Send as File" instead, or view it on GitHub.'),
          inline.filePreviewFallback(filePath, githubUrl, repoName)
        );
        return;
      }
      await ctx.replyWithPhoto({ source: content, filename: fileName }, { caption: `🖼️ ${fileName}` });
      return;
    }

    if (!isTextFile(fileName)) {
      await ctx.reply(
        format.errorMessage('Can\u2019t preview this file type here', `${fileName} isn\u2019t a format Telegram can render inline`, 'Use "Send as File" to download it, or view it on GitHub.'),
        inline.filePreviewFallback(filePath, githubUrl, repoName)
      );
      return;
    }

    const { content: contentBuf, size } = await github.getFileContent(token, user.login, repoName, filePath, { branch: branchOf(ctx, repoName) });
    const raw = contentBuf.toString('utf8'); // safe: isTextFile() already gated this call
    const ext = fileName.toLowerCase().includes('.') ? fileName.toLowerCase().split('.').pop() : '';

    let displayText = raw;
    let renderNote = '';
    if (ext === 'ipynb') {
      try { displayText = renderNotebookPreview(raw); } catch (_) { renderNote = '\n⚠️ Couldn\u2019t parse notebook structure — showing raw JSON\\.'; }
    } else if (ext === 'json' || ext === 'jsonc') {
      try { displayText = JSON.stringify(JSON.parse(raw), null, 2); } catch (_) { /* not valid JSON, fall back to raw */ }
    }

    // v1.2.0-multi — .md/.markdown files get their actual formatting
    // rendered (headers as bold, real bold/italic, tappable links, list
    // bullets) instead of showing the raw "# Heading"/"**bold**" syntax
    // in a code block like every other text file. See lib/markdownRender.js
    // for why this is a careful token-based conversion rather than a
    // simple find/replace — MarkdownV2 escaping mistakes are exactly the
    // kind of bug worth being paranoid about.
    if ((ext === 'md' || ext === 'markdown') && !renderNote) {
      const markdownRender = require('../lib/markdownRender');
      const lines = raw.split('\n');
      const preview = lines.slice(0, 60).join('\n'); // a bit more headroom than plain text, since headers/blank lines read sparser
      const truncated = lines.length > 60;
      let text = `📄 *${format.escapeMd(fileName)}* \\(${format.escapeMd(format.formatBytes(size))}\\)\n\n`;
      text += markdownRender.renderMarkdownToTelegram(preview.slice(0, 3500));
      if (truncated) text += `\n\n⚠️ Showing first 60 lines only\\. Use "Send as File" for full file\\.`;
      await ctx.reply(text, { parse_mode: 'MarkdownV2' });
      return;
    }

    const lines = displayText.split('\n');
    const preview = lines.slice(0, 40).join('\n');
    const truncated = lines.length > 40;

    let text = `📄 *${format.escapeMd(fileName)}* \\(${format.escapeMd(format.formatBytes(size))}\\)\n\n`;
    text += '```\n' + format.escapeCodeBlock(preview.slice(0, 3500)) + '\n```';
    if (truncated) text += `\n⚠️ Showing first 40 lines only\\. Use "Send as File" for full file\\.`;
    text += renderNote;

    await ctx.reply(text, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    await ctx.reply(require('../lib/friendlyErrors').message('Couldn\u2019t load file', err), inline.filePreviewFallback(filePath, githubUrl, repoName));
  }
}

async function sendFileAsDocument(ctx, repoName, filePath) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const fileName = filePath.split('/').pop();
  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    const { content } = await github.getFileContent(token, user.login, repoName, filePath, { allowLarge: true, maxBytes: config.TELEGRAM_UPLOAD_LIMIT_BYTES, branch: branchOf(ctx, repoName) });
    // content is already the raw file Buffer — sending it as-is preserves
    // byte-for-byte fidelity for binary files (images, PDFs, etc.), unlike
    // routing it through a UTF-8 string first.
    await ctx.replyWithDocument({ source: content, filename: fileName });
  } catch (err) {
    if (err.code === 'FILE_TOO_LARGE') {
      await ctx.reply(format.errorMessage('File too large to send', `${format.formatBytes(err.size)} is over the ${format.formatBytes(config.TELEGRAM_UPLOAD_LIMIT_BYTES)} Telegram lets a bot send`, 'Use the GitHub link to download it.'));
      return;
    }
    await ctx.reply(require('../lib/friendlyErrors').message('Couldn\u2019t send file', err));
  }
}

async function askDeleteFile(ctx, repoName, filePath) {
  await ctx.reply(
    `⚠️ Delete "${format.escapeMd(filePath)}" from ${format.escapeMd(repoName)}\\?\nThis cannot be undone\\.`,
    { parse_mode: 'MarkdownV2', ...inline.deleteFileConfirm(filePath, repoName) }
  );
}

async function executeDeleteFile(ctx, repoName, filePath) {
  const actionLock = require('../lib/actionLock');
  const { skipped } = await actionLock.withLock(ctx.from.id, 'deleteFile', () => _executeDeleteFile(ctx, repoName, filePath));
  if (skipped) await ctx.reply('⏳ Already processing — please wait a moment.');
}

async function _executeDeleteFile(ctx, repoName, filePath) {
  const token = await requireConnected(ctx);
  if (!token) return;

  try {
    const user = await repoCache.getUser(ctx.from.id, token);
    const { sha } = await github.getFileContent(token, user.login, repoName, filePath, { shaOnly: true, branch: branchOf(ctx, repoName) });
    await github.deleteFile(token, user.login, repoName, filePath, sha, `Delete ${filePath} via GitroHub`, { branch: branchOf(ctx, repoName) });
    repoCache.invalidateRepos(ctx.from.id);
    repoCache.invalidateLanguages(ctx.from.id, repoName);
    repoCache.invalidateTreeStats(ctx.from.id, repoName);
    await activity.log(ctx.from.id, '🗑', `Deleted file → ${filePath} (${repoName})`, { isCommit: true });
    await ctx.reply(format.successMessage(`Deleted "${filePath}"`));
  } catch (err) {
    await activity.log(ctx.from.id, '⚠️', `Delete file failed → ${filePath}`, { detail: err.message, isError: true });
    // v1.2.1-multi: an unconfirmed delete is reported as unconfirmed — never as a plain failure to "try again".
    if (github.isUnknownOutcome(err)) {
      await ctx.reply(format.errorMessage('Couldn\u2019t confirm the file delete', 'GitHub did not confirm the final result, so I can\u2019t say whether it was deleted', 'Refresh the file list to see its current state before trying again.'));
    } else {
      await ctx.reply(require('../lib/friendlyErrors').message('Couldn\u2019t delete file', err));
    }
  }
}

async function searchFiles(ctx, repoName, query) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const user = await repoCache.getUser(ctx.from.id, token);
  const tree = await github.getTree(token, user.login, repoName, branchOf(ctx, repoName));
  const matches = tree.filter((f) => f.path.toLowerCase().includes(query.toLowerCase())).slice(0, 15);

  if (matches.length === 0) {
    return ctx.reply(format.errorMessage(
      `No files matched "${query}"`,
      `checked ${tree.length} files across all folders in ${repoName}`,
      'Check spelling, or browse manually.'
    ));
  }

  let text = `🔍 *File results for "${format.escapeMd(query)}" in ${format.escapeMd(repoName)}* \\(${matches.length} matches\\)\n\n`;
  text += matches.map((m, i) => `${i + 1}\\. 📄 ${format.escapeMd(m.path)}`).join('\n');

  const rows = matches.map((m) => [style.callback(m.path, callbackRefs.bindRepo(repoName, `browse:file:${m.path}`), style.BLUE)]);

  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

module.exports = {
  showDirectory,
  showFileActions,
  viewFileContent,
  sendFileAsDocument,
  askDeleteFile,
  executeDeleteFile,
  searchFiles,
  isTextFile,
  listDirectory,
};
