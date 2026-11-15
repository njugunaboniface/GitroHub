/**
 * 💼 Workspace → 🧯 Restore center (v1.3.0-multi) — everything reversible, in ONE account-wide timeline.
 *
 *   Repos      what GitroHub changed in a repo (commits, reverts, deleted branches/tags), deleted repos in Trash,
 *              bulk visibility changes (reversible for an hour)
 *   Settings   a changed default (put the old value back), plus tags, pins, saved views and rules you deleted
 *   Other      schedules you cancelled
 *
 * It does not re-implement any undo: repo changes open the existing ⏪ Undo & Restore screen, Trash entries and bulk
 * changes use their existing buttons; only the small things (tags, pins, views, rules, schedules, defaults) are
 * restored here, from lib/softDelete.js (kept 30 days). Removed GitHub accounts are not offered — their token is gone,
 * so adding the account again is the way back.
 */
const ui = require('../ui');
const { pageOf } = require('../common');
const journal = require('../../../lib/changeJournal');
const softDelete = require('../../../lib/softDelete');
const bulkUndo = require('../../../lib/bulkUndo');
const defaults = require('../../../lib/defaults');
const ownerScope = require('../../../lib/ownerScope');
const { pool } = require('../../../db/postgres');

const { esc, plain, btn, back, ago, trunc, style } = ui;
const D = (action, ...args) => `manage:restorec:${[action, ...args].join(':')}`;

const PER_PAGE = 6;
const FILTERS = [['all', 'All'], ['repos', 'Repos'], ['settings', 'Settings'], ['other', 'Other']];
const FILTER_OF = new Map(FILTERS);
const SOURCES = new Set(['j', 't', 'b', 'd', 's']);
const JOURNAL_ICON = { commit: '✏️', revert: '↩️', restore: '📄', rollback: '⏪', branch_delete: '🌿', tag_delete: '🏷️' };
const DEFAULT_LABELS = {
  default_visibility: 'Visibility', default_commit_message: 'Commit message', default_upload_path: 'Upload folder',
  default_sort: 'Repo sort', default_filter: 'Repo filter', auto_suggest_defaults: 'Learn from me',
  trash_retention_days: 'Trash retention', recently_viewed_enabled: 'Recently Viewed',
};
const SOFT_GROUP = { tag: 'settings', pin: 'settings', view: 'settings', rule: 'settings', schedule: 'other' };
const WINDOW_DAYS = 30;
const MAX_ITEMS = 100;

const showVal = (v) => (v === null || v === undefined || v === '' ? '(empty)' : String(v));
const t = (d) => (d ? new Date(d).getTime() : 0);

// ── sources ───────────────────────────────────────────────────────────────────────────────────────────────
async function repoItems(telegramId, owner) {
  const [changes, trash, bulk] = await Promise.all([
    journal.listAll(telegramId, owner, { limit: 40 }).catch(() => []),
    pool.query(
      `SELECT id, original_name, deleted_at FROM trashed_repos
        WHERE telegram_id = $1 AND restored_at IS NULL AND (expires_at IS NULL OR expires_at > now())
          AND ($2::text IS NULL OR owner_login IS NULL OR LOWER(owner_login) = $2::text)
        ORDER BY deleted_at DESC LIMIT 40`, [telegramId, owner]).then((r) => r.rows).catch(() => []),
    bulkUndo.listRecent(telegramId, 5).catch(() => []),
  ]);
  return [
    ...changes.map((r) => ({ src: 'j', id: Number(r.id), group: 'repos', icon: JOURNAL_ICON[r.kind] || '✏️', label: `${r.repo_name}: ${r.label || r.kind}`, at: r.created_at })),
    ...trash.map((r) => ({ src: 't', id: Number(r.id), group: 'repos', icon: '🗑️', label: `Deleted repo ${r.original_name}`, at: r.deleted_at })),
    ...bulk.map((r) => ({ src: 'b', id: Number(r.id), group: 'repos', icon: r.action_type === 'private' ? '🔒' : '🌐', label: `Made ${r.repoNames.length} repo${r.repoNames.length === 1 ? '' : 's'} ${r.action_type}`, at: r.created_at })),
  ];
}

