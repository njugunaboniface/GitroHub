/**
 * ⚡ Manage → ⏪ Undo & Restore (v1.2.5-multi) — the "I committed the wrong thing" toolbox.
 *
 *   ↩️ Undo a recent change      what GitroHub itself changed (commits, reverts, deleted branches…), one tap each
 *   🔙 Go back to a version      pick any commit: go back to it as a new commit, revert just it, or roll the branch back
 *   📄 Restore a file            pick a file, see its versions, put an earlier one back
 *   🟣 Undo a merged PR          revert a pull request that was merged
 *   ♻️ Recover deleted           branches and tags that were deleted (by anyone, for branches)
 *
 * Safe by construction: everything adds a commit and rewrites nothing, EXCEPT "roll the branch back", which saves a
 * backup branch first, refuses protected branches and asks twice. Failed reverts get conflict help (revert the files
 * that can be, or knowingly overwrite later edits) instead of a dead end.
 */
const ui = require('../ui');
const input = require('../input');
const { repoCtx, pageOf, workBranch } = require('../common');
const revert = require('../../../lib/github/revert');
const commits = require('../../../lib/github/commits');
const core = require('../../../lib/github/core');
const journal = require('../../../lib/changeJournal');
const actionLock = require('../../../lib/actionLock');

const { esc, btn, plain, back, code, ago, trunc, style } = ui;
const D = (action, repo, ...args) => `manage:restore:${[action, repo, ...args].join(':')}`;
const SHA = /^[0-9a-f]{7,40}$/i;
const MODES = new Set(['strict', 'skip', 'force']);
const dash = (v) => (v && v !== '-' ? v : null);
const KIND_ICON = { commit: '✏️', revert: '↩️', restore: '📄', rollback: '⏪', branch_delete: '🌿', tag_delete: '🏷' };

const repoInfo = (c) => core.get(c.token, 'GET /repos/{owner}/{repo}', { owner: c.owner, repo: c.repo }, 'Get repo');
async function targetBranch(ctx, c, arg) {
  const given = dash(arg);
  if (given) return given;
  const w = workBranch(ctx, c.repo);
  return w || (await repoInfo(c)).default_branch;
}

/** v1.2.5-multi: tells the monitoring layer about a sensitive action (no-op until that layer is present). */
function noteSensitive(ctx, c, action, detail) {
  try { require('../../../lib/sensitiveActions').note(ctx, { action, repo: c.repo, owner: c.owner, detail }); } catch (_) { /* optional */ }
}

/** Optional owner confirmation for the riskiest actions (Warden Watch). True = held, message already shown. */
async function held(ctx, c, action) {
  const g = await require('../../../lib/sensitiveActions').gate(ctx, { action, repo: c.repo });
  if (g.ok) return false;
  await ctx.reply(g.message);
  return true;
}

async function home(ctx, c) {
  const branch = await targetBranch(ctx, c);
  const rows = [
    [plain('↩️ Undo a recent change', D('recent', c.repo, 1))],
    [plain('🔙 Go back to a version', D('ver', c.repo, '-', 1)), plain('📄 Restore a file', D('file', c.repo))],
    [plain('🟣 Undo a merged PR', D('prs', c.repo, 1)), plain('♻️ Recover deleted', D('rec', c.repo))],
    back('Manage', `manage:hub:${c.repo}`),
  ];
  return ui.screen(ctx, `⏪ *Undo & Restore* — ${esc(c.repo)}\nBranch: ${code(branch)}\n\nMade a mistake? Pick what you want to put right\\. Nothing here rewrites history unless it says so\\.`, rows);
}

// ── Recent changes ───────────────────────────────────────────────────────────

