/** Repo statistics and insights (v1.2.4-multi). */
const { get, getFull, getOrNull } = require('./core');

async function overview(token, owner, repo) {
  const r = await get(token, 'GET /repos/{owner}/{repo}', { owner, repo }, 'Get repo');
  return {
    fullName: r.full_name, stars: r.stargazers_count, forks: r.forks_count, watchers: r.subscribers_count != null ? r.subscribers_count : r.watchers_count,
    openIssues: r.open_issues_count, sizeKb: r.size, defaultBranch: r.default_branch, createdAt: r.created_at, pushedAt: r.pushed_at,
    license: r.license && r.license.spdx_id, archived: !!r.archived, isFork: !!r.fork, visibility: r.visibility || (r.private ? 'private' : 'public'),
  };
}

async function contributors(token, owner, repo, limit = 10) {
  const items = await getOrNull(token, 'GET /repos/{owner}/{repo}/contributors', { owner, repo, per_page: limit }, 'List contributors');
  return (items || []).map((c) => ({ login: c.login, contributions: c.contributions }));
}

/** Last 52 weeks of commit totals, oldest first; null while GitHub is still computing them (HTTP 202). */
async function commitActivity(token, owner, repo) {
  const res = await getFull(token, 'GET /repos/{owner}/{repo}/stats/commit_activity', { owner, repo }, 'Get commit activity');
  if (res.status === 202 || !Array.isArray(res.data) || res.data.length === 0) return null;
  return res.data.map((w) => w.total);
}

/** Views/clones for the last 14 days. Needs push access — returns null without it. */
async function traffic(token, owner, repo) {
  const safe = async (route, label) => {
    try { return await get(token, route, { owner, repo }, label); } catch (err) { if (err && (err.status === 403 || err.status === 404)) return null; throw err; }
  };
  const [views, clones, referrers, paths] = await Promise.all([
    safe('GET /repos/{owner}/{repo}/traffic/views', 'Get views'),
    safe('GET /repos/{owner}/{repo}/traffic/clones', 'Get clones'),
    safe('GET /repos/{owner}/{repo}/traffic/popular/referrers', 'Get referrers'),
    safe('GET /repos/{owner}/{repo}/traffic/popular/paths', 'Get popular paths'),
  ]);
  if (!views && !clones) return null;
  return {
    views: views ? { count: views.count, uniques: views.uniques } : null,
    clones: clones ? { count: clones.count, uniques: clones.uniques } : null,
    referrers: (referrers || []).slice(0, 5).map((r) => ({ name: r.referrer, count: r.count })),
    paths: (paths || []).slice(0, 5).map((p) => ({ path: p.path, count: p.count })),
  };
}

const BARS = '▁▂▃▄▅▆▇█';
/** Compact text chart: one character per value, scaled to the largest. */
function sparkline(values) {
  if (!values || !values.length) return '';
  const max = Math.max(...values);
  if (max <= 0) return BARS[0].repeat(values.length);
  return values.map((v) => BARS[Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))]).join('');
}

module.exports = { overview, contributors, commitActivity, traffic, sparkline };
