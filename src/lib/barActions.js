/**
 * What each bottom-bar button does (v2.0.0-multi).
 *
 * Buttons that mean the same thing everywhere (📁 My Repos, ⚙️ Settings, …) are GLOBAL; a few labels are per-bar because
 * they act on the page they sit on ("🔍 Search" on My Repos vs. on Search GitHub, "🔄 Refresh"). Handlers are required
 * lazily: this file is loaded while the bot is still being assembled.
 *
 * Buttons that simply open one of the page's own inline screens use `chrome.tap(...)`, i.e. they replay the very callback
 * the inline button used to carry, so there is one code path per feature.
 */
const chrome = require('./chrome');

const lazy = (path) => new Proxy({}, { get: (_, key) => require(path)[key] });
const myRepos = lazy('../handlers/myRepos');
const hub = lazy('../handlers/hub');
const pinned = lazy('../handlers/pinned');
const start = lazy('../handlers/start');
const help = lazy('../handlers/help');
const legal = lazy('../handlers/legal');
const repoView = lazy('../handlers/repoView');
const browseFiles = lazy('../handlers/browseFiles');

const needRepo = async (ctx) => {
  const repoName = ctx.session && ctx.session.currentRepo;
  if (!repoName) {
    await ctx.reply('Open a repo first from 📁 My Repos.');
    return null;
  }
  return repoName;
};

function register() {
  chrome.registerGlobal({
    '📁 My Repos': (ctx) => myRepos.showMyRepos(ctx),
    '💼 Workspace': (ctx) => hub.showWorkspace(ctx),
    '⚙️ Settings': (ctx) => hub.showSettings(ctx),
    '🔔 Notifications': (ctx) => hub.showNotifications(ctx),
    '➕ New Repo': (ctx) => ctx.scene.enter('createRepo'),
    '⭐ Pinned': (ctx) => pinned.showPinned(ctx),
    '🔗 Connect GitHub': (ctx) => start.sendConnectPrompt(ctx),
    '❓ Help': (ctx) => help.handleStart(ctx),
    '📜 Legal': (ctx) => legal.handleStart(ctx),
    '🛡️ Admin Dashboard': async (ctx) => {
      if (!(ctx.state && ctx.state.isAdmin)) return; // typed by hand by a non-admin: nothing happens, nothing is revealed
      return require('../handlers/admin').showDashboard(ctx);
    },

    // Repo bar
    '📂 Files': async (ctx) => {
      const repoName = await needRepo(ctx);
      if (repoName) await browseFiles.showDirectory(ctx, repoName, '');
    },
    '📤 Upload': async (ctx) => {
      const repoName = await needRepo(ctx);
      if (!repoName) return;
      const lastPath = await require('./pathMemory').getLastPath(ctx.from.id, repoName).catch(() => null);
      await ctx.scene.enter('uploadFile', { repoName, suggestedDir: lastPath || undefined });
    },
    '📥 Download': async (ctx) => {
      const repoName = await needRepo(ctx);
      if (repoName) await repoView.downloadRepo(ctx, repoName);
    },

    // Files bar
    '📤 Upload Here': async (ctx) => {
      const repoName = await needRepo(ctx);
      if (repoName) await ctx.scene.enter('uploadFile', { repoName, presetDir: ctx.session.currentBrowseDir || '' });
    },
    '🔁 Replace Folder': async (ctx) => {
      const repoName = await needRepo(ctx);
      if (repoName) await ctx.scene.enter('uploadFile', { repoName, presetDir: ctx.session.currentBrowseDir || '', mode: 'replaceFolder' });
    },
    '🔍 Find Files': async (ctx) => {
      const repoName = await needRepo(ctx);
      if (!repoName) return;
      ctx.session.awaitingFileSearch = true;
      ctx.session.awaitingSearch = false;
      ctx.session.awaitingPublicRepo = false;
      await ctx.reply('🔍 Type a filename or keyword to search this repo’s files.\nKeep typing new queries any time.', require('../keyboards/bbtb').cancelOnly);
    },
  });

  chrome.registerActions('repos', {
    '🔍 Search': (ctx) => chrome.tap(ctx, 'search:type:myrepos'),
  });
  chrome.registerActions('notifications', {
    '✅ Mark all read': (ctx) => chrome.tap(ctx, 'manage:notify:allask'),
    '🔄 Refresh': (ctx) => hub.showNotifications(ctx, { force: true }),
    '🔕 Alert settings': (ctx) => chrome.tap(ctx, 'manage:alerts:home'),
  });
  chrome.registerActions('searchgh', {
    '🕘 Recent searches': (ctx) => hub.showRecentSearches(ctx),
    '🗑️ Clear history': (ctx) => chrome.tap(ctx, 'search:clearhistory'),
  });

  // Where ❌ Cancel returns to: the page the typing prompt interrupted.
  chrome.registerScreens({
    home: (ctx) => chrome.goHome(ctx),
    repos: (ctx) => myRepos.showMyRepos(ctx),
    repo: async (ctx) => {
      const repoName = ctx.session && ctx.session.currentRepo;
      return repoName ? repoView.showRepoView(ctx, repoName) : myRepos.showMyRepos(ctx);
    },
    files: async (ctx) => {
      const repoName = ctx.session && ctx.session.currentRepo;
      return repoName ? browseFiles.showDirectory(ctx, repoName, ctx.session.currentBrowseDir || '') : myRepos.showMyRepos(ctx);
    },
    workspace: (ctx) => hub.showWorkspace(ctx),
    settings: (ctx) => hub.showSettings(ctx),
    notifications: (ctx) => hub.showNotifications(ctx),
    searchgh: (ctx) => hub.showSearch(ctx),
  });
}

module.exports = { register };
