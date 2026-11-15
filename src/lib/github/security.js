/** Dependabot / code scanning / secret scanning alerts (v1.2.4-multi). Read-mostly. */
const { get, page, mutate, assertNumber } = require('./core');

const DISMISS_REASONS = ['fix_started', 'inaccurate', 'no_bandwidth', 'not_used', 'tolerable_risk'];
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3 };

/** Runs a read; a 403/404 means "not enabled / not allowed on this repo" — reported as { disabled: true }. */
async function orDisabled(fn) {
  try { return await fn(); } catch (err) {
    if (err && (err.status === 403 || err.status === 404)) return { disabled: true, items: [], hasNext: false, reason: String(err.message || '').slice(0, 160) };
    throw err;
  }
}

const shapeDependabot = (a) => ({
  number: a.number, state: a.state,
  severity: (a.security_advisory && a.security_advisory.severity) || 'unknown',
  summary: (a.security_advisory && a.security_advisory.summary) || '',
  ghsa: a.security_advisory && a.security_advisory.ghsa_id,
  package: a.dependency && a.dependency.package && a.dependency.package.name,
  ecosystem: a.dependency && a.dependency.package && a.dependency.package.ecosystem,
  manifest: a.dependency && a.dependency.manifest_path,
  fixedIn: a.security_vulnerability && a.security_vulnerability.first_patched_version && a.security_vulnerability.first_patched_version.identifier,
  vulnerableRange: a.security_vulnerability && a.security_vulnerability.vulnerable_version_range,
  url: a.html_url, createdAt: a.created_at,
});

/** Dependabot alerts only support cursor paging: pass the previous result's `nextCursor` as `after` (none = first page). */
async function listDependabotAlerts(token, owner, repo, { state = 'open', after = null, perPage = 8 } = {}) {
  return orDisabled(async () => {
    const r = await page(token, 'GET /repos/{owner}/{repo}/dependabot/alerts', { owner, repo, state, sort: 'created', direction: 'desc', per_page: perPage, ...(after ? { after } : {}) }, 'List Dependabot alerts', { cursor: true });
    return { ...r, items: r.items.map(shapeDependabot) };
  });
}

async function getDependabotAlert(token, owner, repo, number) {
  return shapeDependabot(await get(token, 'GET /repos/{owner}/{repo}/dependabot/alerts/{alert_number}', { owner, repo, alert_number: assertNumber(number, 'alert') }, 'Get alert'));
}

async function dismissDependabotAlert(token, owner, repo, number, reason = 'tolerable_risk') {
  if (!DISMISS_REASONS.includes(reason)) throw new Error('Unknown dismissal reason');
  return mutate(token, 'PATCH /repos/{owner}/{repo}/dependabot/alerts/{alert_number}', { owner, repo, alert_number: assertNumber(number, 'alert'), state: 'dismissed', dismissed_reason: reason }, 'Dismiss alert');
}

async function reopenDependabotAlert(token, owner, repo, number) {
  return mutate(token, 'PATCH /repos/{owner}/{repo}/dependabot/alerts/{alert_number}', { owner, repo, alert_number: assertNumber(number, 'alert'), state: 'open' }, 'Reopen alert');
}

async function listCodeScanningAlerts(token, owner, repo, { state = 'open', page: pg = 1, perPage = 8 } = {}) {
  return orDisabled(async () => {
    const r = await page(token, 'GET /repos/{owner}/{repo}/code-scanning/alerts', { owner, repo, state, page: pg, per_page: perPage }, 'List code scanning alerts');
    return {
      ...r,
      items: r.items.map((a) => ({
        number: a.number, state: a.state, rule: a.rule && (a.rule.name || a.rule.id), severity: (a.rule && (a.rule.security_severity_level || a.rule.severity)) || 'unknown',
        location: a.most_recent_instance && a.most_recent_instance.location && `${a.most_recent_instance.location.path}:${a.most_recent_instance.location.start_line}`,
        url: a.html_url, tool: a.tool && a.tool.name,
      })),
    };
  });
}

async function listSecretScanningAlerts(token, owner, repo, { state = 'open', page: pg = 1, perPage = 8 } = {}) {
  return orDisabled(async () => {
    const r = await page(token, 'GET /repos/{owner}/{repo}/secret-scanning/alerts', { owner, repo, state, page: pg, per_page: perPage }, 'List secret scanning alerts');
    return { ...r, items: r.items.map((a) => ({ number: a.number, state: a.state, type: a.secret_type_display_name || a.secret_type, url: a.html_url, createdAt: a.created_at })) };
  });
}

/** Open-alert counts for the overview line (capped at one page of 100 → "100+"). */
async function overview(token, owner, repo) {
  const count = async (route, label) => orDisabled(async () => {
    const r = await page(token, route, { owner, repo, state: 'open', per_page: 100 }, label, { cursor: true });
    return { count: r.items.length, capped: r.hasNext };
  });
  const [dep, code, secret] = await Promise.all([
    count('GET /repos/{owner}/{repo}/dependabot/alerts', 'Count Dependabot alerts'),
    count('GET /repos/{owner}/{repo}/code-scanning/alerts', 'Count code scanning alerts'),
    count('GET /repos/{owner}/{repo}/secret-scanning/alerts', 'Count secret scanning alerts'),
  ]);
  return { dependabot: dep, codeScanning: code, secretScanning: secret };
}

/** Whether Dependabot alerts are switched on for the repo. */
async function alertsEnabled(token, owner, repo) {
  try {
    await get(token, 'GET /repos/{owner}/{repo}/vulnerability-alerts', { owner, repo }, 'Check alerts');
    return true;
  } catch (err) { if (err && err.status === 404) return false; throw err; }
}

async function setAlertsEnabled(token, owner, repo, enabled) {
  return mutate(token, `${enabled ? 'PUT' : 'DELETE'} /repos/{owner}/{repo}/vulnerability-alerts`, { owner, repo }, enabled ? 'Enable Dependabot alerts' : 'Disable Dependabot alerts');
}

module.exports = {
  DISMISS_REASONS, SEVERITY_ORDER, listDependabotAlerts, getDependabotAlert, dismissDependabotAlert, reopenDependabotAlert,
  listCodeScanningAlerts, listSecretScanningAlerts, overview, alertsEnabled, setAlertsEnabled,
};
