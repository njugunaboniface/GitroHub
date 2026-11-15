const inline = require('../keyboards/inline');
const bbtb = require('../keyboards/bbtb');
const format = require('../lib/format');
const defaultsLib = require('../lib/defaults');
const tags = require('../lib/tags');
const muteRules = require('../lib/automationMuteRules');
const backupRules = require('../lib/automationBackupRules');
const trash = require('../lib/trash');
const scheduledRepos = require('../lib/scheduledRepos');
const pins = require('../lib/pins');

const EXPORT_VERSION = 2;

/**
 * 💾 Export/Import — a portable JSON snapshot of everything that shapes
 * how GitroHub behaves for this person: Defaults, Notification prefs,
 * Tags (with their auto-rules), Auto-Mute/Auto-Backup rules, Pins,
 * pending Scheduled Repos, and active Trash entries.
 *
 * Deliberately NOT included: the GitHub connection itself (re-connecting
 * is a normal OAuth flow, not something to smuggle through a settings
 * file), per-repo tag assignments, or activity/log history — this is a
 * config + pending-state backup, not a full data export.
 *
 * Trash and Scheduled Repos are only meaningfully restorable back into
 * the SAME bot/Telegram account they were exported from — Trash entries
 * carry a Telegram file_id (not portable elsewhere), and importing a
 * Scheduled Commit whose time has since passed is skipped rather than
 * silently firing immediately.
 *
 * Lives inline inside 📦 Storage & Data (no BBTB button of its own) —
 * inherits whatever BBTB Storage was already showing, same as 🗑️ Trash.
 */
async function showExportImportMenu(ctx) {
  const users = require('../lib/users');
  const connected = await users.isConnected(ctx.from.id);
  if (!connected) return;

  await ctx.reply(
    `💾 *Export/Import*\n\n` +
    `Back up your Defaults, Notification prefs, Tags \\(with their auto\\-rules\\), Auto\\-Mute/Auto\\-Backup rules, Pins, pending Scheduled Repos, and active Trash entries as a file you can restore later — handy before a reset or a big config change\\.\n\n` +
    `This does *not* include your GitHub connection or activity history\\. Trash/Scheduled items only restore properly back into this same bot account\\.`,
    { parse_mode: 'MarkdownV2', ...inline.exportImportMenu() }
  );
}

async function exportSettings(ctx) {
  const telegramId = ctx.from.id;
  const [defaults, notifPrefs, userTags, muteRulesList, backupRulesList, pinsList, scheduledList, trashList, tagDefaultsList] = await Promise.all([
    defaultsLib.getDefaults(telegramId),
    require('../lib/users').getNotificationPrefs(telegramId),
    tags.listTags(telegramId),
    muteRules.listMuteRules(telegramId),
    backupRules.listBackupRules(telegramId),
    pins.list(telegramId),
    scheduledRepos.listPending(telegramId),
    trash.list(telegramId),
    tags.listTagDefaultsForUser(telegramId),
  ]);

  const tagById = new Map(userTags.map((t) => [t.id, t]));
  const exportData = {
    gitrohubExport: true,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    defaults: defaults || {},
    notifications: notifPrefs ? {
      notif_github_activity: notifPrefs.githubActivity,
      notif_system_alerts: notifPrefs.systemAlerts,
      notif_long_ops: notifPrefs.longOps,
      notif_token_health: notifPrefs.tokenHealth,
      notif_stale_nudge: notifPrefs.staleNudge,
      notif_rollup: notifPrefs.rollup,
      quiet_hours_start: notifPrefs.quietStart,
      quiet_hours_end: notifPrefs.quietEnd,
    } : {},
    tags: userTags.map((t) => ({
      name: t.name,
      emoji: t.emoji,
      colorClass: t.color_class,
      parentName: (t.parent_id && tagById.has(t.parent_id)) ? tagById.get(t.parent_id).name : null,
      autoRule: t.auto_rule_json ? JSON.parse(t.auto_rule_json) : null,
    })),
    muteRules: muteRulesList.map((r) => ({ field: r.field, op: r.op, value: r.value })),
    backupRules: backupRulesList.map((r) => ({ field: r.field, op: r.op, value: r.value })),
    pins: pinsList.map((p) => ({ repoName: p.repo_name, position: p.position, section: p.pin_section })),
    tagDefaults: tagDefaultsList.map((d) => ({ tagName: d.tag_name, key: d.key, value: d.value })),
    scheduledRepos: scheduledList.map((s) => ({
      name: s.name, description: s.description, visibility: s.visibility,
      license: s.license, gitignore: s.gitignore, template: s.template,
      includeReadme: s.include_readme, scheduledFor: s.scheduled_for,
    })),
    trash: trashList.map((t) => ({
      originalName: t.original_name, description: t.description, visibility: t.visibility,
      backupFileId: t.backup_file_id, deletedAt: t.deleted_at, expiresAt: t.expires_at,
      restorable: t.restorable !== false,
    })),
  };

  const json = JSON.stringify(exportData, null, 2);
  const filename = `gitrohub-settings-${new Date().toISOString().slice(0, 10)}.json`;
  await ctx.replyWithDocument(
    { source: Buffer.from(json, 'utf8'), filename },
    { caption: `💾 ${userTags.length} tag(s), ${muteRulesList.length} mute rule(s), ${backupRulesList.length} backup rule(s), ${pinsList.length} pin(s), ${scheduledList.length} scheduled repo(s), ${trashList.length} trash entr${trashList.length === 1 ? 'y' : 'ies'}, plus your Defaults and Notification prefs.` }
  );
}

