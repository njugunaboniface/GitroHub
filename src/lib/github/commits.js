/** Commit history, commit diffs and revert (v1.2.4-multi). */
const { get, getOrNull, page, clamp } = require('./core');
const github = require('../github');
const { withAbortTimeout, client, reconcileUnknown } = github.internals;

const firstLine = (m) => String(m || '').split('\n')[0];

async function listCommits(token, owner, repo, { sha = null, path = null, page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/commits', { owner, repo, page: pg, per_page: perPage, ...(sha ? { sha } : {}), ...(path ? { path } : {}) }, 'List commits');
  return {
    ...r,
    items: r.items.map((c) => ({
      sha: c.sha, short: c.sha.slice(0, 7), message: firstLine(c.commit && c.commit.message),
      author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || 'unknown',
      date: c.commit && c.commit.author && c.commit.author.date, url: c.html_url,
    })),
  };
}

async function getCommit(token, owner, repo, ref) {
  const c = await get(token, 'GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref }, 'Get commit');
  // v1.2.5-multi: a merge commit's own file list is not reliable across GitHub responses; what a merge brought in is
  // exactly the difference between its first parent (the branch it landed on) and itself.
  if ((c.parents || []).length > 1) {
    const cmp = await get(token, 'GET /repos/{owner}/{repo}/compare/{basehead}', { owner, repo, basehead: `${c.parents[0].sha}...${c.sha}` }, 'Compare merge');
    c.files = cmp.files || [];
    c.stats = c.stats || { additions: c.files.reduce((n, f) => n + (f.additions || 0), 0), deletions: c.files.reduce((n, f) => n + (f.deletions || 0), 0) };
  }
  return {
    sha: c.sha, short: c.sha.slice(0, 7), message: (c.commit && c.commit.message) || '', url: c.html_url,
    author: (c.commit && c.commit.author && c.commit.author.name) || 'unknown', date: c.commit && c.commit.author && c.commit.author.date,
    parents: (c.parents || []).map((p) => p.sha),
    stats: c.stats || { additions: 0, deletions: 0, total: 0 },
    files: (c.files || []).map((f) => ({ filename: f.filename, previous: f.previous_filename || null, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch || '', sha: f.sha || null })),
  };
}

// ── Revert ───────────────────────────────────────────────────────────
const MAX_REVERT_FILES = 60;

/** Looks a path up in a tree by walking directory trees (cached): { sha, mode, type } or null. */
function makeTreeWalker(token, owner, repo, signal) {
  const cache = new Map();
  async function entries(treeSha) {
    if (cache.has(treeSha)) return cache.get(treeSha);
    const { data } = await client(token).request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { owner, repo, tree_sha: treeSha, request: { signal } });
    const map = new Map((data.tree || []).map((e) => [e.path, e]));
    cache.set(treeSha, map);
    return map;
  }
  return async function lookup(rootSha, path) {
    const parts = path.split('/');
    let sha = rootSha;
    for (let i = 0; i < parts.length; i++) {
      const e = (await entries(sha)).get(parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return { sha: e.sha, mode: e.mode, type: e.type };
      if (e.type !== 'tree') return null;
      sha = e.sha;
    }
    return null;
  };
}

/**
 * Reverts ONE commit on `branch` by adding a new commit that undoes it — history is never rewritten.
 * A file is only reverted if nobody changed it since; if any file changed afterwards the whole revert is
 * refused with the list of those files (no half-reverts). Merge commits are not supported.
 * Returns { sha } on success or { conflicts: [paths] } when refused.
 *
 * v1.2.5-multi `mode` (conflict help — what to do when files changed afterwards):
 *   'strict' (default)  refuse the whole revert and list the files
 *   'skip'              revert only the files nobody touched since; { sha, skipped: [paths] }
 *   'force'             put every file back, overwriting later edits to them; { sha, overwritten: [paths] }
 * A merge commit (a merged pull request) is reverted against its FIRST parent — the branch it landed on.
 */
async function revertCommit(token, owner, repo, sha, branch, { mode = 'strict' } = {}) {
  const commit = await getCommit(token, owner, repo, sha);
  if (commit.parents.length < 1 || commit.parents.length > 2) throw Object.assign(new Error('That commit can’t be reverted here (the very first commit has nothing to go back to, and octopus merges aren’t supported).'), { code: 'REVERT_UNSUPPORTED' });
  if (commit.files.length === 0) throw Object.assign(new Error('That commit changed no files.'), { code: 'REVERT_UNSUPPORTED' });
  if (commit.files.length > MAX_REVERT_FILES) throw Object.assign(new Error(`That commit touches ${commit.files.length} files — revert it from GitHub instead (limit here: ${MAX_REVERT_FILES}).`), { code: 'REVERT_UNSUPPORTED' });
  const parentSha = commit.parents[0];

  let newSha = null; let tipBefore = null; let stage = 'prepare';
  try {
    return await withAbortTimeout((signal) => (async () => {
      const octo = client(token);
      const req = async (route, params) => (await octo.request(route, { ...params, request: { signal } })).data;

      tipBefore = (await req('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${branch}` })).object.sha;
      const [headCommit, parentCommit] = await Promise.all([
        req('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { owner, repo, commit_sha: tipBefore }),
        req('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { owner, repo, commit_sha: parentSha }),
      ]);
      const lookup = makeTreeWalker(token, owner, repo, signal);
      const conflicts = []; const entries = [];

      for (const f of commit.files) {
        const newPath = f.filename;
        const oldPath = f.status === 'renamed' ? f.previous : f.filename;
        // state of the touched paths NOW (branch tip) must equal their state right after the commit
        const nowNew = await lookup(headCommit.tree.sha, newPath);
        const expectNewSha = f.status === 'removed' ? null : f.sha;
        if ((nowNew ? nowNew.sha : null) !== expectNewSha) { conflicts.push(newPath); if (mode !== 'force') continue; }
        if (f.status === 'renamed') {
          const nowOld = await lookup(headCommit.tree.sha, oldPath);
          if (nowOld) { conflicts.push(oldPath); if (mode !== 'force') continue; }
        }
        // what to put back: the file as it was in the parent (or remove it if the commit added it)
        if (f.status === 'added') { entries.push({ path: newPath, mode: '100644', type: 'blob', sha: null }); continue; }
        const before = await lookup(parentCommit.tree.sha, oldPath);
        if (!before || before.type !== 'blob') { conflicts.push(oldPath); continue; } // nothing to put back — never forced
        if (f.status === 'renamed') entries.push({ path: newPath, mode: '100644', type: 'blob', sha: null });
        entries.push({ path: oldPath, mode: before.mode, type: 'blob', sha: before.sha });
      }
      const conflicted = Array.from(new Set(conflicts));
      if (conflicted.length && mode === 'strict') return { conflicts: conflicted };
      if (!entries.length) return { conflicts: conflicted, nothingToRevert: true };

      const tree = await req('POST /repos/{owner}/{repo}/git/trees', { owner, repo, base_tree: headCommit.tree.sha, tree: entries });
      const created = await req('POST /repos/{owner}/{repo}/git/commits', {
        owner, repo, tree: tree.sha, parents: [tipBefore],
        message: `Revert "${clamp(firstLine(commit.message), 120)}"\n\nThis reverts commit ${commit.sha}.`,
      });
      newSha = created.sha;
      stage = 'ref';
      try {
        await req('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${branch}`, sha: newSha, force: false });
      } catch (err) {
        const notFf = err && err.status === 422 && /fast[- ]?forward/i.test(String(err.message));
        if (err && (err.status === 409 || notFf)) { err.code = 'GIT_REF_CONFLICT'; err.message = 'The branch changed while the revert was being prepared. Nothing was overwritten; please try again.'; }
        throw err;
      }
      return { sha: newSha, parent: tipBefore, ...(mode === 'skip' && conflicted.length ? { skipped: conflicted } : {}), ...(mode === 'force' && conflicted.length ? { overwritten: conflicted } : {}) };
    })(), 'Revert commit', 60000, { mutation: true });
  } catch (err) {
    if (stage !== 'ref') {
      if (err && err.outcome === 'unknown') { err.outcome = 'failed'; err.message = err.originalMessage || err.message; if (err.code === 'GITHUB_OUTCOME_UNKNOWN') err.code = err.reason || 'GITHUB_REQUEST_FAILED'; }
      throw err;
    }
    return reconcileUnknown(err, async () => {
      const tip = await getOrNull(token, 'GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${branch}` }, 'Verify revert');
      const now = tip && tip.object && tip.object.sha;
      if (now === newSha) return { applied: true, value: { sha: newSha, parent: tipBefore } };
      if (now === tipBefore) return { applied: false };
      return { applied: null };
    });
  }
}

module.exports = { listCommits, getCommit, revertCommit, makeTreeWalker, MAX_REVERT_FILES };
