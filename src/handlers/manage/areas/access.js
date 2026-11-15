/** ⚡ Manage → Access (v1.2.4-multi): collaborators & invitations, deploy keys, topics, transfer ownership. */
const ui = require('../ui');
const input = require('../input');
const { repoCtx, num, pageOf } = require('../common');
const acc = require('../../../lib/github/access');

const { esc, btn, plain, back, code, ago, style } = ui;
const D = (action, repo, ...args) => `manage:access:${[action, repo, ...args].join(':')}`;
const PERM = acc.PERMISSION_LABEL;
/** v1.2.5-multi: tell Warden Watch about a sensitive action (scored, never blocks). */
const watch = (ctx, c, action, detail) => { require('../../../lib/sensitiveActions').note(ctx, { action, repo: c.repo, owner: c.owner, detail }).catch(() => {}); };
const PERM_HELP = '*Read* view only · *Triage* manage issues/PRs · *Write* push code · *Maintain* manage repo · *Admin* full control';

async function hub(ctx, c) {
  return ui.screen(ctx, `🔑 *Access* — ${esc(c.repo)}`, [
    [plain('👥 Collaborators', D('collabs', c.repo, 1)), plain('🗝 Deploy keys', D('keys', c.repo, 1))],
    [plain('🏷 Topics', D('topics', c.repo)), plain('📦 Transfer', D('transfer', c.repo))],
    back('Manage', `manage:hub:${c.repo}`),
  ]);
}

