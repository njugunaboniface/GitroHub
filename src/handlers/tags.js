const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const tags = require('../lib/tags');
const format = require('../lib/format');
const requireConnected = require('../lib/requireConnected');
const { safeEditMessageText } = require('../lib/safeEdit');

// Every write function below is gated behind requireConnected — this stops
// a stale button from an old message from adding/removing/creating tags for
// a repo when the account is disconnected, instead of failing silently.

async function showRepoTags(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const telegramId = ctx.from.id;
  const current = await tags.tagsForRepo(telegramId, repoName);

  const currentLine = current.length > 0
    ? current.map((t) => tags.tagLabel(t)).join(', ')
    : 'None yet';

  const rows = [
    [style.callback('➕ Add Tag', `tags:add:${repoName}`, style.BLUE)],
  ];
  if (current.length > 0) {
    rows.push([style.callback('🗑 Remove Tag', `tags:removemenu:${repoName}`, style.BLUE)]);
  }
  rows.push([style.callback('⚙️ Manage All Tags', `tags:manage:${repoName}`, style.BLUE)]);
  rows.push([style.callback('⬅️ Back to Repo', `repo:${repoName}`, style.BLUE)]);

  await ctx.reply(
    `🏷️ *Tags for ${format.escapeMd(repoName)}*\nCurrent: ${format.escapeMd(currentLine)}`,
    { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) }
  );
}

async function showAddTagMenu(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const telegramId = ctx.from.id;
  const [allTags, assigned] = await Promise.all([
    tags.listTags(telegramId),
    tags.tagsForRepo(telegramId, repoName),
  ]);
  const assignedIds = new Set(assigned.map((t) => t.id));
  const available = allTags.filter((t) => !assignedIds.has(t.id));

  const rows = available.map((t) => [
    style.callback(tags.tagLabel(t), `tags:assign:${repoName}:${t.id}`),
  ]);
  rows.push([style.callback('➕ Create New Tag', `tags:create:${repoName}`, style.BLUE)]);
  rows.push([style.callback('⬅️ Back', `repo:tags:${repoName}`, style.BLUE)]);

  const text = available.length > 0
    ? `🏷️ Add a tag to ${format.escapeMd(repoName)}:`
    : `🏷️ You don't have any unused tags yet — create one:`;

  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(rows) });
}

async function assignExistingTag(ctx, repoName, tagId) {
  const token = await requireConnected(ctx);
  if (!token) return;
  await tags.assignTag(ctx.from.id, repoName, Number(tagId));
  await ctx.reply('✅ Tag added.');
  return showRepoTags(ctx, repoName);
}

async function showRemoveTagMenu(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const current = await tags.tagsForRepo(ctx.from.id, repoName);
  const rows = current.map((t) => [
    style.callback(tags.tagLabel(t), `tags:removeconfirm:${repoName}:${t.id}`),
  ]);
  rows.push([style.callback('⬅️ Back', `repo:tags:${repoName}`, style.BLUE)]);
  await ctx.reply('🗑 Tap a tag to remove it:', Markup.inlineKeyboard(rows));
}

async function removeTag(ctx, repoName, tagId) {
  const token = await requireConnected(ctx);
  if (!token) return;
  await tags.removeTagFromRepo(ctx.from.id, repoName, Number(tagId));
  await ctx.reply('✅ Tag removed.');

  // If that was the tag's last assignment anywhere, offer to delete the
  // tag definition entirely instead of leaving an unused tag lingering.
  const allTags = await tags.listTags(ctx.from.id);
  const tag = allTags.find((t) => t.id === Number(tagId));
  if (tag && tag.repo_count === 0) {
    await ctx.reply(
      `🏷️ "${tag.emoji} ${tag.name}" isn't used on any repos anymore. Delete this tag entirely?`,
      Markup.inlineKeyboard([
        [style.callback('🗑 Delete Tag', `tags:deletetag:${tagId}:${repoName}`)],
        [style.callback('➖ Keep It', `repo:tags:${repoName}`)],
      ])
    );
    return;
  }
  return showRepoTags(ctx, repoName);
}

