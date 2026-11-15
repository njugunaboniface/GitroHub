/** Organisations the signed-in account belongs to (v1.2.4-multi). Needs `read:org` for private memberships. */
const { get, page } = require('./core');

async function listOrgs(token, { page: pg = 1, perPage = 20 } = {}) {
  const r = await page(token, 'GET /user/orgs', { page: pg, per_page: perPage }, 'List organisations');
  return { ...r, items: r.items.map((o) => ({ login: o.login, description: o.description || '' })) };
}

/** The person's role in an org ('admin' | 'member') and whether they may create repos. */
async function membership(token, org) {
  const m = await get(token, 'GET /user/memberships/orgs/{org}', { org }, 'Get membership');
  return { role: m.role, state: m.state };
}

async function canCreateRepos(token, org) {
  const o = await get(token, 'GET /orgs/{org}', { org }, 'Get organisation');
  return { name: o.name || o.login, plan: o.plan && o.plan.name, canCreatePrivate: o.plan ? o.plan.private_repos > 0 || o.owned_private_repos != null : null };
}

module.exports = { listOrgs, membership, canCreateRepos };
