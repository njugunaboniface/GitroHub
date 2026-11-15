/** 💼 Workspace → Code search (v1.2.4-multi): search code in your repos (or all of GitHub with a filter). */
const ui = require('../ui');
const input = require('../input');
const { accountCtx, pageOf } = require('../common');
const search = require('../../../lib/github/search');

const { esc, plain, back, code, trunc, btn, style } = ui;
const D = (action, ...args) => `manage:codesearch:${[action, ...args].join(':')}`;

async function results(ctx, c, pg) {
  const s = ctx.session.codeSearch;
  if (!s) return ui.screen(ctx, 'Start a new search\\.', [[btn('🔎 Search', D('home'), style.GREEN)], back('Workspace', 'manage:ws')]);
  const scope = s.scope === 'all' ? { type: 'all' } : { type: 'owner', owner: c.owner };
  let r;
  try { r = await search.searchCode(c.token, s.query, scope, { page: pg }); } catch (e) {
    if (e && (e.code === 'SEARCH_TOO_BROAD' || (!e.status && e.message))) return ui.screen(ctx, `⚠️ ${esc(e.message)}`, [[plain('🔎 New search', D('home'))]]);
    throw e;
  }
  const body = r.items.map((i, k) => `*${k + 1}\\.* ${esc(i.repo || '')} — ${code(i.path)}${i.fragment ? `\n${esc(trunc(i.fragment.replace(/\s+/g, ' '), 140))}` : ''}`).join('\n\n') || '_No matches\\._';
  const rows = r.items.filter((i) => i.url).map((i, k) => [ui.link(`${k + 1}. ${trunc(i.path.split('/').pop(), 30)}`, i.url)]);
  const p = ui.pager(pg, r.hasNext, (x) => D('page', x)); if (p.length) rows.push(p);
  rows.push([plain(s.scope === 'all' ? '👤 Search only my repos' : '🌍 Search all GitHub', D('scope')), plain('🔎 New search', D('home'))]);
  rows.push(back('Workspace', 'manage:ws'));
  return ui.screen(ctx, `🔎 *Code search*: ${code(s.query)}\n${s.scope === 'all' ? 'All of GitHub' : `Repos of ${esc(c.owner)}`} · page ${pg}\n\n${body}`, rows);
}

async function handle(ctx, { action, args }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  switch (action) {
    case 'home': return input.ask(ctx, { area: 'codesearch', action: 'query', prompt: `🔎 What should I search for in ${c.owner}'s code?\n\nTips: add language:js, path:src, or filename:config. Searching all of GitHub needs a filter like language: or org:.`, maxLen: 256, cancelData: 'manage:ws' });
    case 'page': return results(ctx, c, pageOf(args[0]));
    case 'scope': if (ctx.session.codeSearch) ctx.session.codeSearch.scope = ctx.session.codeSearch.scope === 'all' ? 'mine' : 'all'; return results(ctx, c, 1);
    default: return ctx.reply('This button has expired.');
  }
}

async function onInput(ctx, { action, text }) {
  const c = await accountCtx(ctx);
  if (!c) return;
  if (action === 'query') {
    if (text.length < 2) throw input.inputError('Type at least 2 characters.');
    ctx.session.codeSearch = { query: text, scope: 'mine' };
    return results(ctx, c, 1);
  }
}

module.exports = { key: 'codesearch', label: 'Code search', emoji: '🔎', level: 'account', scopes: [], handle, onInput };
