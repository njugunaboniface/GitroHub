const { Markup } = require('telegraf');
const style = require('./buttonStyle');
const callbackRefs = require('../lib/callbackRefs');
const config = require('../config');

/** Shortens a repo name for a button label. */
const shortName = (name, n = 30) => (name.length > n ? `${name.slice(0, n - 1)}…` : name);

/** One repo as a button: visibility + name (+ pin, stars when there are any). */
function repoButtonLabel(r, pinned = false) {
  const stars = r.stargazers_count ? ` · ⭐${r.stargazers_count}` : '';
  return `${r.private ? '🔒' : '🌐'} ${pinned ? '📌 ' : ''}${shortName(r.name)}${stars}`;
}

/**
 * My Repos (v2.0.0-multi): the repos of this page as buttons (no text cards), a pager, a "Recent" row and one small toolbar.
 * Navigation (New Repo, Search, Pinned, Back) lives on the bottom bar, so none of it is repeated here.
 * `opts.pinned` is a Set of pinned names, `opts.recent` the names for the Recent row.
 */
function repoList(repos, page, totalPages, opts = {}) {
  const pinned = opts.pinned || new Set();
  const rows = repos.map((r) => [style.callback(repoButtonLabel(r, pinned.has(r.name)), `repo:${r.name}`, style.BLUE)]);
  if (totalPages > 1) {
    const pager = [];
    if (page > 1) pager.push(style.callback('◀️ Prev', `repos:page:${page - 1}`, style.BLUE));
    pager.push(style.callback(`${page} / ${totalPages}`, 'noop'));
    if (page < totalPages) pager.push(style.callback('Next ▶️', `repos:page:${page + 1}`, style.BLUE));
    rows.push(pager);
  }
  const onPage = new Set(repos.map((r) => r.name));
  const recent = (opts.recent || []).filter((n) => !onPage.has(n)).slice(0, 3);
  if (recent.length) rows.push(recent.map((n) => style.callback(`🕐 ${shortName(n, 14)}`, `repo:${n}`)));
  rows.push([style.callback('🔎 Filter', 'nav:filter', style.BLUE), style.callback('↕️ Sort', 'nav:sort', style.BLUE)]);
  rows.push([style.callback('🧹 Select', 'nav:bulk', style.BLUE), style.callback('📊 Stats', 'repos:stats', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

const filterMenu = Markup.inlineKeyboard([
  [style.callback('All', 'filter:all'), style.callback('🌐 Public', 'filter:public')],
  [style.callback('🔒 Private', 'filter:private'), style.callback('🍴 Forks', 'filter:forks')],
  [style.callback('⚖️ Has License', 'filter:haslicense'), style.callback('🚫 No License', 'filter:nolicense')],
  [style.callback('🏷️ By Tag ▾', 'filter:tagmenu'), style.callback('💻 By Language ▾', 'filter:langmenu')],
  [style.callback('⬅️ Back', 'repos:back', style.BLUE)],
]);

const sortMenu = Markup.inlineKeyboard([
  [style.callback('🕒 Recently Updated', 'sort:updated')],
  [style.callback('🔤 Name (A-Z)', 'sort:name')],
  [style.callback('⭐ Most Stars', 'sort:stars')],
  [style.callback('📅 Recently Created', 'sort:created')],
  [style.callback('💻 Dominant Language (A-Z)', 'sort:language')],
  [style.callback('⬅️ Back', 'repos:back', style.BLUE)],
]);

/**
 * Repo View info card (v1.3.0-multi, grouped): the things you do most are on top; the rest sit behind ⋯ More, with
 * Delete kept apart there. Every button is bound to THIS repo, so an older message still acts on its own repo.
 */
function repoActions(repoName, pinned = false, repoUrl, webhookState = 'none', hasReadme = false, hasManage = false) {
  const pin = style.callback(pinned ? '📌 Unpin' : '📌 Pin', `repo:pin:${pinned ? 'off' : 'on'}:${repoName}`);
  const alerts = webhookState === 'none'
    ? style.callback('🔔 Alerts', `repo:webhook:enable:${repoName}`)
    : style.callback(webhookState === 'muted' ? '🔔 Unmute' : '🔕 Mute', `repo:webhook:${webhookState === 'muted' ? 'unmute' : 'mute'}:${repoName}`);
  const details = style.callback('📊 Details', `repo:info:${repoName}`, style.BLUE);
  const more = style.callback('⋯ More', `repo:more:${repoName}`, style.BLUE);
  const rows = hasManage
    ? [[style.callback('⚡ Manage', `manage:hub:${repoName}`, style.BLUE), pin], [alerts, details], [more]]
    : [[pin, alerts], [details, more]];
  rows.push([style.callback('⬅️ My Repos', 'nav:repos', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** ⋯ More on the repo card: everything else, with the destructive action alone in the last row above Back. */
function repoMore(repoName, repoUrl, hasReadme = false) {
  const go = (action) => callbackRefs.bindRepo(repoName, `nav:${action}`);
  const rows = [
    [style.callback('✏️ Rename', `repo:rename:${repoName}`, style.BLUE), style.callback('📝 Description', `repo:description:${repoName}`, style.BLUE)],
    [style.callback('🔒 Visibility', go('visibility'), style.BLUE), style.callback('⚖️ License', go('license'), style.BLUE)],
    [style.callback('🏷️ Tags', `repo:tags:${repoName}`, style.BLUE), style.callback('📋 Clone URL', `repo:cloneurl:${repoName}`)],
    hasReadme
      ? [style.callback('📄 Export JSON', `repo:export:${repoName}`), style.callback('📖 Full README', `repo:readme:${repoName}`)]
      : [style.callback('📄 Export JSON', `repo:export:${repoName}`)],
  ];
  if (repoUrl) rows.push([style.url('🔗 Open in browser', repoUrl, style.BLUE)]);
  rows.push([style.callback('🗑 Delete repo', `repo:delete:${repoName}`, style.BLUE)]);
  rows.push([style.callback('⬅️ Back to repo', `repo:open:${repoName}`, style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function deleteRepoConfirm(repoName) {
  return Markup.inlineKeyboard([
    [style.callback('✅ Yes, Delete', `repo:delete:confirm:${repoName}`, style.RED)],
    [style.callback('❌ Cancel', `repo:delete:cancel:${repoName}`, style.GREEN)],
  ]);
}

function visibilityConfirm(repoName, currentlyPrivate) {
  const label = currentlyPrivate ? '🌐 Switch to Public' : '🔒 Switch to Private';
  return Markup.inlineKeyboard([
    [style.callback(label, `repo:visibility:confirm:${currentlyPrivate ? 'public' : 'private'}:${repoName}`, style.BLUE)],
    [style.callback('❌ Cancel', `repo:visibility:cancel:${repoName}`, style.BLUE)],
  ]);
}

function createRepoSuccess(repoName) {
  return Markup.inlineKeyboard([
    [style.callback('📦 Open Repo', `repo:${repoName}`, style.BLUE)],
    [style.callback('⬆️ Upload Files', `upload:start:${repoName}`, style.BLUE)],
  ]);
}

/** File/folder tree navigator — folders and files both rendered as rows */
/** Folder/file tree navigator — folders and files rendered as rows, with pagination for large folders */
function fileTree(entries, currentPath, pagination = null, repoUrl = null, repoName = null) {
  // Every browse/file button is bound to the repo THIS message shows (see
  // lib/callbackRefs.js) so it keeps working on the right repo even after a
  // different repo becomes "current".
  const bound = (data) => callbackRefs.bindRepo(repoName, data);
  const rows = entries.map((e) => {
    const label = e.type === 'tree' ? `📁 ${e.name}/` : `📄 ${e.name}`;
    const action = bound(e.type === 'tree' ? `browse:dir:${e.path}` : `browse:file:${e.path}`);
    return [style.callback(label, action, style.BLUE)];
  });

  if (pagination && pagination.totalPages > 1) {
    const pager = [];
    if (pagination.page > 1) pager.push(style.callback('◀️ Prev', bound(`browse:dirpage:${pagination.page - 1}:${currentPath}`), style.BLUE));
    pager.push(style.callback(`${pagination.page} / ${pagination.totalPages}`, 'noop'));
    if (pagination.page < pagination.totalPages) pager.push(style.callback('Next ▶️', bound(`browse:dirpage:${pagination.page + 1}:${currentPath}`), style.BLUE));
    rows.push(pager);
  }
  // Upload here / Replace folder / Find files live on the bottom bar. ⬅️ below is the bar's Back target:
  // one folder up, or the repo itself from the root.
  if (currentPath) {
    const parent = currentPath.split('/').slice(0, -1).join('/');
    rows.push([style.callback('⬅️ Up one level', bound(`browse:dir:${parent}`), style.BLUE)]);
  }
  rows.push([style.callback('⬅️ Back to repo', bound('nav:backrepo'), style.BLUE)]);
  if (repoUrl) {
    const ghPath = currentPath ? `${repoUrl}/tree/HEAD/${currentPath}` : repoUrl;
    rows.push([style.url('🔗 Open in Browser', ghPath, style.BLUE)]);
  }
  return Markup.inlineKeyboard(rows);
}

function fileActions(path, repoName = null) {
  const bound = (data) => callbackRefs.bindRepo(repoName, data);
  return Markup.inlineKeyboard([
    [style.callback('👁 View Content', bound(`file:view:${path}`), style.BLUE), style.callback('📥 Send as File', bound(`file:raw:${path}`), style.BLUE)],
    [style.callback('✏️ Edit', bound(`file:edit:${path}`), style.BLUE), style.callback('🔁 Replace', bound(`file:replace:${path}`), style.BLUE)],
    [style.callback('🗑 Delete File', bound(`file:delete:${path}`), style.BLUE)],
    [style.callback('⬅️ Back to Folder', bound(`browse:parent:${path}`), style.BLUE)],
  ]);
}

/** Fallback shown when a file can't be rendered inline — always offers the
 * raw download, and a direct link to GitHub's own (much broader) preview
 * support when we know the repo's URL for this session. */
function filePreviewFallback(path, githubUrl, repoName = null) {
  const bound = (data) => callbackRefs.bindRepo(repoName, data);
  const rows = [[style.callback('📥 Send as File', bound(`file:raw:${path}`), style.BLUE)]];
  if (githubUrl) rows.push([style.url('🌐 View on GitHub', githubUrl, style.BLUE)]);
  rows.push([style.callback('⬅️ Back', bound(`browse:parent:${path}`), style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function deleteFileConfirm(path, repoName = null) {
  const bound = (data) => callbackRefs.bindRepo(repoName, data);
  return Markup.inlineKeyboard([
    [style.callback('✅ Yes, Delete', bound(`file:delete:confirm:${path}`), style.RED)],
    [style.callback('❌ Cancel', bound(`file:delete:cancel:${path}`), style.GREEN)],
  ]);
}

function forkConfirm() {
  return Markup.inlineKeyboard([
    [style.callback('✅ Confirm Fork', 'external:fork:confirm', style.GREEN)],
    [style.callback('❌ Cancel', 'external:fork:cancel', style.RED)],
  ]);
}

function notificationsMenu(prefs) {
  const check = (b) => (b ? '✅' : '⬜');
  const rollupLabel = { off: '⬜ Off', daily: '☀️ Daily', weekly: '🗓️ Weekly' }[prefs.rollup || 'off'];
  const quietLabel = (prefs.quietStart != null && prefs.quietEnd != null)
    ? `🌙 ${String(prefs.quietStart).padStart(2, '0')}:00–${String(prefs.quietEnd).padStart(2, '0')}:00 local`
    : '🌙 Off';
  return Markup.inlineKeyboard([
    [style.callback(`${check(prefs.githubActivity)} GitHub Activity`, 'notif:toggle:githubActivity')],
    [style.callback(`${check(prefs.systemAlerts)} System Alerts`, 'notif:toggle:systemAlerts')],
    [style.callback(`${check(prefs.longOps)} Long Operations`, 'notif:toggle:longOps')],
    [style.callback(`${check(prefs.tokenHealth)} Token Health`, 'notif:toggle:tokenHealth')],
    [style.callback(`${check(prefs.staleNudge)} Stale Repo Nudge (weekly)`, 'notif:toggle:staleNudge')],
    // Daily/weekly rollup summary + quiet hours cycle on tap rather than
    // a separate picker screen — keeps this one flat menu.
    [style.callback(`Rollup: ${rollupLabel}`, 'notif:cyclerollup')],
    [style.callback(`Quiet Hours: ${quietLabel}`, 'notif:setquiet')],
    [style.callback('⬅️ Back', 'settings:back', style.BLUE)],
  ]);
}

function disconnectConfirm({ multi = false, activeLogin = null } = {}) {
  const rows = [[style.callback(multi && activeLogin ? `✅ Disconnect @${activeLogin} only` : '✅ Yes, Disconnect', 'settings:disconnect:confirm', style.RED)]];
  // v1.2.5-multi: with several accounts the person can end every connection in one go.
  if (multi) rows.push([style.callback('🚪 Disconnect ALL accounts', 'settings:disconnect:all', style.RED)]);
  rows.push([style.callback('❌ Cancel', 'settings:disconnect:cancel', style.GREEN)]);
  return Markup.inlineKeyboard(rows);
}

function disconnectAllConfirm() {
  return Markup.inlineKeyboard([
    [style.callback('✅ Yes, disconnect everything', 'settings:disconnect:allconfirm', style.RED)],
    [style.callback('❌ Cancel', 'settings:disconnect:cancel', style.GREEN)],
  ]);
}

/** 🔧 Rules & Insights — the 2x2 grid of everything grouped under here.
 * Exploiting inline here rather than more BBTB rows, per the redesign:
 * these are content destinations picked once per visit, not frequent
 * actions that deserve permanent thumb-reach real estate. */
/** 🤖 Automation hub content — Log moved here from BBTB, paired with a
 * Refresh action so the live stats in the hub text (active rule counts,
 * queued schedule count, last-run time) can be updated without
 * re-navigating. Same edit-in-place pattern as My Repos' inline Refresh. */
function automationHubActions() {
  return Markup.inlineKeyboard([
    [
      style.callback('📜 Log', 'automation:log', style.BLUE),
      style.callback('🔄 Refresh', 'automation:refresh', style.BLUE),
    ],
    [
      style.callback('🔧 Rules', 'nav:rules', style.BLUE),
      style.callback('📅 Schedule', 'nav:schedule', style.BLUE),
      style.callback('⚙️ Defaults', 'nav:defaults', style.BLUE),
    ],
    [style.callback('⬅️ Settings', 'hub:settings', style.BLUE), style.callback('💼 Workspace', 'manage:ws', style.BLUE)],
  ]);
}

/** 📅 Schedule — the hub-of-hubs for Scheduled Repos, Scheduled Uploads,
 * and Timezone. Repos/Uploads share a row since they're both "queues of
 * pending things," same idea as 🔧 Rules' own grid; Timezone sits alone
 * below since it's a setting, not a queue. */
function scheduleHubMenu() {
  return Markup.inlineKeyboard([
    [
      style.callback('🆕 Scheduled Repos', 'automation:scheduledrepos', style.BLUE),
      style.callback('📤 Scheduled Uploads', 'automation:scheduleduploads', style.BLUE),
    ],
    [style.callback('🌍 Timezone', 'automation:timezone', style.BLUE)],
    [style.callback('⬅️ Back', 'automation:hub', style.BLUE)],
  ]);
}

function rulesHubMenu() {
  return Markup.inlineKeyboard([
    [
      style.callback('🏷️ Auto-Tag', 'automation:tagrules', style.BLUE),
      style.callback('🔕 Auto-Mute', 'automation:muterules', style.BLUE),
    ],
    [
      style.callback('💾 Auto-Backup', 'automation:backuprules', style.BLUE),
      style.callback('🗂️ Stale Repos', 'automation:stalerepos', style.BLUE),
    ],
    [style.callback('▶️ Run Rules Now', 'automation:runrules', style.GREEN)],
    [style.callback('⬅️ Back', 'automation:hub', style.BLUE)],
  ]);
}

/** 🏷️ Auto-Tag Rules list — one row per tag, ⚡ = rule active / ➖ = none.
 * Run Rules Now moved to BBTB (it's a frequent, low-risk action — belongs
 * there, not competing for space with the content below it). */
function autoTagRulesMenu(userTags) {
  const rows = userTags.map((t) => [
    style.callback(`${t.auto_rule_json ? '⚡' : '➖'} ${t.emoji} ${t.name}`, `automation:rule:edit:${t.id}`),
  ]);
  rows.push([style.callback('⬅️ Back', 'automation:ruleshub', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** Field picker for one tag's rule — 2x2, condition types are equal-weight
 * picks, not a sequence. Clear Rule only shown once a rule already exists,
 * and stays colorless: removing a rule is reversible and low-stakes, not
 * in the same tier as Delete Repo/File. */
function ruleFieldMenu(tagId, hasRule) {
  const rows = [
    [
      style.callback('💻 Language', `automation:rule:field:${tagId}:language`),
      style.callback('📛 Name', `automation:rule:field:${tagId}:name`),
    ],
    [
      style.callback('🔒 Visibility', `automation:rule:field:${tagId}:visibility`),
      style.callback('🍴 Fork', `automation:rule:field:${tagId}:fork`),
    ],
  ];
  if (hasRule) rows.push([style.callback('🗑 Clear Rule', `automation:rule:clear:${tagId}`)]);
  rows.push([style.callback('⬅️ Back', 'automation:tagrules', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function ruleVisibilityMenu(tagId) {
  return Markup.inlineKeyboard([
    [
      style.callback('🔒 Private', `automation:rule:setvisibility:${tagId}:private`),
      style.callback('🌐 Public', `automation:rule:setvisibility:${tagId}:public`),
    ],
    [style.callback('⬅️ Back', `automation:rule:edit:${tagId}`, style.BLUE)],
  ]);
}

function ruleForkMenu(tagId) {
  return Markup.inlineKeyboard([
    [
      style.callback('🍴 Is a Fork', `automation:rule:setfork:${tagId}:fork`),
      style.callback('🌱 Not a Fork', `automation:rule:setfork:${tagId}:notfork`),
    ],
    [style.callback('⬅️ Back', `automation:rule:edit:${tagId}`, style.BLUE)],
  ]);
}

/** One-tap suggestion offered inline on Repo View when an auto-tag rule
 * matches a repo that doesn't have that tag yet — colorless (a value pick,
 * same tier as any other suggestion), with an explicit Dismiss so it
 * doesn't feel like it's demanding an answer. */
function autoTagSuggestion(repoName, tagId) {
  return Markup.inlineKeyboard([
    [
      style.callback('✅ Apply', `automation:applysuggested:${repoName}:${tagId}`),
      style.callback('➖ Dismiss', 'automation:dismisssuggested'),
    ],
  ]);
}

/** 🔕 Auto-Mute rules list — each rule's description lives in the message
 * text (numbered), buttons are purely actions: delete #N, add, back. A
 * button whose only job was to display text with no real tap behavior
 * isn't a real button, so descriptions never become tappable labels here. */
function muteRulesMenu(rules) {
  const rows = rules.map((r, i) => [style.callback(`🗑 Delete #${i + 1}`, `automation:mute:delete:${r.id}`)]);
  rows.push([style.callback('➕ Add Rule', 'automation:mute:add', style.BLUE)]);
  rows.push([style.callback('⬅️ Back', 'automation:ruleshub', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function muteRuleFieldMenu() {
  return Markup.inlineKeyboard([
    [
      style.callback('💻 Language', 'automation:mute:field:language'),
      style.callback('📛 Name', 'automation:mute:field:name'),
    ],
    [
      style.callback('🔒 Visibility', 'automation:mute:field:visibility'),
      style.callback('🍴 Fork', 'automation:mute:field:fork'),
    ],
    [style.callback('⬅️ Back', 'automation:muterules', style.BLUE)],
  ]);
}

function muteRuleVisibilityMenu() {
  return Markup.inlineKeyboard([
    [
      style.callback('🔒 Private', 'automation:mute:setvisibility:private'),
      style.callback('🌐 Public', 'automation:mute:setvisibility:public'),
    ],
    [style.callback('⬅️ Back', 'automation:mute:add', style.BLUE)],
  ]);
}

function muteRuleForkMenu() {
  return Markup.inlineKeyboard([
    [
      style.callback('🍴 Is a Fork', 'automation:mute:setfork:fork'),
      style.callback('🌱 Not a Fork', 'automation:mute:setfork:notfork'),
    ],
    [style.callback('⬅️ Back', 'automation:mute:add', style.BLUE)],
  ]);
}

/** 💾 Auto-Backup rules list — same shape as Auto-Mute's list. */
function backupRulesMenu(rules) {
  const rows = rules.map((r, i) => [style.callback(`🗑 Delete #${i + 1}`, `automation:backup:delete:${r.id}`)]);
  rows.push([style.callback('➕ Add Rule', 'automation:backup:add', style.BLUE)]);
  if (rules.length) rows.push([style.callback('▶️ Backup Now', 'nav:backup', style.GREEN)]);
  rows.push([style.callback('⬅️ Back', 'automation:ruleshub', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function backupRuleFieldMenu() {
  return Markup.inlineKeyboard([
    [
      style.callback('💻 Language', 'automation:backup:field:language'),
      style.callback('📛 Name', 'automation:backup:field:name'),
    ],
    [
      style.callback('🔒 Visibility', 'automation:backup:field:visibility'),
      style.callback('🍴 Fork', 'automation:backup:field:fork'),
    ],
    [style.callback('⬅️ Back', 'automation:backuprules', style.BLUE)],
  ]);
}

function backupRuleVisibilityMenu() {
  return Markup.inlineKeyboard([
    [
      style.callback('🔒 Private', 'automation:backup:setvisibility:private'),
      style.callback('🌐 Public', 'automation:backup:setvisibility:public'),
    ],
    [style.callback('⬅️ Back', 'automation:backup:add', style.BLUE)],
  ]);
}

function backupRuleForkMenu() {
  return Markup.inlineKeyboard([
    [
      style.callback('🍴 Is a Fork', 'automation:backup:setfork:fork'),
      style.callback('🌱 Not a Fork', 'automation:backup:setfork:notfork'),
    ],
    [style.callback('⬅️ Back', 'automation:backup:add', style.BLUE)],
  ]);
}

/** 🗂️ Stale Repos — each repo reuses the exact same 'repo:<name>' callback
 * My Repos' own list uses, so tapping one opens the real Repo View. */
function staleReposMenu(repos) {
  const rows = repos.map((r) => [
    style.callback(`📦 ${r.name} — ${r.staleLabel}`, `repo:${r.name}`, style.BLUE),
  ]);
  rows.push([style.callback('⬅️ Back', 'automation:ruleshub', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function automationLogPagination(page, totalPages) {
  const rows = [];
  const nav = [];
  if (page > 1) nav.push(style.callback('⬅️ Prev', `automation:log:page:${page - 1}`, style.BLUE));
  if (page < totalPages) nav.push(style.callback('Next ➡️', `automation:log:page:${page + 1}`, style.BLUE));
  if (nav.length) rows.push(nav);
  rows.push([style.callback('⬅️ Back to Automation', 'automation:hub', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function connectButton(url) {
  return Markup.inlineKeyboard([[Markup.button.url('🔗 Connect GitHub Account', url)]]);
}

/** 💾 Export/Import — the two actions plus Back, no reason for more than
 * one row here. */
function exportImportMenu() {
  return Markup.inlineKeyboard([
    [style.callback('⬇️ Export Settings', 'exportimport:export', style.BLUE)],
    [style.callback('⬆️ Import Settings', 'exportimport:import', style.BLUE)],
    [style.callback('⬅️ Back', 'storage:back', style.BLUE)],
  ]);
}

/** Import is the one genuinely destructive part of this feature (it
 * overwrites Defaults + Notification prefs outright) so it gets the same
 * explicit-confirm treatment as Delete Repo/File — RED for the same reason. */
function importConfirm() {
  return Markup.inlineKeyboard([
    [style.callback('✅ Yes, Import', 'exportimport:import:confirm', style.RED)],
    [style.callback('❌ Cancel', 'exportimport:import:cancel', style.GREEN)],
  ]);
}

function activityPagination(page, totalPages, errorsOnly) {
  const rows = [];
  const nav = [];
  if (page > 1) nav.push(style.callback('⬅️ Prev', `activity:page:${page - 1}:${errorsOnly}`, style.BLUE));
  if (page < totalPages) nav.push(style.callback('Next ➡️', `activity:page:${page + 1}:${errorsOnly}`, style.BLUE));
  if (nav.length) rows.push(nav);
  rows.push([
    style.callback(errorsOnly ? '⬅️ Back to Full Log' : '⚠️ Errors Only', `activity:filter:${!errorsOnly}`),
  ]);
  // Access Log lives here, reachable from inside Activity rather than its
  // own Settings row. Refresh uses the same chained-fresh-message pattern
  // as Settings' Refresh Status, and lives here instead of its own BBTB
  // row to avoid colliding with My Repos' Refresh button.
  rows.push([
    style.callback('🔑 Access Log', 'activity:accesslog', style.BLUE),
    style.callback('🔄 Refresh', `activity:refresh:${errorsOnly}`),
  ]);
  return Markup.inlineKeyboard(rows);
}

/** Two explicit search entry points instead of one box that guesses intent
 * from the input (fuzzy name vs pasted URL). */
function searchTypeMenu() {
  return Markup.inlineKeyboard([
    [style.callback('📁 My Repos', 'search:type:myrepos', style.BLUE)],
    [style.callback('🌐 Public Repo', 'search:type:public', style.BLUE)],
    [style.callback('💼 Workspace', 'manage:ws', style.BLUE)],
  ]);
}

// ── v1.1.0-multi — Admin Dashboard ──────────────────────────────────
// Same conventions as everywhere else: content + destructive confirms
// live here (inline), navigation lives on BBTB (keyboards/bbtb.js).

// v1.3.3-multi — 🔍 Search, 📢 Broadcast, and ⚙️ Config all dropped from
// here too, for the exact same reason 🩺 Maintenance was: each already
// had its own BBTB button elsewhere (Search/Broadcast on the 👥 Users
// screen, Config on the Dashboard's own BBTB row) — same action, two
// buttons. Refresh has no BBTB equivalent (it's a content action, not
// navigation) so it's the only one left here.
/** v1.1.8 — 👥 People hub landing: picks between the three "about a
 * person/account" screens that used to be scattered (Users was a direct
 * Dashboard button; Reports/Admins were inline-only on the Dashboard's
 * own message, with no real home). */
function adminPeopleHubMenu(openReportCount = 0) {
  return Markup.inlineKeyboard([
    [style.callback('👥 All Users', 'admin:users:entry')],
    [style.callback(`🚩 Reports${openReportCount ? ` (${openReportCount})` : ''}`, 'admin:reports', style.BLUE)],
    [style.callback('👑 Admins & roles', 'admin:roles', style.BLUE)],
    [style.callback('🗂️ Bulk actions', 'admin:bulkhub', style.BLUE)],
    [style.callback('⬅️ Admin', 'admin:dashboard', style.BLUE), style.callback('💼 Workspace', 'manage:ws', style.BLUE)],
  ]);
}

/** 📊 Oversight hub landing — both "look, don't act" screens paired
 * together, same reasoning as the original v1.1.8 redesign proposal. */
function adminOversightHubMenu() {
  return Markup.inlineKeyboard([
    [style.callback('📊 Fleet Stats', 'admin:fleet')],
    [style.callback('📜 Audit Log', 'admin:audit:entry')],
    [style.callback('⬆️ Back to Admin', 'admin:dashboard', style.BLUE)],
  ]);
}

/** 🛠️ Ops hub landing — the three fleet-wide levers, none of them
 * about one specific person. Broadcast/Cast History moved here from
 * Users' old BBTB, where it never really belonged. */
/** 📢 Broadcast's own small hub, nested under 🛠️ Ops. */
function adminBroadcastHubMenu() {
  return Markup.inlineKeyboard([
    [style.callback('📢 Cast', 'admin:broadcast')],
    [style.callback('📜 Cast History', 'admin:broadcast:history:1')],
    [style.callback('⬅️ Admin', 'admin:dashboard', style.BLUE), style.callback('💼 Workspace', 'manage:ws', style.BLUE)],
  ]);
}

/**
 * 🤖 Warden keyboards (v1.2.0-multi — observation only).
 * Every control states its own current value and flips it in place; labels stay
 * short enough for two per row. State switches are colourless (RED = irreversible
 * execute, GREEN = "safe way out"; see keyboards/buttonStyle.js).
 */
/**
 * ONE definition of the Trusted / Repo-shield pair, used by BOTH the Warden
 * case card and the admin user card (they used to hand-build it twice, with
 * different wording for the same switch). The state is in the label; tapping
 * flips it. Only the callback data differs per screen.
 */
function protectionControls({ trusted, shielded, trustData, shieldData }) {
  return [
    style.callback(trusted ? '⭐ Trusted: YES' : '⭐ Trusted: NO', trustData),
    style.callback(shielded ? '🛡 Repo shield: ON' : '🛡 Repo shield: OFF', shieldData),
  ];
}

function wardenMainMenu(cfg, openCases = 0, shield = null) {
  // The Repo Shield button carries its own state (how many connected users are protected)
  // so the main menu answers "is the shield on?" without opening a second screen.
  const shieldLabel = shield && Number.isFinite(shield.connected)
    ? `🛡 Shield ${shield.connected_protected}/${shield.connected}`
    : '🛡 Repo Shield';
  return Markup.inlineKeyboard([
    [
      style.callback(cfg.enabled ? '🟢 Warden: ON' : '⚫ Warden: OFF', 'warden:toggle:enabled'),
      style.callback(cfg.alerts_review ? '🔔 Alerts: ON' : '🔕 Alerts: OFF', 'warden:toggle:alerts'),
    ],
    [
      style.callback(`🗂 Board${openCases ? ` (${openCases})` : ''}`, 'warden:board:1', style.BLUE),
      style.callback('📋 Decision Log', 'warden:log:1', style.BLUE),
    ],
    [
      style.callback(shieldLabel, 'warden:shield', style.BLUE),
      style.callback('📤 Export JSONL', 'warden:export', style.BLUE),
    ],
    [style.callback('⬅️ Watch', 'admin:watch', style.BLUE)],
  ]);
}

const BOARD_FILTERS = [
  { key: 'all', label: 'All', minStage: 'flag' },
  { key: 'enhanced', label: 'Enhanced+', minStage: 'enhanced_monitoring' },
  { key: 'review', label: 'Review', minStage: 'review_candidate' },
];

function wardenBoardList(rows, page, totalPages, filterKey) {
  const stageIcon = { flag: '🚩', enhanced_monitoring: '🔎', review_candidate: '🧾' };
  const list = rows.map((c) => {
    const who = c.telegram_username ? `@${c.telegram_username}` : (c.telegram_first_name || `#${c.telegram_id}`);
    const snoozed = c.snooze_until && new Date(c.snooze_until) > new Date() ? ' 💤' : '';
    return [style.callback(`${stageIcon[c.stage] || '•'} ${who.slice(0, 18)} · R${Math.round(c.risk || 0)}${snoozed}`, `warden:case:${c.id}`, style.BLUE)];
  });
  const f = BOARD_FILTERS.find((x) => x.key === filterKey) || BOARD_FILTERS[0];
  const nav = [];
  if (totalPages > 1) {
    if (page > 1) nav.push(style.callback('◀️ Prev', `warden:board:${page - 1}`, style.BLUE));
    nav.push(style.callback(`${page}/${totalPages}`, 'noop'));
    if (page < totalPages) nav.push(style.callback('Next ▶️', `warden:board:${page + 1}`, style.BLUE));
  }
  return Markup.inlineKeyboard([
    ...list,
    ...(nav.length ? [nav] : []),
    [style.callback(`🔎 Filter: ${f.label}`, 'warden:board:filter')],
    [style.callback('⬅️ Back to Warden', 'warden:main', style.BLUE)],
  ]);
}

/** The case card: state-labelled toggles, then the owner's manual actions. */
function wardenCaseCard(caseId, { trusted, shielded, isOpen = true }) {
  const rows = [protectionControls({ trusted, shielded, trustData: `warden:case:${caseId}:trust`, shieldData: `warden:case:${caseId}:shield` })];
  if (isOpen) {
    rows.push([style.callback('🛡 Keep monitoring', `warden:case:${caseId}:watch`, style.BLUE), style.callback('✅ Dismiss', `warden:case:${caseId}:dismiss`, style.BLUE)]);
  }
  rows.push([style.callback('⚠️ Send warning', `warden:case:${caseId}:warn`, style.BLUE), style.callback('📜 Timeline', `warden:case:${caseId}:timeline`, style.BLUE)]);
  rows.push([style.callback('🔨 Enforcement…', `warden:case:${caseId}:enf`, style.BLUE)]);
  rows.push([style.callback('⬅️ Board', 'warden:board:1', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function wardenWarnPreview(caseId) {
  return Markup.inlineKeyboard([
    [style.callback('✅ Send to user', `warden:case:${caseId}:warnsend`, style.BLUE)],
    [style.callback('✖ Cancel', `warden:case:${caseId}`, style.GREEN)],
  ]);
}

function wardenEnforcementGate(caseId, warned) {
  const rows = [];
  if (!warned) rows.push([style.callback('⚠️ Send warning first', `warden:case:${caseId}:warn`, style.BLUE)]);
  rows.push([style.callback(warned ? 'Continue to user actions' : 'Continue — severe case', `warden:case:${caseId}:enfgo`, warned ? style.BLUE : style.RED)]);
  rows.push([style.callback('⬅️ Back to case', `warden:case:${caseId}`, style.GREEN)]);
  return Markup.inlineKeyboard(rows);
}

function wardenBackToCase(caseId) {
  return Markup.inlineKeyboard([[style.callback('⬅️ Back to case', `warden:case:${caseId}`, style.BLUE)]]);
}

function wardenActionLogPagination(page, totalPages) {
  const nav = [];
  if (totalPages > 1) {
    if (page > 1) nav.push(style.callback('◀️ Prev', `warden:log:${page - 1}`, style.BLUE));
    nav.push(style.callback(`Page ${page}/${totalPages}`, 'noop'));
    if (page < totalPages) nav.push(style.callback('Next ▶️', `warden:log:${page + 1}`, style.BLUE));
  }
  return Markup.inlineKeyboard([
    ...(nav.length ? [nav] : []),
    [style.callback('⬅️ Back to Warden', 'warden:main', style.BLUE)],
  ]);
}

function wardenExportMenu() {
  return Markup.inlineKeyboard([
    [style.callback('📋 Decision log', 'warden:export:log', style.BLUE), style.callback('🗂 Cases', 'warden:export:cases', style.BLUE)],
    [style.callback('🔬 Evidence', 'warden:export:evidence', style.BLUE), style.callback('📦 Everything', 'warden:export:all', style.BLUE)],
    [style.callback('⬅️ Back to Warden', 'warden:main', style.BLUE)],
  ]);
}

/**
 * Repo Shield's three scope buttons (v1.2.3-multi). Each shows ITS OWN current status and
 * count — 🛡 all protected, 🔓 none, ◐ some — and tapping it sets the opposite for that
 * whole scope straight away, editing this screen in place. The tap carries its TARGET
 * (on/off) rather than "toggle", so a double tap or an old message can't flip it back.
 * No confirm step: every bulk change can be undone with the ↩️ button below.
 */
function shieldScopeButton(scope, name, sc) {
  const total = (sc && sc.total) || 0;
  const done = (sc && sc.protected) || 0;
  const allOn = total > 0 && done === total;
  const mark = total === 0 ? '➖' : allOn ? '🛡' : done === 0 ? '🔓' : '◐';
  return style.callback(`${mark} ${name} ${done}/${total}`, `warden:shield:set:${scope}:${allOn ? 'off' : 'on'}`, style.BLUE);
}

function wardenShieldMenu(stats) {
  const sc = (stats && stats.scopes) || {};
  const rows = [
    [shieldScopeButton('connected', 'Connected', sc.connected)],
    [shieldScopeButton('trusted', '⭐ Trusted', sc.trusted)],
    [shieldScopeButton('everyone', 'Everyone', sc.everyone)],
  ];
  if (stats && stats.lastBatch) rows.push([style.callback(`↩️ Undo last (${stats.lastBatch.n} users)`, 'warden:shield:undo', style.BLUE)]);
  rows.push([style.callback('⬅️ Back to Warden', 'warden:main', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function wardenShieldConfirm(scope, protect) {
  const p = protect ? 'p' : 'u';
  return Markup.inlineKeyboard([
    [style.callback('✅ Confirm', `warden:shield:do:${scope}:${p}`, style.BLUE)],
    [style.callback('✖ Cancel', 'warden:shield', style.GREEN)],
  ]);
}

function adminOpsHubMenu({ isOwner = false } = {}) {
  const rows = [
    [style.callback('📢 Broadcast', 'admin:broadcast:hub')],
    [style.callback('⚙️ Global Config', 'admin:config')],
    [style.callback('🩺 Maintenance', 'admin:maintenance')],
    [style.callback('🗄️ Export / Import', 'migrate:hub')],
    [style.callback('🛰️ Monitoring', 'admin:mon')],
  ];
  // v1.2.1-multi: the GitHub traffic screen has Owner-only levers, so only the Owner is shown the door.
  if (isOwner) rows.push([style.callback('🌐 GitHub Traffic', 'admin:ghtraffic')]);
  rows.push([style.callback('⬆️ Back to Admin', 'admin:dashboard', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** 🌐 GitHub Traffic screen (Owner-only). Controls only appear when they can do something. */
function githubTrafficMenu({ backgroundPaused = false, breakerOpen = false, pausedLanes = 0 } = {}) {
  const rows = [[style.callback('🔄 Refresh', 'admin:ghtraffic')]];
  rows.push([style.callback(backgroundPaused ? '▶️ Resume background work' : '⏸️ Pause background work', 'admin:ghtraffic:bg', backgroundPaused ? style.GREEN : style.BLUE)]);
  if (breakerOpen) rows.push([style.callback('♻️ Reset circuit breaker', 'admin:ghtraffic:breaker', style.RED)]);
  if (pausedLanes) rows.push([style.callback('⏱️ Clear paused accounts', 'admin:ghtraffic:clear', style.BLUE)]);
  rows.push([style.callback('⬅️ Back to System', 'admin:system', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** v1.1.8: Reports/Admins moved into the 👥 People hub (see
 * adminPeopleHubMenu above) — no longer duplicated here. Dashboard's own
 * inline row is now just Refresh plus the Owner-only break-glass action. */
/** v1.3.0-multi: "what next?" buttons under an admin action's result. */
function adminNextRow() {
  return Markup.inlineKeyboard([[style.callback('🛡️ Admin', 'admin:dashboard', style.BLUE), style.callback('💼 Workspace', 'manage:ws', style.BLUE)]]);
}

function adminDashboardActions(openReportCount = 0, isOwner = false) {
  const rows = [[style.callback('🔄 Refresh', 'admin:refresh')]];
  if (isOwner) rows.push([style.callback('🔒 Lockdown Mode', 'admin:lockdown', style.RED)]);
  return Markup.inlineKeyboard(rows);
}

/** 🔒 Lockdown Mode's own screen — Owner-only, see lib/lockdown.js. */
function adminLockdownMenu(fullActive, keepWarden, locked = []) {
  const rows = [];
  rows.push([
    fullActive
      ? style.callback('🔴 Full Lockdown is ON', 'admin:lockdown:noop')
      : style.callback('🔒 Lock Everyone', 'admin:lockdown:all', style.RED),
  ]);
  rows.push([style.callback('🎯 Targeted Lockdown', 'admin:lockdown:targeted', style.BLUE)]);
  if (locked.length) rows.push([style.callback('🔓 Release Everyone', 'admin:lockdown:releaseall', style.GREEN)]);
  rows.push([style.callback(`🤖 Warden while locked down: ${keepWarden ? 'Keeps running' : 'Also paused'}`, 'admin:lockdown:keepwarden', style.BLUE)]);
  rows.push([style.callback('⬅️ Back to Admin', 'admin:dashboard', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** 🎯 Targeted Lockdown's admin picker — one row per admin (never the
 * Owner, filtered out by the caller), tap to toggle lock/unlock. */
function adminTargetedLockdownList(admins, lockedIds) {
  const rows = admins.map((a) => {
    const isLocked = lockedIds.has(String(a.telegram_id));
    const name = a.telegram_username ? `@${a.telegram_username}` : (a.telegram_first_name || `#${a.telegram_id}`);
    return [style.callback(`${isLocked ? '🔒' : '🔓'} ${name} (${a.role.replace('_', ' ')})`, `admin:lockdown:toggle:${a.telegram_id}`, isLocked ? style.RED : style.BLUE)];
  });
  rows.push([style.callback('⬅️ Back to Lockdown', 'admin:lockdown', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** 🩺 Maintenance Mode — toggle is BLUE either direction (reversible, per
 * the locked color rule: RED is reserved for genuinely irreversible
 * executes only), the schedule fields are colorless picks, and Clear is
 * only offered once a schedule side is actually set. */
function adminMaintenanceMenu(enabled, autoOn, autoOff) {
  const rows = [
    [enabled
      ? style.callback('🟢 Turn OFF', 'admin:maint:off', style.BLUE)
      : style.callback('🔴 Turn ON', 'admin:maint:on', style.BLUE)],
    [style.callback('✏️ Edit Message', 'admin:maint:msg', style.BLUE)],
    [
      style.callback(autoOn ? `⏰ Auto-ON: ${autoOn}` : '⏰ Set Auto-ON', 'admin:maint:schedon'),
      style.callback(autoOff ? `⏰ Auto-OFF: ${autoOff}` : '⏰ Set Auto-OFF', 'admin:maint:schedoff'),
    ],
  ];
  if (autoOn || autoOff) rows.push([style.callback('🗑️ Clear Schedule', 'admin:maint:schedclear', style.GREEN)]);
  rows.push([style.callback('⬅️ Back to System', 'admin:system', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

// v1.3.3-multi — ⚙️ Global Config's shortcut removed from here too: it
// already has exactly one home (the Dashboard's own BBTB row), this was
// a third way in on top of the Dashboard inline button already removed.
function adminFleetActions() {
  return Markup.inlineKeyboard([
    [style.callback('🏆 Leaderboards', 'admin:leaderboards', style.BLUE), style.callback('⚠️ Error Feed', 'admin:errors:1', style.BLUE)],
    [style.callback('🖥️ System Health', 'admin:health', style.BLUE), style.callback('📈 Growth', 'admin:growth', style.BLUE)],
    [style.callback('🕵️ Anomaly Feed', 'admin:anomalies:1', style.BLUE), style.callback('🗓️ Scheduled Jobs', 'admin:jobs', style.BLUE)],
    [style.callback('🔄 Refresh', 'admin:fleet:refresh')],
    [style.callback('⬅️ Watch', 'admin:watch', style.BLUE), style.callback('💼 Workspace', 'manage:ws', style.BLUE)],
  ]);
}

/** Each user is its own tappable row (mirrors repoList), plus a filter
 * strip (split across two rows — 5 filters no longer fit one) and
 * pagination. */
function adminUsersList(rows, filter, page, totalPages) {
  const userRows = rows.map((u) => {
    const label = u.telegram_username ? `@${u.telegram_username}` : (u.telegram_first_name || `#${u.telegram_id}`);
    const suspicious = !u.is_admin && (u.rate_limit_hits >= 3 || (!u.github_token_enc && u.total_actions > 20));
    const badge = u.is_blocked ? '🚫 ' : (u.suspended_until && new Date(u.suspended_until) > new Date() ? '⏸️ ' : (suspicious ? '🚩 ' : ''));
    return [style.callback(`${badge}${label}`, `admin:user:${u.telegram_id}`, style.BLUE)];
  });
  const filters = ['all', 'blocked', 'suspended', 'connected', 'never_connected', 'suspicious'];
  const filterLabels = { all: 'All', blocked: '🚫 Banned', suspended: '⏸️ Suspended', connected: '🔗 Connected', never_connected: '🆕 Never Connected', suspicious: '🚩 Suspicious' };
  const otherFilters = filters.filter((f) => f !== filter).map((f) => style.callback(filterLabels[f], `admin:users:${f}:1`));
  const filterRows = [otherFilters.slice(0, 2), otherFilters.slice(2, 4), otherFilters.slice(4)].filter((r) => r.length);
  const pagination = [];
  if (page > 1) pagination.push(style.callback('⬅️ Prev', `admin:users:${filter}:${page - 1}`, style.BLUE));
  if (page < totalPages) pagination.push(style.callback('Next ➡️', `admin:users:${filter}:${page + 1}`, style.BLUE));

  const rowsOut = [...userRows, ...filterRows];
  if (pagination.length) rowsOut.push(pagination);
  // v1.3.3-multi — the inline 🔍 Search row that used to live here is
  // gone: this screen's own BBTB already has a 🔍 Search button, so this
  // was a second way to trigger the exact same admin.askSearch(ctx).
  return Markup.inlineKeyboard(rowsOut);
}

/** Per-user detail card actions — the actual moderation controls.
 * Admin accounts never get Ban/Suspend/Delete buttons at all — not just
 * refused server-side, hidden here too, so there's nothing to tap in the
 * first place. See lib/adminActions.js's isProtectedAdmin for why. */
/** `isProtected` is computed live via adminActions.isProtectedAdmin (not
 * the `user.is_admin` DB column, which only reflects config.ADMIN_IDS at
 * /start time and would stay FALSE forever for someone promoted later
 * via 👑 Set Role) — this is what makes Ban/Suspend correctly disappear
 * for a promoted user immediately, not just get silently blocked with a
 * confusing error after the button is tapped. `canPromote` gates the new
 * 👑 Set Role button — true only for a super_admin viewer looking at a
 * non-Owner target. */
function adminUserDetail(user, suspended, canPromote = false, isProtected = false, hideOwnerPrivate = false, opts = {}) {
  const rows = [];
  if (isProtected) {
    rows.push([style.callback('🛡️ Protected admin account', 'admin:noop')]);
  } else {
    rows.push(user.is_blocked
      ? [style.callback('✅ Unban', `admin:user:${user.telegram_id}:unban`, style.BLUE)]
      : [style.callback('🚫 Ban', `admin:user:${user.telegram_id}:askban`, style.RED)]);
    if (!user.is_blocked) {
      rows.push(suspended
        ? [style.callback('▶️ Unsuspend', `admin:user:${user.telegram_id}:unsuspend`, style.BLUE)]
        : [
            style.callback('⏸️ Suspend 24h', `admin:user:${user.telegram_id}:suspend:24`, style.BLUE),
            style.callback('Suspend 7d', `admin:user:${user.telegram_id}:suspend:168`, style.BLUE),
          ]);
    }
  }
  // State is in the label (tap flips it). Trusted = exempt from enforcement and from the hourly
  // cap, but still fully observed and logged by Warden.
  const controls = protectionControls({ trusted: !!user.is_trusted, shielded: !!user.repos_protected, trustData: `admin:user:${user.telegram_id}:trust`, shieldData: `admin:user:${user.telegram_id}:shield` });
  if (opts.viewerIsOwner && !hideOwnerPrivate && !isProtected) {
    rows.push(controls);
  } else {
    rows.push([controls[0]]);
    // Hidden controls say WHY instead of silently vanishing.
    if (opts.viewerIsOwner) rows.push([style.callback('🛡 Admins can\u2019t be shielded', 'admin:noop:shieldadmin')]);
    else if (user.repos_protected) rows.push([style.callback('🛡 Repos protected by owner', 'admin:noop')]);
    else rows.push([style.callback('🛡 Shield: Owner only', 'admin:noop:shieldowner')]);
  }
  // v1.3.4-multi — 🎚️ Set Limits / 📜 History dropped from here: this
  // screen's own BBTB (bbtb.adminUserDetail) already has Limits/History
  // buttons that act on ctx.session.currentAdminTarget, which is always
  // this exact user (set in showUserDetail before this card renders) —
  // same action, two buttons, same bug fixed on Fleet Stats/Bulk Hub above.
  if (!hideOwnerPrivate) rows.push([style.callback('📈 Activity & pauses', `admin:mon:u:${user.telegram_id}`, style.BLUE)]);
  rows.push([style.callback('🔓 Access Log', `admin:user:${user.telegram_id}:accesslog`, style.BLUE)]);
  rows.push([
    style.callback('💬 Message', `admin:user:${user.telegram_id}:message`, style.BLUE),
    style.callback('📝 Notes', `admin:user:${user.telegram_id}:notes`, style.BLUE),
  ]);
  // v1.1.24-multi: the owner's repos/data are private from other admins.
  if (user.github_username && !hideOwnerPrivate && !opts.reposShielded) {
    rows.push([style.callback('📂 Repos', `admin:user:${user.telegram_id}:repos`, style.BLUE)]);
  }
  if (canPromote) {
    rows.push([style.callback('👑 Set Role', `admin:roles:${user.telegram_id}`, style.BLUE)]);
  }
  if (hideOwnerPrivate) {
    // no Export / Delete on the owner's card for anyone else
  } else if (isProtected) {
    rows.push([style.callback('📤 Export Data', `admin:user:${user.telegram_id}:export`, style.BLUE)]);
  } else if (opts.canDelete) {
    rows.push([
      style.callback('📤 Export Data', `admin:user:${user.telegram_id}:export`, style.BLUE),
      style.callback('🗑️ Delete', `admin:user:${user.telegram_id}:askdelete`, style.RED),
    ]);
  } else {
    // Deleting an account is super_admin only, so other roles just get the export.
    rows.push([style.callback('📤 Export Data', `admin:user:${user.telegram_id}:export`, style.BLUE)]);
  }
  rows.push([style.callback('⬅️ Users', 'admin:users:all:1', style.BLUE), style.callback('🛡️ Admin', 'admin:dashboard', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** 🎚️ Set Limits sub-screen — three preset rows (zip / file / hourly cap)
 * plus a per-field Clear, and a way back to the user's card. Presets
 * only, deliberately no free-text amount entry — consistent with how the
 * rest of the dashboard avoids typed numeric input wherever a handful of
 * sane choices covers it. */
function adminLimitsMenu(targetId) {
  return Markup.inlineKeyboard([
    [
      style.callback('📦 1MB', `admin:user:${targetId}:setlimit:zip:1mb`),
      style.callback('5MB', `admin:user:${targetId}:setlimit:zip:5mb`),
      style.callback('20MB', `admin:user:${targetId}:setlimit:zip:20mb`),
      style.callback('Clear', `admin:user:${targetId}:setlimit:zip:clear`, style.GREEN),
    ],
    [
      style.callback('📄 1MB', `admin:user:${targetId}:setlimit:file:1mb`),
      style.callback('5MB', `admin:user:${targetId}:setlimit:file:5mb`),
      style.callback('20MB', `admin:user:${targetId}:setlimit:file:20mb`),
      style.callback('Clear', `admin:user:${targetId}:setlimit:file:clear`, style.GREEN),
    ],
    [
      style.callback('⏱️ 50/hr', `admin:user:${targetId}:setlimit:cap:50`),
      style.callback('200/hr', `admin:user:${targetId}:setlimit:cap:200`),
      style.callback('Unlimited', `admin:user:${targetId}:setlimit:cap:unlimited`),
      style.callback('Clear', `admin:user:${targetId}:setlimit:cap:clear`, style.GREEN),
    ],
    [style.callback('⬅️ Back to User', `admin:user:${targetId}`, style.BLUE)],
  ]);
}

/** Generic Yes/Cancel confirm for any admin:*:<action> destructive step —
 * reuses lib/confirmFlow's resolveConfirmation guarantee like every other
 * confirm screen in the bot. */
/** ⏳ Ban duration picker — 7d/30d/Permanent, same shape Suspend's own
 * 24h/7d choice already uses. */
function adminBanDurationMenu(targetId) {
  return Markup.inlineKeyboard([
    [
      style.callback('7 days', `admin:user:${targetId}:banduration:7`, style.BLUE),
      style.callback('30 days', `admin:user:${targetId}:banduration:30`, style.BLUE),
    ],
    [style.callback('Permanent', `admin:user:${targetId}:banduration:0`, style.RED)],
  ]);
}

/** 📁 Repo detail — link, size, license, branch, last push are all
 * shown as TEXT above this keyboard (see handlers/admin.js's
 * showRepoDetail), never truncated into the button itself, so the full
 * "owner/repo" identity is always visible before any of these buttons
 * can be tapped — the confirmation-with-full-name requirement applies
 * to the card this keyboard sits under, not just the follow-up confirm
 * screens each button leads to. */
function adminRepoDetail(targetId, index, repo) {
  return Markup.inlineKeyboard([
    [style.callback('⬇️ Download ZIP', `admin:repos:${targetId}:dl:${index}`, style.BLUE)],
    [style.callback(repo.private ? '🌐 Make Public' : '🔒 Make Private', `admin:repos:${targetId}:vis:${index}:ask`, style.BLUE)],
    [style.callback('⚖️ Change License', `admin:repos:${targetId}:lic:${index}:ask`, style.BLUE)],
    [style.callback('🗑️ Delete Repo', `admin:repos:${targetId}:del:${index}:ask`, style.RED)],
    [style.callback('⬅️ Back to Repos', `admin:repos:${targetId}`, style.BLUE)],
  ]);
}

/** ⚖️ License picker — same four options createRepo's own license
 * template step already offers, kept identical rather than inventing a
 * second curated list. */
function adminRepoLicenseMenu(targetId, index) {
  const LICENSES = [['mit', 'MIT'], ['apache-2.0', 'Apache 2.0'], ['gpl-3.0', 'GPL v3'], ['bsd-3-clause', 'BSD']];
  const rows = LICENSES.map(([key, label]) => [style.callback(label, `admin:repos:${targetId}:lic:${index}:execute:${key}`, style.BLUE)]);
  rows.push([style.callback('❌ Cancel', `admin:repos:${targetId}:open:${index}`, style.GREEN)]);
  return Markup.inlineKeyboard(rows);
}

/** 👑 Admins list — every ADMIN_IDS member with their current role.
 * Change/revoke buttons only render for the viewer if they themselves
 * are a super_admin (handlers/admin.js checks before calling this with
 * `canManage: true`) — everyone else sees the same list as pure
 * information, matching your "guest can view Users" precedent applied
 * to the admin roster itself. */
function adminAdminsList(admins, canManage) {
  const ROLE_ICON = { super_admin: '👑', admin: '🛡️', moderator: '🔧', guest: '👁️' };
  const rows = admins.map((a) => {
    const who = a.telegram_username ? `@${a.telegram_username}` : (a.telegram_first_name || `#${a.telegram_id}`);
    const isOwner = Number(a.telegram_id) === config.OWNER_ID;
    const label = isOwner
      ? `🏆 ${who} — OWNER`
      : `${ROLE_ICON[a.role] || '•'} ${who} — ${a.role.replace('_', ' ')}`;
    // Owner rows never open the role menu, for anyone — askChangeRole
    // would refuse anyway, but not even offering the tap is clearer than
    // a tap that goes nowhere.
    return (canManage && !isOwner)
      ? [style.callback(label, `admin:roles:${a.telegram_id}`, style.BLUE)]
      : [style.callback(label, 'admin:noop', style.BLUE)];
  });
  rows.push([style.callback('⬅️ Back to People', 'admin:people', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

const RANK_ORDER = { guest: 0, moderator: 1, admin: 2, super_admin: 3 };

/** Promote/demote explicitly labeled per-option (not just a flat "Set:"
 * list) so the direction of each tap is obvious without having to
 * remember the tier order — a demote-to-guest button reads as
 * "⬇️ Demote to Guest" in red, a promote reads as "⬆️ Promote to Admin"
 * in blue, right there on the button itself.
 *
 * 🗑️ Revoke Completely is deliberately separate from the four Set
 * options above it — "demote to Guest" and "revoke" are NOT the same
 * action (see lib/roles.js's revokeRole comment): Guest still has a
 * role row, still shows up in this list, still gets Dashboard view
 * access. Revoke removes the row entirely, making them an ordinary user
 * with no trace of ever having had Dashboard standing. */
function adminRoleMenu(targetId, currentRole) {
  const ROLES = [['guest', '👁️ Guest'], ['moderator', '🔧 Moderator'], ['admin', '🛡️ Admin'], ['super_admin', '👑 Super Admin']];
  const currentRank = RANK_ORDER[currentRole] ?? 0;
  const rows = ROLES.filter(([key]) => key !== currentRole)
    .map(([key, label]) => {
      const isPromote = RANK_ORDER[key] > currentRank;
      const text = `${isPromote ? '⬆️ Promote to' : '⬇️ Demote to'} ${label}`;
      return [style.callback(text, `admin:roles:${targetId}:set:${key}`, isPromote ? style.BLUE : style.RED)];
    });
  rows.push([style.callback('🗑️ Revoke Completely (Normal User)', `admin:roles:${targetId}:revoke`, style.RED)]);
  rows.push([style.callback('⬅️ Back to Admins', 'admin:roles', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function adminConfirm(confirmData, label) {
  return Markup.inlineKeyboard([
    [style.callback(`✅ Yes, ${label}`, confirmData, style.RED)],
    [style.callback('❌ Cancel', 'admin:confirm:cancel', style.GREEN)],
  ]);
}

/** ↩️ Undo — attached as its own follow-up message right after a
 * ban/suspend/bulk-suspend/bulk-mute confirmation, per the 1-hour window
 * recorded in admin_undo_log. A separate message (not appended to the
 * "✅ Banned" confirmation itself) so it survives that confirmation
 * getting edited/replaced elsewhere without dragging the undo option
 * along or losing it. */
function adminUndoButton(undoId) {
  return Markup.inlineKeyboard([[style.callback('↩️ Undo', `admin:undo:${undoId}`, style.BLUE)]]);
}

/** 📂 Repo moderation list — each repo its own row with a 🗑️ delete
 * action. Deliberately no pagination: this mirrors what the target's own
 * My Repos would show them, and moderation lists in practice are
 * skimmed, not paged through — if that stops being true at real scale,
 * this is the spot to add it. Repo identity for the delete tap is by
 * INDEX into the list ctx.session.adminRepoList caches (see
 * handlers/admin.js's showUserRepos), not the name itself — keeps
 * callback_data short and avoids ever putting a repo name through
 * Telegram's 64-byte callback_data ceiling. */
function adminUserRepos(targetId, repos, { multi = false } = {}) {
  const rows = repos.map((r, i) => [
    style.callback(`${r.private ? '🔒' : '🌐'} ${r.name}`, `admin:repos:${targetId}:open:${i}`, style.BLUE),
    style.callback('🗑️', `admin:repos:${targetId}:del:${i}:ask`, style.RED),
  ]);
  // v1.2.5-multi: a person with several GitHub accounts can be viewed one account at a time.
  if (multi) rows.push([style.callback('👤 Switch account', `admin:repos:${targetId}:pick`, style.BLUE)]);
  rows.push([style.callback('⬅️ Back to User', `admin:user:${targetId}`, style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** v1.2.5-multi: "which of this person's GitHub accounts?" — one button per account (index into the list the
 * handler cached in the session), so callback data never carries a login. */
function adminAccountPicker(targetId, accountsView) {
  const rows = accountsView.map((a, i) => {
    const mark = a.health === 'revoked' ? '⚠️' : (a.active ? '🟢' : '⚪');
    return [style.callback(`${mark} @${a.login}${a.active ? ' (active)' : ''}`, `admin:repos:${targetId}:acct:${i}`, style.BLUE)];
  });
  rows.push([style.callback('⬅️ Back to User', `admin:user:${targetId}`, style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function adminBackTo(target) {
  return Markup.inlineKeyboard([[style.callback('⬅️ Back', target, style.BLUE)]]);
}

function adminErrorFeedPagination(page, totalPages) {
  const nav = [];
  if (page > 1) nav.push(style.callback('⬅️ Prev', `admin:errors:${page - 1}`, style.BLUE));
  if (page < totalPages) nav.push(style.callback('Next ➡️', `admin:errors:${page + 1}`, style.BLUE));
  const rows = [];
  if (nav.length) rows.push(nav);
  rows.push([style.callback('⬅️ Back', 'admin:fleet', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** Fleet-wide Audit Log OR a per-user History (when `targetTelegramId` is
 * set) share this one pagination builder — same page/prev/next shape,
 * just a different callback prefix and a different "back" destination. */
function adminAuditPagination(page, totalPages, backTarget, targetTelegramId, filterActive = false) {
  const prefix = targetTelegramId ? `admin:user:${targetTelegramId}:history` : 'admin:audit';
  const nav = [];
  if (page > 1) nav.push(style.callback('⬅️ Prev', `${prefix}:${page - 1}`, style.BLUE));
  if (page < totalPages) nav.push(style.callback('Next ➡️', `${prefix}:${page + 1}`, style.BLUE));
  const rows = [];
  if (nav.length) rows.push(nav);
  // Filter is only offered on the fleet-wide log — the per-user History
  // card is already scoped to one person, so a further "filter by user"
  // control there would be filtering something that's already filtered.
  if (!targetTelegramId) rows.push([style.callback(`🔍 Filter${filterActive ? ' •' : ''}`, 'admin:audit:filter', style.BLUE)]);
  rows.push([style.callback('⬅️ Back', backTarget, style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** 🔍 Audit Log filter picker — action-type row(s) built dynamically from
 * whatever's actually in the log (adminStats.distinctAuditActions,
 * never a hardcoded list that could drift), admin row(s) the same way.
 * ✅ marks whichever is currently active; tapping an already-active one
 * again is how you clear just that one filter (see handlers/admin.js's
 * setAuditFilter toggle logic). */
function adminAuditFilterMenu(actions, admins, current) {
  const rows = [];
  const actionButtons = actions.map((a) => style.callback(
    `${current.actionType === a ? '✅ ' : ''}${a}`, `admin:audit:filter:action:${a}`, style.BLUE
  ));
  for (let i = 0; i < actionButtons.length; i += 2) rows.push(actionButtons.slice(i, i + 2));
  for (const a of admins) {
    const label = a.telegram_username ? `@${a.telegram_username}` : (a.telegram_first_name || `#${a.admin_id}`);
    rows.push([style.callback(`${current.adminId === a.admin_id ? '✅ ' : ''}${label}`, `admin:audit:filter:admin:${a.admin_id}`, style.BLUE)]);
  }
  if (current.actionType || current.adminId) rows.push([style.callback('🗑️ Clear Filters', 'admin:audit:filter:clear', style.GREEN)]);
  rows.push([style.callback('⬅️ Back to Log', 'admin:audit:1', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** 📢 Broadcast — Send Now vs Schedule, offered right after the preview
 * (adminConfirm's plain Yes/Cancel wasn't enough once "when" became a
 * real choice, not just "immediately or not at all"). */
function adminBroadcastWhen() {
  return Markup.inlineKeyboard([
    [style.callback('🚀 Send Now', 'admin:broadcast:send', style.RED)],
    [style.callback('⏰ Schedule for Later', 'admin:broadcast:schedule', style.BLUE)],
    [style.callback('❌ Cancel', 'admin:confirm:cancel', style.GREEN)],
  ]);
}

/** v1.1.8: recurrence choice for a scheduled broadcast — 'once' is the
 * pre-existing, unchanged behavior; Daily/Weekly are new. */
function adminBroadcastRecurrenceMenu() {
  return Markup.inlineKeyboard([
    [style.callback('🔂 Just Once', 'admin:broadcast:recur:once', style.BLUE)],
    [style.callback('🔁 Repeat Daily', 'admin:broadcast:recur:daily', style.BLUE)],
    [style.callback('📅 Repeat Weekly', 'admin:broadcast:recur:weekly', style.BLUE)],
    [style.callback('❌ Cancel', 'admin:confirm:cancel', style.GREEN)],
  ]);
}

/** Same three presets + custom Scheduled Uploads' time-ask already uses
 * (handlers/scheduledUploads.js) — kept visually/behaviorally identical
 * rather than inventing a second "pick a future time" pattern. */
function adminBroadcastTimePresets() {
  return Markup.inlineKeyboard([
    [style.callback('In 1 hour', 'admin:broadcast:time:1h', style.BLUE)],
    [style.callback('Tomorrow 9am', 'admin:broadcast:time:tomorrow9am', style.BLUE)],
    [style.callback('⌨️ Custom', 'admin:broadcast:time:custom', style.BLUE)],
    [style.callback('❌ Cancel', 'admin:confirm:cancel', style.GREEN)],
  ]);
}

/** 📜 Broadcast History pagination — deliberately its own function
 * rather than reusing adminAuditPagination: History has no per-user
 * scope and no filter row (yet), so forcing it through the audit
 * builder's extra params would just be dead weight here. */
/** v1.1.8: now takes the actual pending/shown rows so Cancel/Repost can
 * sit right on each one instead of Cast History being view-only — and
 * upgraded to the "◀️ Prev · Page X/Y · Next ▶️" pagination style used
 * across the rest of the v1.1.8 redesign. */
function adminBroadcastHistoryPagination(page, totalPages, pending = [], rows = []) {
  const actionRows = [];
  for (const p of pending) {
    actionRows.push([style.callback(`🚫 Cancel — ${p.text.slice(0, 24)}${p.text.length > 24 ? '…' : ''}`, `admin:broadcast:cancel:${p.id}`, style.RED)]);
  }
  for (const r of rows) {
    if (r.status !== 'sent') continue; // only a successfully-sent broadcast makes sense to repost verbatim
    actionRows.push([style.callback(`🔁 Repost — ${r.text.slice(0, 24)}${r.text.length > 24 ? '…' : ''}`, `admin:broadcast:repost:${r.id}`, style.BLUE)]);
  }
  const nav = [];
  if (totalPages > 1) {
    if (page > 1) nav.push(style.callback('◀️ Prev', `admin:broadcast:history:${page - 1}`, style.BLUE));
    nav.push(style.callback(`Page ${page}/${totalPages}`, 'noop'));
    if (page < totalPages) nav.push(style.callback('Next ▶️', `admin:broadcast:history:${page + 1}`, style.BLUE));
  }
  const rowsOut = [...actionRows];
  if (nav.length) rowsOut.push(nav);
  rowsOut.push([style.callback('⬅️ Back to System', 'admin:system', style.BLUE)]);
  return Markup.inlineKeyboard(rowsOut);
}

/** 🚩 Reports list — one row per open report, tap to open the detail
 * card. Same index-cache trick as 📂 Repos (see inline.adminUserRepos)
 * isn't needed here since the id IS the short, stable identifier —
 * report rows never get reordered under the admin mid-session the way a
 * live GitHub repo list could. */
const REPORT_CAT_ICON = { bug: '🐛', abuse: '🚨', other: '❓' };

/** 🏷️ Category picker for /report — see handlers/reports.js's
 * submitReport for what happens on tap. Not admin-gated (this is the
 * user-facing half of Reports), so it lives outside the admin:* prefix
 * other Dashboard callbacks use. */
function reportCategoryMenu() {
  return Markup.inlineKeyboard([
    [
      style.callback('🐛 Bug', 'report:cat:bug', style.BLUE),
      style.callback('🚨 Abuse', 'report:cat:abuse', style.RED),
    ],
    [style.callback('❓ Other', 'report:cat:other', style.BLUE)],
  ]);
}

function adminReportsList(reports) {
  const rows = reports.map((r) => {
    const who = r.telegram_username ? `@${r.telegram_username}` : (r.telegram_first_name || `#${r.telegram_id}`);
    const preview = r.message.length > 30 ? `${r.message.slice(0, 30)}…` : r.message;
    const icon = REPORT_CAT_ICON[r.category] || '❓';
    return [style.callback(`${icon} ${who} — ${preview}`, `admin:report:${r.id}`, style.BLUE)];
  });
  rows.push([style.callback('⬅️ Back to People', 'admin:people', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function adminReportDetail(report) {
  return Markup.inlineKeyboard([
    [style.callback('👤 View User', `admin:user:${report.telegram_id}`, style.BLUE)],
    [style.callback('💬 Message User', `admin:user:${report.telegram_id}:message`, style.BLUE)],
    [
      style.callback('✅ Resolved', `admin:report:${report.id}:resolve`, style.GREEN),
      style.callback('🗑️ Dismiss', `admin:report:${report.id}:dismiss`, style.RED),
    ],
    [style.callback('⬅️ Back to Reports', 'admin:reports', style.BLUE)],
  ]);
}

/** Simple prev/next nav built from a small array of [label, data] pairs —
 * lighter-weight than the full pagination builders above since the
 * Anomaly Feed doesn't need a page-count display, just next/prev. */
function adminAnomalyFeedNav(navPairs) {
  const rows = [];
  if (navPairs.length) rows.push(navPairs.map(([label, data]) => style.callback(label, data, style.BLUE)));
  rows.push([style.callback('⬅️ Back', 'admin:fleet', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

/** ⚙️ Global Config — same preset-only pattern as the per-user Set Limits
 * menu (lib/adminActions.js's per-user version), deliberately no
 * free-text amount entry here either. */
function adminGlobalConfigMenu(notifyEnabled = false, signupsPaused = false) {
  return Markup.inlineKeyboard([
    [
      style.callback('📦 1MB', 'admin:config:zip:1mb'),
      style.callback('5MB', 'admin:config:zip:5mb'),
      style.callback('20MB', 'admin:config:zip:20mb'),
      style.callback('Clear', 'admin:config:zip:clear', style.GREEN),
    ],
    [
      style.callback('📄 1MB', 'admin:config:file:1mb'),
      style.callback('5MB', 'admin:config:file:5mb'),
      style.callback('20MB', 'admin:config:file:20mb'),
      style.callback('Clear', 'admin:config:file:clear', style.GREEN),
    ],
    [
      style.callback('⏱️ 50/hr', 'admin:config:cap:50'),
      style.callback('200/hr', 'admin:config:cap:200'),
      style.callback('Unlimited', 'admin:config:cap:unlimited'),
      style.callback('Clear', 'admin:config:cap:clear', style.GREEN),
    ],
    [style.callback(`🔔 Notify Users on Repo Moderation: ${notifyEnabled ? 'ON' : 'OFF'}`, 'admin:config:notify:toggle', style.BLUE)],
    // v1.1.8 additions — 3-per-row where a preset picker fits it, same
    // compact style just introduced for pagination rows elsewhere.
    [
      style.callback('🗑️ 7d', 'admin:config:trash:7'),
      style.callback('30d', 'admin:config:trash:30'),
      style.callback('90d', 'admin:config:trash:90'),
    ],
    [
      style.callback('🔑 1h', 'admin:config:sessionttl:1h'),
      style.callback('6h', 'admin:config:sessionttl:6h'),
      style.callback('24h', 'admin:config:sessionttl:24h'),
    ],
    [
      style.callback('📜 30d', 'admin:config:logretention:30'),
      style.callback('90d', 'admin:config:logretention:90'),
      style.callback('180d', 'admin:config:logretention:180'),
    ],
    [
      style.callback('🗜️ 5MB', 'admin:config:archivezip:5mb'),
      style.callback('15MB', 'admin:config:archivezip:15mb'),
      style.callback('50MB', 'admin:config:archivezip:50mb'),
    ],
    [
      style.callback('🗂️ 50 files', 'admin:config:archivefiles:50'),
      style.callback('200', 'admin:config:archivefiles:200'),
      style.callback('1000', 'admin:config:archivefiles:1000'),
    ],
    [
      style.callback('📨 30s', 'admin:config:digest:30s'),
      style.callback('2min', 'admin:config:digest:2min'),
      style.callback('5min', 'admin:config:digest:5min'),
    ],
    [style.callback(`🚦 New Signups: ${signupsPaused ? '⏸️ Paused — tap to resume' : '✅ Open — tap to pause'}`, 'admin:config:signups:toggle', signupsPaused ? style.RED : style.BLUE)],
    [style.callback('🧩 Feature Switches', 'admin:features', style.BLUE)],
    [style.callback('⬅️ Back to System', 'admin:system', style.BLUE)],
  ]);
}

function adminPurgeDaysMenu() {
  return Markup.inlineKeyboard([
    [
      style.callback('7d', 'admin:purge:7:ask'),
      style.callback('30d', 'admin:purge:30:ask'),
      style.callback('90d', 'admin:purge:90:ask'),
      style.callback('Never', 'admin:purge:never:ask', style.RED),
    ],
    [style.callback('⌨️ Custom', 'admin:purge:custom:ask')],
  ]);
}

/** 🗂️ Bulk Actions hub — one row per operation, each opening its own
 * scoped ask/confirm flow rather than confirming straight from here. */
function adminBulkHubMenu() {
  return Markup.inlineKeyboard([
    [style.callback('🧹 Purge Never-Connected', 'admin:purge:ask', style.BLUE)],
    [style.callback('⏸️ Bulk Suspend', 'admin:bulksuspend:ask', style.BLUE)],
    [style.callback('🔇 Bulk Mute', 'admin:bulkmute:ask', style.BLUE)],
    [style.callback('📣 Nudge Never-Connected', 'admin:nudge:ask', style.BLUE)],
    [style.callback('📤 Bulk Export All', 'admin:exportall', style.BLUE)],
    [style.callback('🗑️ Delete Banned', 'admin:bulkdeleteban:ask', style.RED)],
    [style.callback('⬆️ Back to Admin', 'admin:dashboard', style.BLUE)],
  ]);
}

function adminBulkSuspendScopeMenu() {
  return Markup.inlineKeyboard([
    [style.callback('Everyone stale 30d+', 'admin:bulksuspend:scope:stale', style.BLUE)],
    [style.callback('EVERY non-banned user', 'admin:bulksuspend:scope:all', style.RED)],
  ]);
}

function adminBulkSuspendHoursMenu(scope) {
  return Markup.inlineKeyboard([
    [
      style.callback('24h', `admin:bulksuspend:${scope}:24:ask`),
      style.callback('7d', `admin:bulksuspend:${scope}:168:ask`),
    ],
    [style.callback('⌨️ Custom', `admin:bulksuspend:${scope}:custom:ask`)],
  ]);
}

function adminBulkMuteMenu() {
  return Markup.inlineKeyboard([
    [style.callback('🔇 Mute All', 'admin:bulkmute:mute:ask', style.RED)],
    [style.callback('🔊 Unmute All', 'admin:bulkmute:unmute:ask', style.BLUE)],
  ]);
}

/** Search results share the exact same tappable-row shape as the Users
 * list, minus filters/pagination — a handful of matches doesn't need
 * either. */
function adminSearchResults(rows) {
  const userRows = rows.map((u) => {
    const label = u.telegram_username ? `@${u.telegram_username}` : (u.telegram_first_name || `#${u.telegram_id}`);
    const badge = u.is_blocked ? '🚫 ' : (u.suspended_until && new Date(u.suspended_until) > new Date() ? '⏸️ ' : '');
    return [style.callback(`${badge}${label}`, `admin:user:${u.telegram_id}`, style.BLUE)];
  });
  return Markup.inlineKeyboard([...userRows, [style.callback('⬅️ Back to Users', 'admin:users:all:1', style.BLUE)]]);
}

// ─── ❓ Help ─────────────────────────────────────────────────────────
// v1.3.1-multi — deliberately no "Admin Dashboard" entry here, even
// gated to admins-only. Admins already have a permanent, always-visible
// 🛡️ Admin button on the main BBTB menu — mixing admin content into the
// general-audience /help screen (even correctly gated) added confusion
// with no actual benefit, so it doesn't live here at all.
/** entries: [{ id, title }] from handlers/help.js — two per row, then FAQ / Contact / Legal. */
function helpMenu(entries, footer) {
  const rows = [];
  for (let i = 0; i < entries.length; i += 2) {
    rows.push(entries.slice(i, i + 2).map((e) => style.callback(e.title, `help:topic:${e.id}`)));
  }
  rows.push([style.callback('❓ FAQ', 'help:faq'), style.callback('📞 Contact Admin', 'help:contact')]);
  rows.push([style.callback('📜 Legal', 'legal:index')]);
  if (footer) rows.push(footer);
  return Markup.inlineKeyboard(rows);
}

/** Prev / Next across the pages of one Help topic or of the FAQ, plus a way back to the Help menu. */
function helpPageMenu(prefix, page, total, footer) {
  const nav = [];
  if (page > 0) nav.push(style.callback('⬅️ Prev', `${prefix}:${page - 1}`, style.BLUE));
  if (page < total - 1) nav.push(style.callback('Next ➡️', `${prefix}:${page + 1}`, style.BLUE));
  const rows = [];
  if (nav.length) rows.push(nav);
  rows.push(footer || [style.callback('⬅️ Back to Help', 'help:menu', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function helpBackTo() {
  return Markup.inlineKeyboard([[style.callback('⬅️ Back to Help', 'help:menu', style.BLUE)]]);
}

/** v1.1.8: 📞 Contact Admin gets its own keyboard — a tappable Report
 * button right where someone is already reading "how do I reach
 * someone," instead of making them remember to type /report separately
 * after reading this screen. */
function helpContactMenu(footer) {
  return Markup.inlineKeyboard([
    [style.callback('🚩 Report a Problem', 'help:report')],
    footer || [style.callback('⬅️ Back to Help', 'help:menu', style.BLUE)],
  ]);
}

/** Help → 🔗 Account Connection. `url` is a fresh per-person OAuth
 * authorize link (oauth.buildAuthorizeUrl, 10-minute-lived state token)
 * — only included when the viewer isn't already connected, same
 * reasoning as the plain connectButton() above: no point offering to
 * (re)connect an account that's already linked. */
function helpConnectMenu(url, footer) {
  const rows = [];
  if (url) rows.push([Markup.button.url('🔗 Connect GitHub Account', url)]);
  rows.push(footer || [style.callback('⬅️ Back to Help', 'help:menu', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

// ─── 📜 Legal ────────────────────────────────────────────────────────
/** Index screen — every section listed as its own button, per the
 * request that sections be "listed as buttons that paginate too": the
 * index gives direct jump-to-any-section access, and once inside a
 * section Prev/Next step sequentially without going back through the
 * index each time. */
/** entries: [{ title, index }] — one per section, `index` being the section's FIRST page (a long section spans several pages). */
function legalIndexMenu(entries, footer) {
  const rows = entries.map((e) => [style.callback(e.title, `legal:section:${e.index}`)]);
  rows.push(footer || [style.callback('⬅️ Back to Help', 'help:menu', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

function legalSectionMenu(index, total, footer) {
  const nav = [];
  if (index > 0) nav.push(style.callback('⬅️ Prev', `legal:section:${index - 1}`, style.BLUE));
  if (index < total - 1) nav.push(style.callback('Next ➡️', `legal:section:${index + 1}`, style.BLUE));
  const rows = [];
  if (nav.length) rows.push(nav);
  rows.push(footer || [style.callback('📜 Index', 'legal:index'), style.callback('⬅️ Help', 'help:menu', style.BLUE)]);
  return Markup.inlineKeyboard(rows);
}

module.exports = {
  repoButtonLabel,
  shortName,
  repoList,
  filterMenu,
  sortMenu,
  repoActions,
  repoMore,
  deleteRepoConfirm,
  visibilityConfirm,
  createRepoSuccess,
  fileTree,
  fileActions,
  filePreviewFallback,
  deleteFileConfirm,
  forkConfirm,
  notificationsMenu,
  disconnectConfirm,
  disconnectAllConfirm,
  connectButton,
  activityPagination,
  searchTypeMenu,
  autoTagRulesMenu,
  ruleFieldMenu,
  ruleVisibilityMenu,
  ruleForkMenu,
  autoTagSuggestion,
  muteRulesMenu,
  muteRuleFieldMenu,
  muteRuleVisibilityMenu,
  muteRuleForkMenu,
  backupRulesMenu,
  backupRuleFieldMenu,
  backupRuleVisibilityMenu,
  backupRuleForkMenu,
  staleReposMenu,
  automationLogPagination,
  exportImportMenu,
  importConfirm,
  rulesHubMenu,
  automationHubActions,
  scheduleHubMenu,
  adminDashboardActions,
  adminPeopleHubMenu,
  adminOversightHubMenu,
  adminOpsHubMenu,
  githubTrafficMenu,
  adminBroadcastHubMenu,

  // ─── 🤖 Warden ───────────────────────────────────────────────────────
  wardenMainMenu,
  wardenActionLogPagination,
  wardenBoardList, wardenCaseCard, wardenWarnPreview, wardenEnforcementGate, wardenBackToCase,
  wardenExportMenu, wardenShieldMenu, wardenShieldConfirm, BOARD_FILTERS,
  adminLockdownMenu,
  adminTargetedLockdownList,
  adminFleetActions,
  adminNextRow,
  adminUsersList,
  adminUserDetail,
  adminLimitsMenu,
  adminConfirm,
  adminBackTo,
  adminBanDurationMenu,
  adminUndoButton,
  adminUserRepos,
  adminAccountPicker,
  adminRepoDetail,
  adminRepoLicenseMenu,
  adminAdminsList,
  adminRoleMenu,
  adminAuditFilterMenu,
  adminBroadcastWhen,
  adminBroadcastRecurrenceMenu,
  adminBroadcastTimePresets,
  adminBroadcastHistoryPagination,
  adminReportsList,
  adminReportDetail,
  reportCategoryMenu,
  adminErrorFeedPagination,
  adminAuditPagination,
  adminPurgeDaysMenu,
  adminBulkHubMenu,
  adminBulkSuspendScopeMenu,
  adminBulkSuspendHoursMenu,
  adminBulkMuteMenu,
  adminSearchResults,
  adminAnomalyFeedNav,
  adminGlobalConfigMenu,
  adminMaintenanceMenu,
  helpMenu,
  helpPageMenu,
  helpBackTo,
  helpContactMenu,
  helpConnectMenu,
  legalIndexMenu,
  legalSectionMenu,
};