/** A changed default is offered only while it can really be put back: the newest change of that field, still in force. */
async function settingsItems(telegramId, owner) {
  const [soft, changes, current] = await Promise.all([
    softDelete.list(telegramId, { owner, limit: 60 }).then((r) => r.items).catch(() => []),
    pool.query(
      `SELECT id, field, old_value, new_value, source, changed_at FROM defaults_changelog
        WHERE telegram_id = $1 AND changed_at > now() - ($2 || ' days')::interval ORDER BY changed_at DESC, id DESC LIMIT 40`,
      [telegramId, String(WINDOW_DAYS)]).then((r) => r.rows).catch(() => []),
    defaults.getDefaults(telegramId).catch(() => null),
  ]);
  const seen = new Set();
  const changed = [];
  for (const r of changes) {
    if (seen.has(r.field)) continue; // only the newest change per field
    seen.add(r.field);
    if (!current || String(current[r.field]) !== String(r.new_value)) continue; // changed again since
    if (String(r.old_value) === String(r.new_value)) continue;
    changed.push({ src: 'd', id: Number(r.id), group: 'settings', icon: '🎛️', label: `${DEFAULT_LABELS[r.field] || r.field}: ${showVal(r.old_value)} → ${showVal(r.new_value)}`, at: r.changed_at });
  }
  const softItems = soft.filter((r) => SOFT_GROUP[r.kind] === 'settings').map((r) => softItem(r));
  return [...changed, ...softItems];
}

const softItem = (r) => ({ src: 's', id: Number(r.id), group: SOFT_GROUP[r.kind] || 'other', icon: softDelete.ICONS[r.kind] || '🧯', label: r.label || softDelete.KIND_WORDS[r.kind] || 'Deleted item', at: r.deleted_at });

async function otherItems(telegramId, owner) {
  const { items } = await softDelete.list(telegramId, { owner, limit: 60 }).catch(() => ({ items: [] }));
  return items.filter((r) => SOFT_GROUP[r.kind] === 'other').map((r) => softItem(r));
}

/** The merged, newest-first timeline for one filter. Exported for tests. */
async function timeline(telegramId, filter = 'all') {
  const owner = await ownerScope.current(telegramId).catch(() => null);
  const parts = [];
  if (filter === 'all' || filter === 'repos') parts.push(repoItems(telegramId, owner));
  if (filter === 'all' || filter === 'settings') parts.push(settingsItems(telegramId, owner));
  if (filter === 'all' || filter === 'other') parts.push(otherItems(telegramId, owner));
  const all = (await Promise.all(parts)).flat();
  return all.sort((a, b) => t(b.at) - t(a.at)).slice(0, MAX_ITEMS);
}

// ── screens ───────────────────────────────────────────────────────────────────────────────────────────────
async function home(ctx, filter, pg) {
  const f = FILTER_OF.has(filter) ? filter : 'all';
  const items = await timeline(ctx.from.id, f);
  const page = items.slice((pg - 1) * PER_PAGE, pg * PER_PAGE);
  const hasNext = items.length > pg * PER_PAGE;
  const chips = FILTERS.map(([key, label]) => plain(`${key === f ? '● ' : ''}${label}`, D('list', key, 1)));
  const rows = ui.listRows({
    items: page,
    render: (it) => ({ label: `${it.icon} ${trunc(it.label, 36)} · ${ago(it.at)}`, data: D('view', it.src, it.id, f, pg) }),
    pageNo: pg, hasNext, pageData: (x) => D('list', f, x),
    extra: [chips],
    backRow: back('Workspace', 'manage:ws'),
  });
  const intro = 'Everything you can still put back, newest first\\. Deleted tags, pins, saved views, rules and cancelled schedules are kept for 30 days\\.';
  const body = items.length ? `${intro}\n\n${esc(`${items.length} item${items.length === 1 ? '' : 's'}${f === 'all' ? '' : ` in ${FILTER_OF.get(f)}`}`)}` : `${intro}\n\n_Nothing to restore right now\\. 🎉_`;
  return ui.screen(ctx, `🧯 *Restore center*\n\n${body}`, rows);
}

const navBack = (f, pg) => back('Restore center', D('list', f, pg));

