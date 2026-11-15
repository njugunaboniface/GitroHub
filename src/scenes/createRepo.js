/**
 * ➕ New Repo (v2.0.0-multi) — one setup card instead of six questions.
 *
 *   1. "What should it be called?"  (typed — a new message at the bottom)
 *   2. ONE card with everything: visibility, README, license, .gitignore, template, description. Every row is a tap that
 *      edits the card in place (pickers swap in and back); only typing (description, a custom .gitignore, a schedule time)
 *      sends a fresh message and a fresh card at the bottom, so the chat never needs scrolling.
 *   3. ✅ Create → a permanent result card (see lib/resultCard.js); the setup card disappears.
 *
 * Bottom bar while the flow is open: ❌ Cancel / ⬅️ Back (Back = a step back: picker → card, card → rename).
 */
const { Scenes, Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const github = require('../lib/github');
const requireConnected = require('../lib/requireConnected');
const format = require('../lib/format');
const inline = require('../keyboards/inline');
const activity = require('../lib/activity');
const chrome = require('../lib/chrome');
const resultCard = require('../lib/resultCard');

const esc = format.escapeMd;
const LICENSES = [['mit', 'MIT'], ['apache-2.0', 'Apache 2.0'], ['gpl-3.0', 'GPL v3'], ['bsd-3-clause', 'BSD 3-Clause']];
const LICENSE_LABEL = Object.fromEntries(LICENSES);
const GITIGNORES = ['Node', 'Python', 'Java', 'Go', 'Rust', 'macOS'];

const scene = new Scenes.BaseScene('createRepo');

const stateOf = (ctx) => ctx.scene.state;

async function deleteQuietly(ctx, id) {
  if (id) await ctx.telegram.deleteMessage(ctx.chat.id, id).catch(() => {});
}

// ── entering ───────────────────────────────────────────────────────────────────────────────────────────────────────────
scene.enter(async (ctx) => {
  if (!(await requireConnected(ctx))) return ctx.scene.leave();
  const defaultsLib = require('../lib/defaults');
  const d = await defaultsLib.getDefaults(ctx.from.id).catch(() => null);
  Object.assign(stateOf(ctx), {
    step: 'name', data: { name: null, isPrivate: !d || d.default_visibility !== 'public', description: '', includeReadme: true, licenseTemplate: null, gitignoreTemplate: null, template: null },
    cardId: null, picker: null, awaiting: null,
  });
  await askName(ctx);
});

async function askName(ctx) {
  stateOf(ctx).step = 'name';
  await chrome.setBar(ctx, 'typingBack', { title: '📦 New repo — what should it be called?', force: true });
  await ctx.reply('Letters, numbers, hyphens, dots and underscores \\(for example *my\\-project*\\)\\.', { parse_mode: 'MarkdownV2' });
}

// ── the setup card ────────────────────────────────────────────────────────────────────────────────────────────────────
function cardText(ctx) {
  const d = stateOf(ctx).data;
  const rows = [
    `🔒 Visibility   ${d.isPrivate ? 'Private' : 'Public'}`,
    `📝 Description   ${d.description ? d.description : '—'}`,
    `📄 README   ${d.includeReadme ? 'Yes' : 'No'}`,
    `⚖️ License   ${d.licenseTemplate ? (LICENSE_LABEL[d.licenseTemplate] || d.licenseTemplate) : 'None'}`,
    `🚫 .gitignore   ${d.gitignoreTemplate || 'None'}`,
    `📋 Template   ${d.template ? templateLabel(d.template) : 'None'}`,
  ];
  return `📦 *${esc(d.name)}*  ·  _new repository_\n\n${rows.map((r) => `>${esc(r)}`).join('\n')}`;
}

function templateLabel(key) {
  const found = require('../lib/repoTemplates').listTemplates().find((t) => t.key === key);
  return found ? found.label : key;
}

function cardKeyboard(ctx) {
  const d = stateOf(ctx).data;
  return Markup.inlineKeyboard([
    [style.callback(`${d.isPrivate ? '✅ ' : ''}🔒 Private`, 'create:vis:private', d.isPrivate ? style.BLUE : undefined), style.callback(`${d.isPrivate ? '' : '✅ '}🌐 Public`, 'create:vis:public', d.isPrivate ? undefined : style.BLUE)],
    [style.callback(`📄 README ${d.includeReadme ? '✅' : '▫️'}`, 'create:readme'), style.callback('📝 Description', 'create:desc')],
    [style.callback('⚖️ License ▾', 'create:pick:license'), style.callback('🚫 .gitignore ▾', 'create:pick:gitignore')],
    [style.callback('📋 Template ▾', 'create:pick:template'), style.callback('📅 Schedule', 'create:pick:schedule')],
    [style.callback('✅ Create repository', 'create:confirm', style.GREEN)],
  ]);
}

/** Shows (or refreshes in place) the setup card. `fresh` = send it as a new message at the bottom. */
async function showCard(ctx, { fresh = false } = {}) {
  const s = stateOf(ctx);
  s.step = 'card';
  s.picker = null;
  s.awaiting = null;
  const text = cardText(ctx);
  const extra = { parse_mode: 'MarkdownV2', ...cardKeyboard(ctx) };
  if (!fresh && s.cardId && ctx.callbackQuery) {
    try { await ctx.editMessageText(text, extra); return; } catch (_) { /* fall through to a fresh card */ }
  }
  await deleteQuietly(ctx, s.cardId);
  const sent = await ctx.reply(text, extra);
  s.cardId = sent.message_id;
}

// ── pickers (tap-only: swap into the same message) ──────────────────────────────────────────────────────────────────────
function pickerView(ctx, which) {
  const d = stateOf(ctx).data;
  const choice = (label, data, on) => style.callback(`${on ? '✅ ' : ''}${label}`, data);
  if (which === 'license') {
    const rows = LICENSES.map(([key, label]) => choice(label, `create:set:license:${key}`, d.licenseTemplate === key));
    return { title: '⚖️ *Choose a license*', rows: [rows.slice(0, 2), rows.slice(2, 4), [choice('None', 'create:set:license:none', !d.licenseTemplate)]] };
  }
  if (which === 'gitignore') {
    const buttons = GITIGNORES.map((g) => choice(g, `create:set:gitignore:${g}`, d.gitignoreTemplate === g));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([style.callback('⌨️ Other (type it)', 'create:set:gitignore:custom'), choice('None', 'create:set:gitignore:none', !d.gitignoreTemplate)]);
    return { title: '🚫 *Choose a \\.gitignore*', rows };
  }
  if (which === 'template') {
    const templates = require('../lib/repoTemplates').listTemplates();
    const buttons = templates.map((t) => choice(t.label, `create:set:template:${t.key}`, d.template === t.key));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([choice('None', 'create:set:template:none', !d.template)]);
    return { title: '📋 *Start from a template?*\nA small starter file set is committed right after the repo is created\\.', rows };
  }
  if (which === 'schedule') {
    return {
      title: '📅 *When should it be created?*',
      rows: [
        [style.callback('⏱ In 1 hour', 'createrepo:schedulepick:1h'), style.callback('🌅 Tomorrow 9am', 'createrepo:schedulepick:tomorrow9am')],
        [style.callback('📆 In 3 days', 'createrepo:schedulepick:3days'), style.callback('⌨️ Custom time', 'createrepo:schedulepick:custom')],
      ],
    };
  }
  return null;
}

async function showPicker(ctx, which) {
  const view = pickerView(ctx, which);
  if (!view) return showCard(ctx);
  stateOf(ctx).picker = which;
  stateOf(ctx).step = 'picker';
  const rows = [...view.rows, [style.callback('⬅️ Back', 'create:back', style.BLUE)]];
  const extra = { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) };
  try { await ctx.editMessageText(`${view.title}\n\n_${esc(stateOf(ctx).data.name)}_`, extra); } catch (_) { await showCard(ctx, { fresh: true }); }
}

