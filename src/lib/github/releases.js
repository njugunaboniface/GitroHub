/** Releases and tags (v1.2.4-multi). */
const { get, getOrNull, page, mutate, assertNumber, assertBranchName, clamp } = require('./core');
const branches = require('./branches');

const shape = (r) => ({
  id: r.id, tag: r.tag_name, name: r.name || r.tag_name, body: r.body || '', draft: !!r.draft, prerelease: !!r.prerelease,
  target: r.target_commitish, url: r.html_url, publishedAt: r.published_at, createdAt: r.created_at, author: r.author && r.author.login,
  assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, downloads: a.download_count })),
});

async function listReleases(token, owner, repo, { page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/releases', { owner, repo, page: pg, per_page: perPage }, 'List releases');
  return { ...r, items: r.items.map(shape) };
}

async function getRelease(token, owner, repo, id) {
  return shape(await get(token, 'GET /repos/{owner}/{repo}/releases/{release_id}', { owner, repo, release_id: assertNumber(id, 'release') }, 'Get release'));
}

const TAG_SAFE = /^[A-Za-z0-9._\-/+]{1,100}$/;
function assertTagName(name) {
  const t = String(name || '').trim();
  if (!TAG_SAFE.test(t) || t.includes('..') || t.endsWith('/') || t.startsWith('/') || t.endsWith('.lock')) {
    throw Object.assign(new Error('That isn’t a valid tag name (letters, numbers, dots, dashes, underscores; e.g. v1.2.0).'), { code: 'BAD_REF' });
  }
  return t;
}

async function createRelease(token, owner, repo, { tag, target = null, name = '', body = '', draft = false, prerelease = false, generateNotes = false }) {
  const tagName = assertTagName(tag);
  return shape(await mutate(token, 'POST /repos/{owner}/{repo}/releases', {
    owner, repo, tag_name: tagName, ...(target ? { target_commitish: target } : {}), name: clamp(name, 200) || tagName,
    body: clamp(body, 100000), draft: !!draft, prerelease: !!prerelease, generate_release_notes: !!generateNotes,
  }, 'Create release', async () => {
    const found = await getOrNull(token, 'GET /repos/{owner}/{repo}/releases/tags/{tag}', { owner, repo, tag: tagName }, 'Verify release');
    return found ? { applied: true, value: found } : { applied: false };
  }));
}

async function editRelease(token, owner, repo, id, changes) {
  const allowed = {};
  if (changes.name !== undefined) allowed.name = clamp(changes.name, 200);
  if (changes.body !== undefined) allowed.body = clamp(changes.body, 100000);
  if (changes.draft !== undefined) allowed.draft = !!changes.draft;
  if (changes.prerelease !== undefined) allowed.prerelease = !!changes.prerelease;
  if (!Object.keys(allowed).length) throw new Error('Nothing to change.');
  return shape(await mutate(token, 'PATCH /repos/{owner}/{repo}/releases/{release_id}', { owner, repo, release_id: assertNumber(id, 'release'), ...allowed }, 'Edit release'));
}

/** Deletes the release only — the git tag stays unless `alsoTag` is set. */
async function deleteRelease(token, owner, repo, id, { alsoTag = null } = {}) {
  try {
    await mutate(token, 'DELETE /repos/{owner}/{repo}/releases/{release_id}', { owner, repo, release_id: assertNumber(id, 'release') }, 'Delete release');
  } catch (err) { if (!(err && err.status === 404)) throw err; }
  if (alsoTag) await deleteTag(token, owner, repo, alsoTag);
  return true;
}

async function listTags(token, owner, repo, { page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /repos/{owner}/{repo}/tags', { owner, repo, page: pg, per_page: perPage }, 'List tags');
  return { ...r, items: r.items.map((t) => ({ name: t.name, sha: t.commit && t.commit.sha })) };
}

/** Lightweight tag at a branch tip (or an explicit commit sha). */
async function createTag(token, owner, repo, name, { branch = null, sha = null }) {
  const tag = assertTagName(name);
  const target = sha || (branch ? await branches.getBranchSha(token, owner, repo, assertBranchName(branch)) : null);
  if (!target) throw new Error('Couldn’t find the commit to tag.');
  return mutate(token, 'POST /repos/{owner}/{repo}/git/refs', { owner, repo, ref: `refs/tags/${tag}`, sha: target }, 'Create tag', async () => {
    const ref = await getOrNull(token, 'GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `tags/${tag}` }, 'Verify tag');
    return ref && ref.object && ref.object.sha === target ? { applied: true, value: ref } : { applied: false };
  });
}

async function deleteTag(token, owner, repo, name) {
  const tag = assertTagName(name);
  const prev = await getOrNull(token, 'GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `tags/${tag}` }, 'Get tag').catch(() => null);
  try {
    const out = await mutate(token, 'DELETE /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `tags/${tag}` }, 'Delete tag');
    const prevSha = prev && prev.object && prev.object.sha;
    if (prevSha) { try { require('../changeJournal').record({ owner, repo, kind: 'tag_delete', ref: tag, prevSha, label: `Deleted tag ${tag}` }).catch(() => {}); } catch (_) { /* journal is best-effort */ } }
    return out;
  } catch (err) { if (err && (err.status === 404 || err.status === 422)) return null; throw err; }
}

module.exports = { assertTagName, listReleases, getRelease, createRelease, editRelease, deleteRelease, listTags, createTag, deleteTag };
