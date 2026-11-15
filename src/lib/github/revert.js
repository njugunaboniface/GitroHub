/**
 * Advanced undo (v1.2.5-multi): restore a file, go back to a version, roll a branch back (with a backup),
 * recover a deleted branch or tag, revert a merged pull request.
 *
 * Principles
 *   • History is never rewritten except by `rollbackBranch`, which makes a backup branch FIRST, refuses protected
 *     branches, and refuses a point that isn't an earlier commit of the same branch.
 *   • Every write that moves a branch is a fast-forward (force:false) so a concurrent push is never discarded.
 *   • Every function answers honestly when there is nothing to do ({ unchanged: true }) instead of making an empty commit.
 */
const { get, getOrNull, page, mutate, assertBranchName, clamp } = require('./core');
const github = require('../github');
const commits = require('./commits');
const branches = require('./branches');
const journal = require('../changeJournal');
const { withAbortTimeout, client, reconcileUnknown } = github.internals;

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const err = (message, code) => Object.assign(new Error(message), { code });
const firstLine = (m) => String(m || '').split('\n')[0];

/** Buttons carry 7-character shas; the git data API wants the full 40. */
async function fullCommit(req, owner, repo, sha) {
  if (String(sha).length === 40) return req('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { owner, repo, commit_sha: sha });
  const c = await req('GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref: sha });
  return req('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { owner, repo, commit_sha: c.sha });
}

/**
 * Makes ONE new commit on `branch` whose tree comes from `build`, then fast-forwards the branch to it.
 * build({ req, headCommit, lookup }) → { tree } (a complete tree sha) | { entries } (changes on top of the tip)
 *                                       | { result } (answer without committing)  — plus `message`.
 */
async function commitOnBranch(token, owner, repo, branch, build, label) {
  let newSha = null; let tipBefore = null; let stage = 'prepare';
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      const req = async (route, params) => (await octo.request(route, { ...params, request: { signal } })).data;
      tipBefore = (await req('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${branch}` })).object.sha;
      const headCommit = await req('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { owner, repo, commit_sha: tipBefore });
      const lookup = commits.makeTreeWalker(token, owner, repo, signal);
      const plan = await build({ req, headCommit, lookup });
      if (plan.result) return plan.result;
      const treeSha = plan.tree || (await req('POST /repos/{owner}/{repo}/git/trees', { owner, repo, base_tree: headCommit.tree.sha, tree: plan.entries })).sha;
      if (treeSha === headCommit.tree.sha) return { unchanged: true };
      const created = await req('POST /repos/{owner}/{repo}/git/commits', { owner, repo, tree: treeSha, parents: [tipBefore], message: plan.message });
      newSha = created.sha;
      stage = 'ref';
      try {
        await req('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${branch}`, sha: newSha, force: false });
      } catch (e) {
        const notFf = e && e.status === 422 && /fast[- ]?forward/i.test(String(e.message));
        if (e && (e.status === 409 || notFf)) { e.code = 'GIT_REF_CONFLICT'; e.message = 'The branch changed while this was being prepared. Nothing was overwritten; please try again.'; }
        throw e;
      }
      return { sha: newSha, parent: tipBefore };
    })(), label, 60000, { mutation: true });
  } catch (e) {
    if (stage !== 'ref') {
      if (e && e.outcome === 'unknown') { e.outcome = 'failed'; e.message = e.originalMessage || e.message; if (e.code === 'GITHUB_OUTCOME_UNKNOWN') e.code = e.reason || 'GITHUB_REQUEST_FAILED'; }
      throw e;
    }
    return reconcileUnknown(e, async () => {
      const tip = await getOrNull(token, 'GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${branch}` }, 'Verify change');
      const now = tip && tip.object && tip.object.sha;
      if (now === newSha) return { applied: true, value: { sha: newSha, parent: tipBefore } };
      if (now === tipBefore) return { applied: false };
      return { applied: null };
    });
  }
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Commits that touched `path` on `branch`, newest first: { items:[{sha,short,message,author,date}], hasNext }. */
async function fileHistory(token, owner, repo, path, branch, pg = 1) {
  return commits.listCommits(token, owner, repo, { sha: branch || null, path, page: pg });
}

/**
 * Puts `path` back to how it was at commit `fromSha`, as a NEW commit on `branch`.
 * → { sha } | { unchanged: true } | { missing: true } (the file didn't exist at that version)
 */
async function restoreFile(token, owner, repo, branch, path, fromSha) {
  if (!SHA_RE.test(String(fromSha || ''))) throw err('That version isn’t valid.', 'BAD_REF');
  const clean = String(path || '').replace(/^\/+/, '');
  if (!clean || clean.length > 500 || clean.split('/').includes('..')) throw err('That file path isn’t valid.', 'BAD_REF');
  return commitOnBranch(token, owner, repo, branch, async ({ req, headCommit, lookup }) => {
    const target = await fullCommit(req, owner, repo, fromSha);
    const then = await lookup(target.tree.sha, clean);
    if (!then || then.type !== 'blob') return { result: { missing: true } };
    const now = await lookup(headCommit.tree.sha, clean);
    if (now && now.sha === then.sha) return { result: { unchanged: true } };
    return { entries: [{ path: clean, mode: then.mode, type: 'blob', sha: then.sha }], message: `Restore ${clamp(clean, 100)} to ${String(fromSha).slice(0, 7)}\n\nRestored with GitroHub.` };
  }, 'Restore file');
}

/** Makes the branch's content match commit `sha` again, as ONE new commit (nothing is erased; undo is another revert). */
async function revertToCommit(token, owner, repo, branch, sha) {
  if (!SHA_RE.test(String(sha || ''))) throw err('That version isn’t valid.', 'BAD_REF');
  return commitOnBranch(token, owner, repo, branch, async ({ req }) => {
    const target = await fullCommit(req, owner, repo, sha);
    return { tree: target.tree.sha, message: `Go back to ${String(sha).slice(0, 7)}: ${clamp(firstLine(target.message), 100)}\n\nThe branch content now matches ${target.sha}. Done with GitroHub.` };
  }, 'Go back to version');
}

// ── Branch rollback (the one history-rewriting action) ───────────────────────

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

/**
 * Moves `branch` back to the earlier commit `sha` (force update), after saving where it was on a new
 * `backup/<branch>-<time>` branch. Refused on protected branches and for a commit that isn't an earlier point of THIS branch.
 * → { backup, from, to } | { unchanged: true }
 */
async function rollbackBranch(token, owner, repo, branch, sha) {
  const name = assertBranchName(branch);
  if (!SHA_RE.test(String(sha || ''))) throw err('That version isn’t valid.', 'BAD_REF');
  const info = await get(token, 'GET /repos/{owner}/{repo}/branches/{branch}', { owner, repo, branch: name }, 'Get branch');
  if (info.protected) throw err(`${name} is a protected branch, so it can’t be rolled back from here. Use “Go back to this version” instead — it adds a commit and rewrites nothing.`, 'BRANCH_PROTECTED');
  const tip = info.commit.sha;
  const full = (await get(token, 'GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref: sha }, 'Get commit')).sha; // buttons carry 7 characters
  const cmp = await get(token, 'GET /repos/{owner}/{repo}/compare/{basehead}', { owner, repo, basehead: `${tip}...${full}` }, 'Compare');
  if (cmp.status === 'identical') return { unchanged: true };
  if (cmp.status !== 'behind') throw err('That version isn’t an earlier point of this branch, so it can’t be rolled back to.', 'NOT_ANCESTOR');
  const backup = `backup/${name}-${stamp()}`.slice(0, 190);
  await branches.createBranch(token, owner, repo, backup, tip);
  await mutate(token, 'PATCH /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${name}`, sha: full, force: true }, 'Roll back branch', async () => {
    const now = await branches.getBranchSha(token, owner, repo, name);
    return now === full ? { applied: true, value: {} } : now === tip ? { applied: false } : { applied: null };
  });
  await journal.record({ owner, repo, kind: 'rollback', ref: name, sha: full, prevSha: tip, label: `Rolled ${name} back to ${full.slice(0, 7)} (backup: ${backup})` });
  return { backup, from: tip, to: full };
}

/** Fast-forwards `branch` to `sha` (never forced). Used to undo a rollback: the old tip is ahead of where the branch is now. */
async function fastForward(token, owner, repo, branch, sha) {
  const name = assertBranchName(branch);
  const now = await branches.getBranchSha(token, owner, repo, name);
  if (now === sha) return { unchanged: true };
  await mutate(token, 'PATCH /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${name}`, sha, force: false }, 'Move branch', async () => {
    const cur = await branches.getBranchSha(token, owner, repo, name);
    return cur === sha ? { applied: true, value: {} } : cur === now ? { applied: false } : { applied: null };
  });
  return { sha };
}

// ── Recover deleted branches / tags, and undo a rollback ─────────────────────

/** Creates `refs/heads|tags/<name>` at `sha`. Refuses when the name is taken. */
async function restoreRef(token, owner, repo, kind, name, sha) {
  if (!SHA_RE.test(String(sha || '')) || String(sha).length < 40) throw err('The saved position is incomplete, so it can’t be restored.', 'BAD_REF');
  const isTag = kind === 'tag';
  const ref = isTag ? `tags/${name}` : `heads/${assertBranchName(name)}`;
  const exists = await getOrNull(token, 'GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref }, 'Check name');
  if (exists) throw err(`A ${isTag ? 'tag' : 'branch'} called ${name} exists again, so there is nothing to recover.`, 'REF_EXISTS');
  return mutate(token, 'POST /repos/{owner}/{repo}/git/refs', { owner, repo, ref: `refs/${ref}`, sha }, isTag ? 'Recover tag' : 'Recover branch', async () => {
    const r = await getOrNull(token, 'GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref }, 'Verify recovery');
    return r && r.object && r.object.sha === sha ? { applied: true, value: {} } : { applied: false };
  });
}

/**
 * Branches that were deleted and no longer exist: from GitHub's repository activity (works for deletions made
 * anywhere) merged with the ones GitroHub deleted itself (the journal, which also covers tags).
 * → [{ kind:'branch'|'tag', name, sha, at, by, journalId }]
 */
async function listRecoverable(token, owner, repo, { telegramId }) {
  const found = new Map();
  const act = await getOrNull(token, 'GET /repos/{owner}/{repo}/activity', { owner, repo, activity_type: 'branch_deletion', per_page: 30 }, 'Repository activity').catch(() => null);
  for (const a of Array.isArray(act) ? act : []) {
    const name = String(a.ref || '').replace(/^refs\/heads\//, '');
    if (!name || !a.before || /^0+$/.test(a.before) || found.has(`branch:${name}`)) continue;
    found.set(`branch:${name}`, { kind: 'branch', name, sha: a.before, at: a.timestamp, by: a.actor && a.actor.login, journalId: null });
  }
  const mine = await journal.list(telegramId, owner, repo, { kinds: ['branch_delete', 'tag_delete'], limit: 20 });
  for (const j of mine.items) {
    const kind = j.kind === 'tag_delete' ? 'tag' : 'branch';
    if (!j.ref_name || !j.prev_sha) continue;
    found.set(`${kind}:${j.ref_name}`, { kind, name: j.ref_name, sha: j.prev_sha, at: j.created_at, by: 'you', journalId: Number(j.id) });
  }
  const out = [];
  for (const item of found.values()) {
    if (out.length >= 10) break;
    const ref = item.kind === 'tag' ? `tags/${item.name}` : `heads/${item.name}`;
    const now = await getOrNull(token, 'GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref }, 'Check name').catch(() => ({}));
    if (!now) out.push(item); // 404 → still gone
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// ── Merged pull requests ─────────────────────────────────────────────────────

/** Recently merged PRs: { items:[{number,title,base,mergedAt,by,sha}], hasNext }. */
async function listMergedPrs(token, owner, repo, pg = 1) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/pulls', { owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 20, page: pg }, 'List merged PRs');
  const items = r.items.filter((p) => p.merged_at).slice(0, 8).map((p) => ({ number: p.number, title: p.title, base: p.base && p.base.ref, mergedAt: p.merged_at, by: p.user && p.user.login, sha: p.merge_commit_sha }));
  return { items, hasNext: r.hasNext };
}

/**
 * Reverts a merged pull request on the branch it was merged into. Works for merge commits and squash merges.
 * A rebase merge (several commits) is explained instead of half-reverted.
 * → what `revertCommit` returns, plus { pr: { number, base } }
 */
async function revertMergedPr(token, owner, repo, number, { mode = 'strict' } = {}) {
  const pr = await get(token, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: number }, 'Get pull request');
  if (!pr.merged || !pr.merge_commit_sha) throw err('That pull request was never merged, so there is nothing to undo.', 'REVERT_UNSUPPORTED');
  const base = pr.base && pr.base.ref;
  const commit = await commits.getCommit(token, owner, repo, pr.merge_commit_sha);
  if (commit.parents.length === 1) {
    const prSize = (pr.additions || 0) + (pr.deletions || 0);
    if (prSize && commit.stats && commit.stats.total && commit.stats.total !== prSize) {
      throw err(`#${number} was merged by rebasing its ${pr.commits || 'several'} commits onto ${base}, so it has no single commit to undo. Use “Go back to a version” or revert its commits one by one.`, 'REVERT_UNSUPPORTED');
    }
  }
  const out = await commits.revertCommit(token, owner, repo, pr.merge_commit_sha, base, { mode });
  return { ...out, pr: { number, base, title: pr.title } };
}

module.exports = { commitOnBranch, fileHistory, restoreFile, revertToCommit, rollbackBranch, restoreRef, fastForward, listRecoverable, listMergedPrs, revertMergedPr, SHA_RE };