async function promptImportFile(ctx) {
  ctx.session.awaitingSettingsImport = true;
  await ctx.reply(
    '⬆️ Send the exported .json file (as a document attachment) to restore from, or ❌ Cancel.',
    bbtb.cancelOnly
  );
}

/** Called from bot.js's document router once a file arrives while
 * ctx.session.awaitingSettingsImport was set. Downloads, validates, and —
 * if it checks out — shows a summary + explicit confirm before touching
 * anything, since applying this overwrites the current Defaults and
 * Notification prefs outright. */
async function handleImportFile(ctx) {
  const doc = ctx.message.document;
  if (!(doc.file_name || '').toLowerCase().endsWith('.json')) {
    ctx.session.awaitingSettingsImport = true; // wrong file — keep listening for the right one
    await ctx.reply(format.errorMessage('Import failed', `${doc.file_name || 'that file'} isn\u2019t a .json file`, 'Send the file GitroHub\u2019s own Export produced.'));
    return;
  }
  if (doc.file_size > 2 * 1024 * 1024) {
    ctx.session.awaitingSettingsImport = true; // wrong file — keep listening for the right one
    await ctx.reply(format.errorMessage('Import failed', 'that file is larger than a settings export should ever be', 'Send the file GitroHub\u2019s own Export produced.'));
    return;
  }

  let data;
  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(fileLink.href, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    data = JSON.parse(text);
  } catch (err) {
    ctx.session.awaitingSettingsImport = true; // wrong file — keep listening for the right one
    await ctx.reply(format.errorMessage('Import failed', 'couldn\u2019t read that as valid JSON', 'Make sure it\u2019s the unmodified file from Export.'));
    return;
  }

  if (!data || data.gitrohubExport !== true) {
    ctx.session.awaitingSettingsImport = true; // wrong file — keep listening for the right one
    await ctx.reply(format.errorMessage('Import failed', 'this doesn\u2019t look like a GitroHub settings export', 'Use the file from 💾 Export Settings.'));
    return;
  }
  if (typeof data.version !== 'number' || data.version > EXPORT_VERSION) {
    ctx.session.awaitingSettingsImport = true; // wrong file — keep listening for the right one
    await ctx.reply(format.errorMessage('Import failed', `this file is from a newer export format (v${data.version}) than this bot understands (v${EXPORT_VERSION})`, 'Update the bot, or re-export from a matching version.'));
    return;
  }

  const tagCount = Array.isArray(data.tags) ? data.tags.length : 0;
  const tagDefaultCount = Array.isArray(data.tagDefaults) ? data.tagDefaults.length : 0;
  const muteCount = Array.isArray(data.muteRules) ? data.muteRules.length : 0;
  const backupCount = Array.isArray(data.backupRules) ? data.backupRules.length : 0;
  const pinCount = Array.isArray(data.pins) ? data.pins.length : 0;
  const scheduledCount = Array.isArray(data.scheduledRepos) ? data.scheduledRepos.filter((s) => new Date(s.scheduledFor).getTime() > Date.now()).length : 0;
  const trashCount = Array.isArray(data.trash) ? data.trash.filter((t) => !t.expiresAt || new Date(t.expiresAt).getTime() > Date.now()).length : 0;
  const hasDefaults = data.defaults && Object.keys(data.defaults).length > 0;
  const hasNotifs = data.notifications && Object.keys(data.notifications).length > 0;

  ctx.session.pendingImport = data;

  const summary =
    `📋 *Import Summary*\n\n` +
    `Exported: ${format.escapeMd(new Date(data.exportedAt || Date.now()).toLocaleDateString())}\n\n` +
    `${hasDefaults ? '✅' : '➖'} Defaults — ${hasDefaults ? 'will be *overwritten*' : 'nothing to import'}\n` +
    `${hasNotifs ? '✅' : '➖'} Notification prefs — ${hasNotifs ? 'will be *overwritten*' : 'nothing to import'}\n` +
    `${tagCount > 0 ? '✅' : '➖'} ${tagCount} tag${tagCount === 1 ? '' : 's'} — added by name \\(existing tags keep their emoji, colour and nesting unless the file sets them\\)\n` +
    `${tagDefaultCount > 0 ? '✅' : '➖'} ${tagDefaultCount} per\\-tag default${tagDefaultCount === 1 ? '' : 's'} — applied to matching tags\n` +
    `${muteCount > 0 ? '✅' : '➖'} ${muteCount} mute rule${muteCount === 1 ? '' : 's'} — added \\(duplicates skipped\\)\n` +
    `${backupCount > 0 ? '✅' : '➖'} ${backupCount} backup rule${backupCount === 1 ? '' : 's'} — added \\(duplicates skipped\\)\n` +
    `${pinCount > 0 ? '✅' : '➖'} ${pinCount} pin${pinCount === 1 ? '' : 's'} — added \\(already\\-pinned repos skipped\\)\n` +
    `${scheduledCount > 0 ? '✅' : '➖'} ${scheduledCount} scheduled repo${scheduledCount === 1 ? '' : 's'} — past\\-due entries skipped\n` +
    `${trashCount > 0 ? '✅' : '➖'} ${trashCount} trash entr${trashCount === 1 ? 'y' : 'ies'} — already\\-expired and already\\-present entries skipped\n\n` +
    `Anything invalid in the file is skipped and counted, never half\\-applied\\.\n\n` +
    `Proceed?`;

  await ctx.reply(summary, { parse_mode: 'MarkdownV2', ...inline.importConfirm() });
}

