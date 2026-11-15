const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const repoCache = require('../lib/repoCache');
const pins = require('../lib/pins');
const requireConnected = require('../lib/requireConnected');
const format = require('../lib/format');
const myRepos = require('./myRepos');
const { safeEditMessageText } = require('../lib/safeEdit');

async function showPinned(ctx, { edit = false } = {}) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const telegramId = ctx.from.id;
  const pinList = await pins.list(telegramId);

  if (pinList.length === 0) {
    await ctx.reply(
      '📌 Pinned Repos\n\nYou haven\u2019t pinned any repos yet.\nOpen any repo and tap 📌 Pin below to add it here.'
    );
    return;
  }

  const allRepos = await repoCache.getRepos(ctx.from.id, token);
  const repoByName = new Map(allRepos.map((r) => [r.name, r]));
  const tags = require('../lib/tags');
  const tagMap = await tags.tagsForRepos(telegramId, pinList.map((p) => p.repo_name));
  // Bounded to 3 concurrent fetches AND time-boxed (v1.1.21-multi) —
  // Pinned has no pagination cap like My Repos does, so pin count must not
  // decide how long this screen takes to appear. Anything not ready within
  // the budget renders with GitHub's own repo.size and keeps loading in the
  // background so the next Refresh is exact.
  const pinnedRepos = pinList.map((p) => repoByName.get(p.repo_name) || null);
  const treeStatsResults = await repoCache.getTreeStatsBatch(ctx.from.id, token, pinnedRepos);
  const sizeByRepo = new Map(pinList.map((p, i) => [p.repo_name, treeStatsResults[i]]));

  const rows = [];
  const blocks = [];
  let total = 0;

  // v1.2.3-multi: pins are shown in their named sections (pins with no section form
  // the plain "Pinned" group at the top). Reorder arrows work inside a section.
  const groups = await pins.listGrouped(telegramId);
  for (const group of groups) {
    const lines = [];
    const visible = group.items.filter((item) => repoByName.has(item.repo_name)); // a repo may have been deleted/renamed since pinning
    visible.forEach((item, idx) => {
      const repo = repoByName.get(item.repo_name);
      const stats = sizeByRepo.get(repo.name);
      lines.push(myRepos.renderRepoLine(repo, {
        pinned: true,
        tagLine: myRepos.tagLineFor(repo.name, tagMap),
        sizeBytes: stats ? stats.sizeBytes : undefined,
      }));
      total++;

      const controlRow = [];
      if (idx > 0) controlRow.push(style.callback('⬆️', `pin:up:${repo.name}`));
      if (idx < visible.length - 1) controlRow.push(style.callback('⬇️', `pin:down:${repo.name}`));
      controlRow.push(style.callback('📂', `pin:sec:${repo.name}`));
      controlRow.push(style.callback(`Open ${repo.name}`, `repo:${repo.name}`, style.BLUE));
      rows.push(controlRow);
    });
    if (lines.length === 0) continue;
    const header = group.section
      ? `📂 *${format.escapeMd(group.section)}*`
      : (groups.length > 1 ? '📌 *Pinned*' : null);
    blocks.push((header ? `${header}\n\n` : '') + lines.join(`\n${format.CARD_DIVIDER}\n`));
  }

  // #50 — Refresh relocated here (was its own BBTB row, colliding with My
  // Repos' Refresh button — see #49's discovery). #35 — reorder arrows and
  // refresh all edit this same message in place instead of resending the
  // whole pinned list on every tap.
  rows.push([style.callback('🔄 Refresh', 'pinned:refresh')]);
  rows.push(require('./manage/ui').homeRow());

  const text = `${format.sectionHeader('Pinned Repos', `${total} total`)}\n\n` + blocks.join('\n\n');

  if (edit) {
    const keyboard = { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) };
    if (await safeEditMessageText(ctx, text, keyboard)) return;
  }

  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

async function movePin(ctx, repoName, direction) {
  await pins.move(ctx.from.id, repoName, direction === 'up' ? -1 : 1);
  return showPinned(ctx, { edit: true });
}

/** 📂 Pick the section a pin lives in (or create one). Edits the Pinned message in place. */
async function showSectionPicker(ctx, repoName) {
  const sections = await pins.listSections(ctx.from.id);
  const all = await pins.list(ctx.from.id);
  const current = (all.find((p) => p.repo_name === repoName) || {}).pin_section || null;
  const rows = [[style.callback(`${current ? '' : '✓ '}📌 No section`, `pin:setsec:${repoName}:`)]];
  sections.forEach((sec) => rows.push([style.callback(`${current === sec ? '✓ ' : ''}📂 ${sec}`, `pin:setsec:${repoName}:${sec}`)]));
  rows.push([style.callback('➕ New Section…', `pin:newsec:${repoName}`, style.BLUE)]);
  rows.push([style.callback('⬅️ Back', 'pinned:refresh', style.BLUE)]);
  const text = `📂 Where should ${repoName} live?\nSections group your pinned repos on this screen.`;
  const extra = Markup.inlineKeyboard(rows);
  if (ctx.callbackQuery && (await safeEditMessageText(ctx, text, extra))) return;
  await ctx.reply(text, extra);
}

async function setPinSection(ctx, repoName, section) {
  await pins.setSection(ctx.from.id, repoName, section || null);
  return showPinned(ctx, { edit: true });
}

async function askNewSection(ctx, repoName) {
  ctx.session.creatingPinSection = { repoName };
  await ctx.reply(
    `📂 Send a name for the new section (up to 30 characters). ${repoName} will be moved into it.`,
    Markup.keyboard([['❌ Cancel']]).resize()
  );
}

async function handleNewSectionInput(ctx) {
  const state = ctx.session.creatingPinSection;
  const text = ctx.message.text.trim();
  if (text === '❌ Cancel') {
    delete ctx.session.creatingPinSection;
    await ctx.reply('Cancelled.');
    return showPinned(ctx);
  }
  if (!text || text.length > 30 || text.includes(':') || /[\r\n]/.test(text)) {
    // Stay armed so the corrected name is read.
    await ctx.reply(format.errorMessage('That section name won\u2019t work', 'Use 1–30 characters, without a colon', 'Send another name, or ❌ Cancel.'));
    return;
  }
  delete ctx.session.creatingPinSection;
  await pins.setSection(ctx.from.id, state.repoName, text);
  await ctx.reply(`✅ Moved ${state.repoName} into \u201c${text}\u201d.`);
  return showPinned(ctx);
}

module.exports = { showPinned, movePin, showSectionPicker, setPinSection, askNewSection, handleNewSectionInput };