// ── typed prompts ───────────────────────────────────────────────────────────────────────────────────────────────────
async function askTyped(ctx, kind, promptText) {
  const s = stateOf(ctx);
  s.awaiting = kind;
  s.step = 'typing';
  await ctx.reply(promptText, { parse_mode: 'MarkdownV2' });
}

// ── callbacks ───────────────────────────────────────────────────────────────────────────────────────────────────────
scene.on('callback_query', async (ctx, next) => {
  const data = ctx.callbackQuery.data || '';
  const s = stateOf(ctx);
  if (!s.data) return next();
  const fromCard = ctx.callbackQuery.message && ctx.callbackQuery.message.message_id === s.cardId;
  if (!fromCard && !data.startsWith('createrepo:')) {
    await ctx.answerCbQuery('That setup is closed — tap ➕ New Repo to start again.').catch(() => {});
    return;
  }
  await ctx.answerCbQuery().catch(() => {});
  const d = s.data;

  if (data === 'create:back') return showCard(ctx);
  if (data.startsWith('create:vis:')) { d.isPrivate = data.endsWith('private'); return showCard(ctx); }
  if (data === 'create:readme') { d.includeReadme = !d.includeReadme; await ctx.answerCbQuery(d.includeReadme ? 'README on' : 'README off').catch(() => {}); return showCard(ctx); }
  if (data === 'create:desc') return askTyped(ctx, 'description', '📝 Send a short description for *' + esc(d.name) + '*, or tap ⏭️ Skip to leave it empty\\.');
  if (data.startsWith('create:pick:')) return showPicker(ctx, data.split(':')[2]);
  if (data.startsWith('create:set:')) {
    const [, , field, value] = data.split(':');
    if (field === 'license') d.licenseTemplate = value === 'none' ? null : value;
    if (field === 'template') d.template = value === 'none' ? null : value;
    if (field === 'gitignore') {
      if (value === 'custom') return askTyped(ctx, 'gitignore', '🚫 Type the \\.gitignore template name \\(e\\.g\\. *Swift*, *Ruby*\\)\\. GitHub’s list: github\\.com/github/gitignore');
      d.gitignoreTemplate = value === 'none' ? null : value;
    }
    return showCard(ctx);
  }
  if (data === 'create:confirm') return createNow(ctx);
  if (data.startsWith('createrepo:schedulepick:')) return schedulePick(ctx, data.split('createrepo:schedulepick:')[1]);
  return next();
});

