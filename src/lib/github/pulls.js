/** Pull requests (v1.2.4-multi). */
const { get, page, mutate, assertNumber, clamp } = require('./core');

const MERGE_METHODS = ['merge', 'squash', 'rebase'];
const REVIEW_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];

const shape = (p) => ({
  number: p.number, title: p.title, state: p.state, draft: !!p.draft, merged: !!p.merged || !!p.merged_at,
  author: p.user && p.user.login, head: p.head && p.head.ref, base: p.base && p.base.ref,
  headRepo: p.head && p.head.repo && p.head.repo.full_name,
  body: p.body || '', url: p.html_url, comments: p.comments, reviewComments: p.review_comments,
  commits: p.commits, additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files,
  mergeable: p.mergeable, mergeableState: p.mergeable_state, createdAt: p.created_at, updatedAt: p.updated_at, closedAt: p.closed_at, mergedAt: p.merged_at,
  labels: (p.labels || []).map((l) => l.name), assignees: (p.assignees || []).map((a) => a.login),
  requestedReviewers: (p.requested_reviewers || []).map((a) => a.login),
});

async function listPulls(token, owner, repo, { state = 'open', page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/pulls', { owner, repo, state, sort: 'updated', direction: 'desc', page: pg, per_page: perPage }, 'List pull requests');
  return { ...r, items: r.items.map(shape) };
}

async function getPull(token, owner, repo, number) {
  return shape(await get(token, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: assertNumber(number, 'pull request number') }, 'Get pull request'));
}

async function listPullFiles(token, owner, repo, number, { page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files', { owner, repo, pull_number: assertNumber(number, 'pull request number'), page: pg, per_page: perPage }, 'List pull request files');
  return { ...r, items: r.items.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch || '' })) };
}

async function listPullComments(token, owner, repo, number, { page: pg = 1, perPage = 5 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: assertNumber(number, 'pull request number'), page: pg, per_page: perPage }, 'List comments');
  return { ...r, items: r.items.map((c) => ({ id: c.id, author: c.user && c.user.login, body: c.body || '', createdAt: c.created_at })) };
}

async function listReviews(token, owner, repo, number) {
  const items = await get(token, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { owner, repo, pull_number: assertNumber(number, 'pull request number'), per_page: 30 }, 'List reviews');
  return items.map((r) => ({ author: r.user && r.user.login, state: r.state, body: r.body || '' }));
}

/** Merges. method: merge | squash | rebase. Verifies via the PR itself if the outcome is unknown. */
async function mergePull(token, owner, repo, number, method = 'merge', { title = null } = {}) {
  if (!MERGE_METHODS.includes(method)) throw new Error('Unknown merge method');
  const n = assertNumber(number, 'pull request number');
  return mutate(token, 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
    owner, repo, pull_number: n, merge_method: method, ...(title ? { commit_title: clamp(title, 200) } : {}),
  }, 'Merge pull request', async () => {
    const p = await get(token, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: n }, 'Verify merge');
    return p.merged ? { applied: true, value: { merged: true } } : { applied: false };
  });
}

async function setPullState(token, owner, repo, number, state) {
  if (!['open', 'closed'].includes(state)) throw new Error('Invalid state');
  const n = assertNumber(number, 'pull request number');
  return shape(await mutate(token, 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: n, state }, state === 'closed' ? 'Close pull request' : 'Reopen pull request', async () => {
    const p = await get(token, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: n }, 'Verify state');
    return p.state === state ? { applied: true, value: p } : { applied: false };
  }));
}

async function commentOnPull(token, owner, repo, number, body) {
  const text = clamp(body, 65000).trim();
  if (!text) throw new Error('A comment can’t be empty.');
  return mutate(token, 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: assertNumber(number, 'pull request number'), body: text }, 'Comment');
}

async function reviewPull(token, owner, repo, number, event, body = '') {
  if (!REVIEW_EVENTS.includes(event)) throw new Error('Unknown review type');
  const text = clamp(body, 65000).trim();
  if (event !== 'APPROVE' && !text) throw new Error('This kind of review needs a comment.');
  return mutate(token, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { owner, repo, pull_number: assertNumber(number, 'pull request number'), event, ...(text ? { body: text } : {}) }, 'Submit review');
}

async function createPull(token, owner, repo, { head, base, title, body = '', draft = false }) {
  const t = clamp(title, 256).trim();
  if (!t) throw new Error('A pull request needs a title.');
  if (!head || !base) throw new Error('Pick the branches first.');
  if (head === base) throw new Error('The two branches are the same.');
  return shape(await mutate(token, 'POST /repos/{owner}/{repo}/pulls', { owner, repo, head, base, title: t, body: clamp(body, 65000), draft: !!draft }, 'Create pull request', async () => {
    const open = await get(token, 'GET /repos/{owner}/{repo}/pulls', { owner, repo, head: `${owner}:${head}`, base, state: 'open', per_page: 1 }, 'Verify pull request');
    return open[0] ? { applied: true, value: open[0] } : { applied: false };
  }));
}

async function updatePullBranch(token, owner, repo, number) {
  return mutate(token, 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', { owner, repo, pull_number: assertNumber(number, 'pull request number') }, 'Update branch');
}

module.exports = { MERGE_METHODS, REVIEW_EVENTS, shape, listPulls, getPull, listPullFiles, listPullComments, listReviews, mergePull, setPullState, commentOnPull, reviewPull, createPull, updatePullBranch };
