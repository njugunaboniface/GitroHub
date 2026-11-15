/** Context helpers shared by every manage area (v1.2.4-multi). */
const requireConnected = require('../../lib/requireConnected');
const repoCache = require('../../lib/repoCache');

/**
 * { token, owner, repo, user } for a repo-level action, or null after the standard connect prompt.
 * `owner` is whoever My Repos is currently showing (the person, or the active organisation) — the same
 * owner every existing screen uses.
 */
async function repoCtx(ctx, repoName) {
  const token = await requireConnected(ctx);
  if (!token) return null;
  const user = await repoCache.getUser(ctx.from.id, token);
  return { token, owner: user.login, repo: repoName, user };
}

/** { token, user } for an account-level action, or null after the connect prompt. */
async function accountCtx(ctx) {
  const token = await requireConnected(ctx);
  if (!token) return null;
  const user = await repoCache.getUser(ctx.from.id, token);
  return { token, user, owner: user.login };
}

/** Per-repo working branch chosen in Manage → Branches (falls back to the repo's default). */
function workBranch(ctx, repoName, fallback = null) {
  const m = ctx.session && ctx.session.workBranch;
  return (m && m[repoName]) || fallback;
}

function setWorkBranch(ctx, repoName, branch) {
  ctx.session.workBranch = ctx.session.workBranch || {};
  if (branch) ctx.session.workBranch[repoName] = branch; else delete ctx.session.workBranch[repoName];
}

/** Integer from callback data, or null. */
const num = (v) => (/^\d{1,12}$/.test(String(v)) ? Number(v) : null);
/** Page number from callback data (≥ 1). */
const pageOf = (v) => Math.max(1, Math.min(500, num(v) || 1));

module.exports = { repoCtx, accountCtx, workBranch, setWorkBranch, num, pageOf };