// ── typed text ──────────────────────────────────────────────────────────────────────────────────────────────────────
scene.on('text', async (ctx) => {
  const text = ctx.message.text;
  const s = stateOf(ctx);
  if (!s.data) return;

  if (text === '❌ Cancel') {
    await deleteQuietly(ctx, s.cardId);
    await ctx.scene.leave();
    await require('../lib/ephemeral').sendEphemeral(ctx, '❌ Repo creation cancelled — nothing was created.', {}, 2200);
    return chrome.returnFromTyping(ctx);
  }
  if (text === '⬅️ Back') {
    if (s.step === 'picker' || s.step === 'typing') return showCard(ctx, { fresh: s.step === 'typing' });
    if (s.step === 'card') { await deleteQuietly(ctx, s.cardId); s.cardId = null; return askName(ctx); }
    return; // already at the first step
  }
  if (text === '⏭️ Skip' && s.awaiting === 'description') { s.data.description = ''; return showCard(ctx, { fresh: true }); }

  if (s.step === 'name') {
    const check = require('../lib/repoName').validateRepoName(text);
    if (!check.ok) return ctx.reply(format.errorMessage('Invalid repo name', check.error, 'Send a different name, or ❌ Cancel.'));
    s.data.name = check.name;
    return showCard(ctx, { fresh: true });
  }
  if (s.awaiting === 'description') { s.data.description = text.trim().slice(0, 350); return showCard(ctx, { fresh: true }); }
  if (s.awaiting === 'gitignore') { s.data.gitignoreTemplate = text.trim().slice(0, 40); return showCard(ctx, { fresh: true }); }
  if (s.awaiting === 'schedule') return scheduleCustom(ctx, text);
  return ctx.reply('Use the buttons on the card above, or tap ❌ Cancel.');
});

// ── scheduling ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function userTimezone(ctx) {
  const user = await require('../lib/users').getUser(ctx.from.id);
  return { user, tz: (user && user.timezone) || 'UTC' };
}

