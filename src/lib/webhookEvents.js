/**
 * GitHub webhook events → one-line alert summaries (v1.2.4-multi).
 *
 * Each event type has a stable `key` (the one a person toggles under 💼 Workspace → Alert types), a label,
 * and whether it is on by default. `describe(event, payload)` returns { key, summary } or null when the
 * event isn't worth a message. Summaries are PLAIN single-line text (the digest joins them and escapes at
 * send time); anything taken from the payload is shortened so a hostile title can't flood a chat.
 */
const MAX_TITLE = 80;
const MAX_COMMITS_SHOWN = 3;

const EVENT_DEFS = Object.freeze([
  { key: 'push', label: 'Pushes (with commits)', emoji: '⬆️', defaultOn: true },
  { key: 'issues', label: 'New issues', emoji: '🐞', defaultOn: true },
  { key: 'pull_request', label: 'New pull requests', emoji: '🔀', defaultOn: true },
  { key: 'release', label: 'Releases', emoji: '🚀', defaultOn: true },
  { key: 'workflow_run', label: 'CI results', emoji: '⚙️', defaultOn: true },
  { key: 'deployment_status', label: 'Deployments', emoji: '📦', defaultOn: true },
  { key: 'star', label: 'Stars', emoji: '⭐', defaultOn: true },
  { key: 'fork', label: 'Forks', emoji: '🍴', defaultOn: true },
  { key: 'create', label: 'Branches/tags created', emoji: '🌱', defaultOn: false },
  { key: 'delete', label: 'Branches/tags deleted', emoji: '🗑', defaultOn: false },
  { key: 'issue_comment', label: 'Comments', emoji: '💬', defaultOn: false },
  { key: 'pull_request_review', label: 'PR reviews', emoji: '👀', defaultOn: false },
]);
const KEYS = new Set(EVENT_DEFS.map((d) => d.key));
const defaultFor = (key) => { const d = EVENT_DEFS.find((x) => x.key === key); return d ? d.defaultOn : false; };

const clean = (s, n = MAX_TITLE) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const who = (u) => (u && u.login ? `@${clean(u.login, 40)}` : 'someone');
const refName = (ref) => clean(String(ref || '').replace(/^refs\/(heads|tags)\//, ''), 60);

/** v1.2.5-multi: where an alert points, so the digest can attach an "Open PR / issue / run" button. */
function linkFor(type, payload, extra) {
  const repoOwner = payload.repository && payload.repository.owner && payload.repository.owner.login;
  return { type, owner: repoOwner ? String(repoOwner).slice(0, 100) : null, ...extra };
}

function describe(event, payload) {
  const d = describeEvent(event, payload);
  if (!d) return d;
  try {
    switch (event) {
      case 'issues': d.link = linkFor('issue', payload, { number: Number(payload.issue.number), url: payload.issue.html_url }); break;
      case 'pull_request': d.link = linkFor('pr', payload, { number: Number(payload.pull_request.number), url: payload.pull_request.html_url }); break;
      case 'pull_request_review': d.link = linkFor('pr', payload, { number: Number(payload.pull_request.number), url: payload.pull_request.html_url }); break;
      case 'issue_comment': d.link = linkFor(payload.issue.pull_request ? 'pr' : 'issue', payload, { number: Number(payload.issue.number), url: payload.issue.html_url }); break;
      case 'workflow_run': d.link = linkFor('run', payload, { runId: Number(payload.workflow_run.id), url: payload.workflow_run.html_url }); break;
      default: break;
    }
  } catch (_) { /* a link is a bonus — never lose the alert over it */ }
  return d;
}

function describeEvent(event, payload) {
  if (!payload || typeof payload !== 'object') return null;
  switch (event) {
    case 'push': {
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      if (commits.length === 0 || payload.deleted) return null;
      const branch = refName(payload.ref);
      const shown = commits.slice(0, MAX_COMMITS_SHOWN).map((c) => clean(String(c && c.message || '').split('\n')[0], 50)).filter(Boolean);
      const more = commits.length - shown.length;
      const list = shown.length ? ` (${shown.join('; ')}${more > 0 ? `; +${more} more` : ''})` : '';
      return { key: 'push', summary: `${commits.length} new commit${commits.length === 1 ? '' : 's'} pushed${branch ? ` to ${branch}` : ''}${list}` };
    }
    case 'issues':
      if (payload.action !== 'opened' || !payload.issue) return null;
      return { key: 'issues', summary: `New issue: "${clean(payload.issue.title)}"` };
    case 'pull_request':
      if (payload.action !== 'opened' || !payload.pull_request) return null;
      return { key: 'pull_request', summary: `New PR: "${clean(payload.pull_request.title)}"` };
    case 'release':
      if (payload.action !== 'published' || !payload.release) return null;
      return { key: 'release', summary: `New release: ${clean(payload.release.tag_name, 60)}` };
    case 'workflow_run': {
      // Fires for every state change; only the final one is worth a message.
      if (payload.action !== 'completed' || !payload.workflow_run) return null;
      const c = payload.workflow_run.conclusion;
      const icon = c === 'success' ? '✅' : c === 'failure' ? '❌' : '⚠️';
      return { key: 'workflow_run', summary: `${icon} Workflow "${clean(payload.workflow_run.name, 60)}" ${clean(c, 20)}` };
    }
    case 'deployment_status':
      if (!payload.deployment_status) return null;
      return { key: 'deployment_status', summary: `Deployment ${clean(payload.deployment_status.state, 20)} → ${clean(payload.deployment_status.environment, 40)}` };
    case 'star':
      if (payload.action !== 'created') return null;
      return { key: 'star', summary: `⭐ ${who(payload.sender)} starred it${payload.repository && payload.repository.stargazers_count != null ? ` (${Number(payload.repository.stargazers_count)} total)` : ''}` };
    case 'fork':
      return { key: 'fork', summary: `🍴 ${who(payload.sender)} forked it` };
    case 'create':
      if (!payload.ref_type || !['branch', 'tag'].includes(payload.ref_type)) return null;
      return { key: 'create', summary: `New ${payload.ref_type}: ${clean(payload.ref, 60)}` };
    case 'delete':
      if (!payload.ref_type || !['branch', 'tag'].includes(payload.ref_type)) return null;
      return { key: 'delete', summary: `Deleted ${payload.ref_type}: ${clean(payload.ref, 60)}` };
    case 'issue_comment': {
      if (payload.action !== 'created' || !payload.issue) return null;
      const kind = payload.issue.pull_request ? 'PR' : 'issue';
      return { key: 'issue_comment', summary: `💬 ${who(payload.comment && payload.comment.user)} commented on ${kind} #${Number(payload.issue.number)}` };
    }
    case 'pull_request_review': {
      if (payload.action !== 'submitted' || !payload.pull_request) return null;
      const s = payload.review && payload.review.state;
      const verdict = s === 'approved' ? '✅ approved' : s === 'changes_requested' ? '🛑 requested changes on' : '💬 reviewed';
      return { key: 'pull_request_review', summary: `${who(payload.review && payload.review.user)} ${verdict} PR #${Number(payload.pull_request.number)}` };
    }
    default:
      return null;
  }
}

module.exports = { EVENT_DEFS, KEYS, defaultFor, describe };
