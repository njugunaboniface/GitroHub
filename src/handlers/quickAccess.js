const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const format = require('../lib/format');
const pins = require('../lib/pins');
const recentlyViewed = require('../lib/recentlyViewed');
const searchHistory = require('../lib/searchHistory');

/**
 * v1.2.0-multi — Pinned, Recently Viewed, and Search History previously
 * only existed as separate, scattered surfaces: pins had their own
 * dedicated screen, recently-viewed was a bonus message tacked onto My
 * Repos, and search history only ever showed up mid-search. This merges
 * all three into one glance-able screen, without removing any of the
 * originals — 📌 Manage Pins still opens the full pin-management screen
 * (reordering, sections) for when that's actually what's needed.
 *
 * Every tap reuses the EXACT existing callback data those items already
 * used elsewhere (`repo:${name}`, `search:recent:${q}`) rather than
 * introducing a parallel set of routes — so nothing new needed wiring
 * into bot.js's dispatcher for the taps themselves.
 */
async function showQuickAccess(ctx) {
  const telegramId = ctx.from.id;
  const [pinned, recent, searches] = await Promise.all([
    pins.list(telegramId).catch(() => []),
    recentlyViewed.recent(telegramId, 5).catch(() => []),
    searchHistory.recent(telegramId, 5).catch(() => []),
  ]);

  const rows = [];
  for (const p of pinned.slice(0, 5)) rows.push([style.callback(`📌 ${p.repo_name}`, `repo:${p.repo_name}`, style.BLUE)]);
  for (const name of recent) rows.push([style.callback(`📦 ${name}`, `repo:${name}`, style.BLUE)]);
  for (const q of searches) rows.push([style.callback(`🕒 ${q}`, `search:recent:${q}`)]);

  let text = `⚡ *Quick Access*\n\n`;
  if (!pinned.length && !recent.length && !searches.length) {
    text += '_Nothing here yet — pin a repo, browse a few, or run a search and it\u2019ll show up here\\._';
  } else {
    const parts = [];
    if (pinned.length) parts.push(`📌 *Pinned* \\(${pinned.length}\\)\n` + pinned.slice(0, 5).map((p) => `  • ${format.escapeMd(p.repo_name)}`).join('\n'));
    if (recent.length) parts.push(`🕐 *Recently Viewed*\n` + recent.map((n) => `  • ${format.escapeMd(n)}`).join('\n'));
    if (searches.length) parts.push(`🔍 *Recent Searches*\n` + searches.map((q) => `  • ${format.escapeMd(q)}`).join('\n'));
    text += parts.join('\n\n');
  }

  rows.push([style.callback('📌 Manage Pins', 'quickaccess:managepins', style.BLUE)]);
  if (recent.length) rows.push([style.callback('🗑 Clear Recently Viewed', 'quickaccess:clearrecent', style.GREEN)]);
  if (searches.length) rows.push([style.callback('🗑 Clear Search History', 'search:clearhistory', style.GREEN)]);

  rows.push(require('./manage/ui').homeRow());
  await require('./manage/ui').show(ctx, text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

async function clearRecent(ctx) {
  await recentlyViewed.clear(ctx.from.id);
  return showQuickAccess(ctx);
}

module.exports = { showQuickAccess, clearRecent };
