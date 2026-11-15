/** Branches, protection rules, fork sync (v1.2.4-multi). */
const { get, getOrNull, page, mutate, assertBranchName, clamp } = require('./core');

async function listBranches(token, owner, repo, { page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/branches', { owner, repo, page: pg, per_page: perPage }, 'List branches');
  return { ...r, items: r.items.map((b) => ({ name: b.name, sha: b.commit && b.commit.sha, protected: !!b.protected })) };
}

/** The commit sha a branch points at, or null when the branch doesn't exist. */
async function getBranchSha(token, owner, repo, branch) {
  const ref = await getOrNull(token, 'GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${branch}` }, 'Get branch');
  return ref && ref.object ? ref.object.sha : null;
}

async function createBranch(token, owner, repo, name, fromSha) {
  const branch = assertBranchName(name);
  if (!fromSha) throw new Error('No starting point for the new branch.');
  return mutate(token, 'POST /repos/{owner}/{repo}/git/refs', { owner, repo, ref: `refs/heads/${branch}`, sha: fromSha }, 'Create branch', async () => {
    const sha = await getBranchSha(token, owner, repo, branch);
    return sha === fromSha ? { applied: true, value: { ref: `refs/heads/${branch}` } } : { applied: false };
  });
}

async function deleteBranch(token, owner, repo, branch) {
  const name = assertBranchName(branch);
  const prevSha = await getBranchSha(token, owner, repo, name).catch(() => null); // remembered so it can be recovered
  try {
    const out = await mutate(token, 'DELETE /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${name}` }, 'Delete branch', async () => ({ applied: (await getBranchSha(token, owner, repo, name)) === null }));
    if (prevSha) { try { require('../changeJournal').record({ owner, repo, kind: 'branch_delete', ref: name, prevSha, label: `Deleted branch ${name}` }).catch(() => {}); } catch (_) { /* journal is best-effort */ } }
    return out;
  } catch (err) {
    if (err && (err.status === 404 || err.status === 422)) return null; // already gone
    throw err;
  }
}

async function renameBranch(token, owner, repo, branch, newName) {
  const to = assertBranchName(newName);
  return mutate(token, 'POST /repos/{owner}/{repo}/branches/{branch}/rename', { owner, repo, branch, new_name: to }, 'Rename branch');
}

async function setDefaultBranch(token, owner, repo, branch) {
  const name = assertBranchName(branch);
  return mutate(token, 'PATCH /repos/{owner}/{repo}', { owner, repo, default_branch: name }, 'Set default branch', async () => {
    const r = await get(token, 'GET /repos/{owner}/{repo}', { owner, repo }, 'Verify default branch');
    return r.default_branch === name ? { applied: true, value: r } : { applied: false };
  });
}

/** How `head` differs from `base`: { status, ahead, behind, commits[] } */
async function compare(token, owner, repo, base, head) {
  const d = await get(token, 'GET /repos/{owner}/{repo}/compare/{basehead}', { owner, repo, basehead: `${base}...${head}`, per_page: 8 }, 'Compare branches');
  return {
    status: d.status, ahead: d.ahead_by, behind: d.behind_by, total: d.total_commits,
    commits: (d.commits || []).slice(-8).map((c) => ({ sha: c.sha.slice(0, 7), message: String((c.commit && c.commit.message) || '').split('\n')[0] })),
    files: (d.files || []).length,
  };
}

// ── Branch protection ────────────────────────────────────────────────
/** Current rule, or null when the branch is unprotected. Throws a tagged error when the plan can't have rules. */
async function getProtection(token, owner, repo, branch) {
  try {
    return await get(token, 'GET /repos/{owner}/{repo}/branches/{branch}/protection', { owner, repo, branch }, 'Get branch protection');
  } catch (err) {
    if (err && err.status === 404 && /not protected/i.test(String(err.message))) return null;
    if (err && err.status === 403 && /upgrade|pro|public/i.test(String(err.message))) { err.code = 'PLAN_LIMIT'; }
    if (err && err.status === 404 && !/not protected/i.test(String(err.message))) { err.code = err.code || 'NO_ACCESS'; }
    throw err;
  }
}

/** The editable subset we expose, from a GET response (or defaults for none). */
function summarizeProtection(p) {
  if (!p) return { protected: false, reviews: 0, dismissStale: false, codeOwners: false, statusChecks: false, enforceAdmins: false, forcePush: true, deletions: true, linear: false, conversation: false };
  const rev = p.required_pull_request_reviews;
  return {
    protected: true,
    reviews: rev ? rev.required_approving_review_count || 0 : 0,
    requirePr: !!rev,
    dismissStale: !!(rev && rev.dismiss_stale_reviews),
    codeOwners: !!(rev && rev.require_code_owner_reviews),
    statusChecks: !!p.required_status_checks,
    enforceAdmins: !!(p.enforce_admins && p.enforce_admins.enabled),
    forcePush: !!(p.allow_force_pushes && p.allow_force_pushes.enabled),
    deletions: !!(p.allow_deletions && p.allow_deletions.enabled),
    linear: !!(p.required_linear_history && p.required_linear_history.enabled),
    conversation: !!(p.required_conversation_resolution && p.required_conversation_resolution.enabled),
  };
}

/** Builds the PUT body from the current rule so changing ONE setting never resets the others. */
function protectionBody(current, changes = {}) {
  const s = { ...summarizeProtection(current), ...changes };
  const rev = current && current.required_pull_request_reviews;
  const sc = current && current.required_status_checks;
  const restrictions = current && current.restrictions;
  const wantsPr = s.requirePr !== undefined ? s.requirePr : s.reviews > 0;
  return {
    required_status_checks: s.statusChecks ? { strict: !!(sc && sc.strict), contexts: (sc && (sc.contexts || (sc.checks || []).map((c) => c.context))) || [] } : null,
    enforce_admins: !!s.enforceAdmins,
    required_pull_request_reviews: wantsPr ? {
      required_approving_review_count: Math.max(1, Math.min(6, Number(s.reviews) || 1)),
      dismiss_stale_reviews: !!s.dismissStale,
      require_code_owner_reviews: !!s.codeOwners,
      ...(rev && rev.dismissal_restrictions ? {} : {}),
    } : null,
    restrictions: restrictions ? {
      users: (restrictions.users || []).map((u) => u.login), teams: (restrictions.teams || []).map((t) => t.slug), apps: (restrictions.apps || []).map((a) => a.slug),
    } : null,
    required_linear_history: !!s.linear,
    allow_force_pushes: !!s.forcePush,
    allow_deletions: !!s.deletions,
    required_conversation_resolution: !!s.conversation,
  };
}

async function setProtection(token, owner, repo, branch, current, changes) {
  return mutate(token, 'PUT /repos/{owner}/{repo}/branches/{branch}/protection', { owner, repo, branch, ...protectionBody(current, changes) }, 'Update branch protection');
}

async function removeProtection(token, owner, repo, branch) {
  try {
    return await mutate(token, 'DELETE /repos/{owner}/{repo}/branches/{branch}/protection', { owner, repo, branch }, 'Remove branch protection');
  } catch (err) { if (err && err.status === 404) return null; throw err; }
}

// ── Fork sync ────────────────────────────────────────────────────────
/** For a fork: how far it is from its parent (or null when it isn't a fork). */
async function forkStatus(token, owner, repo) {
  const r = await get(token, 'GET /repos/{owner}/{repo}', { owner, repo }, 'Get repo');
  if (!r.fork || !r.parent) return null;
  const branch = r.default_branch;
  const parentBranch = r.parent.default_branch;
  const cmp = await get(token, 'GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner: r.parent.owner.login, repo: r.parent.name, basehead: `${parentBranch}...${owner}:${branch}`,
  }, 'Compare with upstream');
  return { parent: r.parent.full_name, branch, ahead: cmp.ahead_by, behind: cmp.behind_by, status: cmp.status };
}

/** Pulls the parent's changes into the fork's branch. Fast-forward only; conflicts are reported, never forced. */
async function syncFork(token, owner, repo, branch) {
  const name = assertBranchName(branch);
  try {
    const data = await mutate(token, 'POST /repos/{owner}/{repo}/merge-upstream', { owner, repo, branch: name }, 'Sync fork');
    return { merged: true, message: data && data.message ? clamp(data.message, 200) : 'Synced', mergeType: data && data.merge_type };
  } catch (err) {
    if (err && err.status === 409) { err.code = 'SYNC_CONFLICT'; err.message = 'The fork has its own commits that conflict with upstream, so GitHub can’t fast-forward it. Nothing was changed.'; }
    throw err;
  }
}

module.exports = {
  listBranches, getBranchSha, createBranch, deleteBranch, renameBranch, setDefaultBranch, compare,
  getProtection, summarizeProtection, protectionBody, setProtection, removeProtection, forkStatus, syncFork,
};