async function viewJournal(ctx, id, f, pg) {
  const row = await journal.get(ctx.from.id, id);
  if (!row || row.undone_at) return ui.screen(ctx, '_That change is no longer available\\._', [navBack(f, pg)]);
  const lines = [`${JOURNAL_ICON[row.kind] || '✏️'} *${esc(row.label || row.kind)}*`, '', `Repo: ${esc(row.repo_name)}${row.ref_name ? ` · ${esc(row.ref_name)}` : ''}`, esc(ago(row.created_at))];
  return ui.screen(ctx, lines.join('\n'), [
    [btn('↩️ Open in Undo & Restore', `manage:restore:jview:${row.repo_name}:${row.id}`)],
    navBack(f, pg),
  ]);
}

async function viewTrash(ctx, id, f, pg) {
  const { rows } = await pool.query('SELECT id, original_name, visibility, deleted_at, expires_at, restorable FROM trashed_repos WHERE telegram_id = $1 AND id = $2 AND restored_at IS NULL AND (expires_at IS NULL OR expires_at > now())', [ctx.from.id, id]);
  const e = rows[0];
  if (!e) return ui.screen(ctx, '_That repo is no longer in Trash\\._', [navBack(f, pg)]);
  const lines = [`🗑️ *${esc(e.original_name)}*`, '', `Deleted ${esc(ago(e.deleted_at))} · ${e.visibility === 'private' ? '🔒 private' : '🌐 public'}`, e.expires_at ? esc(`Kept until ${new Date(e.expires_at).toISOString().slice(0, 10)}`) : 'Kept until you delete it'];
  const act = e.restorable === false ? [] : [[btn('♻️ Restore now', `trash:restore:${e.id}`, style.GREEN), plain('✏️ Edit, then restore', `trash:editrestore:${e.id}`)]];
  if (e.restorable === false) lines.push('', '_Its backup is too big to restore here — you can still re\\-send the ZIP from Trash\\._');
  return ui.screen(ctx, lines.join('\n'), [...act, [plain('🗑️ Open Trash', 'trash:back')], navBack(f, pg)]);
}

async function viewBulk(ctx, id, f, pg) {
  const e = await bulkUndo.getUndoable(ctx.from.id, id);
  if (!e || e.status !== 'ok') return ui.screen(ctx, `_${e && e.status === 'already-undone' ? 'Already undone' : 'That undo has expired'}\\._`, [navBack(f, pg)]);
  const names = e.repoNames.slice(0, 8).map((n) => `• ${esc(n)}`).join('\n') + (e.repoNames.length > 8 ? `\n… and ${e.repoNames.length - 8} more` : '');
  return ui.screen(ctx, `${e.action_type === 'private' ? '🔒' : '🌐'} *Bulk change to ${esc(e.action_type)}*\n${esc(ago(e.created_at))}\n\n${names}\n\nCan be undone for an hour after it ran\\.`, [
    [btn('↩️ Undo this change', `bulk:undo:${e.id}`, style.GREEN)], navBack(f, pg),
  ]);
}

async function getDefaultEntry(telegramId, id) {
  const { rows } = await pool.query('SELECT id, field, old_value, new_value, changed_at FROM defaults_changelog WHERE telegram_id = $1 AND id = $2', [telegramId, id]);
  return rows[0] || null;
}

async function viewDefault(ctx, id, f, pg) {
  const e = await getDefaultEntry(ctx.from.id, id);
  if (!e) return ui.screen(ctx, '_That change is no longer available\\._', [navBack(f, pg)]);
  const lines = [`🎛️ *${esc(DEFAULT_LABELS[e.field] || e.field)}*`, '', esc(`Changed ${ago(e.changed_at)}: ${showVal(e.old_value)} → ${showVal(e.new_value)}`), '', esc(`Put it back to “${showVal(e.old_value)}”?`)];
  return ui.screen(ctx, lines.join('\n'), [[btn(`↩️ Put back “${trunc(showVal(e.old_value), 20)}”`, D('dok', e.id, f, pg), style.GREEN)], navBack(f, pg)]);
}

const coerce = (field, v) => {
  if (field === 'auto_suggest_defaults' || field === 'recently_viewed_enabled') return v === true || v === 'true' || v === 't';
  if (field === 'trash_retention_days') return Number(v);
  return v == null ? '' : v;
};

