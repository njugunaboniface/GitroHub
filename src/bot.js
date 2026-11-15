const callbackRefs = require('./lib/callbackRefs');
const chrome = require('./lib/chrome');
const barActions = require('./lib/barActions');
const requestContext = require('./lib/requestContext');
const { Telegraf, Scenes, session, Markup, Composer } = require('telegraf');
const config = require('./config');
const accessControl = require('./middleware/accessControl');
const admin = require('./handlers/admin');
const redisStore = require('./middleware/redisSessionStore');
const bbtb = require('./keyboards/bbtb');
const inline = require('./keyboards/inline');
const style = require('./keyboards/buttonStyle');
const confirmFlow = require('./lib/confirmFlow');
const { safeEditMessageText } = require('./lib/safeEdit');
const logger = require('./lib/logger');
const chatAction = require('./lib/chatAction');

const startHandler = require('./handlers/start');
const myRepos = require('./handlers/myRepos');
const repoView = require('./handlers/repoView');
const browseFiles = require('./handlers/browseFiles');
const settings = require('./handlers/settings');
const activityLog = require('./handlers/activityLog');
const search = require('./handlers/search');
const format = require('./lib/format');
const pinned = require('./handlers/pinned');
const tags = require('./handlers/tags');
const bulkActions = require('./handlers/bulkActions');
const myDefaults = require('./handlers/myDefaults');
const automation = require('./handlers/automation');
const scheduledReposHandler = require('./handlers/scheduledRepos');
const scheduledUploads = require('./handlers/scheduledUploads');
const timezoneHandler = require('./handlers/timezone');
const exportImport = require('./handlers/exportImport');
const trash = require('./handlers/trash');
const storageData = require('./handlers/storageData');
const accessLogScreen = require('./handlers/accessLogScreen');
const help = require('./handlers/help');
const legal = require('./handlers/legal');
const reports = require('./handlers/reports');
const wardenAdminHandler = require('./handlers/wardenAdmin');
const wardenBoard = require('./handlers/wardenBoard');
const migrationAdmin = require('./handlers/instanceMigrationAdmin');

const createRepoScene = require('./scenes/createRepo');
const renameRepoScene = require('./scenes/renameRepo');
const uploadFileScene = require('./scenes/uploadFile');
const editFileScene = require('./scenes/editFile');

/**
 * Text inputs that scenes must keep handling THEMSELVES rather than being
 * treated as a "leave the flow" escape — these are legitimate in-flow
 * controls, not navigation.
 */
const SCENE_INTERNAL_LABELS = new Set(['❌ Cancel', '⏭️ Skip', '⬅️ Back', '⌨️ Type Path Instead', '📍 Use Root']);

async function sendCancelledMenu(ctx) {
  // v2.0.0-multi: a short note that disappears by itself, then the person is put back where they were
  // (their previous page and its bar) — never dumped at a main-menu keyboard.
  await require('./lib/ephemeral').sendEphemeral(ctx, '❌ Cancelled', {}, 1800);
  await chrome.returnFromTyping(ctx);
}

/**
 * GLOBAL SCENE ESCAPE HATCH.
 * Registers the same navigation handlers directly on each scene so
 * /start, /cancel, and every BBTB nav button work identically whether or
 * not a wizard is currently active.
 *
 * `selfEntryLabels` excludes the specific label(s) that are how you ENTER
 * this exact scene in the first place. Without this, entering a scene via
 * a BBTB tap (e.g. "➕ New Repo") would cause Telegraf to re-process that
 * same text INSIDE the newly-entered scene — where it would immediately
 * match its own escape hatch, leave, and re-enter again, bouncing several
 * times before settling (each bounce doing real session I/O). This only
 * affects scenes entered by a BBTB label (New Repo, Upload); scenes
 * entered by inline buttons (Rename, Edit File) are unaffected, since
 * there's no re-processed text for the escape hatch to match.
 */
function attachGlobalEscapes(scene, handlerMap, onLeave, selfEntryLabels = []) {
  const excluded = new Set([...SCENE_INTERNAL_LABELS, ...selfEntryLabels]);
  // The escapes must run BEFORE the scene's own handlers (a plain scene registers `on('text')` when it is defined), so
  // whatever the scene already registered is set aside and re-attached after the escapes.
  const sceneOwn = scene.handler;
  scene.handler = Composer.passThru();
  const cleanup = async (ctx) => {
    if (onLeave) {
      try { onLeave(ctx); } catch (_) { /* never let cleanup itself block leaving */ }
    }
    await ctx.scene.leave();
  };
  scene.command('start', async (ctx) => {
    await cleanup(ctx);
    return startHandler.handleStart(ctx);
  });
  scene.command('cancel', async (ctx) => {
    await cleanup(ctx);
    return sendCancelledMenu(ctx);
  });
  for (const [label, handler] of Object.entries(handlerMap)) {
    if (excluded.has(label)) continue;
    scene.hears(label, async (ctx) => {
      await cleanup(ctx);
      return handler(ctx);
    });
  }
  if (sceneOwn) scene.use(sceneOwn);
}

