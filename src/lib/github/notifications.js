/** GitHub notifications inbox (v1.2.4-multi). Needs `notifications` (or `repo`). */
const { page, mutate } = require('./core');

/** https://api.github.com/repos/o/r/pulls/5 → https://github.com/o/r/pull/5 (best effort; null if unrecognised). */
function htmlUrlFor(subjectUrl) {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/(issues|pulls|commits|releases)\/([^/?#]+)$/.exec(String(subjectUrl || ''));
  if (!m) return null;
  const [, o, r, kind, id] = m;
  const seg = { issues: 'issues', pulls: 'pull', commits: 'commit', releases: 'releases/tag' }[kind];
  return kind === 'releases' ? `https://github.com/${o}/${r}/releases` : `https://github.com/${o}/${r}/${seg}/${id}`;
}

const shape = (n) => {
  const m = /\/(issues|pulls)\/(\d+)$/.exec(String((n.subject && n.subject.url) || ''));
  return {
    id: n.id, unread: !!n.unread, reason: n.reason, title: n.subject && n.subject.title, type: n.subject && n.subject.type,
    repo: n.repository && n.repository.full_name, owner: n.repository && n.repository.owner && n.repository.owner.login, repoName: n.repository && n.repository.name,
    number: m ? Number(m[2]) : null, kind: m ? (m[1] === 'pulls' ? 'pull' : 'issue') : null,
    updatedAt: n.updated_at, url: htmlUrlFor(n.subject && n.subject.url),
  };
};

async function listNotifications(token, { all = false, participating = false, page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /notifications', { all, participating, page: pg, per_page: perPage }, 'List notifications');
  return { ...r, items: r.items.map(shape) };
}

const THREAD_ID = /^\d{1,20}$/;
const assertThread = (id) => { if (!THREAD_ID.test(String(id))) throw new Error('Invalid notification'); return String(id); };

async function markRead(token, threadId) {
  return mutate(token, 'PATCH /notifications/threads/{thread_id}', { thread_id: assertThread(threadId) }, 'Mark as read');
}

async function markAllRead(token) {
  return mutate(token, 'PUT /notifications', { last_read_at: new Date().toISOString(), read: true }, 'Mark all as read');
}

/** Stops further notifications from this thread (and marks it read). */
async function muteThread(token, threadId) {
  const id = assertThread(threadId);
  await mutate(token, 'PUT /notifications/threads/{thread_id}/subscription', { thread_id: id, ignored: true }, 'Mute thread');
  return markRead(token, id).catch(() => null);
}

module.exports = { htmlUrlFor, listNotifications, markRead, markAllRead, muteThread };