async function deleteTagDefinition(ctx, tagId, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  await tags.deleteTag(ctx.from.id, Number(tagId));
  await ctx.reply('✅ Tag deleted.');
  return showRepoTags(ctx, repoName);
}

/** Starts the 2-step "create a new tag" text-input flow (name, then emoji) */
async function startCreateTag(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  ctx.session.creatingTag = { repoName, step: 'name' };
  await ctx.reply(
    '🏷️ New tag — send a short name (e.g. "Client Work")',
    Markup.keyboard([['❌ Cancel']]).resize()
  );
}

/** Called from the text router when ctx.session.creatingTag is set */
/** True when `text` is exactly one emoji (incl. ZWJ sequences, flags, skin
 * tones, keycaps). Falls back to a generous length cap on runtimes without
 * Intl.Segmenter. */
function looksLikeSingleEmoji(text) {
  if (!text) return false;
  const emojiRe = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
  if (!emojiRe.test(text)) return false;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length === 1;
  }
  return text.length <= 12;
}


async function handleCreateTagInput(ctx) {
  const state = ctx.session.creatingTag;
  const text = ctx.message.text.trim();

  if (text === '❌ Cancel') {
    delete ctx.session.creatingTag;
    await ctx.reply('Cancelled.');
    return showRepoTags(ctx, state.repoName);
  }

  if (state.step === 'name') {
    if (text.length > 30) {
      await ctx.reply(format.errorMessage('Tag name too long', `"${text}" is over 30 characters`, 'Try a shorter name.'));
      return;
    }
    // A tag with this name already exists: use it exactly as it is (its emoji, colour
    // and nesting stay untouched) instead of asking for an emoji and overwriting it.
    const existing = await tags.findByName(ctx.from.id, text);
    if (existing) {
      await tags.assignTag(ctx.from.id, state.repoName, existing.id);
      delete ctx.session.creatingTag;
      await ctx.reply(`✅ \u201c${existing.name}\u201d already exists, so I added that tag ${existing.emoji} to the repo as it is.`);
      return showRepoTags(ctx, state.repoName);
    }
    state.name = text;
    state.step = 'emoji';
    await ctx.reply('Now send a single emoji for this tag (e.g. 🤖):');
    return;
  }

  if (state.step === 'emoji') {
    const token = await requireConnected(ctx);
    if (!token) { delete ctx.session.creatingTag; return; }
    // Basic sanity check — a real emoji is short; reject obvious plain text
    // v1.1.22 — count user-perceived characters (graphemes), not UTF-16
    // units: 👨‍💻, 🏳️‍🌈 or 👍🏽 are ONE emoji but 5-6 units long, so the old
    // `length > 4` check rejected perfectly good emoji and (with the error
    // shown) made people retype the same thing.
    if (!looksLikeSingleEmoji(text)) {
      await ctx.reply(format.errorMessage('That doesn\u2019t look like a single emoji', `"${text}" isn\u2019t one emoji`, 'Send exactly one emoji, e.g. 🤖, or ❌ Cancel.'));
      return;
    }
    const created = await tags.createTag(ctx.from.id, state.name, text);
    await tags.assignTag(ctx.from.id, state.repoName, created.id);
    delete ctx.session.creatingTag;
    await ctx.reply(`✅ Created and added tag: ${text} ${state.name}`);
    return showRepoTags(ctx, state.repoName);
  }
}

// ── Tag Manager (v1.2.3-multi) ───────────────────────────────────────────
// Nesting, colours and per-tag defaults used to exist only in the database
// (and in Export/Import); these screens are how a person actually uses them.
// Every screen edits its own message in place, and every button names the VALUE
// it sets (a colour, a parent, private/public) rather than "toggle", so a
// repeated or stale tap can't undo itself.

