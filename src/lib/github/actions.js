/** GitHub Actions: runs, workflows, dispatch, secrets, variables (v1.2.4-multi). */
const { get, page, mutate, assertNumber, assertBranchName, clamp } = require('./core');

const shapeRun = (r) => ({
  id: r.id, name: r.name || r.display_title, title: r.display_title, status: r.status, conclusion: r.conclusion,
  branch: r.head_branch, event: r.event, number: r.run_number, attempt: r.run_attempt, actor: r.actor && r.actor.login,
  url: r.html_url, createdAt: r.created_at, updatedAt: r.updated_at, sha: r.head_sha && r.head_sha.slice(0, 7), workflowId: r.workflow_id,
});

/** status: queued | in_progress | completed | success | failure … (GitHub's own filter values) */
async function listRuns(token, owner, repo, { status = null, branch = null, workflowId = null, page: pg = 1, perPage = 8 } = {}) {
  const route = workflowId ? 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs' : 'GET /repos/{owner}/{repo}/actions/runs';
  const r = await page(token, route, { owner, repo, page: pg, per_page: perPage, ...(workflowId ? { workflow_id: workflowId } : {}), ...(status ? { status } : {}), ...(branch ? { branch } : {}) }, 'List workflow runs', { key: 'workflow_runs' });
  return { ...r, items: r.items.map(shapeRun) };
}

async function getRun(token, owner, repo, runId) {
  return shapeRun(await get(token, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}', { owner, repo, run_id: assertNumber(runId, 'run') }, 'Get run'));
}

async function listJobs(token, owner, repo, runId) {
  const d = await get(token, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', { owner, repo, run_id: assertNumber(runId, 'run'), per_page: 30 }, 'List jobs');
  return (d.jobs || []).map((j) => ({
    id: j.id, name: j.name, status: j.status, conclusion: j.conclusion,
    failedSteps: (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name),
  }));
}

async function rerunRun(token, owner, repo, runId, { failedOnly = false } = {}) {
  const route = failedOnly ? 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs' : 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun';
  return mutate(token, route, { owner, repo, run_id: assertNumber(runId, 'run') }, 'Re-run workflow');
}

async function cancelRun(token, owner, repo, runId) {
  return mutate(token, 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel', { owner, repo, run_id: assertNumber(runId, 'run') }, 'Cancel run');
}

async function listWorkflows(token, owner, repo, { page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/actions/workflows', { owner, repo, page: pg, per_page: perPage }, 'List workflows', { key: 'workflows' });
  return { ...r, items: r.items.map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state })) };
}

/** Triggers a workflow_dispatch run. The workflow file must declare `on: workflow_dispatch`. */
async function dispatchWorkflow(token, owner, repo, workflowId, ref, inputs = {}) {
  const branch = assertBranchName(ref);
  try {
    return await mutate(token, 'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', { owner, repo, workflow_id: workflowId, ref: branch, inputs }, 'Run workflow');
  } catch (err) {
    if (err && err.status === 422 && /workflow_dispatch/i.test(String(err.message))) { err.code = 'NO_DISPATCH'; err.message = 'This workflow can’t be started by hand — its file needs `on: workflow_dispatch`.'; }
    throw err;
  }
}

async function setWorkflowEnabled(token, owner, repo, workflowId, enabled) {
  return mutate(token, `PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/${enabled ? 'enable' : 'disable'}`, { owner, repo, workflow_id: workflowId }, enabled ? 'Enable workflow' : 'Disable workflow');
}

// ── Secrets ──────────────────────────────────────────────────────────
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
function assertSecretName(name) {
  const n = String(name || '').trim();
  if (!SECRET_NAME.test(n) || /^GITHUB_/i.test(n)) throw new Error('Secret names use letters, numbers and underscores, can’t start with a number or GITHUB_.');
  return n;
}

async function listSecrets(token, owner, repo, { page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/actions/secrets', { owner, repo, page: pg, per_page: perPage }, 'List secrets', { key: 'secrets' });
  return { ...r, items: r.items.map((s) => ({ name: s.name, updatedAt: s.updated_at })) };
}

/** Encrypts with libsodium's sealed box, as GitHub requires. The value is never logged or stored. */
async function sealSecret(publicKeyB64, value) {
  let sodium;
  try { sodium = require('libsodium-wrappers'); } catch (_) {
    throw Object.assign(new Error('Secrets need the "libsodium-wrappers" package on the server (run npm install).'), { code: 'NO_LIBSODIUM' });
  }
  await sodium.ready;
  const key = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

async function setSecret(token, owner, repo, name, value) {
  const n = assertSecretName(name);
  const v = String(value == null ? '' : value);
  if (!v) throw new Error('A secret can’t be empty.');
  if (Buffer.byteLength(v) > 48 * 1024) throw new Error('A secret can be at most 48 KB.');
  const pk = await get(token, 'GET /repos/{owner}/{repo}/actions/secrets/public-key', { owner, repo }, 'Get secrets key');
  const encrypted = await sealSecret(pk.key, v);
  await mutate(token, 'PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}', { owner, repo, secret_name: n, encrypted_value: encrypted, key_id: pk.key_id }, 'Save secret');
  return n;
}

async function deleteSecret(token, owner, repo, name) {
  try {
    return await mutate(token, 'DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}', { owner, repo, secret_name: assertSecretName(name) }, 'Delete secret');
  } catch (err) { if (err && err.status === 404) return null; throw err; }
}

// ── Variables ────────────────────────────────────────────────────────
async function listVariables(token, owner, repo, { page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/actions/variables', { owner, repo, page: pg, per_page: perPage }, 'List variables', { key: 'variables' });
  return { ...r, items: r.items.map((v) => ({ name: v.name, value: v.value, updatedAt: v.updated_at })) };
}

async function setVariable(token, owner, repo, name, value, { exists = false } = {}) {
  const n = assertSecretName(name);
  const v = clamp(value, 48 * 1024);
  if (exists) return mutate(token, 'PATCH /repos/{owner}/{repo}/actions/variables/{name}', { owner, repo, name: n, value: v }, 'Update variable');
  return mutate(token, 'POST /repos/{owner}/{repo}/actions/variables', { owner, repo, name: n, value: v }, 'Create variable');
}

async function deleteVariable(token, owner, repo, name) {
  try {
    return await mutate(token, 'DELETE /repos/{owner}/{repo}/actions/variables/{name}', { owner, repo, name: assertSecretName(name) }, 'Delete variable');
  } catch (err) { if (err && err.status === 404) return null; throw err; }
}

module.exports = {
  listRuns, getRun, listJobs, rerunRun, cancelRun, listWorkflows, dispatchWorkflow, setWorkflowEnabled,
  assertSecretName, listSecrets, setSecret, deleteSecret, sealSecret, listVariables, setVariable, deleteVariable,
};
