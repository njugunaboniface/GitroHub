const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const repoCache = require('../lib/repoCache');
const requireConnected = require('../lib/requireConnected');
const format = require('../lib/format');
const inline = require('../keyboards/inline');
const config = require('../config');
const pins = require('../lib/pins');
const tags = require('../lib/tags');
const savedViews = require('../lib/savedViews');
const { safeEditMessageText } = require('../lib/safeEdit');
const chrome = require('../lib/chrome');
const show = (ctx, text, extra) => require('./manage/ui').show(ctx, text, extra);

// Simple in-memory view-state per user (filter/sort/page) — not sensitive,
// fine to keep in process memory; resets on restart which is harmless here.
// v1.2.1-multi: LRU-capped (an evicted entry just re-initializes to the defaults on next use).
const viewState = new (require('../lib/boundedMap').BoundedMap)({ max: 5000, name: 'viewState' });

function getState(telegramId) {
  if (!viewState.has(telegramId)) {
    viewState.set(telegramId, { filterType: 'all', filterValue: null, sort: 'updated', page: 1, initialized: false, savedViewId: null });
  }
  return viewState.get(telegramId);
}

async function applyFilterSort(repos, state, telegramId, activeView) {
  let filtered = repos;
  if (activeView) {
    // Smart Folder active — its saved clauses replace the simple
    // filterType chain entirely (they're two different filtering systems;
    // mixing them silently would be confusing about which one "won").
    filtered = await savedViews.apply(telegramId, activeView, repos);
  } else {
    if (state.filterType === 'public') filtered = repos.filter((r) => !r.private);
    if (state.filterType === 'private') filtered = repos.filter((r) => r.private);
    if (state.filterType === 'forks') filtered = repos.filter((r) => r.fork);
    // #9 — has-license / no-license filter. license.key === 'other' or
    // spdx_id === 'NOASSERTION' both mean GitHub couldn't confidently detect
    // a real license, treated the same as "no license" everywhere else in
    // the bot (see format.repoCard).
    if (state.filterType === 'haslicense') {
      filtered = repos.filter((r) => r.license && r.license.spdx_id && r.license.spdx_id !== 'NOASSERTION');
    }
    if (state.filterType === 'nolicense') {
      filtered = repos.filter((r) => !r.license || !r.license.spdx_id || r.license.spdx_id === 'NOASSERTION');
    }
    if (state.filterType === 'language') filtered = repos.filter((r) => (r.language || 'None') === state.filterValue);
    if (state.filterType === 'tag') {
      const repoNames = new Set(await tags.reposWithTag(telegramId, Number(state.filterValue)));
      filtered = repos.filter((r) => repoNames.has(r.name));
    }
  }

  const sorted = [...filtered];
  if (state.sort === 'updated') sorted.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  if (state.sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
  if (state.sort === 'stars') sorted.sort((a, b) => b.stargazers_count - a.stargazers_count);
  if (state.sort === 'created') sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (state.sort === 'language') sorted.sort((a, b) => (a.language || 'zzz').localeCompare(b.language || 'zzz'));

  return sorted;
}

const SORT_LABELS = { updated: 'Recently Updated', name: 'Name (A-Z)', stars: 'Most Stars', created: 'Recently Created', language: 'Dominant Language (A-Z)' };

async function filterLabel(state, telegramId, activeView) {
  if (activeView) return `📁 ${activeView.name}`;
  if (state.filterType === 'all') return 'All';
  if (state.filterType === 'public') return '🌐 Public';
  if (state.filterType === 'private') return '🔒 Private';
  if (state.filterType === 'forks') return '🍴 Forks';
  if (state.filterType === 'haslicense') return '⚖️ Has License';
  if (state.filterType === 'nolicense') return '🚫 No License';
  if (state.filterType === 'language') return `💻 ${state.filterValue}`;
  if (state.filterType === 'tag') {
    const allTags = await tags.listTags(telegramId);
    const t = allTags.find((x) => x.id === Number(state.filterValue));
    return t ? `🏷️ ${tags.tagLabel(t)}` : '🏷️ Tag';
  }
  return 'All';
}

/**
 * Renders one repo using the locked bot-wide card format (see
 * format.repoCard). Kept as its own export (rather than every screen
 * calling format.repoCard directly) so Pinned and any future screen render
 * identically to My Repos with one shared call.
 *
 * Note: a prior version of this took a `ctx` that was never actually in
 * scope (masked by a surrounding try/catch), which silently broke the
 * per-repo language-breakdown lookup on every call. The new card format
 * doesn't need that lookup at all — it shows repo.language directly — so
 * this version has no hidden dependency on caller scope.
 */
function renderRepoLine(r, { pinned = false, tagLine = '', sizeBytes } = {}) {
  return format.repoCard(r, { pinned, tagLine, sizeBytes, partialHealthCheck: true });
}

/** Builds the 🏷️ tag-chip line for a repo, if it has any tags. */
function tagLineFor(repoName, tagMap) {
  const repoTags = tagMap[repoName];
  if (!repoTags || repoTags.length === 0) return '';
  return `🏷️ ${format.escapeMd(repoTags.map((t) => tags.tagLabel(t)).join(' · '))}`;
}

async function showMyRepos(ctx, { edit = false } = {}) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const telegramId = ctx.from.id;
  const state = getState(telegramId);

  if (!state.initialized) {
    state.initialized = true;
    try {
      const defaultsLib = require('../lib/defaults');
      const d = await defaultsLib.getDefaults(telegramId);
      if (d) {
        state.sort = d.default_sort || 'updated';
        state.filterType = d.default_filter || 'all';
      }
    } catch (_) { /* best-effort — fall back to hardcoded defaults */ }
  }

  const allRepos = await repoCache.getRepos(ctx.from.id, token);

  // Smart Folders (saved views) — resolved once per load so applyFilterSort
  // and filterLabel agree on the same view without querying twice.
  let activeView = null;
  if (state.savedViewId) {
    activeView = await savedViews.get(telegramId, state.savedViewId);
    if (!activeView) state.savedViewId = null; // deleted elsewhere — fall back silently
  }

  const filtered = await applyFilterSort(allRepos, state, telegramId, activeView);

  const perPage = config.REPOS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  state.page = Math.min(state.page, totalPages);
  const pageRepos = filtered.slice((state.page - 1) * perPage, state.page * perPage);

  const fLabel = await filterLabel(state, telegramId, activeView);
  const filterActive = !!activeView || state.filterType !== 'all';
  let text = `📁 *My Repos*  ·  ${allRepos.length}\n`;
  text += `🔎 ${format.escapeMd(fLabel)}  ·  ↕️ ${format.escapeMd(SORT_LABELS[state.sort])}`;
  if (totalPages > 1) text += `  ·  page ${state.page}/${totalPages}`;
  if (allRepos.length === 0) {
    text += '\n\nNo repos yet\\. Tap ➕ *New Repo* below to create your first one\\.';
  } else if (pageRepos.length === 0) {
    text += `\n\nNothing matches *${format.escapeMd(fLabel)}*\\.`;
  } else {
    text += '\n\nTap a repo to open it\\.';
  }

  let pinnedSet = new Set();
  let recent = [];
  try {
    const [pinList, recentNames] = await Promise.all([
      pins.list(telegramId),
      state.page === 1 ? require('../lib/recentlyViewed').recent(telegramId, 5).catch(() => []) : [],
    ]);
    pinnedSet = new Set(pinList.map((p) => p.repo_name));
    recent = recentNames;
  } catch (_) { /* pins and recents are decorations */ }

  const keyboard = inline.repoList(pageRepos, state.page, totalPages, { pinned: pinnedSet, recent });
  if (filterActive && pageRepos.length === 0) {
    keyboard.reply_markup.inline_keyboard.unshift([style.callback('✖️ Clear filter', activeView ? 'savedview:exit' : 'filter:all', style.BLUE)]);
  }
  const extra = { parse_mode: 'MarkdownV2', ...keyboard };

  await chrome.setBar(ctx, 'repos');
  chrome.setBack(ctx, null);
  if ((edit || ctx.callbackQuery) && (await safeEditMessageText(ctx, text, extra))) return;
  await ctx.reply(text, extra);
}