async function applyImport(ctx) {
  const data = ctx.session.pendingImport;
  delete ctx.session.pendingImport;
  if (!data) {
    await ctx.reply('Nothing to import — that confirmation expired. Please resend the file.');
    return;
  }

  const telegramId = ctx.from.id;

  // Everything below is validated item by item. An item that is invalid, or that
  // can't be applied, is counted in `skipped` and reported at the end instead of
  // aborting the whole import half-way (v1.2.3-multi).
  let skipped = 0;

  // Defaults — wholesale overwrite, one field at a time through the
  // normal setDefault() so the defaults_changelog audit trail still
  // records exactly what an import changed, same as a manual edit would.
  // setDefault validates every value, so a hand-edited file can't plant a bad one.
  if (data.defaults) {
    const ALLOWED = ['default_visibility', 'default_commit_message', 'default_upload_path', 'default_sort', 'default_filter', 'auto_suggest_defaults'];
    for (const field of ALLOWED) {
      if (data.defaults[field] === undefined) continue;
      try {
        await defaultsLib.setDefault(telegramId, field, data.defaults[field], { source: 'import' });
      } catch (_) {
        skipped++;
      }
    }
  }

  // Notifications — wholesale overwrite via direct column update, since
  // there's no per-field changelog for these the way Defaults has.
  if (data.notifications) {
    const { pool } = require('../db/postgres');
    const n = data.notifications;
    const bool = (v) => (typeof v === 'boolean' ? v : null);
    const rollup = ['off', 'daily', 'weekly'].includes(n.notif_rollup) ? n.notif_rollup : null;
    const hour = (v) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : null);
    // Explicit nulls on every value — a bare `undefined` (an older/partial export
    // missing a key) isn't something to rely on across driver versions; null makes
    // the COALESCE below behave predictably no matter what.
    await pool.query(
      `UPDATE users SET
         notif_github_activity = COALESCE($1, notif_github_activity),
         notif_system_alerts = COALESCE($2, notif_system_alerts),
         notif_long_ops = COALESCE($3, notif_long_ops),
         notif_token_health = COALESCE($4, notif_token_health),
         notif_stale_nudge = COALESCE($5, notif_stale_nudge),
         notif_rollup = COALESCE($6, notif_rollup),
         quiet_hours_start = $7,
         quiet_hours_end = $8
       WHERE telegram_id = $9`,
      [
        bool(n.notif_github_activity), bool(n.notif_system_alerts), bool(n.notif_long_ops), bool(n.notif_token_health),
        bool(n.notif_stale_nudge), rollup,
        hour(n.quiet_hours_start), hour(n.quiet_hours_end),
        telegramId,
      ]
    );
  }

  // Tags — additive, matched by name. createTag only changes the fields a caller
  // passes, so an existing tag keeps its emoji / colour / nesting unless the file
  // actually carries a value for them. Two passes so parent references can
  // resolve to the freshly created/updated ids regardless of array order.
  let tagsApplied = 0;
  const nameToId = new Map();
  if (Array.isArray(data.tags)) {
    for (const t of data.tags) {
      if (!t || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 30) { skipped++; continue; }
      const opts = t.colorClass ? { colorClass: t.colorClass } : {};
      const created = await tags.createTag(telegramId, t.name, typeof t.emoji === 'string' && t.emoji ? t.emoji : null, opts).catch(() => null);
      if (!created) { skipped++; continue; }
      nameToId.set(t.name.trim(), created.id);
      tagsApplied++;
    }
    for (const t of data.tags) {
      if (!t || typeof t.name !== 'string' || !nameToId.has(t.name.trim())) continue;
      const id = nameToId.get(t.name.trim());
      if (t.parentName && nameToId.has(String(t.parentName).trim()) && String(t.parentName).trim() !== t.name.trim()) {
        await tags.createTag(telegramId, t.name, null, { parentId: nameToId.get(String(t.parentName).trim()) }).catch(() => { skipped++; });
      }
      if (t.autoRule) {
        await tags.setAutoRule(telegramId, id, t.autoRule).catch(() => { skipped++; });
      }
    }
  }
  // Per-tag defaults for the tags we just matched (setTagDefault validates and checks ownership).
  let tagDefaultsApplied = 0;
  if (Array.isArray(data.tagDefaults)) {
    for (const d of data.tagDefaults) {
      const id = d && nameToId.get(String(d.tagName || '').trim());
      if (!id) { skipped++; continue; }
      const ok = await tags.setTagDefault(telegramId, id, d.key, d.value).catch(() => false);
      if (ok) tagDefaultsApplied++; else skipped++;
    }
  }

  // Mute/Backup rules — additive, skip exact duplicates (same field+op+value). The
  // creators validate each rule, so an invalid one is skipped and counted.
  const applyRules = async (list, existingList, create) => {
    let applied = 0;
    const keys = new Set(existingList.map((r) => `${r.field}:${r.op}:${r.value}`));
    for (const r of list) {
      if (!r || !r.field || !r.op || typeof r.value !== 'string') { skipped++; continue; }
      const key = `${r.field}:${r.op}:${r.value.trim()}`;
      if (keys.has(key)) continue;
      try {
        await create(telegramId, r);
        keys.add(key);
        applied++;
      } catch (_) {
        skipped++;
      }
    }
    return applied;
  };
  const muteApplied = Array.isArray(data.muteRules)
    ? await applyRules(data.muteRules, await muteRules.listMuteRules(telegramId), muteRules.createMuteRule) : 0;
  const backupApplied = Array.isArray(data.backupRules)
    ? await applyRules(data.backupRules, await backupRules.listBackupRules(telegramId), backupRules.createBackupRule) : 0;

  // Pins — additive, skip repos already pinned (pin() itself already
  // no-ops on conflict, but counting only genuinely-new ones keeps the
  // summary honest).
  let pinsApplied = 0;
  if (Array.isArray(data.pins)) {
    const existingNames = new Set((await pins.list(telegramId)).map((p) => p.repo_name));
    for (const p of data.pins) {
      if (!p || !p.repoName || existingNames.has(p.repoName)) continue;
      await pins.pin(telegramId, p.repoName, p.section || null);
      existingNames.add(p.repoName);
      pinsApplied++;
    }
  }

  // Scheduled repos — only restorable back into the same bot account; anything whose
  // time has already passed is skipped rather than firing immediately, an identical
  // pending one (same name + time) isn't duplicated, and only schedules that were
  // really created are counted.
  let scheduledApplied = 0;
  if (Array.isArray(data.scheduledRepos)) {
    const pending = await scheduledRepos.listPending(telegramId);
    const pendingKeys = new Set(pending.map((s) => `${s.name}|${new Date(s.scheduled_for).getTime()}`));
    const repoNameLib = require('../lib/repoName');
    for (const s of data.scheduledRepos) {
      if (!s || !s.name || !s.scheduledFor) { skipped++; continue; }
      const when = new Date(s.scheduledFor);
      if (Number.isNaN(when.getTime())) { skipped++; continue; }
      if (when.getTime() <= Date.now()) continue;
      const nameCheck = repoNameLib.validateRepoName(s.name);
      if (!nameCheck.ok) { skipped++; continue; }
      const key = `${nameCheck.name}|${when.getTime()}`;
      if (pendingKeys.has(key)) continue;
      try {
        await scheduledRepos.create(telegramId, {
          name: nameCheck.name, description: s.description || null, visibility: s.visibility === 'public' ? 'public' : 'private',
          license: s.license || null, gitignore: s.gitignore || null, template: s.template || null,
          includeReadme: s.includeReadme !== false, scheduledFor: when,
        });
        pendingKeys.add(key);
        scheduledApplied++;
      } catch (_) {
        skipped++;
      }
    }
  }

  // Trash — only restorable back into the same bot account (backupFileId is a
  // Telegram file reference); already-expired and already-present entries are skipped.
  let trashApplied = 0;
  if (Array.isArray(data.trash)) {
    for (const t of data.trash) {
      if (!t || !t.originalName || !t.backupFileId) { skipped++; continue; }
      const restored = await trash.importEntry(telegramId, {
        originalName: t.originalName, description: t.description || null, visibility: t.visibility === 'public' ? 'public' : 'private',
        backupFileId: t.backupFileId, deletedAt: t.deletedAt, expiresAt: t.expiresAt, restorable: t.restorable !== false,
      }).catch(() => { skipped++; return null; });
      if (restored) trashApplied++;
    }
  }

  const activity = require('../lib/activity');
  const counts = `${tagsApplied} tag(s), ${tagDefaultsApplied} tag default(s), ${muteApplied} mute rule(s), ${backupApplied} backup rule(s), ${pinsApplied} pin(s), ${scheduledApplied} scheduled repo(s), ${trashApplied} trash entr${trashApplied === 1 ? 'y' : 'ies'}`;
  await activity.log(telegramId, '💾', `Settings imported → ${counts}${skipped ? `, ${skipped} item(s) skipped` : ''}`);

  await ctx.reply(format.successMessage(
    `Imported ${counts}${data.defaults ? ', and your Defaults' : ''}${data.notifications ? ' + Notification prefs' : ''}`,
    skipped ? `${skipped} item${skipped === 1 ? ' was' : 's were'} skipped because ${skipped === 1 ? 'it was' : 'they were'} invalid or couldn\u2019t be applied.` : undefined
  ));
  return showExportImportMenu(ctx);
}

module.exports = { showExportImportMenu, exportSettings, promptImportFile, handleImportFile, applyImport };
