/** Issues, labels, assignees, milestones (v1.2.4-multi). */
const { get, page, mutate, assertNumber, clamp } = require('./core');

const shape = (i) => ({
  number: i.number, title: i.title, state: i.state, stateReason: i.state_reason || null,
  author: i.user && i.user.login, body: i.body || '', url: i.html_url, comments: i.comments,
  labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
  assignees: (i.assignees || []).map((a) => a.login), milestone: i.milestone ? { number: i.milestone.number, title: i.milestone.title } : null,
  isPull: !!i.pull_request, createdAt: i.created_at, updatedAt: i.updated_at,
});

/** The issues endpoint also returns pull requests — they are filtered out here. */
async function listIssues(token, owner, repo, { state = 'open', labels = null, assignee = null, milestone = null, page: pg = 1, perPage = 10 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/issues', {
    owner, repo, state, sort: 'updated', direction: 'desc', page: pg, per_page: perPage,
    ...(labels ? { labels } : {}), ...(assignee ? { assignee } : {}), ...(milestone ? { milestone } : {}),
  }, 'List issues');
  return { ...r, items: r.items.filter((i) => !i.pull_request).map(shape) };
}

async function getIssue(token, owner, repo, number) {
  return shape(await get(token, 'GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: assertNumber(number, 'issue number') }, 'Get issue'));
}

async function listIssueComments(token, owner, repo, number, { page: pg = 1, perPage = 5 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: assertNumber(number, 'issue number'), page: pg, per_page: perPage }, 'List comments');
  return { ...r, items: r.items.map((c) => ({ id: c.id, author: c.user && c.user.login, body: c.body || '', createdAt: c.created_at })) };
}

async function createIssue(token, owner, repo, { title, body = '', labels = [], assignees = [], milestone = null }) {
  const t = clamp(title, 256).trim();
  if (!t) throw new Error('An issue needs a title.');
  return shape(await mutate(token, 'POST /repos/{owner}/{repo}/issues', {
    owner, repo, title: t, body: clamp(body, 65000), ...(labels.length ? { labels } : {}), ...(assignees.length ? { assignees } : {}), ...(milestone ? { milestone } : {}),
  }, 'Create issue', async () => {
    const recent = await get(token, 'GET /repos/{owner}/{repo}/issues', { owner, repo, state: 'open', sort: 'created', direction: 'desc', per_page: 5 }, 'Verify issue');
    const mine = recent.find((i) => !i.pull_request && i.title === t && Date.now() - Date.parse(i.created_at) < 10 * 60 * 1000);
    return mine ? { applied: true, value: mine } : { applied: false };
  }));
}

async function commentOnIssue(token, owner, repo, number, body) {
  const text = clamp(body, 65000).trim();
  if (!text) throw new Error('A comment can’t be empty.');
  return mutate(token, 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: assertNumber(number, 'issue number'), body: text }, 'Comment');
}

/** state: open | closed; reason (closing only): completed | not_planned. */
async function setIssueState(token, owner, repo, number, state, reason = null) {
  if (!['open', 'closed'].includes(state)) throw new Error('Invalid state');
  const n = assertNumber(number, 'issue number');
  return shape(await mutate(token, 'PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
    owner, repo, issue_number: n, state, ...(state === 'closed' && reason ? { state_reason: reason } : {}),
  }, state === 'closed' ? 'Close issue' : 'Reopen issue', async () => {
    const i = await get(token, 'GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: n }, 'Verify state');
    return i.state === state ? { applied: true, value: i } : { applied: false };
  }));
}

async function listLabels(token, owner, repo) {
  const items = await get(token, 'GET /repos/{owner}/{repo}/labels', { owner, repo, per_page: 100 }, 'List labels');
  return items.map((l) => ({ name: l.name, color: l.color, description: l.description || '' }));
}