async function showStats(ctx) {
  const token = await requireConnected(ctx);
  if (!token) return;

  const allRepos = await repoCache.getRepos(ctx.from.id, token);

  if (allRepos.length === 0) {
    await show(ctx, '📊 Stats\n\nYou don\u2019t have any repos yet — create one to see stats here.');
    return;
  }

  const publicCount = allRepos.filter((r) => !r.private).length;
  const privateCount = allRepos.length - publicCount;
  const totalStars = allRepos.reduce((sum, r) => sum + (r.stargazers_count || 0), 0);

  const langCounts = {};
  for (const r of allRepos) {
    if (!r.language) continue;
    langCounts[r.language] = (langCounts[r.language] || 0) + 1;
  }
  const topLangEntry = Object.entries(langCounts).sort((a, b) => b[1] - a[1])[0];
  const topLanguage = topLangEntry ? `${topLangEntry[0]} (${topLangEntry[1]} repo${topLangEntry[1] === 1 ? '' : 's'})` : 'No language data';

  const mostActive = [...allRepos].sort((a, b) => new Date(b.pushed_at || b.updated_at) - new Date(a.pushed_at || a.updated_at))[0];
  const oldest = [...allRepos].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];

  // #8 — size trend. Uses GitHub's own repo.size field (already on every
  // repo object here, no extra fetch) rather than the real tree-based size
  // used elsewhere — summing real tree sizes across an entire account would
  // mean one tree fetch per repo just to render Stats, which isn't worth it
  // for a trend line that only needs to be roughly right, not exact.
  const sizeSnapshot = require('../lib/sizeSnapshot');
  const totalBytes = allRepos.reduce((sum, r) => sum + (r.size || 0) * 1024, 0);
  const previous = await sizeSnapshot.getPrevious(ctx.from.id).catch(() => null);
  await sizeSnapshot.save(ctx.from.id, totalBytes).catch(() => {});
  let trendLine = '';
  if (previous) {
    const delta = totalBytes - Number(previous.total_bytes);
    if (Math.abs(delta) >= 1024) { // don't show noise under 1KB
      const arrow = delta > 0 ? '📈' : '📉';
      const sign = delta > 0 ? '\\+' : '\\-'; // MarkdownV2: escape the reserved +/- character itself
      trendLine = `▸ ${arrow} ${sign}${format.escapeMd(format.formatBytes(Math.abs(delta)))} since ${format.escapeMd(format.relativeTime(previous.snapshotted_at))}\n`;
    }
  }
  // Rolling 30-day sparkline, one data point per calendar day
  // (size_snapshot_history), alongside the single prior-vs-now delta.
  let sparkLine = '';
  try {
    const history = await sizeSnapshot.getHistory(ctx.from.id, 30);
    if (history.length >= 3) {
      const spark = sizeSnapshot.sparkline(history.map((h) => Number(h.total_bytes)));
      sparkLine = `▸ 📊 30d trend: ${spark}\n`;
    }
  } catch (_) { /* best-effort */ }

  const text =
    `${format.sectionHeader('Stats', `${allRepos.length} total`)}\n\n` +
    `▸ 🌐 Public: ${publicCount}  ·  🔒 Private: ${privateCount}\n` +
    `▸ ⭐ Total stars: ${totalStars}\n` +
    `▸ 💻 Top language: ${format.escapeMd(topLanguage)}\n` +
    `▸ 💾 Total size: ${format.escapeMd(format.formatBytes(totalBytes))}\n` +
    trendLine +
    sparkLine +
    `\n📌 *Most active repo*\n` +
    `${format.escapeMd(mostActive.name)} · 🕒 ${format.escapeMd(format.relativeTime(mostActive.pushed_at || mostActive.updated_at))}\n\n` +
    `🕰️ *Oldest repo*\n` +
    `${format.escapeMd(oldest.name)} · 📅 ${format.escapeMd(format.relativeTime(oldest.created_at))}`;

  await show(ctx, text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([
      [style.callback(`📦 Open ${mostActive.name}`, `repo:${mostActive.name}`, style.BLUE)],
      [style.callback('⬅️ Back', 'repos:back', style.BLUE)],
    ]),
  });
}

