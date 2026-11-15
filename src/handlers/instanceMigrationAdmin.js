/**
 * Instance Export/Import handler — Owner-only (fix #13).
 * All the heavy lifting lives in lib/instanceMigration.js; this file
 * drives the live-progress Telegram message-edit loop and handles the
 * file-receive flow for import.
 */

const adminActions = require('../lib/adminActions');
const logger = require('../lib/logger');

async function showMigrationHub(ctx, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  const text =
    `🗄️ *Export / Import*\n\n` +
    `Move this entire deployment to another environment, or restore a snapshot\\.\n\n` +
    `*Export* packages every table plus all GitHub tokens \\(re\\-keyed under a single\\-use transport key\\), then sends you a snapshot file and a one\\-time transport key\\. Keep both\\.\n\n` +
    `*Import* — send the snapshot file, then paste the transport key\\. Everything is validated and written in a transaction \\(if anything fails, your data is untouched\\)\\.\n\n` +
    `\u26a0\ufe0f Import REPLACES all data in this deployment\\.`;
  const { Markup } = require('telegraf');
  const style = require('../keyboards/buttonStyle');
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([
      [style.callback('📤 Export Everything', 'migrate:export', style.BLUE)],
      [style.callback('📥 Import Snapshot', 'migrate:import:start', style.BLUE)],
      [style.callback('⬆️ Back to Admin', 'admin:dashboard', style.BLUE)],
    ]),
  });
}

async function startExport(ctx, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  await ctx.answerCbQuery();
  const { exportInstance } = require('../lib/instanceMigration');

  // Send a progress message we'll edit in-place as each phase completes
  const progressMsg = await ctx.reply('📦 Starting export…');
  const msgId = progressMsg.message_id;
  const chatId = ctx.chat.id;

  async function updateProgress(text) {
    try {
      await ctx.telegram.editMessageText(chatId, msgId, undefined, text);
    } catch (e) { /* edit race — ignore */ }
  }

  let result;
  try {
    result = await exportInstance(updateProgress);
  } catch (e) {
    await updateProgress(`❌ Export failed: ${e.message}`);
    logger.error({ err: e }, 'Instance export failed');
    return;
  }

  const { buffer, transportKey, summary } = result;

  // Send the file
  await ctx.replyWithDocument(
    { source: buffer, filename: `gitrohub-snapshot-${new Date().toISOString().slice(0, 10)}.json.gz` },
    { caption: '📦 GitroHub snapshot — see the transport key below.' }
  );

  // Transport key as a separate message with a strong warning
  await ctx.reply(
    `🔑 *Transport Key* \\(shown once — save it now\\)\n\n` +
    `\`${transportKey}\`\n\n` +
    `You\\'ll need this when importing on the target deployment\\. Without it, tokens can\\'t be restored and users will need to reconnect GitHub\\. This key is NOT stored anywhere\\.`,
    { parse_mode: 'MarkdownV2' }
  );

  const summaryLines = Object.entries(summary.rowCounts)
    .filter(([, v]) => v > 0)
    .map(([t, v]) => `${t}: ${v}`)
    .join(', ');
  await ctx.telegram.editMessageText(
    chatId, msgId, undefined,
    `✅ Export complete — ${summary.tableCount} tables, ${summary.tokenCount} token(s) re-keyed.\n${summaryLines}`
  ).catch(() => {});

  await adminActions.auditLog(ctx.from.id, null, 'instance_export', `${summary.tableCount} tables, ${summary.tokenCount} tokens`);
}

async function startImport(ctx, { adminFn } = {}) {
  if (!(await adminFn.requireOwner(ctx))) return;
  await ctx.answerCbQuery();
  ctx.session.awaitingMigrationFile = true;
  ctx.session.pendingMigrationKey = null;
  await ctx.reply('📥 Send me the `.json.gz` snapshot file to import\\.', { parse_mode: 'MarkdownV2' });
}