async function createLabel(token, owner, repo, name, color = 'ededed', description = '') {
  const n = clamp(name, 50).trim();
  if (!n) throw new Error('A label needs a name.');
  const c = String(color || 'ededed').replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(c)) throw new Error('Colour must be 6 hex digits, like ff8800.');
  return mutate(token, 'POST /repos/{owner}/{repo}/labels', { owner, repo, name: n, color: c, description: clamp(description, 100) }, 'Create label');
}

async function addLabel(token, owner, repo, number, label) {
  return mutate(token, 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { owner, repo, issue_number: assertNumber(number, 'issue number'), labels: [label] }, 'Add label');
}

async function removeLabel(token, owner, repo, number, label) {
  try {
    return await mutate(token, 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { owner, repo, issue_number: assertNumber(number, 'issue number'), name: label }, 'Remove label');
  } catch (err) { if (err && err.status === 404) return null; throw err; } // already gone = done
}

async function listAssignable(token, owner, repo) {
  const items = await get(token, 'GET /repos/{owner}/{repo}/assignees', { owner, repo, per_page: 50 }, 'List assignees');
  return items.map((u) => u.login);
}

async function addAssignee(token, owner, repo, number, login) {
  return mutate(token, 'POST /repos/{owner}/{repo}/issues/{issue_number}/assignees', { owner, repo, issue_number: assertNumber(number, 'issue number'), assignees: [login] }, 'Assign');
}

async function removeAssignee(token, owner, repo, number, login) {
  return mutate(token, 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees', { owner, repo, issue_number: assertNumber(number, 'issue number'), assignees: [login] }, 'Unassign');
}

// ── Milestones ───────────────────────────────────────────────────────
const shapeMilestone = (m) => ({
  number: m.number, title: m.title, state: m.state, description: m.description || '', open: m.open_issues, closed: m.closed_issues,
  dueOn: m.due_on, url: m.html_url,
});

async function listMilestones(token, owner, repo, { state = 'open', page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/milestones', { owner, repo, state, sort: 'due_on', direction: 'asc', page: pg, per_page: perPage }, 'List milestones');
  return { ...r, items: r.items.map(shapeMilestone) };
}

async function getMilestone(token, owner, repo, number) {
  return shapeMilestone(await get(token, 'GET /repos/{owner}/{repo}/milestones/{milestone_number}', { owner, repo, milestone_number: assertNumber(number, 'milestone number') }, 'Get milestone'));
}

async function createMilestone(token, owner, repo, { title, description = '', dueOn = null }) {
  const t = clamp(title, 255).trim();
  if (!t) throw new Error('A milestone needs a title.');
  return shapeMilestone(await mutate(token, 'POST /repos/{owner}/{repo}/milestones', { owner, repo, title: t, description: clamp(description, 2000), ...(dueOn ? { due_on: dueOn } : {}) }, 'Create milestone'));
}

async function setMilestoneState(token, owner, repo, number, state) {
  if (!['open', 'closed'].includes(state)) throw new Error('Invalid state');
  return shapeMilestone(await mutate(token, 'PATCH /repos/{owner}/{repo}/milestones/{milestone_number}', { owner, repo, milestone_number: assertNumber(number, 'milestone number'), state }, 'Update milestone'));
}

async function deleteMilestone(token, owner, repo, number) {
  return mutate(token, 'DELETE /repos/{owner}/{repo}/milestones/{milestone_number}', { owner, repo, milestone_number: assertNumber(number, 'milestone number') }, 'Delete milestone');
}

/** Sets (or clears with null) an issue's/PR's milestone. */
async function setIssueMilestone(token, owner, repo, number, milestoneNumber) {
  return mutate(token, 'PATCH /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: assertNumber(number, 'issue number'), milestone: milestoneNumber == null ? null : assertNumber(milestoneNumber, 'milestone number') }, 'Set milestone');
}

module.exports = {
  shape, listIssues, getIssue, listIssueComments, createIssue, commentOnIssue, setIssueState,
  listLabels, createLabel, addLabel, removeLabel, listAssignable, addAssignee, removeAssignee,
  listMilestones, getMilestone, createMilestone, setMilestoneState, deleteMilestone, setIssueMilestone,
};