/** Shows `text` by editing the tapped message, or sends a new one if that isn't possible. */
async function showScreen(ctx, text, rows, parseMode) {
  const extra = { ...(parseMode ? { parse_mode: parseMode } : {}), ...Markup.inlineKeyboard(rows) };
  if (ctx.callbackQuery && (await safeEditMessageText(ctx, text, extra))) return;
  await ctx.reply(text, extra);
}

/** Tags as an indented list (children under their parent), depth-first. */
function flattenTree(roots) {
  const out = [];
  const walk = (node, depth) => {
    out.push({ tag: node, depth });
    node.children.forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

async function showTagManager(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const roots = await tags.listTagsTree(ctx.from.id);
  const rows = flattenTree(roots).map(({ tag, depth }) => [
    style.callback(`${'   '.repeat(depth)}${depth ? '↳ ' : ''}${tags.tagLabel(tag)} (${tag.repo_count})`, `tags:edit:${tag.id}:${repoName}`),
  ]);
  rows.push([style.callback('⬅️ Back', `repo:tags:${repoName}`, style.BLUE)]);
  const text = rows.length > 1
    ? '⚙️ Manage Tags\nTap a tag to change its colour, nest it under another tag, set per-tag defaults, or delete it.'
    : '⚙️ Manage Tags\nYou don\u2019t have any tags yet — add one from a repo\u2019s 🏷️ Tags screen first.';
  return showScreen(ctx, text, rows);
}

async function showTagEditor(ctx, tagId, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return;
  const tag = await tags.getTag(ctx.from.id, tagId);
  if (!tag) {
    await ctx.reply('That tag no longer exists.');
    return showTagManager(ctx, repoName);
  }
  const all = await tags.listTags(ctx.from.id);
  const parent = tag.parent_id ? all.find((t) => t.id === tag.parent_id) : null;
  const self = all.find((t) => t.id === tag.id);
  const overrides = await tags.listTagDefaults(ctx.from.id, tag.id);
  const text =
    `🏷️ ${tags.tagLabel(tag)}\n` +
    `Used on ${self ? self.repo_count : 0} repo${self && self.repo_count === 1 ? '' : 's'}\n` +
    `Colour: ${tags.COLOR_NAMES[tag.color_class] || 'None'}\n` +
    `Nested under: ${parent ? tags.tagLabel(parent) : 'nothing (top level)'}\n` +
    `Defaults for tagged repos: ${overrides.length ? overrides.map((o) => o.key.replace('default_', '').replace('_', ' ')).join(', ') : 'none set'}`;
  return showScreen(ctx, text, [
    [style.callback('🎨 Colour', `tags:colors:${tag.id}:${repoName}`, style.BLUE), style.callback('🔗 Nest Under…', `tags:parents:${tag.id}:${repoName}`, style.BLUE)],
    [style.callback('⚙️ Defaults For This Tag', `tags:defaults:${tag.id}:${repoName}`, style.BLUE)],
    [style.callback('🗑 Delete Tag', `tags:deleteask:${tag.id}:${repoName}`, style.RED)],
    [style.callback('⬅️ Back', `tags:manage:${repoName}`, style.BLUE)],
  ]);
}

async function showColourPicker(ctx, tagId, repoName) {
  const tag = await tags.getTag(ctx.from.id, tagId);
  if (!tag) return showTagManager(ctx, repoName);
  const rows = tags.COLOR_CLASSES.map((c) => [
    style.callback(`${tags.COLOR_DOTS[c] || '⚪'} ${tags.COLOR_NAMES[c]}${tag.color_class === c ? '  ✓' : ''}`, `tags:setcolor:${tag.id}:${c}:${repoName}`),
  ]);
  rows.push([style.callback('⬅️ Back', `tags:edit:${tag.id}:${repoName}`, style.BLUE)]);
  return showScreen(ctx, `🎨 Colour for ${tag.emoji} ${tag.name}\nThe colour shows as a dot in front of the tag everywhere it appears.`, rows);
}

async function setColour(ctx, tagId, colour, repoName) {
  const result = await tags.updateTag(ctx.from.id, tagId, { colorClass: colour });
  if (!result.ok) await ctx.reply(`⚠️ ${result.error}`);
  return showTagEditor(ctx, tagId, repoName);
}

async function showParentPicker(ctx, tagId, repoName) {
  const tag = await tags.getTag(ctx.from.id, tagId);
  if (!tag) return showTagManager(ctx, repoName);
  const [all, descendants] = await Promise.all([tags.listTags(ctx.from.id), tags.descendantTagIds(ctx.from.id, tag.id)]);
  const blocked = new Set([tag.id, ...descendants]);
  const rows = [[style.callback(`${tag.parent_id ? '' : '✓ '}➖ Top level (no parent)`, `tags:setparent:${tag.id}:0:${repoName}`)]];
  all.filter((t) => !blocked.has(t.id)).forEach((t) => {
    rows.push([style.callback(`${tag.parent_id === t.id ? '✓ ' : ''}${tags.tagLabel(t)}`, `tags:setparent:${tag.id}:${t.id}:${repoName}`)]);
  });
  rows.push([style.callback('⬅️ Back', `tags:edit:${tag.id}:${repoName}`, style.BLUE)]);
  return showScreen(ctx, `🔗 Nest ${tag.emoji} ${tag.name} under…\nFiltering by a parent tag also finds repos tagged with any of its sub-tags.`, rows);
}

async function setParent(ctx, tagId, parentId, repoName) {
  const result = await tags.updateTag(ctx.from.id, tagId, { parentId: Number(parentId) === 0 ? null : Number(parentId) });
  if (!result.ok) await ctx.reply(`⚠️ ${result.error}`);
  return showTagEditor(ctx, tagId, repoName);
}

const TAG_DEFAULT_LABELS = {
  default_visibility: '🔒 Visibility for new repos',
  default_upload_path: '📁 Upload folder',
  default_commit_message: '📝 Commit message',
};

async function showTagDefaults(ctx, tagId, repoName) {
  const tag = await tags.getTag(ctx.from.id, tagId);
  if (!tag) return showTagManager(ctx, repoName);
  const overrides = new Map((await tags.listTagDefaults(ctx.from.id, tag.id)).map((o) => [o.key, o.value]));
  const show = (key) => {
    if (!overrides.has(key)) return 'uses your global default';
    const v = overrides.get(key);
    if (key === 'default_upload_path' && v === '') return 'repo root';
    return key === 'default_visibility' ? (v === 'private' ? '🔒 Private' : '🌐 Public') : `\u201c${v}\u201d`;
  };
  const text =
    `⚙️ Defaults for ${tags.tagLabel(tag)}\nThese apply to repos carrying this tag, in place of your global defaults:\n\n` +
    Object.keys(TAG_DEFAULT_LABELS).map((k) => `${TAG_DEFAULT_LABELS[k]}: ${show(k)}`).join('\n');
  const rows = [
    [style.callback('🔒 Private', `tags:defvis:${tag.id}:private:${repoName}`), style.callback('🌐 Public', `tags:defvis:${tag.id}:public:${repoName}`), style.callback('✖️ Clear', `tags:defclear:${tag.id}:vis:${repoName}`)],
    [style.callback('📁 Set Upload Folder', `tags:deftext:${tag.id}:upload:${repoName}`, style.BLUE), style.callback('✖️ Clear', `tags:defclear:${tag.id}:upload:${repoName}`)],
    [style.callback('📝 Set Commit Message', `tags:deftext:${tag.id}:commit:${repoName}`, style.BLUE), style.callback('✖️ Clear', `tags:defclear:${tag.id}:commit:${repoName}`)],
    [style.callback('⬅️ Back', `tags:edit:${tag.id}:${repoName}`, style.BLUE)],
  ];
  return showScreen(ctx, text, rows);
}

const DEFAULT_KEY_BY_SHORT = { vis: 'default_visibility', upload: 'default_upload_path', commit: 'default_commit_message' };

async function setTagVisibilityDefault(ctx, tagId, value, repoName) {
  await tags.setTagDefault(ctx.from.id, Number(tagId), 'default_visibility', value).catch(() => false);
  return showTagDefaults(ctx, tagId, repoName);
}

async function clearTagDefaultValue(ctx, tagId, shortKey, repoName) {
  const key = DEFAULT_KEY_BY_SHORT[shortKey];
  if (key) await tags.clearTagDefault(ctx.from.id, Number(tagId), key);
  return showTagDefaults(ctx, tagId, repoName);
}

/** Starts a typed-input prompt for the upload-folder or commit-message override. */
async function askTagDefaultText(ctx, tagId, shortKey, repoName) {
  const key = DEFAULT_KEY_BY_SHORT[shortKey];
  const tag = await tags.getTag(ctx.from.id, tagId);
  if (!key || !tag) return showTagManager(ctx, repoName);
  ctx.session.editingTagDefault = { tagId: Number(tagId), key, repoName };
  await ctx.reply(
    key === 'default_upload_path'
      ? `📁 Send the folder to suggest for uploads to repos tagged ${tag.emoji} ${tag.name} (e.g. docs/assets), or "root" for the repo root.`
      : `📝 Send the commit message to use for repos tagged ${tag.emoji} ${tag.name}. You can use {filename}, {repo}, {date} and {count}.`,
    Markup.keyboard([['❌ Cancel']]).resize()
  );
}

async function handleTagDefaultInput(ctx) {
  const state = ctx.session.editingTagDefault;
  const text = ctx.message.text.trim();
  if (text === '❌ Cancel') {
    delete ctx.session.editingTagDefault;
    await ctx.reply('Cancelled.');
    return showTagDefaults(ctx, state.tagId, state.repoName);
  }
  const value = state.key === 'default_upload_path' && text.toLowerCase() === 'root' ? '' : text;
  try {
    const ok = await tags.setTagDefault(ctx.from.id, state.tagId, state.key, value);
    if (!ok) throw new Error('That tag no longer exists.');
  } catch (err) {
    // Stay armed so the corrected value is read.
    await ctx.reply(format.errorMessage('Couldn\u2019t save that', err.message, 'Try again, or ❌ Cancel.'));
    return;
  }
  delete ctx.session.editingTagDefault;
  await ctx.reply('✅ Saved.');
  return showTagDefaults(ctx, state.tagId, state.repoName);
}

async function askDeleteTag(ctx, tagId, repoName) {
  const tag = await tags.getTag(ctx.from.id, tagId);
  if (!tag) return showTagManager(ctx, repoName);
  return showScreen(
    ctx,
    `🗑 Delete the tag ${tags.tagLabel(tag)}?\nIt is removed from every repo that has it, and any sub-tags move up to the top level. Your repos themselves are not touched.`,
    [
      [style.callback('🗑 Yes, Delete Tag', `tags:deletetag:${tag.id}:${repoName}`, style.RED)],
      [style.callback('❌ Cancel', `tags:edit:${tag.id}:${repoName}`, style.GREEN)],
    ]
  );
}

module.exports = {
  showTagManager,
  showTagEditor,
  showColourPicker,
  setColour,
  showParentPicker,
  setParent,
  showTagDefaults,
  setTagVisibilityDefault,
  clearTagDefaultValue,
  askTagDefaultText,
  handleTagDefaultInput,
  askDeleteTag,
  showRepoTags,
  showAddTagMenu,
  assignExistingTag,
  showRemoveTagMenu,
  removeTag,
  deleteTagDefinition,
  startCreateTag,
  handleCreateTagInput,
};