async function showFilterMenu(ctx) {
  const rows = inline.filterMenu.reply_markup.inline_keyboard.filter((r) => !r.some((b) => b.callback_data === 'repos:back')).map((r) => r.slice());
  // 📁 Smart Folders live here now (they used to be a separate message above the list).
  try {
    const views = await savedViews.list(ctx.from.id);
    const activeId = getState(ctx.from.id).savedViewId;
    const folders = views.map((v) => style.callback(`${v.id === activeId ? '✅ ' : ''}📁 ${v.name}`, `savedview:apply:${v.id}`, style.BLUE));
    for (let i = 0; i < folders.length; i += 2) rows.push(folders.slice(i, i + 2));
    if (activeId) rows.push([style.callback('✖️ Exit Smart Folder', 'savedview:exit', style.BLUE)]);
  } catch (_) { /* folders are optional */ }
  rows.push([style.callback('⬅️ Back', 'repos:back', style.BLUE)]);
  await show(ctx, '🔎 *Filter repositories by*', { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

async function showSortMenu(ctx) {
  const current = getState(ctx.from.id).sort;
  const rows = inline.sortMenu.reply_markup.inline_keyboard.map((r) => r.map((b) => (
    b.callback_data === `sort:${current}` ? { ...b, text: `✅ ${b.text}` } : b)));
  await show(ctx, '↕️ *Sort repositories by*', { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

async function showLanguageFilterMenu(ctx) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const allRepos = await repoCache.getRepos(ctx.from.id, token);

  const counts = {};
  for (const r of allRepos) {
    const lang = r.language || 'None';
    counts[lang] = (counts[lang] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const rows = entries.map(([lang, count]) => [
    style.callback(`${lang} (${count})`, `filter:lang:${lang}`),
  ]);
  rows.push([style.callback('📊 Language Overview', 'filter:langoverview', style.BLUE)]);
  rows.push([style.callback('⬅️ Back', 'repos:back', style.BLUE)]);

  await show(ctx, '💻 Filter by language:', Markup.inlineKeyboard(rows));
}

async function showLanguageOverview(ctx) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const allRepos = await repoCache.getRepos(ctx.from.id, token);

  const counts = {};
  for (const r of allRepos) {
    const lang = r.language || 'Other';
    counts[lang] = (counts[lang] || 0) + 1;
  }
  const total = allRepos.length || 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  const barWidth = 10;
  let text = `📊 *Your Languages* — ${total} repos\n\n`;
  for (const [lang, count] of sorted.slice(0, 8)) {
    const pct = Math.round((count / total) * 100);
    const filled = Math.round((pct / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    text += `${format.escapeMd(lang.padEnd(12))} ${count} repos  ${bar}  ${pct}%\n`;
  }

  await show(ctx, text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([[style.callback('⬅️ Back to Filter', 'repos:langfiltermenu', style.BLUE)]]),
  });
}

async function showTagFilterMenu(ctx) {
  const userTags = await tags.listTags(ctx.from.id);
  if (userTags.length === 0) {
    await show(ctx, '🏷️ You don\u2019t have any tags yet — create one from a repo\u2019s Tags screen first.');
    return;
  }
  const rows = userTags.map((t) => [style.callback(`${tags.tagLabel(t)} (${t.repo_count})`, `filter:tag:${t.id}`)]);
  rows.push([style.callback('⬅️ Back', 'repos:back', style.BLUE)]);
  await show(ctx, '🏷️ Filter by tag:', Markup.inlineKeyboard(rows));
}

function setFilter(telegramId, type, value = null) {
  const state = getState(telegramId);
  state.filterType = type;
  state.filterValue = value;
  state.savedViewId = null; // choosing a plain filter exits any active Smart Folder
  state.page = 1;
}

function setSort(telegramId, sort) {
  const state = getState(telegramId);
  state.sort = sort;
  state.page = 1;
}

function setPage(telegramId, page) {
  getState(telegramId).page = page;
}

function setSavedView(telegramId, viewId) {
  const state = getState(telegramId);
  state.savedViewId = viewId;
  state.page = 1;
}

function clearSavedView(telegramId) {
  const state = getState(telegramId);
  state.savedViewId = null;
  state.page = 1;
}

module.exports = {
  showMyRepos,
  showStats,
  showFilterMenu,
  showSortMenu,
  showLanguageFilterMenu,
  showLanguageOverview,
  showTagFilterMenu,
  setFilter,
  setSort,
  setPage,
  setSavedView,
  clearSavedView,
  getState,
  renderRepoLine,
  tagLineFor,
};
