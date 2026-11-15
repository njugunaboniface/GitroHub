/** Code and issue search, "my work" queries (v1.2.4-multi). GitHub's search API: 30 requests/min, 10/min for code. */
const { page, clamp } = require('./core');

const TEXT_MATCH = { headers: { accept: 'application/vnd.github.text-match+json' } };
const QUALIFIER_SAFE = /^[A-Za-z0-9_.\-/]+$/;

/** scope: { type: 'owner', owner } | { type: 'repo', owner, repo } | { type: 'all' } */
function scopeQualifier(scope) {
  if (!scope || scope.type === 'all') return '';
  if (scope.type === 'repo' && QUALIFIER_SAFE.test(scope.owner) && QUALIFIER_SAFE.test(scope.repo)) return ` repo:${scope.owner}/${scope.repo}`;
  if (scope.type === 'owner' && QUALIFIER_SAFE.test(scope.owner)) return ` user:${scope.owner}`;
  throw new Error('Invalid search scope');
}

async function searchCode(token, query, scope, { page: pg = 1, perPage = 6 } = {}) {
  const q = clamp(query, 256).trim();
  if (q.length < 2) throw new Error('Type at least 2 characters to search for.');
  if (scope && scope.type === 'all' && !/\b(language|user|org|repo):/.test(q)) {
    throw Object.assign(new Error('Searching all of GitHub needs a narrowing filter, e.g. "language:js useEffect".'), { code: 'SEARCH_TOO_BROAD' });
  }
  const r = await page(token, 'GET /search/code', { q: `${q}${scopeQualifier(scope)}`, page: pg, per_page: perPage, ...TEXT_MATCH }, 'Search code');
  return {
    ...r,
    items: r.items.map((i) => ({
      path: i.path, repo: i.repository && i.repository.full_name, url: i.html_url, name: i.name,
      fragment: ((i.text_matches || [])[0] || {}).fragment || '',
    })),
  };
}

/** Issues / PRs across repos for the signed-in account: kind = pr | issue; role = assigned | authored | review | mentioned. */
async function myWork(token, kind, role, { page: pg = 1, perPage = 8 } = {}) {
  const type = kind === 'pr' ? 'is:pr' : 'is:issue';
  const who = { assigned: 'assignee:@me', authored: 'author:@me', review: 'review-requested:@me', mentioned: 'mentions:@me', changes: 'author:@me review:changes_requested', failing: 'author:@me status:failure' }[role];
  if (!who || (['review', 'changes', 'failing'].includes(role) && kind !== 'pr')) throw new Error('Unsupported filter');
  const r = await page(token, 'GET /search/issues', { q: `${type} is:open archived:false ${who}`, sort: 'updated', order: 'desc', page: pg, per_page: perPage }, 'Search your work');
  return {
    ...r,
    items: r.items.map((i) => {
      const m = /repos\/([^/]+)\/([^/]+)$/.exec(String(i.repository_url || ''));
      return { number: i.number, title: i.title, repo: m ? `${m[1]}/${m[2]}` : '', owner: m ? m[1] : null, repoName: m ? m[2] : null, url: i.html_url, isPull: !!i.pull_request, comments: i.comments, createdAt: i.created_at, updatedAt: i.updated_at };
    }),
  };
}

module.exports = { scopeQualifier, searchCode, myWork };