async function schedulePick(ctx, pick) {
  const timezone = require('../lib/timezone');
  const { tz } = await userTimezone(ctx);
  const now = new Date();
  let runAt = null;
  if (pick === 'custom') {
    return askTyped(ctx, 'schedule', `⌨️ Send a time in your timezone \\(${esc(tz)}\\) — *14:00* works \\(today, or tomorrow if passed\\), or add a date: *12\\-25 09:00*, or the full *2026\\-09\\-15 14:00*\\. 12\\-hour like *2:30pm* works too\\.`);
  }
  if (pick === '1h') runAt = new Date(now.getTime() + 3600 * 1000);
  else if (pick === '3days') runAt = new Date(now.getTime() + 3 * 86400 * 1000);
  else if (pick === 'tomorrow9am') {
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const [ty, tm, td] = todayLocal.split('-').map(Number);
    const t = new Date(Date.UTC(ty, tm - 1, td + 1));
    runAt = timezone.zonedTimeToUtc(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`, '09:00', tz);
    if (runAt.getTime() <= now.getTime()) runAt = new Date(runAt.getTime() + 86400 * 1000);
  }
  if (!runAt) return ctx.reply(format.errorMessage('Unrecognized option', 'that schedule choice wasn’t understood', 'Pick one of the options on the card.'));
  return finalizeSchedule(ctx, runAt, tz);
}

async function scheduleCustom(ctx, text) {
  const timezone = require('../lib/timezone');
  const { tz } = await userTimezone(ctx);
  const runAt = timezone.parseFlexibleDateTime(text.trim(), tz);
  if (!runAt) return ctx.reply(format.errorMessage('Couldn’t read that', 'try "14:00", "12-25 09:00", or "2026-09-15 14:00"', '12-hour like "2:30pm" also works, or ❌ Cancel.'));
  if (runAt.getTime() <= Date.now()) return ctx.reply(format.errorMessage('That time has already passed', `that resolves to the past in ${tz}`, 'Send a future date/time, or ❌ Cancel.'));
  return finalizeSchedule(ctx, runAt, tz);
}

async function finalizeSchedule(ctx, scheduledFor, tz) {
  const d = stateOf(ctx).data;
  await require('../lib/scheduledRepos').create(ctx.from.id, {
    name: d.name, description: d.description || null, visibility: d.isPrivate ? 'private' : 'public', license: d.licenseTemplate || null,
    gitignore: d.gitignoreTemplate || null, includeReadme: d.includeReadme, template: d.template || null, scheduledFor,
  });
  const user = await require('../lib/users').getUser(ctx.from.id);
  const shown = require('../lib/timezone').formatInZone(scheduledFor, tz, { hour12: user && user.time_format === '12h' });
  await deleteQuietly(ctx, stateOf(ctx).cardId);
  await ctx.scene.leave();
  await resultCard.send(ctx, {
    title: 'Repository scheduled',
    subject: `📦 *${esc(d.name)}*  ${d.isPrivate ? '🔒 Private' : '🌐 Public'}`,
    details: [`🕒 ${shown} (${tz})`],
    note: 'Manage it any time in Settings → Automation → Scheduled repos.',
  });
}

// ── creating ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function createNow(ctx) {
  const token = await requireConnected(ctx);
  if (!token) return ctx.scene.leave();
  const s = stateOf(ctx);
  const { name, isPrivate, description, includeReadme, licenseTemplate, gitignoreTemplate, template } = s.data;
  const actionLock = require('../lib/actionLock');
  let created = null;
  const { skipped } = await actionLock.withLock(ctx.from.id, 'createRepo', async () => {
    try {
      await ctx.editMessageText(`⏳ Creating *${esc(name)}*…`, { parse_mode: 'MarkdownV2' }).catch(() => {});
      const repo = await github.createRepo(token, { name, isPrivate, description, licenseTemplate, gitignoreTemplate, org: await require('../lib/accounts').getActiveOwner(ctx.from.id).catch(() => null) });
      require('../lib/repoCache').invalidateRepos(ctx.from.id);
      const notes = [];
      // auto_init always creates README.md (every other feature assumes a default branch exists); skipping it removes that one file.
      if (!includeReadme) {
        try {
          const existing = await github.getFileContent(token, repo.owner.login, repo.name, 'README.md');
          await github.deleteFile(token, repo.owner.login, repo.name, 'README.md', existing.sha, 'Remove default README');
        } catch (err) {
          await activity.log(ctx.from.id, '⚠️', `README cleanup failed → ${name}`, { detail: err.message, isError: true });
          notes.push('The default README.md could not be removed — delete it from Files if you don’t want it.');
        }
      }
      if (template) {
        try {
          const files = require('../lib/repoTemplates').getTemplateFiles(template, repo.name);
          if (files) await github.commitMultipleFiles(token, repo.owner.login, repo.name, files, `Initial commit from ${template} template`);
        } catch (err) {
          await activity.log(ctx.from.id, '⚠️', `Template commit failed → ${name}`, { detail: err.message, isError: true });
          notes.push('The starter template could not be committed.');
        }
      }
      await activity.log(ctx.from.id, '➕', `Created repo → ${name}`, { detail: `visibility:${isPrivate ? 'private' : 'public'}` });
      created = { repo, notes };
    } catch (err) {
      await activity.log(ctx.from.id, '⚠️', `Create repo failed → ${name}`, { detail: err.message, isError: true });
      const errorHelpers = require('../lib/errorHelpers');
      if (errorHelpers.isAuthError(err)) await errorHelpers.replyGithubError(ctx, err, 'Couldn’t create repo');
      else {
        const reason = errorHelpers.isNameCollisionError(err) ? `GitHub says "${name}" already exists on your account` : err.message;
        await resultCard.send(ctx, { kind: 'error', title: 'Couldn’t create repository', subject: `📦 *${esc(name)}*`, details: [reason], note: 'Tap ⬅️ Back to pick a different name.' });
        // the card stays so the person can fix the name and try again
        await showCard(ctx, { fresh: true });
      }
    }
  });
  if (skipped) return ctx.reply('⏳ Already creating — please wait a moment.');
  if (!created) return;

  const { repo, notes } = created;
  await deleteQuietly(ctx, s.cardId);
  await ctx.scene.leave();
  await resultCard.send(ctx, {
    title: 'Repository created',
    subject: `📦 *${esc(repo.name)}*  ${isPrivate ? '🔒 Private' : '🌐 Public'}`,
    details: [description || '', includeReadme ? '📄 README' : '', licenseTemplate ? `⚖️ ${LICENSE_LABEL[licenseTemplate] || licenseTemplate}` : '', gitignoreTemplate ? `🚫 ${gitignoreTemplate}` : '', template ? `📋 ${templateLabel(template)}` : ''],
    link: repo.html_url,
    note: notes.join(' '),
  }, inline.createRepoSuccess(repo.name).reply_markup.inline_keyboard);
  await afterCreateSuggestions(ctx, repo, { isPrivate, licenseTemplate });
}

/** Optional one-tap suggestions (default tag, "learn my default visibility") — small, kept below the result. */
async function afterCreateSuggestions(ctx, repo, { isPrivate, licenseTemplate }) {
  try {
    const tagsLib = require('../lib/tags');
    const userTags = await tagsLib.listTags(ctx.from.id);
    const candidates = isPrivate && !licenseTemplate ? ['personal', 'private'] : (!isPrivate && licenseTemplate ? ['open-source', 'public'] : []);
    const match = userTags.find((t) => candidates.includes(t.name.toLowerCase()));
    if (match) {
      await ctx.reply(`🏷️ Tag this as ${match.emoji} *${esc(match.name)}*?`, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[style.callback('✅ Yes, tag it', `createrepo:tagit:${repo.name}:${match.id}`), style.callback('➖ Skip', 'createrepo:tagit:skip')]]) });
      return;
    }
  } catch (_) { /* suggestions are a bonus */ }
  try {
    const suggestion = await require('../lib/defaults').checkVisibilityPattern(ctx.from.id);
    if (suggestion) {
      const label = suggestion === 'private' ? '🔒 Private' : '🌐 Public';
      await ctx.reply(`💡 You’ve chosen ${label} the last 3 times. Make it your default?`, Markup.inlineKeyboard([[style.callback('✅ Yes, update default', `createrepo:learndefault:${suggestion}`, style.BLUE), style.callback('➖ Keep as is', 'createrepo:learndefault:skip')]]));
    }
  } catch (_) { /* suggestions are a bonus */ }
}

module.exports = scene;