async function collabs(ctx, c, pg) {
  const [r, inv] = await Promise.all([acc.listCollaborators(c.token, c.owner, c.repo, { page: pg }), pg === 1 ? acc.listInvitations(c.token, c.owner, c.repo).catch(() => []) : []]);
  const people = r.items.filter((x) => x.login.toLowerCase() !== String(c.owner).toLowerCase());
  const rows = ui.listRows({
    items: people, render: (x) => ({ label: `👤 ${x.login} · ${PERM[x.permission] || x.permission}`, data: D('collab', c.repo, x.login) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (n) => D('collabs', c.repo, n),
  });
  for (const i of inv) rows.push([plain(`⏳ ${i.login} · invited — cancel`, D('invcancel', c.repo, i.id))]);
  rows.push([btn('➕ Invite someone', D('invite', c.repo), style.GREEN)]);
  rows.push(back('Access', D('home', c.repo)));
  return ui.screen(ctx, `👥 *Collaborators* — ${esc(c.repo)}\n${PERM_HELP}${people.length || inv.length ? '' : '\n\n_No collaborators yet\\._'}`, rows);
}

async function topics(ctx, c) {
  const names = await acc.getTopics(c.token, c.owner, c.repo);
  const rows = names.map((t, i) => [plain(`✖️ ${t}`, D('topicdel', c.repo, i))]);
  if (names.length < acc.MAX_TOPICS) rows.push([btn('➕ Add topic', D('topicadd', c.repo), style.GREEN)]);
  rows.push(back('Access', D('home', c.repo)));
  return ui.screen(ctx, `🏷 *Topics* — ${esc(c.repo)}\nTap a topic to remove it\\.${names.length ? '' : '\n\n_No topics yet\\._'}`, rows);
}

async function keys(ctx, c, pg) {
  const r = await acc.listDeployKeys(c.token, c.owner, c.repo, { page: pg });
  const rows = ui.listRows({
    items: r.items, render: (k) => ({ label: `🗝 ${k.title} · ${k.readOnly ? 'read-only' : 'read/write'}`, data: D('keyview', c.repo, k.id) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (n) => D('keys', c.repo, n),
    extra: [[btn('➕ Add deploy key', D('keyadd', c.repo), style.GREEN)]], backRow: back('Access', D('home', c.repo)),
  });
  return ui.screen(ctx, `🗝 *Deploy keys* — ${esc(c.repo)}\nSSH keys that give one server access to this repo${r.items.length ? '' : '\n\n_No deploy keys\\._'}`, rows);
}

async function handle(ctx, { action, args, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const who = args[0];
  switch (action) {
    case 'home': return hub(ctx, c);
    case 'collabs': return collabs(ctx, c, pageOf(args[0]));
    case 'collab': {
      if (!who) return;
      const rows = acc.PERMISSIONS.map((p) => [plain(`Set: ${PERM[p]}`, D('perm', c.repo, who, p))]);
      rows.push([btn('🗑 Remove access', D('rmask', c.repo, who), style.RED)], back('Collaborators', D('collabs', c.repo, 1)));
      return ui.screen(ctx, `👤 *${esc(who)}*\n${PERM_HELP}`, rows);
    }
    case 'perm': { const p = args[1]; if (!who || !acc.PERMISSIONS.includes(p)) return; await acc.addCollaborator(c.token, c.owner, c.repo, who, p); watch(ctx, c, 'collab_add', `${who} (${p})`); return collabs(ctx, c, 1); }
    case 'rmask': if (!who) return; return ui.screen(ctx, `Remove *${esc(who)}* from this repo?`, ui.confirmRows('🗑 Yes, remove', D('rmok', c.repo, who), D('collab', c.repo, who)));
    case 'rmok': if (!who) return; await acc.removeCollaborator(c.token, c.owner, c.repo, who); watch(ctx, c, 'collab_remove', who); return collabs(ctx, c, 1);
    case 'invite': return input.ask(ctx, { area: 'access', action: 'invite', repoName, prompt: '➕ Send the GitHub username to invite.', maxLen: 60, cancelData: D('collabs', c.repo, 1) });
    case 'invperm': { const p = args[1]; if (!who || !acc.PERMISSIONS.includes(p)) return; const r = await acc.addCollaborator(c.token, c.owner, c.repo, who, p); watch(ctx, c, 'collab_add', `${who} (${p})`); return ui.screen(ctx, r.invited ? `✅ Invitation sent to *${esc(who)}* \\(${esc(PERM[p])}\\)\\. They must accept it on GitHub\\.` : `✅ *${esc(who)}* now has *${esc(PERM[p])}* access\\.`, [back('Collaborators', D('collabs', c.repo, 1))]); }
    case 'invcancel': { const id = num(who); if (!id) return; await acc.cancelInvitation(c.token, c.owner, c.repo, id); return collabs(ctx, c, 1); }
    case 'topics': return topics(ctx, c);
    case 'topicadd': return input.ask(ctx, { area: 'access', action: 'topic', repoName, prompt: '🏷 Send a topic (lowercase, hyphens), or several separated by spaces/commas.', maxLen: 300, cancelData: D('topics', c.repo) });
    case 'topicdel': { const i = Number(who); const names = await acc.getTopics(c.token, c.owner, c.repo); if (!Number.isInteger(i) || !names[i]) return topics(ctx, c); names.splice(i, 1); await acc.setTopics(c.token, c.owner, c.repo, names); return topics(ctx, c); }
    case 'keys': return keys(ctx, c, pageOf(args[0]));
    case 'keyview': { const id = num(who); if (!id) return; const r = await acc.listDeployKeys(c.token, c.owner, c.repo, { perPage: 50 }); const k = r.items.find((x) => x.id === id); if (!k) return keys(ctx, c, 1); return ui.screen(ctx, `🗝 *${esc(k.title)}*\n${k.readOnly ? 'Read\\-only' : 'Read/write'} · added ${esc(ago(k.createdAt))}\n${code(k.fingerprint)}…`, [[btn('🗑 Delete', D('keydelask', c.repo, id), style.RED)], back('Deploy keys', D('keys', c.repo, 1))]); }
    case 'keydelask': { const id = num(who); if (!id) return; return ui.screen(ctx, 'Delete this deploy key?\n\nThe server using it loses access\\.', ui.confirmRows('🗑 Yes, delete', D('keydelok', c.repo, id), D('keys', c.repo, 1))); }
    case 'keydelok': { const id = num(who); if (!id) return; await acc.deleteDeployKey(c.token, c.owner, c.repo, id); return keys(ctx, c, 1); }
    case 'keyadd': return input.ask(ctx, { area: 'access', action: 'keytitle', repoName, prompt: '🗝 Send a name for the key (e.g. production server).', maxLen: 100, cancelData: D('keys', c.repo, 1) });
    case 'transfer': return ui.screen(ctx, `📦 *Transfer ${esc(c.repo)}*\n\nMoves the repo to another user or organisation\\. They get an email to accept unless you own both\\. Stars, issues and PRs move with it, and old URLs redirect\\.`, [[btn('📦 Start transfer…', D('transferask', c.repo), style.RED)], back('Access', D('home', c.repo))]);
    case 'transferask': return input.ask(ctx, { area: 'access', action: 'transfer', repoName, prompt: '📦 Send the GitHub username or organisation to transfer this repo to.', maxLen: 60, cancelData: D('transfer', c.repo) });
    case 'transferok': { if (!who) return; const g = await require('../../../lib/sensitiveActions').gate(ctx, { action: 'transfer', repo: c.repo }); if (!g.ok) return ctx.reply(g.message); const r = await acc.transferRepo(c.token, c.owner, c.repo, who); watch(ctx, c, 'transfer', `to ${who}`); return ui.screen(ctx, r ? `✅ Transfer to *${esc(who)}* started\\. If they must accept, GitHub emailed them\\.` : `⚠️ GitHub didn’t confirm the transfer — check ${esc(who)} on GitHub before trying again\\.`, [[plain('📁 My repos', 'repos:back')]]); }
    case 'keyok': {
      const [mode, titleB64] = args; if (!['ro', 'rw'].includes(mode)) return;
      return input.ask(ctx, { area: 'access', action: 'keybody', repoName, args: [mode, titleB64], prompt: '🗝 Paste the PUBLIC key (starts with ssh-ed25519 or ssh-rsa). Never send a private key.', maxLen: 4000, cancelData: D('keys', c.repo, 1) });
    }
    default: return ctx.reply('This button has expired.');
  }
}

async function onInput(ctx, { action, args, repoName, text }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  if (action === 'invite') {
    let login; try { login = acc.assertLogin(text); } catch (e) { throw input.inputError(e.message); }
    const rows = acc.PERMISSIONS.map((p) => [plain(PERM[p], D('invperm', c.repo, login, p))]);
    rows.push([btn('❌ Cancel', D('collabs', c.repo, 1), style.GREEN)]);
    return ui.screen(ctx, `Which access should *${esc(login)}* get?\n${PERM_HELP}`, rows);
  }
  if (action === 'topic') {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    const add = [];
    for (const p of parts) { const n = acc.normalizeTopic(p); if (!n.ok) throw input.inputError(`“${p}” — ${n.error}`); add.push(n.topic); }
    const cur = await acc.getTopics(c.token, c.owner, c.repo);
    const merged = Array.from(new Set([...cur, ...add]));
    if (merged.length > acc.MAX_TOPICS) throw input.inputError(`A repo can have at most ${acc.MAX_TOPICS} topics.`);
    await acc.setTopics(c.token, c.owner, c.repo, merged);
    return topics(ctx, c);
  }
  if (action === 'keytitle') {
    return ui.screen(ctx, `Key name: *${esc(text)}*\n\nShould the server be able to push?`, [
      [plain('🔒 Read-only (safer)', D('keyok', c.repo, 'ro', Buffer.from(text).toString('base64url')))],
      [btn('✏️ Read and write', D('keyok', c.repo, 'rw', Buffer.from(text).toString('base64url')), style.RED)],
    ]);
  }
  if (action === 'keybody') {
    const [mode, titleB64] = args;
    try { await acc.addDeployKey(c.token, c.owner, c.repo, { title: Buffer.from(titleB64 || '', 'base64url').toString('utf8'), key: text, readOnly: mode !== 'rw' }); } catch (e) {
      if (e && !e.status) throw input.inputError(e.message);
      if (e && e.status === 422) throw input.inputError('GitHub refused that key (it may already be used on another repo).');
      throw e;
    }
    watch(ctx, c, 'deploy_key_add', mode === 'rw' ? 'read/write key' : 'read-only key');
    return keys(ctx, c, 1);
  }
  if (action === 'transfer') {
    let login; try { login = acc.assertLogin(text); } catch (e) { throw input.inputError(e.message); }
    return ui.screen(ctx, `⚠️ Transfer *${esc(c.repo)}* to *${esc(login)}*?\n\nYou lose control of it once accepted\\.`, ui.confirmRows('📦 Yes, transfer', D('transferok', c.repo, login), D('transfer', c.repo)));
  }
}

module.exports = { key: 'access', label: 'Access', emoji: '🔑', level: 'repo', scopes: [], handle, onInput };
