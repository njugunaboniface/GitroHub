/**
 * Registers every ⚡ Manage (per repo) and 💼 Workspace (account) area, in the order they appear on the hubs.
 * Called once from createBot(); safe to call again (already-registered areas are skipped), and the
 * registry can be reset in tests.
 */
const registry = require('./registry');

const REPO_AREAS = ['pulls', 'issues', 'branches', 'commits', 'restore', 'releases', 'actions', 'access', 'security', 'insights', 'milestones'];
const ACCOUNT_AREAS = ['notifications', 'attention', 'mywork', 'gists', 'codesearch', 'projects', 'orgs', 'alerts', 'accounts', 'safety', 'restorecenter'];

function registerAll() {
  for (const file of [...REPO_AREAS, ...ACCOUNT_AREAS]) {
    const area = require(`./areas/${file}`);
    if (!registry.get(area.key)) registry.register(area);
  }
}

module.exports = { registerAll, REPO_AREAS, ACCOUNT_AREAS };