/** What the import had to skip because this version's schema differs from the snapshot's (plain text). */
function importNotes(summary) {
  const out = [];
  if (summary.skippedTables && summary.skippedTables.length) out.push(`Skipped tables not in this version: ${summary.skippedTables.join(', ')}`);
  const cols = Object.entries(summary.skippedColumns || {}).map(([t, c]) => `${t}: ${c.join(', ')}`);
  if (cols.length) out.push(`Skipped columns not in this version: ${cols.join(' | ')}`);
  if (summary.safetyColumnsSkipped && summary.safetyColumnsSkipped.length) out.push(`⚠️ Safety-related columns were not imported (${summary.safetyColumnsSkipped.join(', ')}). Check protection/trust/ban settings.`);
  return out.length ? `\n\n${out.join('\n')}` : '';
}

async function handleMigrationFile(ctx, { adminFn } = {}) {
  if (!ctx.session.awaitingMigrationFile) return false;
  if (!(await adminFn.requireOwner(ctx))) return true;
  const doc = ctx.message.document;
  if (!doc || !(doc.file_name || '').endsWith('.gz')) {
    await ctx.reply('That doesn\'t look like a `.json.gz` snapshot — send the file exported by GitroHub.');
    return true;
  }
  // Download it
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const https = require('https');
    const chunks = await new Promise((resolve, reject) => {
      const parts = [];
      https.get(link.href, (res) => {
        res.on('data', (c) => parts.push(c));
        res.on('end', () => resolve(parts));
        res.on('error', reject);
      }).on('error', reject);
    });
    ctx.session.pendingMigrationBuffer = Buffer.concat(chunks).toString('base64');
    ctx.session.awaitingMigrationFile = false;
    ctx.session.awaitingMigrationKey = true;
    await ctx.reply('✅ File received. Now paste the transport key (the 64-character hex code shown at export time).');
  } catch (e) {
    // The snapshot was not imported; keep the file-input flow armed so the
    // Owner can retry with the same or a corrected file.
    ctx.session.awaitingMigrationFile = true;
    await ctx.reply(`❌ Couldn't download the file: ${e.message}\n\nSend the .json.gz snapshot again, or /cancel to abort.`);
  }
  return true;
}

async function handleMigrationKey(ctx, { adminFn } = {}) {
  if (!ctx.session.awaitingMigrationKey) return false;
  if (!(await adminFn.requireOwner(ctx))) return true;
  const key = ctx.message.text.trim();
  if (!/^[0-9a-f]{64}$/.test(key)) {
    await ctx.reply('That doesn\'t look like a valid transport key — it should be a 64-character hex string. Try again or send /cancel to abort.');
    return true;
  }
  ctx.session.awaitingMigrationKey = false;
  const bufferB64 = ctx.session.pendingMigrationBuffer;
  ctx.session.pendingMigrationBuffer = null;
  if (!bufferB64) {
    await ctx.reply('⚠️ Lost the snapshot file — please start over with /start.');
    return true;
  }

  const { importInstance } = require('../lib/instanceMigration');
  const progressMsg = await ctx.reply('📥 Starting import…');
  const msgId = progressMsg.message_id;
  const chatId = ctx.chat.id;

  async function updateProgress(text) {
    try { await ctx.telegram.editMessageText(chatId, msgId, undefined, text); } catch (e) {}
  }

  try {
    const buffer = Buffer.from(bufferB64, 'base64');
    const { tokenResult, summary } = await importInstance(buffer, key, updateProgress);
    const tokenLine = tokenResult === 'carried'
      ? `✅ ${(summary.rowCounts['users'] || 0)} token(s) carried over`
      : `⚠️ Tokens cleared — users will be asked to reconnect GitHub`;
    const summaryLines = Object.entries(summary.rowCounts).filter(([, v]) => v > 0).map(([t, v]) => `${t}: ${v}`).join(', ');
    await ctx.telegram.editMessageText(
      chatId, msgId, undefined,
      `✅ Import complete — ${summary.tableCount} tables. ${tokenLine}.\n${summaryLines}${importNotes(summary)}`
    ).catch(() => {});
    await adminActions.auditLog(ctx.from.id, null, 'instance_import', `${summary.tableCount} tables, tokens: ${tokenResult}`);
  } catch (e) {
    await ctx.telegram.editMessageText(chatId, msgId, undefined, `❌ Import failed: ${e.message}`).catch(() => {});
    logger.error({ err: e }, 'Instance import failed');
  }
  return true;
}

module.exports = {
  showMigrationHub, startExport, startImport,
  handleMigrationFile, handleMigrationKey,
};
