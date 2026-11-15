const { Scenes, Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const github = require('../lib/github');
const repoCache = require('../lib/repoCache');
const requireConnected = require('../lib/requireConnected');
const format = require('../lib/format');
const activity = require('../lib/activity');
const ephemeral = require('../lib/ephemeral');
const chrome = require('../lib/chrome');
const resultCard = require('../lib/resultCard');
const esc = format.escapeMd;

async function cancelled(ctx) {
  await ephemeral.sendEphemeral(ctx, '❌ Rename cancelled', {}, 1800);
  await chrome.returnFromTyping(ctx);
}

const scene = new Scenes.WizardScene(
  'renameRepo',

  async (ctx) => {
    ctx.wizard.state.oldName = ctx.wizard.state.oldName || ctx.scene.state.repoName;
    await chrome.setBar(ctx, 'cancel', { title: `✏️ Rename ${ctx.wizard.state.oldName} — send the new name`, force: true });
    return ctx.wizard.next();
  },

  async (ctx) => {
    if (ctx.message && ctx.message.text === '❌ Cancel') {
      await cancelled(ctx);
      return ctx.scene.leave();
    }
    if (!ctx.message || !ctx.message.text) {
      await ctx.reply('Send the new name as text, or ❌ Cancel.');
      return;
    }
    const nameCheck = require('../lib/repoName').validateRepoName(ctx.message.text);
    if (!nameCheck.ok) {
      await ctx.reply(format.errorMessage('Invalid repo name', nameCheck.error, 'Send a different name, or ❌ Cancel.'));
      return;
    }
    const newName = nameCheck.name;
    if (newName === ctx.wizard.state.oldName) {
      await ctx.reply('That\u2019s already the repo\u2019s name — send a different one, or ❌ Cancel.');
      return;
    }
    ctx.wizard.state.newName = newName;

    await ctx.reply(
      `✏️ *Rename repository?*\n\n>${esc(ctx.wizard.state.oldName)}  →  *${esc(newName)}*\n\n` +
      `⚠️ ${esc('Old links and clones redirect automatically, but git remotes you set up elsewhere won\u2019t update on their own.')}`,
      { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[style.callback('✅ Rename', 'rename:confirm', style.GREEN)]]) }
    );
    return ctx.wizard.next();
  },

  async (ctx) => {
    if (ctx.message && ctx.message.text === '❌ Cancel') {
      await cancelled(ctx);
      return ctx.scene.leave();
    }
    if (!ctx.callbackQuery) {
      await ctx.reply('Tap ✅ Rename above, or ❌ Cancel.');
      return;
    }
    await ctx.answerCbQuery();

    if (ctx.callbackQuery.data === 'rename:cancel') {
      await cancelled(ctx);
      return ctx.scene.leave();
    }
    if (ctx.callbackQuery.data !== 'rename:confirm') {
      // Stray/stale callback from an unrelated old message — don't treat
      // it as a rename confirmation.
      await ctx.reply('Tap ✅ Rename above, or ❌ Cancel.');
      return;
    }

    const token = await requireConnected(ctx);
    if (!token) return ctx.scene.leave();

    const { oldName, newName } = ctx.wizard.state;
    const actionLock = require('../lib/actionLock');
    const { skipped } = await actionLock.withLock(ctx.from.id, 'renameRepo', async () => {
    try {
      const user = await repoCache.getUser(ctx.from.id, token);
      const repo = await github.renameRepo(token, user.login, oldName, newName);
      repoCache.invalidateRepos(ctx.from.id);
      repoCache.invalidateLanguages(ctx.from.id, oldName);
      repoCache.invalidateTreeStats(ctx.from.id, oldName);
      // If the repo just renamed was the one "open" in Repo View, keep
      // session state pointing at it under its new name — otherwise every
      // BBTB action that reads ctx.session.currentRepo (Upload, Browse
      // Files, Download, Visibility, License, ...) would keep targeting a
      // name that no longer exists until the person reopens it manually.
      if (ctx.session.currentRepo === oldName) ctx.session.currentRepo = repo.name;
      // Keeps tags/pins/path-memory/mutes/webhooks bound to the repo
      // through the rename instead of staying keyed to the old name —
      // see renameCascade.js.
      try {
        const renameCascade = require('../lib/renameCascade');
        await renameCascade.cascadeRename(ctx.from.id, oldName, repo.name); // GitHub's returned name is the source of truth
      } catch (cascadeErr) {
        // GitHub's side already succeeded — never fail the whole rename over
        // this, but make sure it's loud in the logs and in Activity.
        await activity.log(ctx.from.id, '⚠️', `Rename cascade incomplete → ${oldName} → ${repo.name}`, { detail: cascadeErr.message, isError: true });
      }
      await activity.log(ctx.from.id, '✏️', `Renamed → ${oldName} → ${newName}`);
      await resultCard.send(ctx, { title: 'Repository renamed', subject: `📦 *${esc(repo.name)}*`, details: [`${oldName} → ${repo.name}`], link: repo.html_url },
        [[style.callback('📂 Open repo', `repo:open:${repo.name}`, style.BLUE)]]);
    } catch (err) {
      await activity.log(ctx.from.id, '⚠️', `Rename failed → ${oldName}`, { detail: err.message, isError: true });
      const errorHelpers = require('../lib/errorHelpers');
      if (errorHelpers.isAuthError(err) || github.isUnknownOutcome(err)) {
        // (an unconfirmed rename gets the truthful "GitHub did not confirm" reply, not "choose a different name")
        await errorHelpers.replyGithubError(ctx, err, 'Rename failed');
      } else {
        const reason = errorHelpers.isNameCollisionError(err)
          ? `"${newName}" is already taken by another repo on your account`
          : err.message;
        await ctx.reply(format.errorMessage('Rename failed', reason, 'Choose a different name.'));
      }
    }
    });
    if (skipped) await ctx.reply('⏳ Already renaming — please wait a moment.');
    return ctx.scene.leave();
  }
);

module.exports = scene;