async function recent(ctx, c, pg) {
  const r = await journal.list(ctx.from.id, c.owner, c.repo, { limit: 8, offset: (pg - 1) * 8 });
  const rows = ui.listRows({
    items: r.items,
    render: (j) => ({ label: `${KIND_ICON[j.kind] || '▫️'} ${j.label || j.kind}`, data: D('jview', c.repo, j.id) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('recent', c.repo, x),
    backRow: back('Undo & Restore', D('home', c.repo)),
  });
  const note = r.items.length ? '' : '\n\n_Nothing yet\\. Changes GitroHub makes from now on \\(uploads, edits, reverts, deleted branches\\) show up here\\._';
  return ui.screen(ctx, `↩️ *Recent changes* — ${esc(c.repo)}\nTap one to undo it\\.${note}`, rows);
}

async function jview(ctx, c, id) {
  const j = await journal.get(ctx.from.id, id);
  if (!j || j.repo_name !== c.repo) return ui.screen(ctx, '⚠️ That entry is no longer available\\.', [back('Recent changes', D('recent', c.repo, 1))]);
  const lines = [`${KIND_ICON[j.kind] || '▫️'} *${esc(trunc(j.label || j.kind, 120))}*`, `${esc(ago(j.created_at))}${j.ref_name ? ` · ${esc(j.ref_name)}` : ''}${j.undone_at ? ' · ✅ undone' : ''}`];
  const rows = [];
  if (!j.undone_at) {
    if (['commit', 'revert', 'restore'].includes(j.kind) && j.sha) rows.push([btn('↩️ Undo this change', D('rvask', c.repo, j.sha.slice(0, 7), j.ref_name || '-', 'strict', j.id), style.RED)]);
    if (j.kind === 'rollback') rows.push([btn('⏪ Undo this rollback', D('unrollask', c.repo, j.id), style.RED)]);
    if (j.kind === 'branch_delete' || j.kind === 'tag_delete') rows.push([btn(`♻️ Recover ${j.kind === 'tag_delete' ? 'tag' : 'branch'}`, D('jrec', c.repo, j.id), style.GREEN)]);
  }
  rows.push(back('Recent changes', D('recent', c.repo, 1)));
  return ui.screen(ctx, lines.join('\n'), rows);
}

// ── Revert one commit (with conflict help) ───────────────────────────────────

async function revAsk(ctx, c, sha, br, mode, jid) {
  const target = await targetBranch(ctx, c, br);
  const extra = mode === 'force' ? '\n\n⚠️ Files changed since will be *overwritten* with their earlier version\\.' : mode === 'skip' ? '\n\nOnly the files nobody touched since are put back\\.' : '\n\nA new commit that undoes it is added — history isn’t rewritten\\. If a file changed since, nothing is touched and you’re told which\\.';
  return ui.screen(ctx, `↩️ Revert *${esc(sha.slice(0, 7))}* on *${esc(target)}*?${extra}`, ui.confirmRows(mode === 'force' ? '⚠️ Yes, overwrite' : '↩️ Yes, revert', D('rv', c.repo, sha.slice(0, 7), target, mode, jid || '-'), D('home', c.repo)));
}

/** Runs a commit revert / PR revert and shows the outcome, including conflict help. */
async function showRevertOutcome(ctx, c, { result, target, retry, label, jid, noun = 'commit' }) {
  if (result.nothingToRevert) {
    return ui.screen(ctx, `ℹ️ Nothing could be put back — every file in that ${noun} was changed afterwards\\.`, [back('Undo & Restore', D('home', c.repo))]);
  }
  if (result.conflicts) {
    const files = result.conflicts.slice(0, 12).map((p) => `• ${code(p)}`).join('\n');
    const more = result.conflicts.length > 12 ? `\n… and ${result.conflicts.length - 12} more` : '';
    return ui.screen(ctx, `⚠️ *Can’t revert cleanly*\n\nThese files changed after that ${noun}:\n${files}${more}\n\nNothing was changed\\. You can:`, [
      [plain('↩️ Revert the other files only', retry('skip'))],
      [btn('⚠️ Revert anyway (overwrite later edits)', retry('force'), style.RED)],
      back('Undo & Restore', D('home', c.repo)),
    ]);
  }
  await journal.record({ owner: c.owner, repo: c.repo, kind: 'revert', ref: target, sha: result.sha, label: label || `Reverted a ${noun} on ${target}` });
  if (jid && jid !== '-') await journal.markUndone(ctx.from.id, Number(jid)).catch(() => {});
  const extra = result.skipped ? `\n\nLeft alone \\(changed since\\): ${result.skipped.slice(0, 8).map((p) => code(p)).join(', ')}` : result.overwritten ? `\n\nOverwritten: ${result.overwritten.slice(0, 8).map((p) => code(p)).join(', ')}` : '';
  return ui.screen(ctx, `✅ Reverted — new commit ${code(String(result.sha).slice(0, 7))} on *${esc(target)}*\\.${extra}\n\nChanged your mind? It’s under ↩️ Recent changes\\.`, [[plain('↩️ Recent changes', D('recent', c.repo, 1))], back('Undo & Restore', D('home', c.repo))]);
}

async function revDo(ctx, c, sha, br, mode, jid) {
  if (mode === 'force' && (await held(ctx, c, 'revert_forced'))) return;
  const target = await targetBranch(ctx, c, br);
  let result = null;
  const lock = await actionLock.withLock(ctx.from.id, `revert:${c.repo}`, async () => { result = await commits.revertCommit(c.token, c.owner, c.repo, sha, target, { mode }); });
  if (lock.skipped) return;
  if (result && !result.conflicts) noteSensitive(ctx, c, mode === 'force' ? 'revert_forced' : 'revert', `${sha.slice(0, 7)} on ${target}`);
  return showRevertOutcome(ctx, c, { result, target, jid, label: `Reverted ${sha.slice(0, 7)} on ${target}`, retry: (m) => D('rvask', c.repo, sha.slice(0, 7), target, m, jid || '-') });
}

// ── Versions: go back / roll back ────────────────────────────────────────────

async function versions(ctx, c, br, pg) {
  const branch = await targetBranch(ctx, c, br);
  const r = await commits.listCommits(c.token, c.owner, c.repo, { sha: branch, page: pg });
  const rows = ui.listRows({
    items: r.items,
    render: (m) => ({ label: `${m.short} ${m.message}`, data: D('vview', c.repo, m.short, branch) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('ver', c.repo, branch, x),
    backRow: back('Undo & Restore', D('home', c.repo)),
  });
  return ui.screen(ctx, `🔙 *Go back to a version* — ${esc(c.repo)} · ${esc(branch)}\nPick the commit you want to return to\\.`, rows);
}

async function vview(ctx, c, sha, branch) {
  const m = await commits.getCommit(c.token, c.owner, c.repo, sha);
  const rows = [
    [btn('🔙 Go back to this version', D('gbask', c.repo, m.short, branch), style.BLUE)],
    [plain('↩️ Revert only this commit', D('rvask', c.repo, m.short, branch, 'strict', '-'))],
    [plain('📄 Restore one file from here', D('fileat', c.repo, m.short, branch))],
    [btn('⏪ Roll branch back to here (backup)', D('rbask', c.repo, m.short, branch), style.RED)],
    back('Versions', D('ver', c.repo, branch, 1)),
  ];
  return ui.screen(ctx, `📜 *${esc(m.short)}* — ${esc(trunc(m.message.split('\n')[0], 160))}\n${esc(m.author)} · ${esc(ago(m.date))}\n\n🔙 *Go back* adds a commit so ${esc(branch)} looks exactly like this again — nothing is erased\\.\n⏪ *Roll back* moves the branch itself \\(history after this commit is saved on a backup branch first\\)\\.`, rows);
}

async function goBackDo(ctx, c, sha, branch) {
  let out = null;
  const lock = await actionLock.withLock(ctx.from.id, `revert:${c.repo}`, async () => { out = await revert.revertToCommit(c.token, c.owner, c.repo, branch, sha); });
  if (lock.skipped) return;
  if (out.unchanged) return ui.screen(ctx, `ℹ️ *${esc(branch)}* already matches ${code(sha.slice(0, 7))} — nothing to do\\.`, [back('Versions', D('ver', c.repo, branch, 1))]);
  await journal.record({ owner: c.owner, repo: c.repo, kind: 'restore', ref: branch, sha: out.sha, label: `Went back to ${sha.slice(0, 7)} on ${branch}` });
  noteSensitive(ctx, c, 'revert', `went back to ${sha.slice(0, 7)} on ${branch}`);
  return ui.screen(ctx, `✅ *${esc(branch)}* now matches ${code(sha.slice(0, 7))}\\. New commit ${code(String(out.sha).slice(0, 7))}\\.\n\nNot right? Undo it from ↩️ Recent changes\\.`, [[plain('↩️ Recent changes', D('recent', c.repo, 1))], back('Undo & Restore', D('home', c.repo))]);
}

async function rollbackAsk(ctx, c, sha, branch, step) {
  const info = await core.get(c.token, 'GET /repos/{owner}/{repo}/branches/{branch}', { owner: c.owner, repo: c.repo, branch }, 'Get branch');
  if (info.protected) return ui.screen(ctx, `🔒 *${esc(branch)}* is protected, so it can’t be rolled back from here\\.\n\nUse *Go back to this version* instead — it adds a commit and rewrites nothing\\.`, [back('Version', D('vview', c.repo, sha, branch))]);
  if (step === 1) {
    return ui.screen(ctx, `⏪ *Roll back ${esc(branch)} to ${esc(sha.slice(0, 7))}?*\n\nEvery commit after it leaves the branch\\. They are saved first on a new backup branch, and you can undo this from ↩️ Recent changes\\.\n\nAnyone who already pulled ${esc(branch)} will need to reset their copy\\.`, ui.confirmRows('⏪ Continue', D('rbask2', c.repo, sha, branch), D('vview', c.repo, sha, branch)));
  }
  return ui.screen(ctx, `⚠️ *Last check*\n\nRoll *${esc(branch)}* back to ${code(sha.slice(0, 7))} now?`, ui.confirmRows('⏪ Yes, roll back', D('rbok', c.repo, sha, branch), D('vview', c.repo, sha, branch)));
}

async function rollbackDo(ctx, c, sha, branch) {
  if (await held(ctx, c, 'branch_rollback')) return;
  let out = null;
  const lock = await actionLock.withLock(ctx.from.id, `revert:${c.repo}`, async () => { out = await revert.rollbackBranch(c.token, c.owner, c.repo, branch, sha); });
  if (lock.skipped) return;
  if (out.unchanged) return ui.screen(ctx, `ℹ️ *${esc(branch)}* is already at ${code(sha.slice(0, 7))}\\.`, [back('Versions', D('ver', c.repo, branch, 1))]);
  noteSensitive(ctx, c, 'branch_rollback', `${branch} → ${sha.slice(0, 7)}`);
  return ui.screen(ctx, `✅ *${esc(branch)}* is back at ${code(out.to.slice(0, 7))}\\.\n\nBackup of where it was: ${code(out.backup)}\n\nUndo it any time from ↩️ Recent changes\\.`, [[plain('↩️ Recent changes', D('recent', c.repo, 1))], back('Undo & Restore', D('home', c.repo))]);
}

async function unrollAsk(ctx, c, id) {
  const j = await journal.get(ctx.from.id, id);
  if (!j || j.kind !== 'rollback') return ui.screen(ctx, '⚠️ That entry is no longer available\\.', [back('Recent changes', D('recent', c.repo, 1))]);
  return ui.screen(ctx, `⏪ Move *${esc(j.ref_name)}* forward again to ${code(String(j.prev_sha).slice(0, 7))}?\n\nThe commits that were rolled back return exactly as they were\\.`, ui.confirmRows('✅ Yes, restore them', D('unrollok', c.repo, id), D('jview', c.repo, id)));
}

async function unrollDo(ctx, c, id) {
  const j = await journal.get(ctx.from.id, id);
  if (!j || j.kind !== 'rollback' || !j.prev_sha) return ui.screen(ctx, '⚠️ That entry is no longer available\\.', [back('Recent changes', D('recent', c.repo, 1))]);
  const now = await require('../../../lib/github/branches').getBranchSha(c.token, c.owner, c.repo, j.ref_name);
  if (now !== j.sha) return ui.screen(ctx, `⚠️ *${esc(j.ref_name)}* has moved since that rollback, so restoring it automatically could lose newer work\\.\n\nThe backup branch from then still has it\\.`, [back('Recent changes', D('recent', c.repo, 1))]);
  await revert.fastForward(c.token, c.owner, c.repo, j.ref_name, j.prev_sha);
  await journal.markUndone(ctx.from.id, id);
  return ui.screen(ctx, `✅ *${esc(j.ref_name)}* is back to ${code(String(j.prev_sha).slice(0, 7))}\\.`, [back('Undo & Restore', D('home', c.repo))]);
}

// ── Restore a file ───────────────────────────────────────────────────────────

const pathState = (ctx) => (ctx.session && ctx.session.restoreFile) || null;

async function fileAsk(ctx, c, sha = null, branch = null) {
  return input.ask(ctx, { area: 'restore', action: sha ? 'fileatpath' : 'filepath', repoName: c.repo, args: sha ? [sha, branch || '-'] : [], prompt: sha ? `📄 Send the path of the file to restore from ${sha.slice(0, 7)} (for example src/app.js).` : '📄 Send the path of the file you want to restore (for example src/app.js).', maxLen: 300, cancelData: D('home', c.repo) });
}

function cleanPath(text) {
  const p = String(text || '').trim().replace(/^\/+/, '');
  if (!p || p.split('/').includes('..') || /[\0\n\r]/.test(p)) throw input.inputError('That doesn’t look like a file path. Example: src/app.js');
  return p;
}

async function fileHistory(ctx, c, pg) {
  const st = pathState(ctx);
  if (!st || st.repo !== c.repo) return fileAsk(ctx, c);
  const r = await revert.fileHistory(c.token, c.owner, c.repo, st.path, st.branch, pg);
  if (!r.items.length && pg === 1) return ui.screen(ctx, `⚠️ No history found for ${code(st.path)} on *${esc(st.branch)}*\\. Check the spelling \\(paths are case\\-sensitive\\)\\.`, [[plain('📄 Try another path', D('file', c.repo))], back('Undo & Restore', D('home', c.repo))]);
  const rows = ui.listRows({
    items: r.items,
    render: (m) => ({ label: `${m.short} ${m.message}`, data: D('fpick', c.repo, m.short) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('fhist', c.repo, x),
    backRow: back('Undo & Restore', D('home', c.repo)),
  });
  return ui.screen(ctx, `📄 ${code(st.path)} — versions on *${esc(st.branch)}*\nPick the version to put back\\. The newest is what it is now\\.`, rows);
}

async function filePick(ctx, c, sha) {
  const st = pathState(ctx);
  if (!st || st.repo !== c.repo) return fileAsk(ctx, c);
  return ui.screen(ctx, `📄 Put ${code(st.path)} back to how it was at ${code(sha.slice(0, 7))} on *${esc(st.branch)}*?\n\nA new commit is added; the other files are untouched\\.`, ui.confirmRows('📄 Yes, restore', D('fok', c.repo, sha), D('fhist', c.repo, 1)));
}

async function fileDo(ctx, c, sha) {
  const st = pathState(ctx);
  if (!st || st.repo !== c.repo) return fileAsk(ctx, c);
  let out = null;
  const lock = await actionLock.withLock(ctx.from.id, `revert:${c.repo}`, async () => { out = await revert.restoreFile(c.token, c.owner, c.repo, st.branch, st.path, sha); });
  if (lock.skipped) return;
  if (out.missing) return ui.screen(ctx, `ℹ️ ${code(st.path)} didn’t exist at ${code(sha.slice(0, 7))}, so there is nothing to restore from that version\\.`, [back('Versions', D('fhist', c.repo, 1))]);
  if (out.unchanged) return ui.screen(ctx, `ℹ️ ${code(st.path)} is already identical to that version\\.`, [back('Versions', D('fhist', c.repo, 1))]);
  await journal.record({ owner: c.owner, repo: c.repo, kind: 'restore', ref: st.branch, sha: out.sha, label: `Restored ${st.path} to ${sha.slice(0, 7)}` });
  return ui.screen(ctx, `✅ ${code(st.path)} restored to ${code(sha.slice(0, 7))}\\. New commit ${code(String(out.sha).slice(0, 7))}\\.`, [[plain('↩️ Recent changes', D('recent', c.repo, 1))], back('Undo & Restore', D('home', c.repo))]);
}

// ── Merged PRs ───────────────────────────────────────────────────────────────

async function prs(ctx, c, pg) {
  const r = await revert.listMergedPrs(c.token, c.owner, c.repo, pg);
  const rows = ui.listRows({
    items: r.items,
    render: (p) => ({ label: `🟣 #${p.number} ${p.title}`, data: D('pview', c.repo, p.number) }),
    pageNo: pg, hasNext: r.hasNext, pageData: (x) => D('prs', c.repo, x),
    backRow: back('Undo & Restore', D('home', c.repo)),
  });
  return ui.screen(ctx, `🟣 *Merged pull requests* — ${esc(c.repo)}\nPick one to undo\\.${r.items.length ? '' : '\n\n_No recently merged pull requests\\._'}`, rows);
}

async function prAsk(ctx, c, n, mode) {
  const pr = await core.get(c.token, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: c.owner, repo: c.repo, pull_number: n }, 'Get pull request');
  const extra = mode === 'force' ? '\n\n⚠️ Files changed since will be *overwritten*\\.' : mode === 'skip' ? '\n\nOnly files nobody touched since are put back\\.' : '';
  return ui.screen(ctx, `🟣 Undo *\\#${n}* — ${esc(trunc(pr.title, 120))}?\n\nA new commit on *${esc(pr.base.ref)}* reverses what the merge brought in\\. History isn’t rewritten\\.${extra}`, ui.confirmRows(mode === 'force' ? '⚠️ Yes, overwrite' : '↩️ Yes, undo it', D('pok', c.repo, n, mode), D('prs', c.repo, 1)));
}

async function prDo(ctx, c, n, mode) {
  if (mode === 'force' && (await held(ctx, c, 'revert_forced'))) return;
  let result = null;
  const lock = await actionLock.withLock(ctx.from.id, `revert:${c.repo}`, async () => { result = await revert.revertMergedPr(c.token, c.owner, c.repo, n, { mode }); });
  if (lock.skipped) return;
  if (!result.conflicts) noteSensitive(ctx, c, mode === 'force' ? 'revert_forced' : 'revert', `merged PR #${n} on ${result.pr.base}`);
  return showRevertOutcome(ctx, c, { result, target: result.pr.base, noun: 'pull request', label: `Undid merged PR #${n} on ${result.pr.base}`, retry: (m) => D('pask', c.repo, n, m) });
}

// ── Recover deleted ──────────────────────────────────────────────────────────

async function recoverList(ctx, c) {
  const items = await revert.listRecoverable(c.token, c.owner, c.repo, { telegramId: ctx.from.id });
  ctx.session.restoreRec = { repo: c.repo, items };
  const rows = items.map((it, i) => [plain(`${it.kind === 'tag' ? '🏷' : '🌿'} ${it.name} · ${ago(it.at)}`, D('recask', c.repo, i))]);
  rows.push(back('Undo & Restore', D('home', c.repo)));
  const note = items.length ? 'Pick one to bring back exactly as it was\\.' : '_Nothing deleted recently that can be recovered\\._\n\nBranch deletions come from GitHub’s own activity record; tags GitroHub deleted are remembered for 90 days\\.';
  return ui.screen(ctx, `♻️ *Recover deleted* — ${esc(c.repo)}\n${note}`, rows);
}

const recItem = (ctx, c, idx) => {
  const st = ctx.session && ctx.session.restoreRec;
  return st && st.repo === c.repo ? st.items[Number(idx)] || null : null;
};

async function recoverAsk(ctx, c, idx) {
  const it = recItem(ctx, c, idx);
  if (!it) return recoverList(ctx, c);
  return ui.screen(ctx, `♻️ Bring back ${it.kind} *${esc(it.name)}* at ${code(it.sha.slice(0, 7))}?`, ui.confirmRows('♻️ Yes, recover', D('recok', c.repo, idx), D('rec', c.repo)));
}

async function recoverDo(ctx, c, idx) {
  const it = recItem(ctx, c, idx);
  if (!it) return recoverList(ctx, c);
  await revert.restoreRef(c.token, c.owner, c.repo, it.kind, it.name, it.sha);
  if (it.journalId) await journal.markUndone(ctx.from.id, it.journalId).catch(() => {});
  ctx.session.restoreRec = null;
  return ui.screen(ctx, `✅ ${it.kind === 'tag' ? 'Tag' : 'Branch'} *${esc(it.name)}* is back at ${code(it.sha.slice(0, 7))}\\.`, [back('Undo & Restore', D('home', c.repo))]);
}

async function jrecover(ctx, c, id) {
  const j = await journal.get(ctx.from.id, id);
  if (!j || !j.prev_sha || !j.ref_name) return ui.screen(ctx, '⚠️ That entry is no longer available\\.', [back('Recent changes', D('recent', c.repo, 1))]);
  await revert.restoreRef(c.token, c.owner, c.repo, j.kind === 'tag_delete' ? 'tag' : 'branch', j.ref_name, j.prev_sha);
  await journal.markUndone(ctx.from.id, id);
  return ui.screen(ctx, `✅ *${esc(j.ref_name)}* is back at ${code(String(j.prev_sha).slice(0, 7))}\\.`, [back('Undo & Restore', D('home', c.repo))]);
}

// ── Router ───────────────────────────────────────────────────────────────────

async function handle(ctx, { action, args, repoName }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const sha = args[0];
  switch (action) {
    case 'home': return home(ctx, c);
    case 'recent': return recent(ctx, c, pageOf(args[0]));
    case 'jview': { const id = Number(args[0]); return Number.isInteger(id) ? jview(ctx, c, id) : undefined; }
    case 'rvask': { const [s, br, mode = 'strict', jid] = args; if (!SHA.test(s || '') || !MODES.has(mode)) return; return revAsk(ctx, c, s, br, mode, jid); }
    case 'rv': { const [s, br, mode = 'strict', jid] = args; if (!SHA.test(s || '') || !MODES.has(mode)) return; return revDo(ctx, c, s, br, mode, jid); }
    case 'ver': return versions(ctx, c, args[0], pageOf(args[1]));
    case 'vview': if (!SHA.test(sha || '')) return; return vview(ctx, c, sha, await targetBranch(ctx, c, args[1]));
    case 'gbask': { if (!SHA.test(sha || '')) return; const b = args[1]; return ui.screen(ctx, `🔙 Make *${esc(b)}* look exactly like ${code(sha.slice(0, 7))} again?\n\nOne new commit is added; later commits stay in history\\.`, ui.confirmRows('🔙 Yes, go back', D('gbok', c.repo, sha, b), D('vview', c.repo, sha, b))); }
    case 'gbok': if (!SHA.test(sha || '') || !args[1]) return; return goBackDo(ctx, c, sha, args[1]);
    case 'rbask': if (!SHA.test(sha || '') || !args[1]) return; return rollbackAsk(ctx, c, sha, args[1], 1);
    case 'rbask2': if (!SHA.test(sha || '') || !args[1]) return; return rollbackAsk(ctx, c, sha, args[1], 2);
    case 'rbok': if (!SHA.test(sha || '') || !args[1]) return; return rollbackDo(ctx, c, sha, args[1]);
    case 'unrollask': return unrollAsk(ctx, c, Number(args[0]));
    case 'unrollok': return unrollDo(ctx, c, Number(args[0]));
    case 'file': return fileAsk(ctx, c);
    case 'fileat': if (!SHA.test(sha || '')) return; return fileAsk(ctx, c, sha, dash(args[1]));
    case 'fhist': return fileHistory(ctx, c, pageOf(args[0]));
    case 'fpick': if (!SHA.test(sha || '')) return; return filePick(ctx, c, sha);
    case 'fok': if (!SHA.test(sha || '')) return; return fileDo(ctx, c, sha);
    case 'prs': return prs(ctx, c, pageOf(args[0]));
    case 'pview': case 'pask': { const n = Number(args[0]); const mode = args[1] || 'strict'; if (!Number.isInteger(n) || n < 1 || !MODES.has(mode)) return; return prAsk(ctx, c, n, mode); }
    case 'pok': { const n = Number(args[0]); const mode = args[1] || 'strict'; if (!Number.isInteger(n) || n < 1 || !MODES.has(mode)) return; return prDo(ctx, c, n, mode); }
    case 'rec': return recoverList(ctx, c);
    case 'recask': return recoverAsk(ctx, c, args[0]);
    case 'recok': return recoverDo(ctx, c, args[0]);
    case 'jrec': return jrecover(ctx, c, Number(args[0]));
    default: return ctx.reply('This button has expired.');
  }
}

/** Typed answers: the file path to restore. */
async function onInput(ctx, { action, args, repoName, text }) {
  const c = await repoCtx(ctx, repoName);
  if (!c) return;
  const path = cleanPath(text);
  if (action === 'filepath') {
    ctx.session.restoreFile = { repo: c.repo, path, branch: await targetBranch(ctx, c) };
    return fileHistory(ctx, c, 1);
  }
  if (action === 'fileatpath') {
    const [sha, br] = args;
    const branch = await targetBranch(ctx, c, br);
    ctx.session.restoreFile = { repo: c.repo, path, branch };
    return filePick(ctx, c, sha);
  }
}

module.exports = { key: 'restore', label: 'Undo & Restore', emoji: '⏪', level: 'repo', scopes: [], handle, onInput };
