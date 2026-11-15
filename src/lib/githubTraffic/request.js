/**
 * Request description (v1.2.1-multi) — derives the internal metadata every
 * GitHub request carries (spec §7) from an Octokit request's options:
 * category, read/write, repo key, rate-limit resource, parallel-safety.
 *
 * Works on both route templates ("/repos/{owner}/{repo}/contents/{path}") and
 * already-expanded paths / absolute pagination URLs. The endpoint label that
 * ends up in logs and metrics is NORMALIZED so it never contains a user's
 * repository name or file path.
 */
// A literal '{' marks an unexpanded route placeholder. Spelled as an escape so naive brace-counting
// tools (scripts/check-patterns.js) aren't confused by a lone brace in a string.
const TEMPLATE_OPEN = '\u007b';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function pathOf(url) {
  return String(url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
}

function normalizeEndpoint(path) {
  const m = /^\/repos\/[^/]+\/[^/]+(\/.*)?$/.exec(path);
  if (!m) return path.replace(/\/[^/]*\d[^/]*/g, '/:id');
  let rest = m[1] || '';
  rest = rest.replace(/^(\/contents)\/.*/, '$1/:path').replace(/^(\/git\/(?:trees|commits|blobs|refs?))\/.*/, '$1/:sha');
  return `/repos/:owner/:repo${rest}`;
}

const CATEGORY_RULES = [
  [/^\/search\//, 'search'],
  [/^\/repos\/[^/]+\/[^/]+\/contents/, 'file'],
  [/^\/repos\/[^/]+\/[^/]+\/git\//, 'git'],
  [/^\/repos\/[^/]+\/[^/]+\/(issues|pulls\/[^/]+\/comments)/, 'issue'],
  [/^\/repos\/[^/]+\/[^/]+\/pulls/, 'pull'],
  [/^\/repos\/[^/]+\/[^/]+\/releases/, 'release'],
  [/^\/repos\/[^/]+\/[^/]+\/(actions|check-runs|check-suites)/, 'workflow'],
  [/^\/repos\/[^/]+\/[^/]+\/hooks/, 'hook'],
  [/^\/repos\/[^/]+\/[^/]+\/(zipball|tarball)/, 'download'],
  [/^\/repos\/[^/]+\/[^/]+(\/|$)/, 'repo'],
  [/^\/user\/(repos|starred)/, 'repo'],
  [/^\/user/, 'user'],
  [/^\/(rate_limit|licenses|meta)/, 'meta'],
];

function describeRequest(options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const raw = pathOf(options.url);
  const category = (CATEGORY_RULES.find(([re]) => re.test(raw)) || [null, 'other'])[1];
  let owner = options.owner; let repo = options.repo;
  if (!owner || !repo) {
    // Route templates carry unexpanded placeholders; only real values name a repo.
    const parts = raw.split('/');
    if (parts[1] === 'repos' && parts[2] && parts[3] && !parts[2].includes(TEMPLATE_OPEN) && !parts[3].includes(TEMPLATE_OPEN)) { owner = parts[2]; repo = parts[3]; }
  }
  const mutation = !READ_METHODS.has(method);
  return {
    method,
    template: raw,
    endpoint: normalizeEndpoint(raw),
    category,
    mutation,
    // Blob creation is content-addressed (same bytes → same sha): concurrent creation is safe and
    // retrying is harmless, so it must not be serialized behind other writes to the repo.
    parallelSafe: method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/git\/blobs$/.test(raw),
    repoKey: owner && repo ? `${String(owner).toLowerCase()}/${String(repo).toLowerCase()}` : null,
    resource: category === 'search' ? 'search' : raw.startsWith('/graphql') ? 'graphql' : 'core',
  };
}

module.exports = { describeRequest, normalizeEndpoint, pathOf };
