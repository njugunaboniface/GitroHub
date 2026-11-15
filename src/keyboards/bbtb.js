/**
 * BBTB = "Buttons Below the Typing Bar" = Telegram reply keyboards (v2.0.0-multi).
 *
 * Every bottom bar is defined once, in lib/chrome.js (BARS): never more than two rows of two, ⬅️ Back always last, and
 * the 2×2 Home bar shown only on /start and Home. This file is the compatibility layer that older call sites use
 * (`bbtb.mainMenuFor(...)`, `bbtb.cancelOnly`, …): each export now simply points at the right bar.
 *
 * Rules that shaped the bars:
 *   • navigation is always the last row (⬅️ Back); no 🏠 Home button on inner pages;
 *   • a typing prompt shows ❌ Cancel (plus ⏭️ Skip where skipping makes sense), never a menu;
 *   • content actions live on the inline message, not the bar, unless they are the page's main verbs.
 */
const chrome = require('../lib/chrome');

const bar = (id) => chrome.keyboardFor(id);

const mainMenu = bar('home');
const mainMenuAdmin = mainMenu;
const mainMenuFor = () => mainMenu; // same for everyone — Admin lives in ⚙️ Settings (admins only)

const disconnected = bar('disconnected');
const disconnectedAdmin = bar('disconnectedAdmin');
const disconnectedFor = (isAdmin) => (isAdmin ? disconnectedAdmin : disconnected);

/** The ONE place that decides which main keyboard a person gets: connected or not. */
const menuFor = (connected, isAdmin = false) => (connected ? mainMenu : disconnectedFor(isAdmin));

// Page bars
const myRepos = bar('repos');
const repoView = bar('repo');
const browseFiles = bar('files');
const settings = bar('settings');

// Typing prompts
const cancelOnly = bar('cancel');
const cancelWithSkip = bar('typingSkip');
const cancelWithBack = bar('typingBack');

// Everything else is an inner page: just ⬅️ Back.
const back = bar('back');
const uploadSummary = back;
const searchAgain = back;
const activityLog = back;
const pinned = back;
const bulkComplete = back;
const backToSettings = back;
const backToAutomation = back;
const automation = back;
const automationScheduleHub = back;
const automationScheduleSub = back;
const automationRulesHub = back;
const automationRulesSub = back;
const automationBackupRules = back;
const bulkSelect = bar('typingBack');
const bulkActionMenu = back;

// Admin screens are inline-only; their old bottom keyboards are now the plain Back bar.
const adminDashboard = back;
const adminDashboardOwner = back;
const adminPeopleHub = back;
const adminOversightHub = back;
const adminOpsHub = back;
const adminBroadcastHub = back;
const adminUsersList = back;
const adminUserDetail = back;
const adminFleetStats = back;
const adminBulkHub = back;
const adminAuditLog = back;
const adminGlobalConfig = back;
const adminMaintenance = back;

// Admin typing prompts
const adminBroadcastCompose = cancelOnly;
const adminBanReasonCompose = cancelWithSkip;
const adminNotesCompose = cancelOnly;
const adminMessageCompose = cancelOnly;

const remove = require('telegraf').Markup.removeKeyboard();

module.exports = {
  mainMenu, mainMenuAdmin, mainMenuFor,
  adminDashboard, adminDashboardOwner, adminPeopleHub, adminOversightHub, adminOpsHub, adminBroadcastHub, adminUsersList,
  adminUserDetail, adminFleetStats, adminBulkHub, adminAuditLog, adminGlobalConfig, adminMaintenance,
  adminBroadcastCompose, adminBanReasonCompose, adminNotesCompose, adminMessageCompose,
  myRepos, repoView, browseFiles, settings, cancelOnly, cancelWithSkip, cancelWithBack, uploadSummary, searchAgain,
  activityLog, disconnected, disconnectedAdmin, disconnectedFor, menuFor, pinned, bulkSelect, bulkActionMenu, bulkComplete,
  backToSettings, backToAutomation, automation, automationScheduleHub, automationScheduleSub, automationRulesHub,
  automationRulesSub, automationBackupRules, back, remove,
};