function createBot() {
  const bot = new Telegraf(config.BOT_TOKEN);
  require('./handlers/manage/areas').registerAll();

  // Assigned once the typed-input flag lists exist (further down); handlers only
  // call it at runtime, long after createBot() has finished wiring.
  let releaseAllTypedInput = () => {};

  bot.use(accessControl());

  // Serializes update processing PER USER — only one update from a given
  // telegram_id is ever being handled at a time. Caps how many simultaneous
  // DB/GitHub requests one person's backlog burst (crash-restart replay,
  // several quick taps) can pile up, without making unrelated users wait
  // behind each other's slow operations.
  //
  // v1.1.0-multi: this used to be ONE shared chain for every update from
  // anyone — correct only because a single-owner bot only ever had one
  // person's updates to serialize against in the first place. With open
  // multi-user access, that would mean User B's tap queues behind
  // whatever User A happens to be doing (e.g. a large zip upload) even
  // though the two share nothing. Keyed by telegram_id instead, so
  // per-user ordering is preserved (still no risk of two updates from the
  // SAME person racing each other) while different users run fully in
  // parallel.
  // Short, bounded, secret-free label for logs/metrics: the callback's action
  // prefix (before the first ':' / '|' / '~') or the command word. Never message text.
  const describeUpdate = (ctx) => {
    const u = ctx.update || {};
    if (u.callback_query && typeof u.callback_query.data === 'string') return `cb:${u.callback_query.data.split(/[:|~]/)[0].replace(/[^\w.-]/g, '').slice(0, 24)}`;
    const text = u.message && typeof u.message.text === 'string' ? u.message.text : '';
    if (text.startsWith('/')) return `cmd:${text.split(/[\s@]/)[0].slice(1, 25).replace(/[^\w]/g, '')}`;
    if (u.message && (u.message.document || u.message.photo)) return 'file';
    return u.message ? 'message' : 'update';
  };
  const updateSerializer = new (require('./lib/userSerializer').UserSerializer)({ maxPending: Number(process.env.USER_MAX_PENDING_UPDATES) || 25, maxRunMs: Number(process.env.USER_UPDATE_TIMEOUT_MS) || 60000 });
  const rapidTap = new (require('./lib/rapidTap').RapidTapGuard)();
  bot.use(async (ctx, next) => {
    const senderId = ctx.from && ctx.from.id;
    // v1.2.3-multi: an identical tap on the same button within ~1.2s is a
    // bounce, not a second request. Drop it before it queues so toggles
    // can't flip twice (see lib/rapidTap.js).
    const cbq = ctx.callbackQuery;
    if (cbq && cbq.message && rapidTap.isDuplicate(senderId, cbq.message.chat && cbq.message.chat.id, cbq.message.message_id, cbq.data)) {
      await ctx.answerCbQuery().catch(() => {});
      return;
    }
    const result = await updateSerializer.run(senderId, async () => {
      // Immediate visual feedback the moment this update actually starts
      // being worked on — so a tap never just sits there with no sign
      // anything happened, even during the split-second before the real
      // reply arrives. Fire-and-forget: never blocks on this.
      ctx.sendChatAction('typing').catch(() => {});

      // v1.2.1-multi: everything this update does — database work, GitHub
      // requests, retries — carries one correlation id (op_…) and this user's
      // id, so the GitHub traffic layer can schedule fairly per user and logs
      // can be traced from the Telegram update to the final outcome.
      await requestContext.runOperation({ userId: senderId, priority: 'interactive', operation: describeUpdate(ctx) }, () => next());
    });
    if (result.dropped) {
      // A user with a huge backlog of unprocessed updates: refuse the excess instead of holding it in memory.
      if (ctx.callbackQuery) await ctx.answerCbQuery('Too many requests at once — give me a moment.').catch(() => {});
    }
  });

  bot.use(session({ store: redisStore }));
  bot.use(chrome.middleware);
  bot.use(chrome.tidyUserMessages);

  // v1.1.7-multi — callback-data resolver. Runs right after the session is
  // loaded and BEFORE the scene stage / any router, so nothing downstream ever
  // sees a packed value. It (a) expands `~id` references that replaced
  // callback_data over Telegram's 64-byte limit, and (b) unwraps `@repo|`
  // bindings, making the repo a button was rendered for the current repo
  // again — so a browse/file button on an OLDER message acts on the repo THAT
  // message showed, not whichever repo became "current" afterwards.
  // See lib/callbackRefs.js.
  bot.use(async (ctx, next) => {
    const cb = ctx.update && ctx.update.callback_query;
    if (!cb || !callbackRefs.needsResolve(cb.data)) return next();

    const resolved = await callbackRefs.resolve(cb.data);
    if (!resolved) {
      await ctx.answerCbQuery('This button has expired — please reopen it from the menu.', { show_alert: true }).catch(() => {});
      return;
    }
    cb.data = resolved.data;
    if (resolved.repo && ctx.session && ctx.session.currentRepo !== resolved.repo) {
      ctx.session.currentRepo = resolved.repo;
      // repoUrl (Open in Browser / View on GitHub links) is tied to the current
      // repo too — recompute it so it can't keep pointing at the previous one.
      const login = ctx.state && ctx.state.user && ctx.state.user.github_username;
      ctx.session.repoUrl = login ? `https://github.com/${login}/${resolved.repo}` : null;
    }
    return next();
  });

  // ─── Shared handler map: BBTB label -> handler ────────────────
  // v1.3.0-multi: the admin bottom keyboards are gone (Admin lives inside 💼 Workspace). Someone still holding an old one
  // gets the normal menu back on their first tap, then the screen they asked for.
  const legacyAdmin = (fn) => async (ctx) => {
    if (ctx.state && ctx.state.isAdmin) await ctx.reply('🛡️ Admin now lives in 💼 Workspace → 🛡️ Admin. Your menu has been refreshed.', bbtb.mainMenuFor(true));
    return fn(ctx);
  };
  const handlerMap = {
    '📁 My Repos': (ctx) => myRepos.showMyRepos(ctx),
    '➕ New Repo': (ctx) => ctx.scene.enter('createRepo'),
    '🔍 Search Repo': async (ctx) => {
      await ctx.reply('🔍 Search for a repo:', inline.searchTypeMenu());
    },
    '⚙️ Settings': (ctx) => require('./handlers/hub').showSettings(ctx),
    // v1.2.4-multi: account-level tools hub (orgs, gists, notifications, …).
    '💼 Workspace': (ctx) => require('./handlers/hub').showWorkspace(ctx),
    '🔗 Connect GitHub': (ctx) => startHandler.sendConnectPrompt(ctx),

    // v1.3.3-multi: this used to be two separate entries — '⬆️ Back to
    // Menu' (most screens) and a shorter '⬆️ Menu' (Bulk Select only,
    // cramped for width) — that happened to do the exact same thing.
    // Renamed the long label down to match the short one everywhere, so
    // there's exactly one "leave to the main menu" button and one handler
    // for it. This is also the ONLY way out of 🛡️ Admin (see adminZone
    // below) — clearing it here, and nowhere else, is what makes it the
    // sole exit from the admin side back to the regular one.
    '⬆️ Menu': async (ctx) => {
      releaseAllTypedInput(ctx);
      ctx.session.awaitingSearch = false;
      ctx.session.adminZone = false;
      await chrome.goHome(ctx);
    },

    '🔎 Filter': (ctx) => myRepos.showFilterMenu(ctx),
    '↕️ Sort': (ctx) => myRepos.showSortMenu(ctx),
    '⭐ Pinned': (ctx) => pinned.showPinned(ctx),
    '⚡ Quick Access': (ctx) => require('./handlers/quickAccess').showQuickAccess(ctx),
    '🧹 Bulk Select': (ctx) => bulkActions.startBulkSelect(ctx),

    '⬅️ Back to Repos': (ctx) => myRepos.showMyRepos(ctx),

    '⬆️ Upload': async (ctx) => {
      const repoName = ctx.session.currentRepo;
      if (!repoName) return ctx.reply('Open a repo first from 📁 My Repos.');
      const pathMemory = require('./lib/pathMemory');
      const lastPath = await pathMemory.getLastPath(ctx.from.id, repoName).catch(() => null);
      await ctx.scene.enter('uploadFile', { repoName, suggestedDir: lastPath || undefined });
    },
    '📁 Browse Files': async (ctx) => {
      const repoName = ctx.session.currentRepo;
      if (!repoName) return ctx.reply('Open a repo first from 📁 My Repos.');
      return chatAction.withChatAction(ctx, 'typing', () => browseFiles.showDirectory(ctx, repoName, ''));
    },
    '⬇️ Download Repo': async (ctx) => {
      const repoName = ctx.session.currentRepo;
      if (!repoName) return ctx.reply('Open a repo first from 📁 My Repos.');
      await repoView.downloadRepo(ctx, repoName);
    },
    '🔒 Visibility': async (ctx) => {
      const repoName = ctx.session.currentRepo;
      if (!repoName) return ctx.reply('Open a repo first from 📁 My Repos.');
      await repoView.askToggleVisibility(ctx, repoName);
    },
    '⚖️ License': async (ctx) => {
      const repoName = ctx.session.currentRepo;
      if (!repoName) return ctx.reply('Open a repo first from 📁 My Repos.');
      await repoView.showLicenseMenu(ctx, repoName);
    },

    '🔍 Search Files': async (ctx) => {
      ctx.session.awaitingFileSearch = true;
      ctx.session.awaitingSearch = false;
      ctx.session.awaitingPublicRepo = false;
      await ctx.reply('🔍 Type a filename or keyword to search across all files.\nKeep typing new queries any time, no need to tap Search again.', bbtb.cancelOnly);
    },
    '⬆️ Back to Repo': async (ctx) => {
      const repoName = ctx.session.currentRepo;
      if (repoName) await repoView.showRepoView(ctx, repoName);
    },
    '⬆️ Upload Here': async (ctx) => {
      const repoName = ctx.session.currentRepo;
      const dir = ctx.session.currentBrowseDir || '';
      if (!repoName) return ctx.reply('Open a repo first from 📁 My Repos.');
      await ctx.scene.enter('uploadFile', { repoName, presetDir: dir });
    },
    '🔁 Replace Folder': async (ctx) => {
      const repoName = ctx.session.currentRepo;
      const dir = ctx.session.currentBrowseDir || '';
      if (!repoName) return ctx.reply('Open a repo first from 📁 My Repos.');
      await ctx.scene.enter('uploadFile', { repoName, presetDir: dir, mode: 'replaceFolder' });
    },

    '📜 Activity': (ctx) => chatAction.withChatAction(ctx, 'typing', () => activityLog.showActivity(ctx)),
    '🚪 Disconnect': (ctx) => settings.askDisconnect(ctx),
    '⬆️ Back to Settings': (ctx) => settings.showSettings(ctx),
    '🤖 Automation': (ctx) => automation.showAutomationHub(ctx),
    '⬆️ Back to Automation': (ctx) => automation.showAutomationHub(ctx),
    '🔧 Rules': (ctx) => automation.showRulesHub(ctx),
    '⬆️ Back to Rules': (ctx) => automation.showRulesHub(ctx),
    '▶️ Backup Now': (ctx) => automation.runBackupNow(ctx),
    '⚙️ Defaults': (ctx) => myDefaults.showDefaults(ctx),
    '▶️ Run Rules Now': (ctx) => chatAction.withChatAction(ctx, 'typing', () => automation.runAllRulesNow(ctx)),
    '📅 Schedule': (ctx) => automation.showScheduleHub(ctx),
    '⬆️ Back to Schedule': (ctx) => automation.showScheduleHub(ctx),
    '📦 Storage': (ctx) => storageData.showStorageData(ctx),
    // 🔄 Refresh Status and 🔑 Access Log are no longer BBTB buttons —
    // relocated to inline (see #47/#48). Their handler functions are still
    // reachable, now via the callback_query router below.

    '⬅️ Back': async (ctx) => {
      // The bottom bar's ⬅️ Back — the only Back in the bot. Ends any typed-input mode, then replays the screen's own
      // Back target (or Home when there is none). See lib/chrome.js.
      releaseAllTypedInput(ctx);
      ctx.session.awaitingSearch = false;
      ctx.session.awaitingPublicRepo = false;
      ctx.session.awaitingFileSearch = false;
      return chrome.goBack(ctx);
    },

    '📤 Upload Another': async (ctx) => {
      const repoName = ctx.session.currentRepo;
      if (repoName) await ctx.scene.enter('uploadFile', { repoName });
    },

    '✅ Done': (ctx) => bulkActions.showActionMenu(ctx),
    '◀️ Selection': (ctx) => bulkActions.startBulkSelect(ctx),

    // v1.1.0-multi — 🛡️ Admin Dashboard. Each handler re-checks
    // ctx.state.isAdmin itself (admin.requireAdmin) rather than trusting
    // that the BBTB button was hidden — bot.hears matches on exact text,
    // so a non-admin typing the label by hand must still be a no-op.
    '🛡️ Admin': legacyAdmin((ctx) => admin.showDashboard(ctx)),
    // v1.1.8 hub redesign — 👥 Users / 📊 Stats / 📜 Audit / ⚙️ Config /
    // 🩺 Maint are no longer direct Dashboard buttons (see bbtb.js);
    // they're one level deeper now, reached via their hub's own inline
    // picker. Handlers kept — those screens are unchanged, only their
    // entry point moved.
    '🤖 Warden': legacyAdmin((ctx) => wardenAdminHandler.showWarden(ctx, { adminFn: admin })),
    '👥 People': legacyAdmin((ctx) => admin.showPeopleHub(ctx)),
    '📊 Oversight': legacyAdmin((ctx) => admin.showOversightHub(ctx)),
    '🛠️ Ops': legacyAdmin((ctx) => admin.showOpsHub(ctx)),
    '🗂️ Bulk': legacyAdmin((ctx) => admin.showBulkHub(ctx)),
    '⬆️ Back to Admin': (ctx) => admin.showDashboard(ctx),
    '⬅️ Back to People': (ctx) => admin.showPeopleHub(ctx),
    '⬅️ Back to Oversight': (ctx) => admin.showOversightHub(ctx),
    '⬅️ Back to Ops': (ctx) => admin.showOpsHub(ctx),
    '⬅️ Back to Users': (ctx) => admin.showUsers(ctx, { filter: 'all', page: 1 }),
    '⏭️ Skip': (ctx) => {
      // ✏️ Description edit shows ⏭️ Skip ("Skip to clear it") — this label used
      // to fall through to the ban-reason handler, which silently did nothing.
      if (ctx.session.editingDescription) return repoView.handleDescriptionInput(ctx, '⏭️ Skip');
      if (ctx.session.awaitingMaintenanceMessage) return admin.skipMaintenanceMessage(ctx);
      if (ctx.session.awaitingSuspendReason) return admin.skipSuspendReason(ctx);
      return admin.skipBanReason(ctx);
    },
    '🗑️ Clear Notes': (ctx) => admin.clearNotes(ctx),

    // Admin sub-hub shortcuts — act on the fleet in general (no target
    // needed) or on ctx.session.currentAdminTarget (whichever user's
    // detail card is currently open, same pattern as currentRepo).
    '🔍 Search': (ctx) => admin.askSearch(ctx),
    '📢 Cast': (ctx) => admin.askBroadcast(ctx),
    '📜 Cast History': (ctx) => admin.showBroadcastHistory(ctx),
    '📈 Chart': (ctx) => chatAction.withChatAction(ctx, 'upload_photo', () => admin.sendFleetChart(ctx)),
    '📤 CSV': (ctx) => admin.exportFleetStatsCsv(ctx),
    '📤 Export CSV': (ctx) => admin.exportAuditLogCsv(ctx),
    '🎚️ Limits': (ctx) => {
      const targetId = ctx.session.currentAdminTarget;
      if (!targetId) return ctx.reply('Open a user first from 👥 Users.');
      return admin.showLimits(ctx, targetId);
    },
    '📜 History': (ctx) => {
      const targetId = ctx.session.currentAdminTarget;
      if (!targetId) return ctx.reply('Open a user first from 👥 Users.');
      return admin.showAuditLog(ctx, { page: 1, targetTelegramId: targetId });
    },
    // v1.3.4-multi — 🏆 Top / ⚠️ Errors / 📈 Growth / 🕵️ Anomaly / 🗓️ Jobs /
    // 🖥️ Health / 🧹 Purge / ⏸️ Suspend / 🔇 Mute / 📣 Nudge / 📤 Export /
    // 🗑️ Banned are no longer BBTB buttons — removed from bbtb.adminFleetStats
    // and bbtb.adminBulkHub as duplicates of that screen's own inline
    // keyboard. Their handler functions are still reachable, now only via
    // the callback_query router below (same pattern as Refresh/Access Log
    // above).
  };

  // v2.0.0-multi: every label on the new bottom bars gets a handler (so it also escapes an open wizard), and the labels that
  // mean different things on different bars are routed by the bar that is on screen.
  barActions.register();
  for (const label of chrome.knownLabels()) {
    if (!handlerMap[label]) handlerMap[label] = (ctx) => chrome.runLabel(ctx, label);
  }
  handlerMap['🔍 Search'] = async (ctx) => { if (!(await chrome.runLabel(ctx, '🔍 Search'))) return admin.askSearch(ctx); };

  // v1.3.0-multi: the buttons that used to sit on contextual bottom keyboards are inline now. `nav:<key>` callbacks
  // reach the very same handlers the old text labels did (handlers/hub.js keeps the bridge).
  const NAV_LABELS = {
    repos: '📁 My Repos', newrepo: '➕ New Repo', filter: '🔎 Filter', sort: '↕️ Sort', pinned: '⭐ Pinned', quick: '⚡ Quick Access',
    bulk: '🧹 Bulk Select', upload: '⬆️ Upload', browse: '📁 Browse Files', download: '⬇️ Download Repo', visibility: '🔒 Visibility',
    license: '⚖️ License', searchfiles: '🔍 Search Files', backrepo: '⬆️ Back to Repo', uploadhere: '⬆️ Upload Here',
    replacefolder: '🔁 Replace Folder', activity: '📜 Activity', disconnect: '🚪 Disconnect', automation: '🤖 Automation',
    rules: '🔧 Rules', schedule: '📅 Schedule', defaults: '⚙️ Defaults', storage: '📦 Storage', runrules: '▶️ Run Rules Now',
    backup: '▶️ Backup Now', backautomation: '⬆️ Back to Automation', backrules: '⬆️ Back to Rules', backschedule: '⬆️ Back to Schedule',
  };
  require('./handlers/hub').registerNav(Object.fromEntries(Object.entries(NAV_LABELS).filter(([, label]) => handlerMap[label]).map(([key, label]) => [key, handlerMap[label]])));

  attachGlobalEscapes(createRepoScene, handlerMap, null, ['➕ New Repo']);
  attachGlobalEscapes(renameRepoScene, handlerMap);
  attachGlobalEscapes(uploadFileScene, handlerMap, uploadFileScene.releaseOnExternalLeave, ['⬆️ Upload', '⬆️ Upload Here', '📤 Upload', '📤 Upload Here', '🔁 Replace Folder', '📤 Upload Another']);
  attachGlobalEscapes(editFileScene, handlerMap);

  const stage = new Scenes.Stage([createRepoScene, renameRepoScene, uploadFileScene, editFileScene]);
  // v2.3.3: ❌ Cancel on the live upload card. The upload runs as a background job, so this is answered the moment it is tapped —
  // ahead of the scenes (a wizard step would otherwise treat the tap as its own input). It stops the commit before the branch
  // moves; once the branch update has started it is too late and the card simply finishes as a success.
  bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery || ctx.callbackQuery.data !== 'upload:job:cancel') return next();
    const uploadProgress = require('./lib/uploadProgress');
    const job = uploadProgress.getJob(ctx.from.id);
    if (!job) {
      await ctx.answerCbQuery('This upload already finished.').catch(() => {});
      return undefined;
    }
    uploadProgress.requestCancel(ctx.from.id);
    await ctx.answerCbQuery('Cancelling…').catch(() => {});
    if (job.card) await job.card.update({ stage: 'cancelling' });
    return undefined;
  });

  bot.use(stage.middleware());
  bot.use(chrome.dispatcher);

  // ─── Commands ─────────────────────────────────────────────
  bot.start(startHandler.handleStart);
  bot.command('settings', (ctx) => require('./handlers/hub').showSettings(ctx)); // still works when typed; hidden from the "/" menu
  bot.command('help', (ctx) => help.handleStart(ctx));
  bot.command('legal', (ctx) => legal.handleStart(ctx));
  // 🛡️ /admin — admins only: straight to the Admin Dashboard (works while not connected to GitHub too, since roles belong to the
  // Telegram account). Anyone else gets exactly what an unknown command gets: nothing.
  bot.command('admin', async (ctx) => {
    if (!(ctx.state && ctx.state.isAdmin)) return;
    return admin.showDashboard(ctx);
  });
  // 🌐 /owner — OWNER only: a private, single-use, 2-minute link to the web panel (see lib/ownerWeb.js). Anyone else: nothing.
  bot.command('owner', (ctx) => require('./handlers/ownerWebLink').sendLink(ctx));
  // Typed shortcuts: /repos and /new mirror the "👤 My Repos" and "➕ New Repo" Main Menu
  // buttons exactly (same guarded handler/scene, so requireConnected(), the hourly action
  // cap and every other gate on those entry points applies here too). They are
  // deliberately NOT in the registered command list (setMyCommands in index.js) — they work
  // when typed, or when deep-linked, but don't clutter the "/" menu.
  bot.command('repos', (ctx) => myRepos.showMyRepos(ctx));
  bot.command('new', (ctx) => ctx.scene.enter('createRepo'));
  // 🚩 /report — see handlers/reports.js: the one inbound admin-facing
  // channel a user has, as opposed to every other admin↔user interaction
  // running admin→user.
  bot.command('report', (ctx) => reports.askReport(ctx));
  // /cancel is registered further down, right after the ❌ Cancel handler — it
  // must clear pending typed input exactly like that button does.
  // Deliberately NOT added to setMyCommands (index.js) — a power-user
  // shortcut straight into the exact same Full Reset confirmation flow as
  // Settings → 📦 Storage → 🗑 Clear Data → Everything, not a second
  // reset mechanism with its own rules. Still requires typing RESET to
  // actually go through.
  bot.command('reset', (ctx) => storageData.confirmClear(ctx, 'full'));

  // Typed-input modes that stay armed after an invalid entry (so the corrected
  // value is read) must not outlive the moment the person moves on: tapping any
  // inline button or menu label abandons them. Without this, a re-armed
  // prompt would swallow whatever unrelated text they type next.
  const REARMABLE_INPUT_FLAGS = [
    'awaitingSaveViewName', 'awaitingQuietHours', 'creatingTag', 'editingTagDefault', 'creatingPinSection', 'editingDefault',
    'automationRuleInput', 'automationMuteRuleInput', 'automationBackupRuleInput',
    'awaitingCustomTimezone', 'awaitingTrashRestoreName', 'editingTrashRestore',
    'editingScheduledField', 'editingScheduledTime', 'editingUploadField', 'editingUploadTime',
    'awaitingFullReset', 'editingDescription', 'editingDescriptionPrevious',
    'awaitingSettingsImport', 'awaitingBroadcastText', 'awaitingBanReason',
    'awaitingSuspendReason', 'awaitingCustomNumber', 'awaitingMigrationFile',
    'awaitingMigrationKey', 'awaitingUserSearch', 'awaitingMaintenanceMessage',
    'awaitingMaintenanceAutoOn', 'awaitingMaintenanceAutoOff', 'awaitingAdminMessageText',
    'awaitingAdminNotesText', 'awaitingReportText', 'awaitingBroadcastScheduleTime',
    'manageInput',
  ];
  // Search modes are deliberately NOT in the list above: they are meant to
  // survive the search:* / external:* callbacks (recent-search taps, star/
  // fork/download on a looked-up repo — see the callback router), which is
  // what "keep typing new queries any time" promises. Only a NAV LABEL or
  // ❌ Cancel / ⬆️ Menu / ⬅️ Back ends them.
  const SEARCH_MODE_FLAGS = ['awaitingSearch', 'awaitingPublicRepo', 'awaitingFileSearch'];
  releaseAllTypedInput = (ctx) => {
    for (const f of REARMABLE_INPUT_FLAGS) delete ctx.session[f];
    for (const f of SEARCH_MODE_FLAGS) ctx.session[f] = false;
  };
  const navLabels = new Set(Object.keys(handlerMap));
  bot.use(async (ctx, next) => {
    const text = ctx.message && ctx.message.text;
    const movedOn = !!ctx.callbackQuery
      || (typeof text === 'string' && text.startsWith('📂 ') && !!(ctx.session && ctx.session.dockRepo))
      || (typeof text === 'string' && navLabels.has(text) && !SCENE_INTERNAL_LABELS.has(text));
    if (movedOn && ctx.session) for (const f of REARMABLE_INPUT_FLAGS) delete ctx.session[f];
    if (ctx.session && typeof text === 'string' && navLabels.has(text) && !SCENE_INTERNAL_LABELS.has(text)) {
      for (const f of SEARCH_MODE_FLAGS) ctx.session[f] = false;
    }
    return next();
  });

  // ─── BBTB (Reply Keyboard) text handlers ───────────────────
  for (const [label, handler] of Object.entries(handlerMap)) {
    bot.hears(label, handler);
  }

  const cancelPendingInput = async (ctx) => {
    // Clears EVERY session-flag-driven flow, not just search — otherwise a
    // stale flag (e.g. awaitingFullReset) stays stuck after Cancel and can
    // misfire on the next unrelated message the person sends.
    releaseAllTypedInput(ctx);
    ctx.session.awaitingSearch = false;
    ctx.session.awaitingPublicRepo = false;
    ctx.session.awaitingFileSearch = false;
    ctx.session.awaitingSaveViewName = false;
    delete ctx.session.awaitingQuietHours;
    delete ctx.session.creatingTag;
    delete ctx.session.editingTagDefault;
    delete ctx.session.creatingPinSection;
    delete ctx.session.editingDefault;
    delete ctx.session.automationRuleInput;
    delete ctx.session.automationMuteRuleInput;
    delete ctx.session.automationBackupRuleInput;
    delete ctx.session.awaitingCustomTimezone;
    delete ctx.session.awaitingTrashRestoreName;
    delete ctx.session.editingTrashRestore;
    delete ctx.session.editingScheduledField;
    delete ctx.session.editingScheduledTime;
    delete ctx.session.editingUploadField;
    delete ctx.session.editingUploadTime;
    delete ctx.session.awaitingFullReset;
    delete ctx.session.editingDescription;
    delete ctx.session.awaitingSettingsImport;
    delete ctx.session.pendingImport;
    delete ctx.session.awaitingBroadcastText;
    delete ctx.session.pendingBroadcast;
    delete ctx.session.awaitingBanReason;
    delete ctx.session.pendingBanTarget;
    delete ctx.session.pendingBanReason;
    delete ctx.session.pendingBanDays;
    delete ctx.session.awaitingSuspendReason;
    delete ctx.session.pendingSuspendTarget;
    delete ctx.session.pendingSuspendHours;
    delete ctx.session.pendingBroadcastSendAt;
    delete ctx.session.awaitingCustomNumber;
    delete ctx.session.awaitingMigrationFile;
    delete ctx.session.awaitingMigrationKey;
    delete ctx.session.pendingMigrationBuffer;
    delete ctx.session.awaitingUserSearch;
    delete ctx.session.awaitingMaintenanceMessage;
    delete ctx.session.awaitingMaintenanceAutoOn;
    delete ctx.session.awaitingMaintenanceAutoOff;
    delete ctx.session.awaitingAdminMessageText;
    delete ctx.session.pendingMessageTarget;
    delete ctx.session.awaitingAdminNotesText;
    delete ctx.session.pendingNotesTarget;
    delete ctx.session.awaitingReportText;
    delete ctx.session.pendingReportText;
    delete ctx.session.awaitingBroadcastScheduleTime;
    delete ctx.session.pendingBroadcast;
    await sendCancelledMenu(ctx);
  };
  bot.hears('❌ Cancel', cancelPendingInput);
  // Same handler for /cancel — before this it only showed the menu and left
  // every pending-input flag armed (so e.g. the migration prompt's "send
  // /cancel to abort" didn't actually abort, and the next message was still
  // swallowed by the flow).
  bot.command('cancel', cancelPendingInput);

  // ─── Free-text input router ─────────────────────────────────
  // v1.1.22-multi — "typed-answer" safety net. Most typed-input flows consume
  // their pending-input flag FIRST and only re-arm it on the specific bad
  // inputs they validate for. If the save itself then failed (a GitHub or DB
  // hiccup, a rejected value) the flag was already gone, so the person's
  // NEXT message matched nothing and the bot went silent until they hit
  // Cancel and started over. Snapshot the retry-safe flags before the
  // handler runs; if it throws, put them back so the very same prompt keeps
  // listening. bot.catch() still reports the error, and adds a hint that the
  // prompt is still active. (Only prompts where a throw means "input not
  // accepted" are listed — destructive/admin confirmations are deliberately
  // NOT auto re-armed.)
  const RETRY_SAFE_INPUT_FLAGS = [
    'awaitingSaveViewName', 'awaitingQuietHours', 'awaitingCustomTimezone',
    'creatingTag', 'editingTagDefault', 'creatingPinSection', 'editingDefault',
    'automationRuleInput', 'automationMuteRuleInput', 'automationBackupRuleInput',
    'awaitingTrashRestoreName', 'editingTrashRestore',
    'editingScheduledField', 'editingScheduledTime', 'editingUploadField', 'editingUploadTime',
    'editingDescription', 'editingDescriptionPrevious', 'awaitingReportText',
    'manageInput',
  ];
  const guardedTextInput = async (ctx, next) => {
    const snapshot = {};
    for (const k of RETRY_SAFE_INPUT_FLAGS) {
      if (ctx.session && ctx.session[k]) snapshot[k] = ctx.session[k];
    }
    try {
      return await textInputRouter(ctx, next);
    } catch (err) {
      let rearmed = false;
      for (const [k, v] of Object.entries(snapshot)) {
        if (!ctx.session[k]) { ctx.session[k] = v; rearmed = true; }
      }
      if (rearmed) ctx.state.inputRearmed = true;
      throw err;
    }
  };

  const textInputRouter = async (ctx, next) => {
    if (ctx.scene && ctx.scene.current) return next(); // scene handles its own text

    if (ctx.session.awaitingSaveViewName) return bulkActions.handleSaveViewNameInput(ctx, ctx.message.text);
    if (ctx.session.awaitingQuietHours) return settings.handleQuietHoursInput(ctx, ctx.message.text);
    if (ctx.session.creatingTag) return tags.handleCreateTagInput(ctx);
    if (ctx.session.editingTagDefault) return tags.handleTagDefaultInput(ctx);
    if (ctx.session.creatingPinSection) return pinned.handleNewSectionInput(ctx);
    if (ctx.session.editingDefault) return myDefaults.handleTextInput(ctx);
    if (ctx.session.automationRuleInput) return automation.handleRuleValueInput(ctx, ctx.message.text);
    if (ctx.session.automationMuteRuleInput) return automation.handleMuteRuleValueInput(ctx, ctx.message.text);
    if (ctx.session.automationBackupRuleInput) return automation.handleBackupRuleValueInput(ctx, ctx.message.text);
    if (ctx.session.awaitingCustomTimezone) return timezoneHandler.handleCustomTimezoneInput(ctx);
    if (ctx.session.awaitingTrashRestoreName) return trash.handleRestoreNameInput(ctx);
    if (ctx.session.editingTrashRestore) return trash.handleEditRestoreTextInput(ctx);
    if (ctx.session.editingScheduledField) return scheduledReposHandler.handleFieldTextInput(ctx);
    if (ctx.session.editingScheduledTime) return scheduledReposHandler.handleCustomTimeInput(ctx);
    if (ctx.session.editingUploadField) return scheduledUploads.handleFieldTextInput(ctx);
    if (ctx.session.editingUploadTime) return scheduledUploads.handleCustomTimeInput(ctx);
    if (ctx.session.awaitingFullReset) return storageData.handleResetConfirmationText(ctx);
    if (ctx.session.editingDescription) return repoView.handleDescriptionInput(ctx, ctx.message.text);
    if (ctx.session.awaitingBroadcastText) return admin.handleBroadcastText(ctx);
    if (ctx.session.awaitingBanReason) return admin.handleBanReasonText(ctx);
    if (ctx.session.awaitingSuspendReason) return admin.handleSuspendReasonText(ctx);
    if (ctx.session.awaitingCustomNumber) return admin.handleCustomNumberText(ctx);
    // v1.1.8 — migration transport key (Owner-only)
    if (ctx.session.awaitingMigrationKey) {
      const handled = await migrationAdmin.handleMigrationKey(ctx, { adminFn: admin });
      if (handled) return;
    }
    if (ctx.session.awaitingUserSearch) return admin.handleSearchText(ctx);
    if (ctx.session.awaitingMaintenanceMessage) return admin.handleMaintenanceMessageText(ctx);
    if (ctx.session.awaitingMaintenanceAutoOn) return admin.handleMaintenanceScheduleInput(ctx, 'on');
    if (ctx.session.awaitingMaintenanceAutoOff) return admin.handleMaintenanceScheduleInput(ctx, 'off');
    if (ctx.session.awaitingAdminMessageText) return admin.handleAdminMessageText(ctx);
    if (ctx.session.awaitingAdminNotesText) return admin.handleAdminNotesText(ctx);
    if (ctx.session.awaitingReportText) return reports.handleReportText(ctx);
    if (ctx.session.awaitingBroadcastScheduleTime) return admin.handleBroadcastScheduleCustomTime(ctx);
    if (ctx.session.manageInput) { if (await require('./handlers/manage/input').handleText(ctx)) return; }
    if (ctx.session.awaitingSettingsImport) return ctx.reply('Send the exported .json file as a document attachment, or ❌ Cancel.');
    if (ctx.session.awaitingMigrationFile) return ctx.reply('Send the .json.gz snapshot file as a document attachment, or ❌ Cancel.');

    if (ctx.session.awaitingSearch) {
      return search.handleMyReposSearchInput(ctx, ctx.message.text);
    }
    if (ctx.session.awaitingPublicRepo) {
      return search.handlePublicRepoInput(ctx, ctx.message.text);
    }
    if (ctx.session.awaitingFileSearch) {
      return browseFiles.searchFiles(ctx, ctx.session.currentRepo, ctx.message.text);
    }
    // v2.1.1: never ignore a tap silently. A bar button that somehow got past its own handler still runs, and text nobody
    // is waiting for gets a short hint that removes itself.
    if (chrome.knownLabels().has(ctx.message.text) && await chrome.runLabel(ctx, ctx.message.text)) return;
    if (!(ctx.scene && ctx.scene.current) && !ctx.message.text.startsWith('/')) {
      return require('./lib/ephemeral').sendEphemeral(ctx, 'ℹ️ I wasn’t expecting that. Use the buttons below, or /help.', {}, 3500);
    }
    return next();
  };
  bot.on('text', guardedTextInput);

  // ─── Free-document input router ─────────────────────────────
  // Only one flow outside a Scene needs a raw document upload right now
  // (Import Settings) — this stays intentionally tiny rather than growing
  // into a second upload pipeline; anything heavier belongs in a Scene
  // like uploadFile already is.
  bot.on('document', async (ctx, next) => {
    if (ctx.scene && ctx.scene.current) return next(); // scene handles its own documents
    if (ctx.session.awaitingSettingsImport) {
      ctx.session.awaitingSettingsImport = false;
      return exportImport.handleImportFile(ctx);
    }
    if (ctx.session.manageInput && (await require('./handlers/manage/input').handleDocument(ctx))) return;
    if (ctx.session.awaitingAdminMessageText) return admin.handleAdminMessageDocument(ctx);
    // v1.1.8 — migration file (Owner-only)
    if (ctx.session.awaitingMigrationFile) return migrationAdmin.handleMigrationFile(ctx, { adminFn: admin });
    return next();
  });

  // ─── Free-photo input router ────────────────────────────────
  // Only one flow needs a raw photo outside a Scene right now — 💬
  // Message's attachment support — same "stays tiny, heavier upload
  // pipelines belong in a Scene" reasoning the document router above
  // already documents.
  bot.on('photo', async (ctx, next) => {
    if (ctx.scene && ctx.scene.current) return next(); // scene handles its own photos
    if (ctx.session.awaitingAdminMessageText) return admin.handleAdminMessagePhoto(ctx);
    return next();
  });

  // ─── Inline callback_query router ───────────────────────────
  const callbackRouter = async (ctx, next) => {
    const data = ctx.callbackQuery.data || '';

    // Claim write-style confirmation callbacks by their Telegram message before
    // any handler runs. Closes the rapid-double-tap race where both taps are
    // already queued even though the first handler removed the keyboard (a
    // double-tapped "Send broadcast" would otherwise go out twice). Shared via
    // Redis so it also holds across instances; fails open if Redis is down.
    if (confirmFlow.isActionCallback(data)) {
      const claimed = await confirmFlow.claimCallback(ctx);
      if (!claimed) {
        await ctx.answerCbQuery('Already handled — please wait for the result.').catch(() => {});
        return;
      }
    }

    // v1.1.8: the "Page X/Y" label in the middle of a pagination row
    // (see inline.js's "◀️ Prev · Page X/Y · Next ▶️" style) isn't
    // meant to do anything when tapped — just answer so Telegram
    // doesn't leave the tap spinning, and stop here.
    if (data === 'noop') return ctx.answerCbQuery();

    if (data.startsWith('report:cat:')) {
      await ctx.answerCbQuery();
      return reports.submitReport(ctx, data.split('report:cat:')[1]);
    }

    // Any navigation away from search (anything other than the search
    // callbacks themselves) ends "still listening for a search query" —
    // otherwise a stray later message could be mistaken for one. search:*
    // and external:* are exempt since those are still part of the search
    // flow itself (recent-search taps, star/fork/download on a looked-up
    // repo) and shouldn't interrupt being able to paste/type another query.
    if (!data.startsWith('search:') && !data.startsWith('external:')) {
      ctx.session.awaitingSearch = false;
      ctx.session.awaitingPublicRepo = false;
      ctx.session.awaitingFileSearch = false;
    }

    // ❓ Help / 📜 Legal — plain content navigation, no confirm/session state.
    if (data === 'help:menu') { await ctx.answerCbQuery(); return help.showMenu(ctx, { edit: true }); }
    if (data.startsWith('help:topic:')) { await ctx.answerCbQuery(); const [, , topicId, topicPage] = data.split(':'); return help.showTopic(ctx, topicId, topicPage); }
    if (data === 'help:faq' || data.startsWith('help:faq:')) { await ctx.answerCbQuery(); return help.showFaq(ctx, data.split(':')[2]); }
    if (data === 'help:contact') { await ctx.answerCbQuery(); return help.showContact(ctx); }
    if (data === 'help:report') { await ctx.answerCbQuery(); return reports.askReport(ctx); }
    if (data === 'legal:index') { await ctx.answerCbQuery(); return legal.showIndex(ctx, { edit: true }); }
    if (data.startsWith('legal:section:')) { await ctx.answerCbQuery(); return legal.showSection(ctx, data.split(':')[2]); }

    // v1.3.0-multi: Workspace / Settings hubs and the bridge to what used to be bottom-keyboard buttons.
    if (data.startsWith('hub:') || data.startsWith('nav:')) {
      await ctx.answerCbQuery().catch(() => {});
      if (await require('./handlers/hub').route(ctx, data)) return;
    }
    // v1.4.0-multi: 📊 Details — the deeper tier of the repo card (languages, commits, README preview), shown in place.
    if (data.startsWith('repo:info:')) {
      await ctx.answerCbQuery().catch(() => {});
      return repoView.showRepoView(ctx, data.slice('repo:info:'.length), { detail: true });
    }
    if (data.startsWith('repo:open:')) {
      await ctx.answerCbQuery().catch(() => {});
      return repoView.showRepoView(ctx, data.slice('repo:open:'.length), { edit: true });
    }
    if (data.startsWith('repo:more:')) {
      await ctx.answerCbQuery().catch(() => {});
      const name = data.slice('repo:more:'.length);
      const same = ctx.session && ctx.session.currentRepo === name;
      const markup = inline.repoMore(name, same ? ctx.session.repoUrl : null, same && !!ctx.session.repoHasReadme).reply_markup;
      try { return await ctx.editMessageReplyMarkup(markup); } catch (_) { return repoView.showRepoView(ctx, name); }
    }
    if (data === 'settings:status') { await ctx.answerCbQuery(); return settings.showSettings(ctx, { skipBbtb: true, edit: true }); }

    // Search entry-point split (📁 My Repos vs 🌐 Public Repo)
    if (data === 'search:type:myrepos') {
      await ctx.answerCbQuery();
      ctx.session.awaitingSearch = true;
      ctx.session.awaitingPublicRepo = false;
      ctx.session.awaitingFileSearch = false;
      // Recent searches as quick-tap suggestions, best-effort.
      // bot.js sits at src/bot.js, sibling to src/lib/, so the require
      // path is './lib/searchHistory'.
      const searchHistory = require('./lib/searchHistory');
      const recent = await searchHistory.recent(ctx.from.id, 5).catch(() => []);
      await ctx.reply(
        '🔍 Type a name or keyword to fuzzy-search your repos.\nAdd filters like is:private, lang:JavaScript, tag:work, stars:>50 — mix and match, or use them alone.\nKeep typing new queries any time, no need to tap Search again.',
        bbtb.cancelOnly
      );
      if (recent.length) {
        const rows = recent.map((q) => [style.callback(`🕒 ${q}`, `search:recent:${q}`)]);
        rows.push([style.callback('🗑 Clear History', 'search:clearhistory')]);
        await ctx.reply('Or tap a recent search:', Markup.inlineKeyboard(rows));
      }
      return;
    }
    if (data.startsWith('search:recent:')) {
      await ctx.answerCbQuery();
      return search.handleMyReposSearchInput(ctx, data.split('search:recent:')[1]);
    }
    if (data === 'search:clearhistory') {
      await ctx.answerCbQuery();
      const searchHistory = require('./lib/searchHistory');
      await searchHistory.clear(ctx.from.id);
      if (await safeEditMessageText(ctx, '🗑 Search history cleared.')) return;
      return ctx.reply('🗑 Search history cleared.');
    }
    if (data === 'quickaccess:managepins') {
      await ctx.answerCbQuery();
      return pinned.showPinned(ctx);
    }
    if (data === 'quickaccess:clearrecent') {
      await ctx.answerCbQuery();
      return require('./handlers/quickAccess').clearRecent(ctx);
    }
    if (data === 'search:type:public') {
      await ctx.answerCbQuery();
      ctx.session.awaitingPublicRepo = true;
      ctx.session.awaitingSearch = false;
      ctx.session.awaitingFileSearch = false;
      await ctx.reply('🌐 Paste a GitHub repo link (e.g. https://github.com/owner/repo). You can paste another right after this one, any time.', bbtb.cancelOnly);
      return;
    }

    // v1.2.4-multi: every ⚡ Manage / 💼 Workspace button goes through one dispatcher
    // (connected → feature switch → scopes → repo name → handler).
    if (data.startsWith('manage:')) {
      await ctx.answerCbQuery();
      if (await require('./handlers/manage').route(ctx, data)) return;
    }

    // Repo list / filter / sort / pagination
    if (
      data.startsWith('repo:') &&
      !data.includes(':rename:') && !data.includes(':delete:') &&
      !data.includes(':visibility:') && !data.includes(':pin:') && !data.includes(':tags:') &&
      !data.includes(':description:') && !data.includes(':license:') &&
      !data.includes(':cloneurl:') && !data.includes(':star:') &&
      !data.includes(':export:') && !data.includes(':readme:') && !data.includes(':webhook:') &&
      !data.startsWith('repo:info:') && !data.startsWith('repo:open:')
    ) {
      await ctx.answerCbQuery();
      const repoName = data.split('repo:')[1];
      return repoView.showRepoView(ctx, repoName);
    }
    if (data.startsWith('repos:page:')) {
      await ctx.answerCbQuery();
      myRepos.setPage(ctx.from.id, Number(data.split(':')[2]));
      return myRepos.showMyRepos(ctx, { edit: true });
    }
    if (data === 'repos:refresh') { await ctx.answerCbQuery('🔄 Refreshed'); return myRepos.showMyRepos(ctx, { edit: true }); }
    if (data === 'repos:stats') { await ctx.answerCbQuery(); return myRepos.showStats(ctx); }
    if (data === 'repos:back') {
      await ctx.answerCbQuery();
      return myRepos.showMyRepos(ctx);
    }
    if (data === 'repos:langfiltermenu') {
      await ctx.answerCbQuery();
      return myRepos.showLanguageFilterMenu(ctx);
    }

    // Repo actions: rename / delete / visibility / pin / tags
    if (data.startsWith('repo:rename:')) {
      await ctx.answerCbQuery();
      const repoName = data.split('repo:rename:')[1];
      return ctx.scene.enter('renameRepo', { repoName });
    }
    if (data.startsWith('undo:action:')) {
      await ctx.answerCbQuery();
      return repoView.undoAction(ctx, data.split('undo:action:')[1]);
    }
    if (data.startsWith('repo:description:')) {
      await ctx.answerCbQuery();
      return repoView.askEditDescription(ctx, data.split('repo:description:')[1]);
    }
    if (data.startsWith('repo:cloneurl:')) {
      await ctx.answerCbQuery();
      return repoView.showCloneUrl(ctx, data.split('repo:cloneurl:')[1]);
    }
    if (data.startsWith('repo:export:')) {
      await ctx.answerCbQuery();
      return repoView.exportRepoJson(ctx, data.split('repo:export:')[1]);
    }
    if (data.startsWith('repo:readme:')) {
      await ctx.answerCbQuery();
      return repoView.sendFullReadme(ctx, data.split('repo:readme:')[1]);
    }
    if (data.startsWith('repo:webhook:enable:')) {
      await ctx.answerCbQuery();
      return repoView.toggleWebhookEnable(ctx, data.split('repo:webhook:enable:')[1]);
    }
    if (data.startsWith('repo:webhook:mute:') || data.startsWith('repo:webhook:unmute:')) {
      await ctx.answerCbQuery();
      const wantMute = data.startsWith('repo:webhook:mute:');
      return repoView.toggleWebhookMute(ctx, data.slice(data.indexOf(':', 'repo:webhook:'.length) + 1), wantMute ? 'mute' : 'unmute');
    }
    if (data.startsWith('repo:webhook:toggle:')) {
      await ctx.answerCbQuery();
      return repoView.toggleWebhookMute(ctx, data.split('repo:webhook:toggle:')[1]);
    }
    if (data.startsWith('repo:license:confirm:')) {
      await ctx.answerCbQuery();
      const parts = data.split('repo:license:confirm:')[1].split(':');
      const licenseKey = parts.pop();
      const repoName = parts.join(':');
      await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Updating license…');
      return repoView.executeSetLicense(ctx, repoName, licenseKey);
    }
    if (data.startsWith('repo:license:cancel:')) {
      await ctx.answerCbQuery();
      return confirmFlow.resolveConfirmation(ctx, 'cancelled', '❌ Cancelled — license unchanged.');
    }
    if (data.startsWith('repo:delete:confirm:')) {
      await ctx.answerCbQuery();
      const repoName = data.split('repo:delete:confirm:')[1];
      await confirmFlow.resolveConfirmation(ctx, 'confirmed', `⏳ Deleting ${repoName}…`);
      return repoView.executeDeleteRepo(ctx, repoName);
    }
    if (data.startsWith('repo:delete:cancel:')) {
      await ctx.answerCbQuery();
      return confirmFlow.resolveConfirmation(ctx, 'cancelled', '❌ Cancelled — repo was not deleted.');
    }
    if (data.startsWith('repo:delete:')) {
      await ctx.answerCbQuery();
      return repoView.askDeleteRepo(ctx, data.split('repo:delete:')[1]);
    }
    if (data.startsWith('repo:visibility:confirm:')) {
      await ctx.answerCbQuery();
      const visRest = data.split('repo:visibility:confirm:')[1];
      const visMatch = visRest.match(/^(public|private):(.+)$/);
      const repoName = visMatch ? visMatch[2] : visRest;
      const visTarget = visMatch ? visMatch[1] : null; // null = older button: flip whatever it is now
      await confirmFlow.resolveConfirmation(ctx, 'confirmed', `⏳ Updating visibility for ${repoName}…`);
      return repoView.executeToggleVisibility(ctx, repoName, visTarget);
    }
    if (data.startsWith('repo:visibility:cancel:')) {
      await ctx.answerCbQuery();
      return confirmFlow.resolveConfirmation(ctx, 'cancelled', '❌ Cancelled — visibility unchanged.');
    }
    if (data.startsWith('repo:pin:')) {
      await ctx.answerCbQuery();
      // New buttons carry their target (repo:pin:on:<name> / repo:pin:off:<name>);
      // a bare repo:pin:<name> is an older button still sitting in a chat.
      const pinRest = data.split('repo:pin:')[1];
      const pinMatch = pinRest.match(/^(on|off):(.+)$/);
      return repoView.togglePin(ctx, pinMatch ? pinMatch[2] : pinRest, pinMatch ? pinMatch[1] : null);
    }
    if (data.startsWith('repo:tags:')) {
      await ctx.answerCbQuery();
      return tags.showRepoTags(ctx, data.split('repo:tags:')[1]);
    }

    // Tags flow
    if (data.startsWith('tags:add:')) {
      await ctx.answerCbQuery();
      return tags.showAddTagMenu(ctx, data.split('tags:add:')[1]);
    }
    if (data.startsWith('tags:assign:')) {
      await ctx.answerCbQuery();
      const [, , repoName, tagId] = data.split(':');
      return tags.assignExistingTag(ctx, repoName, tagId);
    }
    if (data.startsWith('tags:removemenu:')) {
      await ctx.answerCbQuery();
      return tags.showRemoveTagMenu(ctx, data.split('tags:removemenu:')[1]);
    }
    if (data.startsWith('tags:removeconfirm:')) {
      await ctx.answerCbQuery();
      const [, , repoName, tagId] = data.split(':');
      return tags.removeTag(ctx, repoName, tagId);
    }
    if (data.startsWith('tags:create:')) {
      await ctx.answerCbQuery();
      return tags.startCreateTag(ctx, data.split('tags:create:')[1]);
    }
    // ── Tag Manager (v1.2.3-multi) — every payload is tags:<action>:<tagId>[:<value>]:<repo> ──
    if (data.startsWith('tags:manage:')) {
      await ctx.answerCbQuery();
      return tags.showTagManager(ctx, data.slice('tags:manage:'.length));
    }
    // tags:<action>:<tagId>:<repo>            (edit, colors, parents, defaults, deleteask)
    // tags:<action>:<tagId>:<value>:<repo>    (setcolor, setparent, defvis, defclear, deftext)
    // Repo names never contain ':', so the split is unambiguous.
    const tagParts = (prefix, withValue) => {
      const [tagId, ...rest] = data.slice(prefix.length).split(':');
      if (withValue) return { tagId, value: rest[0], repoName: rest.slice(1).join(':') };
      return { tagId, repoName: rest.join(':') };
    };
    if (data.startsWith('tags:edit:')) {
      await ctx.answerCbQuery();
      const x = tagParts('tags:edit:', false);
      return tags.showTagEditor(ctx, x.tagId, x.repoName);
    }
    if (data.startsWith('tags:colors:')) {
      await ctx.answerCbQuery();
      const x = tagParts('tags:colors:', false);
      return tags.showColourPicker(ctx, x.tagId, x.repoName);
    }
    if (data.startsWith('tags:parents:')) {
      await ctx.answerCbQuery();
      const x = tagParts('tags:parents:', false);
      return tags.showParentPicker(ctx, x.tagId, x.repoName);
    }
    if (data.startsWith('tags:defaults:')) {
      await ctx.answerCbQuery();
      const x = tagParts('tags:defaults:', false);
      return tags.showTagDefaults(ctx, x.tagId, x.repoName);
    }
    if (data.startsWith('tags:deleteask:')) {
      await ctx.answerCbQuery();
      const x = tagParts('tags:deleteask:', false);
      return tags.askDeleteTag(ctx, x.tagId, x.repoName);
    }
    if (data.startsWith('tags:setcolor:')) {
      await ctx.answerCbQuery();
      const x = tagParts('tags:setcolor:', true);
      return tags.setColour(ctx, x.tagId, x.value, x.repoName);
    }
    if (data.startsWith('tags:setparent:')) {
      await ctx.answerCbQuery();
      const x = tagParts('tags:setparent:', true);
      return tags.setParent(ctx, x.tagId, x.value, x.repoName);
    }
    if (data.startsWith('tags:defvis:')) {
      await ctx.answerCbQuery();
      const x = tagParts('tags:defvis:', true);
      return tags.setTagVisibilityDefault(ctx, x.tagId, x.value, x.repoName);
    }
    if (data.startsWith('tags:defclear:')) {
      await ctx.answerCbQuery();
      const x = tagParts('tags:defclear:', true);
      return tags.clearTagDefaultValue(ctx, x.tagId, x.value, x.repoName);
    }
    if (data.startsWith('tags:deftext:')) {
      await ctx.answerCbQuery();
      const x = tagParts('tags:deftext:', true);
      return tags.askTagDefaultText(ctx, x.tagId, x.value, x.repoName);
    }
    if (data.startsWith('tags:deletetag:')) {
      await ctx.answerCbQuery();
      const [, , tagId, repoName] = data.split(':');
      return tags.deleteTagDefinition(ctx, tagId, repoName);
    }

    // Pin reorder
    if (data.startsWith('pin:sec:')) {
      await ctx.answerCbQuery();
      return pinned.showSectionPicker(ctx, data.slice('pin:sec:'.length));
    }
    if (data.startsWith('pin:setsec:')) {
      await ctx.answerCbQuery();
      // pin:setsec:<repo>:<section> — an empty section means "no section"; repo names never contain ':'
      const rest = data.slice('pin:setsec:'.length);
      const cut = rest.indexOf(':');
      return pinned.setPinSection(ctx, rest.slice(0, cut), rest.slice(cut + 1));
    }
    if (data.startsWith('pin:newsec:')) {
      await ctx.answerCbQuery();
      return pinned.askNewSection(ctx, data.slice('pin:newsec:'.length));
    }
    if (data.startsWith('pin:up:')) {
      await ctx.answerCbQuery();
      return pinned.movePin(ctx, data.split('pin:up:')[1], 'up');
    }
    if (data.startsWith('pin:down:')) {
      await ctx.answerCbQuery();
      return pinned.movePin(ctx, data.split('pin:down:')[1], 'down');
    }
    if (data === 'pinned:refresh') {
      await ctx.answerCbQuery();
      return pinned.showPinned(ctx, { edit: true });
    }

    // Upload entry points
    if (data.startsWith('upload:start:')) {
      await ctx.answerCbQuery();
      const repoName = data.split('upload:start:')[1];
      ctx.session.currentRepo = repoName;
      return ctx.scene.enter('uploadFile', { repoName });
    }
    if (data.startsWith('file:replace:')) {
      await ctx.answerCbQuery();
      const lockedPath = data.split('file:replace:')[1];
      return ctx.scene.enter('uploadFile', { repoName: ctx.session.currentRepo, lockedPath });
    }

    // Filter — language and tag sub-menus (checked BEFORE the generic filter: handler)
    if (data === 'filter:tagmenu') {
      await ctx.answerCbQuery();
      return myRepos.showTagFilterMenu(ctx);
    }
    if (data === 'filter:langmenu') {
      await ctx.answerCbQuery();
      return myRepos.showLanguageFilterMenu(ctx);
    }
    if (data === 'filter:langoverview') {
      await ctx.answerCbQuery();
      return myRepos.showLanguageOverview(ctx);
    }
    if (data.startsWith('filter:lang:')) {
      await ctx.answerCbQuery();
      const lang = data.split('filter:lang:')[1];
      myRepos.setFilter(ctx.from.id, 'language', lang);
      return myRepos.showMyRepos(ctx);
    }
    if (data.startsWith('filter:tag:')) {
      await ctx.answerCbQuery();
      const tagId = data.split('filter:tag:')[1];
      myRepos.setFilter(ctx.from.id, 'tag', tagId);
      return myRepos.showMyRepos(ctx);
    }

    // Filter / Sort menus — these render on their OWN freshly-sent message,
    // so editing here is almost always safe (never a stale reference) — the
    // one exception is a rapid double-tap of the same option, which still
    // needs the same protection as every other edit-then-continue flow.
    if (data.startsWith('filter:') || data.startsWith('sort:')) {
      await ctx.answerCbQuery();
      if (data.startsWith('filter:')) myRepos.setFilter(ctx.from.id, data.split(':')[1]);
      else myRepos.setSort(ctx.from.id, data.split(':')[1]);

      return myRepos.showMyRepos(ctx);
    }

    // File browsing
    if (data.startsWith('browse:dirpage:')) {
      await ctx.answerCbQuery();
      const rest = data.split('browse:dirpage:')[1];
      const page = Number(rest.split(':')[0]);
      const dirPath = rest.split(':').slice(1).join(':');
      return browseFiles.showDirectory(ctx, ctx.session.currentRepo, dirPath, page);
    }
    if (data.startsWith('browse:dir:')) {
      await ctx.answerCbQuery();
      return browseFiles.showDirectory(ctx, ctx.session.currentRepo, data.split('browse:dir:')[1]);
    }
    if (data.startsWith('browse:file:')) {
      await ctx.answerCbQuery();
      return browseFiles.showFileActions(ctx, ctx.session.currentRepo, data.split('browse:file:')[1]);
    }
    if (data.startsWith('browse:parent:')) {
      await ctx.answerCbQuery();
      const filePath = data.split('browse:parent:')[1];
      const parent = filePath.split('/').slice(0, -1).join('/');
      return browseFiles.showDirectory(ctx, ctx.session.currentRepo, parent);
    }
    if (data.startsWith('file:view:')) {
      await ctx.answerCbQuery();
      return browseFiles.viewFileContent(ctx, ctx.session.currentRepo, data.split('file:view:')[1]);
    }
    if (data.startsWith('file:raw:')) {
      await ctx.answerCbQuery();
      return browseFiles.sendFileAsDocument(ctx, ctx.session.currentRepo, data.split('file:raw:')[1]);
    }
    if (data.startsWith('file:edit:')) {
      await ctx.answerCbQuery();
      const filePath = data.split('file:edit:')[1];
      return ctx.scene.enter('editFile', { repoName: ctx.session.currentRepo, filePath });
    }
    if (data.startsWith('file:delete:confirm:')) {
      await ctx.answerCbQuery();
      const filePath = data.split('file:delete:confirm:')[1];
      await confirmFlow.resolveConfirmation(ctx, 'confirmed', `⏳ Deleting ${filePath}…`);
      return browseFiles.executeDeleteFile(ctx, ctx.session.currentRepo, filePath);
    }
    if (data.startsWith('file:delete:cancel:')) {
      await ctx.answerCbQuery();
      return confirmFlow.resolveConfirmation(ctx, 'cancelled', '❌ Cancelled — file was not deleted.');
    }
    if (data.startsWith('file:delete:')) {
      await ctx.answerCbQuery();
      return browseFiles.askDeleteFile(ctx, ctx.session.currentRepo, data.split('file:delete:')[1]);
    }

    // External repo (search-detected link)
    if (data === 'external:download') {
      await ctx.answerCbQuery();
      return search.downloadExternalZip(ctx);
    }
    if (data === 'external:fork') {
      await ctx.answerCbQuery();
      return search.forkExternal(ctx);
    }
    if (data === 'external:fork:confirm') {
      await ctx.answerCbQuery();
      await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Forking…');
      return search.executeForkExternal(ctx);
    }
    if (data === 'external:fork:cancel' || data === 'external:cancel') {
      await ctx.answerCbQuery();
      return confirmFlow.resolveConfirmation(ctx, 'cancelled', '❌ Cancelled — nothing was forked.');
    }
    if (data === 'external:star') {
      await ctx.answerCbQuery();
      return search.toggleStar(ctx);
    }
    if (data.startsWith('search:copylink:')) {
      await ctx.answerCbQuery();
      return search.copyRepoLink(ctx, data.split('search:copylink:')[1]);
    }

    // Settings / notifications / activity
    if (data.startsWith('notif:toggle:')) {
      await ctx.answerCbQuery();
      return settings.toggleNotification(ctx, data.split('notif:toggle:')[1]);
    }
    if (data === 'notif:cyclerollup') {
      await ctx.answerCbQuery();
      return settings.cycleRollup(ctx);
    }
    if (data === 'notif:setquiet') {
      await ctx.answerCbQuery();
      return settings.promptQuietHours(ctx);
    }

    // 💾 Export/Import
    if (data === 'exportimport:export') { await ctx.answerCbQuery(); return exportImport.exportSettings(ctx); }
    if (data === 'exportimport:import') { await ctx.answerCbQuery(); return exportImport.promptImportFile(ctx); }
    if (data === 'exportimport:import:confirm') {
      await ctx.answerCbQuery();
      await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Importing…');
      return exportImport.applyImport(ctx);
    }
    if (data === 'exportimport:import:cancel') {
      await ctx.answerCbQuery();
      return confirmFlow.resolveConfirmation(ctx, 'cancelled', '❌ Import cancelled — nothing changed.');
    }
    if (data === 'settings:disconnect:confirm') {
      await ctx.answerCbQuery();
      await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Disconnecting…');
      return settings.executeDisconnect(ctx);
    }
    if (data === 'settings:disconnect:all') {
      await ctx.answerCbQuery();
      return settings.askDisconnectAll(ctx);
    }
    if (data === 'settings:disconnect:allconfirm') {
      await ctx.answerCbQuery();
      await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Disconnecting everything…');
      return settings.executeDisconnect(ctx, { all: true });
    }
    if (data === 'settings:disconnect:cancel') {
      await ctx.answerCbQuery();
      return confirmFlow.resolveConfirmation(ctx, 'cancelled', '❌ Cancelled — still connected.');
    }
    if (data === 'settings:back') {
      await ctx.answerCbQuery();
      return require('./handlers/hub').showSettings(ctx);
    }
    if (data.startsWith('activity:page:')) {
      await ctx.answerCbQuery();
      const [, , page, errorsOnly] = data.split(':');
      return activityLog.showActivity(ctx, { page: Number(page), errorsOnly: errorsOnly === 'true', edit: true });
    }
    if (data.startsWith('activity:filter:')) {
      await ctx.answerCbQuery();
      const errorsOnly = data.split('activity:filter:')[1] === 'true';
      return activityLog.showActivity(ctx, { page: 1, errorsOnly, edit: true });
    }
    if (data.startsWith('activity:refresh:')) {
      await ctx.answerCbQuery();
      const errorsOnly = data.split('activity:refresh:')[1] === 'true';
      return activityLog.showActivity(ctx, { page: 1, errorsOnly, skipBbtb: true });
    }
    if (data === 'activity:accesslog') {
      await ctx.answerCbQuery();
      return accessLogScreen.showAccessLog(ctx, { fromActivity: true });
    }

    // v1.1.0-multi — 🛡️ Admin Dashboard. Every branch delegates straight
    // to handlers/admin.js, which re-checks isAdmin itself; the check
    // here is just to avoid doing any work at all for a non-admin sender
    // (the deeper check in admin.js is the one that actually matters).
    if (data.startsWith('admin:') || data.startsWith('warden:') || data.startsWith('migrate:')) {
      if (!ctx.state.isAdmin) { await ctx.answerCbQuery(); return; }

      if (data === 'admin:mon' || data.startsWith('admin:mon:')) return require('./handlers/monitoring').route(ctx, data);
      if (data === 'admin:noop:shieldadmin') { await ctx.answerCbQuery('Admin and Owner accounts are never shielded — they are already protected from moderation.', { show_alert: true }); return; }
      if (data === 'admin:noop:shieldowner') { await ctx.answerCbQuery('Only the Owner can turn Repo Shield on or off.', { show_alert: true }); return; }
      if (data === 'admin:noop') { await ctx.answerCbQuery('This account is protected.'); return; }
      if (data === 'admin:web') { await ctx.answerCbQuery(); return require('./handlers/ownerWebLink').sendLink(ctx); }
      if (data === 'admin:refresh' || data === 'admin:dashboard') {
        await ctx.answerCbQuery();
        return admin.showDashboard(ctx, { skipBbtb: data === 'admin:refresh' });
      }
      if (data === 'admin:attn') { await ctx.answerCbQuery(); return require('./handlers/adminHub').showAttention(ctx); }
      if (data === 'admin:watch') { await ctx.answerCbQuery(); return require('./handlers/adminHub').showWatch(ctx); }
      if (data === 'admin:system') { await ctx.answerCbQuery(); return require('./handlers/adminHub').showSystem(ctx); }
      if (data === 'admin:bulkhub') { await ctx.answerCbQuery(); return admin.showBulkHub(ctx); }
      if (data === 'admin:people') { await ctx.answerCbQuery(); return admin.showPeopleHub(ctx, { edit: true }); }
      if (data === 'admin:oversight') { await ctx.answerCbQuery(); return admin.showOversightHub(ctx, { edit: true }); }
      if (data === 'admin:ops') { await ctx.answerCbQuery(); return admin.showOpsHub(ctx, { edit: true }); }
      if (data === 'admin:broadcast:hub') { await ctx.answerCbQuery(); return admin.showBroadcastHub(ctx, { edit: true }); }
      if (data === 'admin:search') { await ctx.answerCbQuery(); return admin.askSearch(ctx); }
      if (data === 'admin:broadcast') { await ctx.answerCbQuery(); return admin.askBroadcast(ctx); }
      if (data === 'admin:ghtraffic') { await ctx.answerCbQuery(); return require('./handlers/githubTraffic').show(ctx, { edit: true }); }
      if (data === 'admin:ghtraffic:bg') { const toast = await require('./handlers/githubTraffic').toggleBackground(ctx); await ctx.answerCbQuery(toast || undefined).catch(() => {}); return; }
      if (data === 'admin:ghtraffic:breaker') { const toast = await require('./handlers/githubTraffic').resetBreaker(ctx); await ctx.answerCbQuery(toast || undefined).catch(() => {}); return; }
      if (data === 'admin:ghtraffic:clear') { const toast = await require('./handlers/githubTraffic').clearPauses(ctx); await ctx.answerCbQuery(toast || undefined).catch(() => {}); return; }
      if (data === 'admin:health') { await ctx.answerCbQuery(); return admin.showSystemHealth(ctx, { edit: true }); }
      if (data === 'admin:growth') { await ctx.answerCbQuery(); return admin.showGrowth(ctx, { edit: true }); }
      if (data.startsWith('admin:anomalies:')) {
        await ctx.answerCbQuery();
        return admin.showAnomalyFeed(ctx, { page: Number(data.split('admin:anomalies:')[1]), edit: true });
      }
      if (data === 'admin:jobs') { await ctx.answerCbQuery(); return admin.showScheduledJobs(ctx, { edit: true }); }
      if (data === 'admin:config') { await ctx.answerCbQuery(); return admin.showGlobalConfig(ctx); }
      if (data === 'admin:config:notify:toggle') { await ctx.answerCbQuery(); return admin.toggleNotifyUsers(ctx); }
      if (data === 'admin:features') { await ctx.answerCbQuery(); return admin.showFeatureSwitches(ctx, { edit: true }); }
      if (data.startsWith('admin:features:toggle:')) { await ctx.answerCbQuery(); return admin.toggleFeatureSwitch(ctx, data.slice('admin:features:toggle:'.length)); }
      if (data === 'admin:config:signups:toggle') { await ctx.answerCbQuery(); return admin.toggleSignupsPaused(ctx); }
      if (data.startsWith('admin:config:')) {
        const [, , field, preset] = data.split(':');
        await ctx.answerCbQuery();
        return admin.setGlobalConfig(ctx, field, preset);
      }
      if (data === 'admin:maintenance') { await ctx.answerCbQuery(); return admin.showMaintenance(ctx); }
      if (data === 'admin:maint:on') { await ctx.answerCbQuery('🩺 Maintenance ON'); return admin.toggleMaintenance(ctx, true); }
      if (data === 'admin:maint:off') { await ctx.answerCbQuery('✅ Maintenance OFF'); return admin.toggleMaintenance(ctx, false); }
      if (data === 'admin:maint:msg') { await ctx.answerCbQuery(); return admin.askMaintenanceMessage(ctx); }
      if (data === 'admin:maint:schedon') { await ctx.answerCbQuery(); return admin.askMaintenanceSchedule(ctx, 'on'); }
      if (data === 'admin:maint:schedoff') { await ctx.answerCbQuery(); return admin.askMaintenanceSchedule(ctx, 'off'); }
      if (data === 'admin:maint:schedclear') {
        await ctx.answerCbQuery('🗑️ Schedule cleared');
        const maintenance = require('./lib/maintenance');
        await maintenance.clearAutoOn(ctx.from.id);
        await maintenance.clearAutoOff(ctx.from.id);
        return admin.showMaintenance(ctx, { edit: true });
      }
      if (data === 'admin:nudge:ask') { await ctx.answerCbQuery(); return admin.askNudge(ctx); }
      if (data === 'admin:nudge:execute') {
        await ctx.answerCbQuery();
        await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Sending…');
        return admin.executeNudge(ctx);
      }
      if (data === 'admin:exportall') { await ctx.answerCbQuery(); return admin.exportAll(ctx); }

      if (data === 'admin:users:entry') {
        await ctx.answerCbQuery();
        return admin.showUsers(ctx, { filter: 'all', page: 1 });
      }
      if (data.startsWith('admin:users:')) {
        await ctx.answerCbQuery();
        const [, , filter, page] = data.split(':');
        return admin.showUsers(ctx, { filter, page: Number(page), edit: true, skipBbtb: true });
      }

      if (data === 'admin:audit:filter') { await ctx.answerCbQuery(); return admin.askAuditFilter(ctx); }
      if (data === 'admin:audit:filter:clear') { await ctx.answerCbQuery(); return admin.setAuditFilter(ctx, 'clear'); }
      if (data.startsWith('admin:audit:filter:action:')) {
        await ctx.answerCbQuery();
        return admin.setAuditFilter(ctx, 'action', data.split('admin:audit:filter:action:')[1]);
      }
      if (data.startsWith('admin:audit:filter:admin:')) {
        await ctx.answerCbQuery();
        return admin.setAuditFilter(ctx, 'admin', data.split('admin:audit:filter:admin:')[1]);
      }
      if (data === 'admin:audit:entry') {
        await ctx.answerCbQuery();
        return admin.showAuditLog(ctx, { page: 1 });
      }
      if (data.startsWith('admin:audit:')) {
        await ctx.answerCbQuery();
        return admin.showAuditLog(ctx, { page: Number(data.split(':')[2]), edit: true, skipBbtb: true });
      }

      if (data.startsWith('admin:broadcast:history:')) {
        await ctx.answerCbQuery();
        return admin.showBroadcastHistory(ctx, { page: Number(data.split('admin:broadcast:history:')[1]), edit: true });
      }
      if (data.startsWith('admin:broadcast:cancel:')) {
        return admin.cancelBroadcast(ctx, Number(data.split(':')[3]));
      }
      if (data.startsWith('admin:broadcast:repost:')) {
        return admin.repostBroadcast(ctx, Number(data.split(':')[3]));
      }
      if (data.startsWith('admin:broadcast:recur:')) {
        await ctx.answerCbQuery();
        return admin.chooseBroadcastRecurrence(ctx, data.split(':')[3]);
      }
      if (data === 'admin:broadcast:schedule') { await ctx.answerCbQuery(); return admin.askBroadcastSchedule(ctx); }
      if (data.startsWith('admin:broadcast:time:')) {
        await ctx.answerCbQuery();
        return admin.setBroadcastQuickTime(ctx, data.split('admin:broadcast:time:')[1]);
      }

      if (data === 'admin:reports') { await ctx.answerCbQuery(); return admin.showReports(ctx, { edit: true }); }
      if (data.startsWith('admin:report:')) {
        const rest = data.split('admin:report:')[1]; // '<id>' | '<id>:resolve' | '<id>:dismiss'
        const [idStr, action] = rest.split(':');
        const reportId = Number(idStr);
        await ctx.answerCbQuery();
        if (!action) return admin.showReportDetail(ctx, reportId, { edit: true });
        if (action === 'resolve') return admin.resolveReport(ctx, reportId, 'resolved');
        if (action === 'dismiss') return admin.resolveReport(ctx, reportId, 'dismissed');
        return;
      }

      if (data.startsWith('admin:user:')) {
        const rest = data.split('admin:user:')[1];
        const parts = rest.split(':');
        const targetId = Number(parts[0]);
        const action = parts[1];
        if (!action) { await ctx.answerCbQuery(); return admin.showUserDetail(ctx, targetId); }
        if (action === 'askban') { await ctx.answerCbQuery(); return admin.askBan(ctx, targetId); }
        if (action === 'banduration') { await ctx.answerCbQuery(); return admin.setBanDuration(ctx, targetId, Number(parts[2]) || null); }
        if (action === 'ban') {
          await ctx.answerCbQuery();
          await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Banning…');
          return admin.executeBan(ctx, targetId);
        }
        if (action === 'unban') { await ctx.answerCbQuery(); return admin.executeUnban(ctx, targetId); }
        if (action === 'suspend') { await ctx.answerCbQuery(); return admin.askSuspendReason(ctx, targetId, Number(parts[2])); }
        if (action === 'unsuspend') { await ctx.answerCbQuery(); return admin.executeUnsuspend(ctx, targetId); }
        if (action === 'trust') { await ctx.answerCbQuery(); return admin.toggleTrust(ctx, targetId); }
        if (action === 'shield') { await ctx.answerCbQuery(); return admin.toggleShield(ctx, targetId); }
        if (action === 'export') { await ctx.answerCbQuery(); return admin.exportUser(ctx, targetId); }
        if (action === 'askdelete') { await ctx.answerCbQuery(); return admin.askDelete(ctx, targetId); }
        if (action === 'delete') {
          await ctx.answerCbQuery();
          await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Deleting…');
          return admin.executeDelete(ctx, targetId);
        }
        if (action === 'limits') { await ctx.answerCbQuery(); return admin.showLimits(ctx, targetId, { edit: true }); }
        if (action === 'setlimit') {
          await ctx.answerCbQuery();
          return admin.setLimit(ctx, targetId, parts[2], parts[3]);
        }
        if (action === 'history') { await ctx.answerCbQuery(); return admin.showAuditLog(ctx, { page: Number(parts[2]), targetTelegramId: targetId, edit: true }); }
        if (action === 'accesslog') { await ctx.answerCbQuery(); return admin.showUserAccessLog(ctx, targetId, { edit: true }); }
        if (action === 'message') { await ctx.answerCbQuery(); return admin.askMessageUser(ctx, targetId); }
        if (action === 'notes') { await ctx.answerCbQuery(); return admin.askNotes(ctx, targetId); }
        if (action === 'repos') { await ctx.answerCbQuery(); return admin.showUserRepos(ctx, targetId, { edit: true }); }
        await ctx.answerCbQuery();
        return;
      }

      if (data.startsWith('admin:repos:')) {
        // admin:repos:<targetId> (bare — back to list) | :open:<idx> | :dl:<idx>
        // | :vis:<idx>:ask|execute | :lic:<idx>:ask | :lic:<idx>:execute:<key>
        // | :del:<idx>:ask|execute
        const parts = data.split(':'); // ['admin','repos', targetId, verb?, idx?, step?, extra?]
        const targetId = Number(parts[2]);
        const verb = parts[3];
        await ctx.answerCbQuery();
        if (!verb) return admin.showUserRepos(ctx, targetId, { edit: true });
        // v1.2.5-multi: a person with several GitHub accounts — pick which one to view.
        if (verb === 'pick') return admin.showUserRepos(ctx, targetId, { edit: true, forcePick: true });
        if (verb === 'acct') return admin.chooseRepoAccount(ctx, targetId, Number(parts[4]));
        const idx = Number(parts[4]);
        if (verb === 'open') return admin.showRepoDetail(ctx, targetId, idx, { edit: true });
        if (verb === 'dl') return admin.downloadUserRepo(ctx, targetId, idx);
        if (verb === 'vis') {
          const step = parts[5];
          if (step === 'ask') return admin.askRepoVisibility(ctx, targetId, idx);
          if (step === 'execute') {
            await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Updating…');
            return admin.executeRepoVisibility(ctx, targetId, idx);
          }
        }
        if (verb === 'lic') {
          const step = parts[5];
          if (step === 'ask') return admin.askRepoLicense(ctx, targetId, idx);
          if (step === 'execute') {
            // v1.1.2 fix: this picker has 4 options, not a single yes/cancel
            // confirm, but it needs the exact same stale-button guard —
            // without resolving it here, the picker's other 3 license
            // buttons stayed live after one was tapped, so a second tap on
            // a DIFFERENT license would fire a second real write to GitHub.
            await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Applying license…');
            return admin.executeRepoLicense(ctx, targetId, idx, parts[6]);
          }
        }
        if (verb === 'del') {
          const step = parts[5];
          if (step === 'ask') return admin.askDeleteUserRepo(ctx, targetId, idx);
          if (step === 'execute') {
            await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Deleting…');
            return admin.executeDeleteUserRepo(ctx, targetId, idx);
          }
        }
        return;
      }

      if (data === 'admin:noop') { await ctx.answerCbQuery(); return; }

      if (data === 'admin:roles') { await ctx.answerCbQuery(); return admin.showAdmins(ctx, { edit: true }); }
      if (data === 'admin:lockdown') { await ctx.answerCbQuery(); return admin.showLockdown(ctx, { edit: true }); }
      // ─── 🤖 Warden (Owner-only) — observation, evidence, Owner Board ──────
      if (data === 'warden:main') { await ctx.answerCbQuery(); return wardenAdminHandler.showWarden(ctx, { edit: true, adminFn: admin }); }
      if (data === 'warden:toggle:enabled') { return wardenAdminHandler.toggleEnabled(ctx, { adminFn: admin }); }
      if (data === 'warden:toggle:alerts') { return wardenAdminHandler.toggleAlerts(ctx, { adminFn: admin }); }
      // Decision log + JSONL export
      if (data.startsWith('warden:log:')) { await ctx.answerCbQuery(); return wardenAdminHandler.showActionLog(ctx, { page: Number(data.split(':')[2]) || 1, edit: true, adminFn: admin }); }
      if (data === 'warden:export') { await ctx.answerCbQuery(); return wardenAdminHandler.showExportMenu(ctx, { adminFn: admin }); }
      if (data.startsWith('warden:export:')) { return wardenAdminHandler.exportDataset(ctx, data.split(':')[2], { adminFn: admin }); }
      // Owner Board
      if (data === 'warden:board:filter') { return wardenBoard.cycleFilter(ctx, { adminFn: admin }); }
      if (data.startsWith('warden:board:')) { await ctx.answerCbQuery(); return wardenBoard.showBoard(ctx, { page: Number(data.split(':')[2]) || 1, adminFn: admin }); }
      {
        const m = data.match(/^warden:case:(\d+)(?::([a-z]+))?$/);
        if (m) {
          const id = Number(m[1]); const act = m[2]; const o = { adminFn: admin };
          if (!act) { await ctx.answerCbQuery(); return wardenBoard.showCase(ctx, id, o); }
          if (act === 'trust') return wardenBoard.toggleTrust(ctx, id, o);
          if (act === 'shield') return wardenBoard.toggleShield(ctx, id, o);
          if (act === 'watch') return wardenBoard.keepWatching(ctx, id, o);
          if (act === 'dismiss') return wardenBoard.dismissCase(ctx, id, o);
          if (act === 'warn') { await ctx.answerCbQuery(); return wardenBoard.previewWarning(ctx, id, o); }
          if (act === 'warnsend') return wardenBoard.sendWarning(ctx, id, o);
          if (act === 'timeline') { await ctx.answerCbQuery(); return wardenBoard.showTimeline(ctx, id, o); }
          if (act === 'enf') { await ctx.answerCbQuery(); return wardenBoard.showEnforcementGate(ctx, id, o); }
          if (act === 'enfgo') { await ctx.answerCbQuery(); return wardenBoard.enforcementContinue(ctx, id, o); }
        }
      }
      // Repo Shield
      if (data === 'warden:shield') { await ctx.answerCbQuery(); return wardenBoard.showShield(ctx, { adminFn: admin }); }
      if (data === 'warden:shield:undo') { return wardenBoard.undoShield(ctx, { adminFn: admin }); }
      if (data.startsWith('warden:shield:set:')) {
        // warden:shield:set:<scope>:<on|off> — the tap names the state it sets, so repeats are harmless
        const m = data.match(/^warden:shield:set:([a-z]+):(on|off)$/);
        if (!m) return ctx.answerCbQuery().catch(() => {});
        return wardenBoard.setShield(ctx, m[1], m[2] === 'on', { adminFn: admin });
      }
      {
        const m = data.match(/^warden:shield:(ask|do):([a-z]+):([pu])$/);
        if (m) {
          const protect = m[3] === 'p';
          if (m[1] === 'ask') return wardenBoard.askShield(ctx, m[2], protect, { adminFn: admin });
          return wardenBoard.doShield(ctx, m[2], protect, { adminFn: admin });
        }
      }
      // Anything else under warden: is a button from an older menu (Stop Now, privilege/limit
      // toggles, templates, perm-ban/delete…). Warden no longer takes actions — say so and redraw.
      if (data.startsWith('warden:')) { return wardenAdminHandler.refreshRemoved(ctx, { adminFn: admin }); }
      // ─── 🗄️ Export/Import ────────────────────────────────────────────
      if (data === 'migrate:hub') { await ctx.answerCbQuery(); return migrationAdmin.showMigrationHub(ctx, { adminFn: admin }); }
      if (data === 'migrate:export') { return migrationAdmin.startExport(ctx, { adminFn: admin }); }
      if (data === 'migrate:import:start') { return migrationAdmin.startImport(ctx, { adminFn: admin }); }
      if (data === 'admin:lockdown:noop') { return ctx.answerCbQuery(); }
      if (data === 'admin:lockdown:all') { return admin.lockdownAll(ctx); }
      if (data === 'admin:lockdown:releaseall') { return admin.releaseLockdownAll(ctx); }
      if (data === 'admin:lockdown:targeted') { await ctx.answerCbQuery(); return admin.askTargetedLockdown(ctx); }
      if (data === 'admin:lockdown:keepwarden') { await ctx.answerCbQuery(); return admin.toggleKeepWardenDuringLockdown(ctx); }
      if (data.startsWith('admin:lockdown:toggle:')) { return admin.toggleLockAdmin(ctx, Number(data.split(':')[3])); }
      if (data.startsWith('admin:roles:')) {
        // admin:roles:<targetId> (open menu) | admin:roles:<targetId>:set:<role> | admin:roles:<targetId>:revoke
        const parts = data.split(':');
        const targetId = Number(parts[2]);
        await ctx.answerCbQuery();
        // v1.1.2 fix: same stale-button class as the license picker —
        // this menu applies directly on tap with no separate yes/cancel
        // confirm, so without disarming it here, a second stray tap on a
        // DIFFERENT option right after (e.g. "Demote to Guest" right
        // after "Set: Moderator") would fire a second real role change.
        if (parts[3] === 'set') {
          await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Updating role…');
          return admin.executeSetRole(ctx, targetId, parts[4]);
        }
        if (parts[3] === 'revoke') {
          await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Revoking access…');
          return admin.executeRevokeRole(ctx, targetId);
        }
        return admin.askChangeRole(ctx, targetId);
      }

      if (data.startsWith('admin:undo:')) {
        await ctx.answerCbQuery();
        return admin.executeUndo(ctx, Number(data.split('admin:undo:')[1]));
      }

      if (data === 'admin:confirm:cancel') {
        await ctx.answerCbQuery();
        return confirmFlow.resolveConfirmation(ctx, 'cancelled', '❌ Cancelled — no changes made.');
      }
      if (data === 'admin:fleet' || data === 'admin:fleet:refresh') {
        await ctx.answerCbQuery();
        return admin.showFleetStats(ctx, { edit: true, skipBbtb: data === 'admin:fleet:refresh' });
      }
      if (data === 'admin:leaderboards') {
        await ctx.answerCbQuery();
        return admin.showLeaderboards(ctx, { edit: true });
      }
      if (data.startsWith('admin:errors:')) {
        await ctx.answerCbQuery();
        return admin.showErrorFeed(ctx, { page: Number(data.split('admin:errors:')[1]), edit: true });
      }
      if (data === 'admin:broadcast:send') {
        await ctx.answerCbQuery();
        await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Sending…');
        return admin.executeBroadcast(ctx);
      }

      // 🗂️ Bulk Actions hub
      if (data.startsWith('admin:purge:')) {
        const parts = data.split(':'); // ['admin','purge', ...]
        await ctx.answerCbQuery();
        if (parts.length === 3 && parts[2] === 'ask') return admin.askBulkPurge(ctx); // opened from the Bulk hub
        if (parts[2] === 'custom' && parts[3] === 'ask') return admin.askCustomNumber(ctx, { kind: 'purge_days' });
        const days = parts[2] === 'never' ? null : Number(parts[2]);
        const step = parts[3];
        if (step === 'ask') return admin.askBulkPurgeConfirm(ctx, days);
        if (step === 'execute') {
          await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Purging…');
          return admin.executeBulkPurge(ctx, days);
        }
        return;
      }
      if (data.startsWith('admin:bulksuspend:')) {
        const parts = data.split(':'); // ['admin','bulksuspend', ...]
        await ctx.answerCbQuery();
        if (parts.length === 3 && parts[2] === 'ask') return admin.askBulkSuspend(ctx);
        if (parts.length === 4 && parts[2] === 'scope') return admin.askBulkSuspendHours(ctx, parts[3]);
        if (parts.length === 5 && parts[3] === 'custom' && parts[4] === 'ask') {
          return admin.askCustomNumber(ctx, { kind: 'bulksuspend_hours', scope: parts[2] });
        }
        if (parts.length === 5) {
          const [, , scope, hours, step] = parts;
          if (step === 'ask') return admin.askBulkSuspendConfirm(ctx, scope, Number(hours));
          if (step === 'execute') {
            await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Suspending…');
            return admin.executeBulkSuspend(ctx, scope, Number(hours));
          }
        }
        return;
      }
      if (data.startsWith('admin:bulkmute:')) {
        const parts = data.split(':'); // ['admin','bulkmute', ...]
        await ctx.answerCbQuery();
        if (parts.length === 3 && parts[2] === 'ask') return admin.askBulkMute(ctx);
        if (parts.length === 4) {
          const mute = parts[2] === 'mute';
          if (parts[3] === 'ask') return admin.askBulkMuteConfirm(ctx, mute);
          if (parts[3] === 'execute') {
            await confirmFlow.resolveConfirmation(ctx, 'confirmed', mute ? '⏳ Muting…' : '⏳ Unmuting…');
            return admin.executeBulkMute(ctx, mute);
          }
        }
        return;
      }
      if (data === 'admin:bulkdeleteban:ask') { await ctx.answerCbQuery(); return admin.askBulkDeleteBanned(ctx); }
      if (data === 'admin:bulkdeleteban:execute') {
        await ctx.answerCbQuery();
        await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Deleting…');
        return admin.executeBulkDeleteBanned(ctx);
      }

      return; // unmatched admin: callback — swallow rather than fall through
    }

    // My Defaults
    if (data === 'defaults:notifications') { await ctx.answerCbQuery(); return settings.showNotifications(ctx); }
    if (data === 'defaults:visibility') { await ctx.answerCbQuery(); return myDefaults.editVisibility(ctx); }
    if (data.startsWith('defaults:setvisibility:')) { await ctx.answerCbQuery(); return myDefaults.setVisibility(ctx, data.split(':')[2]); }
    if (data === 'defaults:commit') { await ctx.answerCbQuery(); return myDefaults.startEditCommitMessage(ctx); }
    if (data === 'defaults:path') { await ctx.answerCbQuery(); return myDefaults.startEditUploadPath(ctx); }
    if (data === 'defaults:sortfilter') { await ctx.answerCbQuery(); return myDefaults.editSortFilter(ctx); }
    if (data.startsWith('defaults:setsort:')) { await ctx.answerCbQuery(); return myDefaults.setSort(ctx, data.split(':')[2]); }
    if (data.startsWith('defaults:setfilter:')) { await ctx.answerCbQuery(); return myDefaults.setFilter(ctx, data.split(':')[2]); }
    if (data === 'defaults:togglelearn') { await ctx.answerCbQuery(); return myDefaults.toggleLearn(ctx); }
    if (data === 'defaults:trashretention') { await ctx.answerCbQuery(); return myDefaults.editTrashRetention(ctx); }
    if (data.startsWith('defaults:settrash:')) { await ctx.answerCbQuery(); return myDefaults.setTrashRetention(ctx, data.split(':')[2]); }
    if (data === 'defaults:recentlyviewed') { await ctx.answerCbQuery(); return myDefaults.showRecentlyViewedSettings(ctx); }
    if (data === 'defaults:rv:toggle') { await ctx.answerCbQuery(); return myDefaults.toggleRecentlyViewed(ctx); }
    if (data === 'defaults:rv:clear') { await ctx.answerCbQuery('🧹 Cleared'); return myDefaults.clearRecentlyViewed(ctx); }
    if (data === 'defaults:history') { await ctx.answerCbQuery(); return myDefaults.showChangeHistory(ctx); }
    if (data === 'defaults:back') { await ctx.answerCbQuery(); return myDefaults.showDefaults(ctx); }
    if (data === 'defaults:rv:back') { await ctx.answerCbQuery(); return myDefaults.showDefaults(ctx); }

    // 🤖 Automation
    if (data === 'automation:hub') { await ctx.answerCbQuery(); return automation.showAutomationHub(ctx); }
    if (data === 'automation:refresh') { await ctx.answerCbQuery('🔄 Refreshed'); return automation.showAutomationHub(ctx, { skipBbtb: true }); }
    if (data === 'automation:ruleshub') { await ctx.answerCbQuery(); return automation.showRulesHub(ctx); }
    if (data === 'automation:schedulehub') { await ctx.answerCbQuery(); return automation.showScheduleHub(ctx); }
    if (data === 'automation:scheduledrepos') { await ctx.answerCbQuery(); return scheduledReposHandler.showScheduledRepos(ctx); }
    if (data === 'automation:scheduleduploads') { await ctx.answerCbQuery(); return scheduledUploads.showScheduledUploads(ctx); }
    if (data === 'automation:timezone') { await ctx.answerCbQuery(); return timezoneHandler.showTimezone(ctx); }
    if (data === 'automation:defaults') { await ctx.answerCbQuery(); return myDefaults.showDefaults(ctx); }
    if (data === 'automation:tagrules') { await ctx.answerCbQuery(); return automation.showAutoTagRules(ctx); }
    if (data === 'automation:muterules') { await ctx.answerCbQuery(); return automation.showMuteRules(ctx); }
    if (data === 'automation:stalerepos') { await ctx.answerCbQuery(); return automation.showStaleRepos(ctx); }
    if (data === 'automation:runrules') { await ctx.answerCbQuery(); return automation.runAllRulesNow(ctx); }

    if (data.startsWith('automation:rule:edit:')) { await ctx.answerCbQuery(); return automation.startEditRule(ctx, data.split(':')[3]); }
    if (data.startsWith('automation:rule:field:')) {
      await ctx.answerCbQuery();
      const [, , , tagId, field] = data.split(':');
      return automation.selectRuleField(ctx, tagId, field);
    }
    if (data.startsWith('automation:rule:setvisibility:')) {
      await ctx.answerCbQuery();
      const [, , , tagId, value] = data.split(':');
      return automation.setVisibilityRule(ctx, tagId, value);
    }
    if (data.startsWith('automation:rule:setfork:')) {
      await ctx.answerCbQuery();
      const [, , , tagId, value] = data.split(':');
      return automation.setForkRule(ctx, tagId, value);
    }
    if (data.startsWith('automation:rule:clear:')) { await ctx.answerCbQuery(); return automation.clearRule(ctx, data.split(':')[3]); }
    if (data.startsWith('automation:applysuggested:')) {
      await ctx.answerCbQuery();
      const rest = data.split('automation:applysuggested:')[1];
      const tagId = rest.split(':').pop();
      const repoName = rest.slice(0, rest.length - tagId.length - 1);
      return automation.applySuggestedTag(ctx, repoName, tagId);
    }
    if (data === 'automation:dismisssuggested') { await ctx.answerCbQuery(); return automation.dismissSuggestion(ctx); }

    if (data === 'automation:mute:add') { await ctx.answerCbQuery(); return automation.startAddMuteRule(ctx); }
    if (data.startsWith('automation:mute:field:')) { await ctx.answerCbQuery(); return automation.selectMuteRuleField(ctx, data.split(':')[3]); }
    if (data.startsWith('automation:mute:setvisibility:')) { await ctx.answerCbQuery(); return automation.setMuteVisibilityRule(ctx, data.split(':')[3]); }
    if (data.startsWith('automation:mute:setfork:')) { await ctx.answerCbQuery(); return automation.setMuteForkRule(ctx, data.split(':')[3]); }
    if (data.startsWith('automation:mute:delete:')) { await ctx.answerCbQuery(); return automation.deleteMuteRule(ctx, data.split(':')[3]); }

    if (data === 'automation:backuprules') { await ctx.answerCbQuery(); return automation.showBackupRules(ctx); }
    if (data === 'automation:runbackup') { await ctx.answerCbQuery(); return automation.runBackupNow(ctx); }
    if (data === 'automation:backup:add') { await ctx.answerCbQuery(); return automation.startAddBackupRule(ctx); }
    if (data.startsWith('automation:backup:field:')) { await ctx.answerCbQuery(); return automation.selectBackupRuleField(ctx, data.split(':')[3]); }
    if (data.startsWith('automation:backup:setvisibility:')) { await ctx.answerCbQuery(); return automation.setBackupVisibilityRule(ctx, data.split(':')[3]); }
    if (data.startsWith('automation:backup:setfork:')) { await ctx.answerCbQuery(); return automation.setBackupForkRule(ctx, data.split(':')[3]); }
    if (data.startsWith('automation:backup:delete:')) { await ctx.answerCbQuery(); return automation.deleteBackupRule(ctx, data.split(':')[3]); }

    if (data === 'automation:log') { await ctx.answerCbQuery(); return automation.showAutomationLog(ctx); }
    if (data.startsWith('automation:log:page:')) {
      await ctx.answerCbQuery();
      return automation.showAutomationLog(ctx, { page: Number(data.split(':')[3]), edit: true });
    }

    // 📅 Scheduled Repos — creating one is handled entirely inside
    // scenes/createRepo.js's own wizard step (createrepo:schedule and
    // createrepo:schedulepick:* never reach this global router while that
    // scene is active, same as every other createRepo callback). Only
    // managing already-scheduled ones lives here.
    if (data.startsWith('schedcommits:cancel:')) { await ctx.answerCbQuery(); return scheduledReposHandler.cancelScheduled(ctx, data.split(':')[2]); }
    if (data === 'schedcommits:back') { await ctx.answerCbQuery(); return scheduledReposHandler.showScheduledRepos(ctx); }
    if (data.startsWith('schedcommits:runnow:')) { await ctx.answerCbQuery(); return scheduledReposHandler.runScheduledNow(ctx, data.split(':')[2]); }
    if (data.startsWith('schedcommits:edit:')) { await ctx.answerCbQuery(); return scheduledReposHandler.showEditMenu(ctx, data.split(':')[2]); }
    if (data.startsWith('schedcommits:editname:')) { await ctx.answerCbQuery(); return scheduledReposHandler.startEditName(ctx, data.split(':')[2]); }
    if (data.startsWith('schedcommits:editdesc:')) { await ctx.answerCbQuery(); return scheduledReposHandler.startEditDescription(ctx, data.split(':')[2]); }
    if (data.startsWith('schedcommits:togglevis:')) { await ctx.answerCbQuery(); return scheduledReposHandler.toggleVisibility(ctx, data.split(':')[2]); }
    if (data.startsWith('schedcommits:editlicense:')) { await ctx.answerCbQuery(); return scheduledReposHandler.showLicenseMenu(ctx, data.split(':')[2]); }
    if (data.startsWith('schedcommits:setlicense:')) {
      await ctx.answerCbQuery();
      const [, , id, licenseKey] = data.split(':');
      return scheduledReposHandler.setLicense(ctx, id, licenseKey);
    }
    if (data.startsWith('schedcommits:edittime:')) { await ctx.answerCbQuery(); return scheduledReposHandler.showTimeMenu(ctx, data.split(':')[2]); }
    if (data.startsWith('schedcommits:settime:')) {
      await ctx.answerCbQuery();
      const [, , id, pick] = data.split(':');
      return scheduledReposHandler.setQuickTime(ctx, id, pick);
    }

    // 📤 Scheduled Uploads — same pattern as 🆕 Scheduled Repos above,
    // deliberately kept as a separate namespace/screen (see
    // handlers/scheduledUploads.js's header comment for why).
    if (data.startsWith('scheduploads:cancel:')) { await ctx.answerCbQuery(); return scheduledUploads.cancelScheduled(ctx, data.split(':')[2]); }
    if (data === 'scheduploads:back') { await ctx.answerCbQuery(); return scheduledUploads.showScheduledUploads(ctx); }
    if (data.startsWith('scheduploads:runnow:')) { await ctx.answerCbQuery(); return scheduledUploads.runScheduledNow(ctx, data.split(':')[2]); }
    if (data.startsWith('scheduploads:edit:')) { await ctx.answerCbQuery(); return scheduledUploads.showEditMenu(ctx, data.split(':')[2]); }
    if (data.startsWith('scheduploads:editpath:')) { await ctx.answerCbQuery(); return scheduledUploads.startEditPath(ctx, data.split(':')[2]); }
    if (data.startsWith('scheduploads:editmsg:')) { await ctx.answerCbQuery(); return scheduledUploads.startEditMessage(ctx, data.split(':')[2]); }
    if (data.startsWith('scheduploads:edittime:')) { await ctx.answerCbQuery(); return scheduledUploads.showTimeMenu(ctx, data.split(':')[2]); }
    if (data.startsWith('scheduploads:settime:')) {
      await ctx.answerCbQuery();
      const [, , id, pick] = data.split(':');
      return scheduledUploads.setQuickTime(ctx, id, pick);
    }

    // 🌍 Timezone
    if (data.startsWith('timezone:set:')) { await ctx.answerCbQuery(); return timezoneHandler.setTimezone(ctx, data.split('timezone:set:')[1]); }
    if (data === 'timezone:custom') { await ctx.answerCbQuery(); return timezoneHandler.promptCustomTimezone(ctx); }
    if (data === 'timezone:toggleformat') { await ctx.answerCbQuery(); return timezoneHandler.toggleTimeFormat(ctx); }
    if (data.startsWith('upload:learnpath:')) {
      await ctx.answerCbQuery();
      // v2.3.3: the upload finishes in a background job with no session, so the suggestion is recomputed here.
      const suggested = ctx.session.suggestedUploadPath || await require('./lib/defaults').checkUploadPathPattern(ctx.from.id).catch(() => null);
      ctx.session.suggestedUploadPath = null;
      if (!suggested) return ctx.reply('That suggestion has expired — nothing changed.');
      const defaultsLib = require('./lib/defaults');
      if (data === 'upload:learnpath:yes') {
        await defaultsLib.setDefault(ctx.from.id, 'default_upload_path', suggested, { source: 'learned' });
        return ctx.reply(`✅ Default upload folder is now \u201c${suggested}/\u201d.`);
      }
      await defaultsLib.dismissUploadPathSuggestion(ctx.from.id, suggested);
      return ctx.reply('👍 Kept your current default.');
    }
    if (data.startsWith('createrepo:learndefault:')) {
      await ctx.answerCbQuery();
      const value = data.split('createrepo:learndefault:')[1];
      if (value !== 'skip') {
        const defaultsLib = require('./lib/defaults');
        await defaultsLib.setDefault(ctx.from.id, 'default_visibility', value);
        await ctx.reply(`✅ Default visibility updated to ${value === 'private' ? '🔒 Private' : '🌐 Public'}.`);
      } else {
        await ctx.reply('👍 Kept your current default.');
      }
      return;
    }
    if (data.startsWith('createrepo:tagit:')) {
      await ctx.answerCbQuery();
      const rest = data.split('createrepo:tagit:')[1];
      if (rest === 'skip') {
        return ctx.reply('👍 Skipped.');
      }
      const [repoName, tagId] = rest.split(':');
      const tagsLib = require('./lib/tags');
      await tagsLib.assignTag(ctx.from.id, repoName, Number(tagId));
      return ctx.reply('🏷️ Tagged.');
    }

    // Storage & Data
    if (data === 'storage:clearmenu') { await ctx.answerCbQuery(); return storageData.showClearMenu(ctx); }
    if (data === 'storage:back') { await ctx.answerCbQuery(); return storageData.showStorageData(ctx); }
    if (data === 'storage:trash') { await ctx.answerCbQuery(); return trash.showTrash(ctx); }
    if (data === 'storage:exportimport') { await ctx.answerCbQuery(); return exportImport.showExportImportMenu(ctx); }
    if (data.startsWith('trash:restore:')) { await ctx.answerCbQuery(); return trash.requestRestore(ctx, data.split(':')[2]); }
    if (data === 'trash:back') { await ctx.answerCbQuery(); return trash.showTrash(ctx); }
    if (data.startsWith('trash:download:')) { await ctx.answerCbQuery(); return trash.downloadZip(ctx, data.split(':')[2]); }
    if (data.startsWith('trash:editrestore:')) { await ctx.answerCbQuery(); return trash.showEditRestore(ctx, data.split(':')[2]); }
    if (data.startsWith('trash:editname:')) { await ctx.answerCbQuery(); return trash.startEditRestoreName(ctx, data.split(':')[2]); }
    if (data.startsWith('trash:editdesc:')) { await ctx.answerCbQuery(); return trash.startEditRestoreDescription(ctx, data.split(':')[2]); }
    if (data.startsWith('trash:togglevis:')) { await ctx.answerCbQuery(); return trash.toggleEditRestoreVisibility(ctx, data.split(':')[2]); }
    if (data.startsWith('trash:deleteforever:confirm:')) { await ctx.answerCbQuery(); return trash.executeDeleteForever(ctx, data.split(':')[3]); }
    if (data.startsWith('trash:deleteforever:cancel:')) { await ctx.answerCbQuery(); return trash.showTrash(ctx); }
    if (data.startsWith('trash:deleteforever:')) { await ctx.answerCbQuery(); return trash.confirmDeleteForever(ctx, data.split(':')[2]); }
    if (data.startsWith('storage:clear:')) { await ctx.answerCbQuery(); return storageData.confirmClear(ctx, data.split('storage:clear:')[1]); }
    if (data.startsWith('storage:doclear:')) {
      await ctx.answerCbQuery();
      const scope = data.split('storage:doclear:')[1];
      await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Clearing…');
      return storageData.executeClear(ctx, scope);
    }
    if (data.startsWith('storage:clearcancel:')) {
      await ctx.answerCbQuery();
      return confirmFlow.resolveConfirmation(ctx, 'cancelled', '❌ Cancelled — nothing was cleared.');
    }
    if (data === 'storage:exportmenu') { await ctx.answerCbQuery(); return storageData.showExportMenu(ctx); }
    if (data.startsWith('storage:export:')) { await ctx.answerCbQuery(); return storageData.executeExport(ctx, data.split('storage:export:')[1]); }
    if (data === 'storage:cleanupmenu') { await ctx.answerCbQuery(); return storageData.showCleanupMenu(ctx); }
    if (data.startsWith('storage:retention:')) { await ctx.answerCbQuery(); return storageData.setRetention(ctx, data.split('storage:retention:')[1]); }
    if (data === 'storage:toggleautodelete') { await ctx.answerCbQuery(); return storageData.toggleAutoDelete(ctx); }

    // Access Log
    if (data === 'accesslog:togglealert') { await ctx.answerCbQuery(); return accessLogScreen.toggleAlert(ctx, true); }
    if (data === 'accesslog:backtoactivity') { await ctx.answerCbQuery(); return activityLog.showActivity(ctx, { skipBbtb: true }); }
    if (data === 'settings:refresh') { await ctx.answerCbQuery(); return settings.showSettings(ctx, { skipBbtb: true, edit: true }); }
    if (data === 'settings:report') { await ctx.answerCbQuery(); return reports.askReport(ctx); }

    // Bulk Repo Actions
    if (data.startsWith('bulk:toggle:')) {
      await ctx.answerCbQuery();
      return bulkActions.toggleRepo(ctx, data.split('bulk:toggle:')[1], ctx.session.bulkPage || 1);
    }
    if (data.startsWith('bulk:page:')) { await ctx.answerCbQuery(); return bulkActions.startBulkSelect(ctx, { page: Number(data.split(':')[2]), edit: true }); }
    if (data === 'bulk:selectall') { await ctx.answerCbQuery(); return bulkActions.selectAll(ctx); }
    if (data === 'bulk:invert') { await ctx.answerCbQuery(); return bulkActions.invertSelection(ctx); }
    if (data === 'bulk:selectstale') { await ctx.answerCbQuery(); return bulkActions.selectStale(ctx); }
    if (data === 'bulk:selectprivate') { await ctx.answerCbQuery(); return bulkActions.selectByVisibility(ctx, true); }
    if (data === 'bulk:selectpublic') { await ctx.answerCbQuery(); return bulkActions.selectByVisibility(ctx, false); }
    if (data === 'bulk:tagmenu') { await ctx.answerCbQuery(); return bulkActions.showTagSelectMenu(ctx); }
    if (data.startsWith('bulk:selecttag:')) { await ctx.answerCbQuery(); return bulkActions.selectByTag(ctx, data.split('bulk:selecttag:')[1]); }
    if (data === 'bulk:back') { await ctx.answerCbQuery(); return bulkActions.startBulkSelect(ctx, { page: ctx.session.bulkPage || 1, edit: true }); }
    if (data.startsWith('bulk:action:')) { await ctx.answerCbQuery(); return bulkActions.confirmAction(ctx, data.split('bulk:action:')[1]); }
    if (data === 'bulk:cancel') {
      await ctx.answerCbQuery();
      return confirmFlow.resolveConfirmation(ctx, 'cancelled', '❌ Cancelled — no changes made.');
    }
    if (data.startsWith('bulk:execute:')) {
      await ctx.answerCbQuery();
      const action = data.split('bulk:execute:')[1];
      await confirmFlow.resolveConfirmation(ctx, 'confirmed', '⏳ Working…');
      if (action === 'download') return bulkActions.executeDownloads(ctx);
      return bulkActions.execute(ctx, action);
    }
    if (data.startsWith('bulk:retryfailed:')) {
      await ctx.answerCbQuery();
      return bulkActions.retryFailed(ctx, data.split('bulk:retryfailed:')[1]);
    }
    if (data === 'bulk:undolist') { await ctx.answerCbQuery(); return bulkActions.showRecentChanges(ctx); }
    if (data.startsWith('bulk:undo:')) {
      await ctx.answerCbQuery();
      return bulkActions.undoBulkAction(ctx, data.split('bulk:undo:')[1]);
    }
    // Composable filter builder clauses
    if (data.startsWith('bulkfilter:add:')) {
      await ctx.answerCbQuery();
      const [, , type, ...rest] = data.split(':');
      return bulkActions.addFilterClause(ctx, type, rest.join(':'));
    }
    if (data === 'bulkfilter:clear') {
      await ctx.answerCbQuery();
      bulkActions.clearFilterClauses(ctx);
      return bulkActions.startBulkSelect(ctx, { page: 1, edit: true });
    }
    if (data === 'bulkfilter:saveview') {
      await ctx.answerCbQuery();
      return bulkActions.promptSaveAsView(ctx);
    }
    // Smart Folders (saved views)
    if (data.startsWith('savedview:apply:')) {
      await ctx.answerCbQuery();
      const myRepos = require('./handlers/myRepos');
      const viewId = Number(data.split('savedview:apply:')[1]);
      myRepos.setSavedView(ctx.from.id, viewId);
      return myRepos.showMyRepos(ctx);
    }
    if (data === 'savedview:exit') {
      await ctx.answerCbQuery();
      const myRepos = require('./handlers/myRepos');
      myRepos.clearSavedView(ctx.from.id);
      return myRepos.showMyRepos(ctx);
    }
    if (data.startsWith('savedview:delete:')) {
      await ctx.answerCbQuery('🗑 Removed');
      const savedViews = require('./lib/savedViews');
      await savedViews.remove(ctx.from.id, Number(data.split('savedview:delete:')[1]));
      const myRepos = require('./handlers/myRepos');
      return myRepos.showMyRepos(ctx);
    }

    // Nothing matched — most likely a stale button from an old message
    // (e.g. a completed wizard's confirm button tapped again later).
    // Without this, the tap just leaves Telegram's loading spinner stuck
    // until it times out, which looks like the bot is broken.
    await require('./handlers/manage/ui').expired(ctx);
    return;
  };
  chrome.configure({
    callbackRouter,
    // A replayed tap counts as "moved on" exactly like a real one: pending typed input is abandoned.
    beforeTap: (derived) => { if (derived.session) for (const f of REARMABLE_INPUT_FLAGS) delete derived.session[f]; },
    home: (ctx) => startHandler.handleStart(ctx),
    releaseTyped: (ctx) => {
      for (const f of REARMABLE_INPUT_FLAGS) delete ctx.session[f];
      for (const f of SEARCH_MODE_FLAGS) ctx.session[f] = false;
    },
    isTyping: (ctx) => !!ctx.session && (REARMABLE_INPUT_FLAGS.some((f) => ctx.session[f]) || SEARCH_MODE_FLAGS.some((f) => ctx.session[f])),
  });
  bot.on('callback_query', callbackRouter);

  // ─── Global error handler ────────────────────────────────────
  bot.catch(async (err, ctx) => {
    logger.error({ err, telegramId: ctx && ctx.from && ctx.from.id }, 'Bot error');
    // v1.2.4-multi: a 401 "Bad credentials" that reaches here means GitHub no
    // longer honours the stored token (usually: revoked on GitHub). Confirm it,
    // disconnect locally and send the connect flow instead of a raw error.
    try {
      if (await require('./lib/revokedToken').handleAuthFailure(ctx, err)) return;
    } catch (_) { /* fall through to the normal error message */ }
    try {
      const hint = ctx.state && ctx.state.inputRearmed
        ? 'I\u2019m still listening \u2014 send it again, or tap \u274c Cancel.'
        : 'Try again, or go back to the main menu.';
      // v1.2.1-multi: a database / Redis outage gets a truthful, non-leaky message (no driver text,
      // no hostnames) that doesn't claim "nothing changed" — a DB failure can follow a GitHub write.
      const dep = require('./lib/dependencyErrors').describeDependencyError(err);
      // v2.3.2: a GitHub "slow down" (its own limit or the bot's local hold) is one short friendly line, never "Something went wrong".
      const slow = require('./lib/rateLimitFriendly').describe(err);
      if (slow) {
        await ctx.reply(slow.text);
      } else if (dep) {
        await ctx.reply(format.errorMessage('Temporarily unavailable', dep.message, 'I couldn\u2019t complete this. Try again in a minute \u2014 and if you were changing something on GitHub, check it before repeating.'));
      } else {
        await ctx.reply(format.errorMessage('Something went wrong', err.message || 'unexpected error', hint));
      }
    } catch (_) { /* swallow */ }
    // v2.1.1: an error inside a flow must never leave the person stuck in it (Cancel/Back bar, every tap swallowed by a
    // half-open scene). Close the flow and put them back on the page they came from.
    try {
      const inScene = ctx && ctx.scene && ctx.scene.current;
      if (inScene && !(ctx.state && ctx.state.inputRearmed)) {
        await ctx.scene.leave();
        releaseAllTypedInput(ctx);
        await chrome.returnFromTyping(ctx);
      }
    } catch (_) { /* best effort */ }
  });

  return bot;
}

module.exports = createBot;