async function doDefault(ctx, id, f, pg) {
  const e = await getDefaultEntry(ctx.from.id, id);
  if (!e) return ui.screen(ctx, '_That change is no longer available\\._', [navBack(f, pg)]);
  const cur = await defaults.getDefaults(ctx.from.id);
  if (!cur || String(cur[e.field]) !== String(e.new_value)) return ui.screen(ctx, '⚠️ That setting has changed again since, so I left it alone\\.', [navBack(f, pg)]);
  try {
    await defaults.setDefault(ctx.from.id, e.field, coerce(e.field, e.old_value), { source: 'manual' });
  } catch (err) {
    if (err && err.code === 'INVALID_DEFAULT') return ui.screen(ctx, '⚠️ I can’t go back to that value any more\\. Change it in ⚙️ Settings instead\\.', [navBack(f, pg)]);
    throw err;
  }
  return ui.screen(ctx, `✅ *${esc(DEFAULT_LABELS[e.field] || e.field)}* is back to ${esc(`“${showVal(e.old_value)}”`)}\\.`, [navBack(f, pg)]);
}

async function viewSoft(ctx, id, f, pg) {
  const row = await softDelete.get(ctx.from.id, id);
  if (!row || row.restored_at || new Date(row.expires_at).getTime() <= Date.now()) return ui.screen(ctx, '_That item is no longer available\\._', [navBack(f, pg)]);
  const left = Math.max(1, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 86400000));
  const lines = [`${softDelete.ICONS[row.kind] || '🧯'} *${esc(row.label)}*`, '', `${esc(softDelete.KIND_WORDS[row.kind] || 'Item')} deleted ${esc(ago(row.deleted_at))} · ${left} day${left === 1 ? '' : 's'} left`];
  return ui.screen(ctx, lines.join('\n'), [[btn('↩️ Restore', D('sok', row.id, f, pg), style.GREEN), plain('🗑 Forget', D('sfask', row.id, f, pg))], navBack(f, pg)]);
}

async function doSoft(ctx, id, f, pg) {
  const r = await softDelete.restore(ctx.from.id, id);
  if (!r.ok) return ui.screen(ctx, `⚠️ ${esc(r.reason)}`, [[plain('🗑 Forget it', D('sfask', id, f, pg))], navBack(f, pg)]);
  return ui.screen(ctx, `✅ ${r.already ? 'Already restored' : 'Restored'}: *${esc(r.label || 'item')}*`, [navBack(f, pg)]);
}

async function askForget(ctx, id, f, pg) {
  const row = await softDelete.get(ctx.from.id, id);
  if (!row || row.restored_at) return ui.screen(ctx, '_That item is no longer available\\._', [navBack(f, pg)]);
  return ui.screen(ctx, `Forget *${esc(row.label)}* for good?\n\nIt will no longer be restorable\\.`, ui.confirmRows('🗑 Yes, forget it', D('sfok', id, f, pg), D('view', 's', id, f, pg), '❌ Keep it'));
}

async function doForget(ctx, id, f, pg) {
  await softDelete.forget(ctx.from.id, id);
  return ui.screen(ctx, '🗑 Forgotten\\.', [navBack(f, pg)]);
}

const VIEWS = { j: viewJournal, t: viewTrash, b: viewBulk, d: viewDefault, s: viewSoft };
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const filterOf = (v) => (FILTER_OF.has(v) ? v : 'all');

async function handle(ctx, { action, args }) {
  switch (action) {
    case 'home': return home(ctx, 'all', 1);
    case 'list': return home(ctx, filterOf(args[0]), pageOf(args[1]));
    case 'view': {
      const [src, rawId, f, pg] = args; const id = idOf(rawId);
      if (!SOURCES.has(src) || !id) return ctx.reply('This button has expired.');
      return VIEWS[src](ctx, id, filterOf(f), pageOf(pg));
    }
    case 'dok': { const id = idOf(args[0]); return id ? doDefault(ctx, id, filterOf(args[1]), pageOf(args[2])) : undefined; }
    case 'sok': { const id = idOf(args[0]); return id ? doSoft(ctx, id, filterOf(args[1]), pageOf(args[2])) : undefined; }
    case 'sfask': { const id = idOf(args[0]); return id ? askForget(ctx, id, filterOf(args[1]), pageOf(args[2])) : undefined; }
    case 'sfok': { const id = idOf(args[0]); return id ? doForget(ctx, id, filterOf(args[1]), pageOf(args[2])) : undefined; }
    default: return ctx.reply('This button has expired.');
  }
}

module.exports = { key: 'restorec', label: 'Restore center', emoji: '🧯', level: 'account', scopes: [], handle, timeline, FILTERS };
