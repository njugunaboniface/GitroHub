/** Collaborators, deploy keys, topics, transfer (v1.2.4-multi). */
const { get, getOrNull, page, mutate, clamp } = require('./core');

const PERMISSIONS = ['pull', 'triage', 'push', 'maintain', 'admin'];
const PERMISSION_LABEL = { pull: 'Read', triage: 'Triage', push: 'Write', maintain: 'Maintain', admin: 'Admin' };
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function assertLogin(login) {
  const l = String(login || '').trim().replace(/^@/, '');
  if (!LOGIN.test(l)) throw new Error('That doesn’t look like a GitHub username.');
  return l;
}

async function listCollaborators(token, owner, repo, { page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/collaborators', { owner, repo, affiliation: 'direct', page: pg, per_page: perPage }, 'List collaborators');
  return {
    ...r,
    items: r.items.map((c) => ({
      login: c.login,
      permission: c.role_name === 'write' ? 'push' : c.role_name === 'read' ? 'pull' : (c.role_name || (c.permissions && (c.permissions.admin ? 'admin' : c.permissions.maintain ? 'maintain' : c.permissions.push ? 'push' : c.permissions.triage ? 'triage' : 'pull')) || 'pull'),
    })),
  };
}

async function listInvitations(token, owner, repo) {
  const items = await get(token, 'GET /repos/{owner}/{repo}/invitations', { owner, repo, per_page: 30 }, 'List invitations');
  return items.map((i) => ({ id: i.id, login: i.invitee && i.invitee.login, permission: i.permissions }));
}

/** Invites (or changes the permission of) a user. 201 = invitation sent, 204 = already a collaborator, updated. */
async function addCollaborator(token, owner, repo, login, permission = 'push') {
  if (!PERMISSIONS.includes(permission)) throw new Error('Unknown permission');
  const user = assertLogin(login);
  const data = await mutate(token, 'PUT /repos/{owner}/{repo}/collaborators/{username}', { owner, repo, username: user, permission }, 'Add collaborator');
  return { login: user, invited: !!(data && data.id) };
}

async function removeCollaborator(token, owner, repo, login) {
  try {
    return await mutate(token, 'DELETE /repos/{owner}/{repo}/collaborators/{username}', { owner, repo, username: assertLogin(login) }, 'Remove collaborator');
  } catch (err) { if (err && err.status === 404) return null; throw err; }
}

async function cancelInvitation(token, owner, repo, invitationId) {
  try {
    return await mutate(token, 'DELETE /repos/{owner}/{repo}/invitations/{invitation_id}', { owner, repo, invitation_id: Number(invitationId) }, 'Cancel invitation');
  } catch (err) { if (err && err.status === 404) return null; throw err; }
}

// ── Deploy keys ──────────────────────────────────────────────────────
async function listDeployKeys(token, owner, repo, { page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/keys', { owner, repo, page: pg, per_page: perPage }, 'List deploy keys');
  return { ...r, items: r.items.map((k) => ({ id: k.id, title: k.title, readOnly: !!k.read_only, createdAt: k.created_at, fingerprint: String(k.key || '').slice(0, 32) })) };
}

const SSH_KEY = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/=]+(\s+.*)?$/;
async function addDeployKey(token, owner, repo, { title, key, readOnly = true }) {
  const k = String(key || '').trim();
  if (/PRIVATE KEY/i.test(k)) throw new Error('That looks like a PRIVATE key. Never share it — send the PUBLIC key (.pub file) instead.');
  if (!SSH_KEY.test(k)) throw new Error('That isn’t a valid SSH public key (it should start with ssh-ed25519 or ssh-rsa).');
  const t = clamp(title, 100).trim() || 'GitroHub deploy key';
  return mutate(token, 'POST /repos/{owner}/{repo}/keys', { owner, repo, title: t, key: k, read_only: !!readOnly }, 'Add deploy key');
}

async function deleteDeployKey(token, owner, repo, keyId) {
  try {
    return await mutate(token, 'DELETE /repos/{owner}/{repo}/keys/{key_id}', { owner, repo, key_id: Number(keyId) }, 'Delete deploy key');
  } catch (err) { if (err && err.status === 404) return null; throw err; }
}

// ── Topics ───────────────────────────────────────────────────────────
const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/;
const MAX_TOPICS = 20;

/** Lower-cases, strips #, validates. Returns { ok, topic } / { ok:false, error }. */
function normalizeTopic(raw) {
  const t = String(raw || '').trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
  if (!TOPIC.test(t)) return { ok: false, error: 'Topics use lowercase letters, numbers and hyphens (max 50 characters).' };
  return { ok: true, topic: t };
}

async function getTopics(token, owner, repo) {
  const d = await get(token, 'GET /repos/{owner}/{repo}/topics', { owner, repo }, 'Get topics');
  return d.names || [];
}

async function setTopics(token, owner, repo, names) {
  const unique = Array.from(new Set(names));
  if (unique.length > MAX_TOPICS) throw new Error(`A repo can have at most ${MAX_TOPICS} topics.`);
  for (const n of unique) if (!TOPIC.test(n)) throw new Error(`"${n}" isn’t a valid topic.`);
  const data = await mutate(token, 'PUT /repos/{owner}/{repo}/topics', { owner, repo, names: unique }, 'Save topics', async () => {
    const now = await getTopics(token, owner, repo);
    return JSON.stringify([...now].sort()) === JSON.stringify([...unique].sort()) ? { applied: true, value: { names: now } } : { applied: false };
  });
  return (data && data.names) || unique;
}

// ── Transfer ─────────────────────────────────────────────────────────
/** Starts a transfer to another user/organisation. GitHub emails the new owner to accept (unless you own both). */
async function transferRepo(token, owner, repo, newOwner, newName = null) {
  const target = assertLogin(newOwner);
  return mutate(token, 'POST /repos/{owner}/{repo}/transfer', { owner, repo, new_owner: target, ...(newName ? { new_name: newName } : {}) }, 'Transfer repo', async () => {
    const moved = await getOrNull(token, 'GET /repos/{owner}/{repo}', { owner: target, repo: newName || repo }, 'Verify transfer');
    return moved ? { applied: true, value: moved } : { applied: null };
  });
}

module.exports = {
  PERMISSIONS, PERMISSION_LABEL, assertLogin, listCollaborators, listInvitations, addCollaborator, removeCollaborator, cancelInvitation,
  listDeployKeys, addDeployKey, deleteDeployKey, MAX_TOPICS, normalizeTopic, getTopics, setTopics, transferRepo,
};
