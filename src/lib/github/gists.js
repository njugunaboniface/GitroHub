/** Gists (v1.2.4-multi). Needs the `gist` scope. */
const { get, page, mutate, clamp } = require('./core');

const shape = (g) => ({
  id: g.id, description: g.description || '', public: !!g.public, url: g.html_url, updatedAt: g.updated_at, createdAt: g.created_at,
  files: Object.values(g.files || {}).map((f) => ({ name: f.filename, size: f.size, language: f.language, truncated: !!f.truncated, content: f.content })),
});

async function listGists(token, { page: pg = 1, perPage = 8 } = {}) {
  const r = await page(token, 'GET /gists', { page: pg, per_page: perPage }, 'List gists');
  return { ...r, items: r.items.map(shape) };
}

const GIST_ID = /^[0-9a-f]{20,40}$/i;
const assertGistId = (id) => { if (!GIST_ID.test(String(id || ''))) throw new Error('Invalid gist id'); return String(id); };

async function getGist(token, id) {
  return shape(await get(token, 'GET /gists/{gist_id}', { gist_id: assertGistId(id) }, 'Get gist'));
}

const FILE_NAME = /^[^/\\\0]{1,255}$/;
async function createGist(token, { description = '', isPublic = false, filename, content }) {
  const name = String(filename || '').trim();
  if (!FILE_NAME.test(name)) throw new Error('That isn’t a valid file name.');
  const text = String(content == null ? '' : content);
  if (!text.trim()) throw new Error('A gist can’t be empty.');
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('That’s over 1 MB — too large for a gist created here.');
  return shape(await mutate(token, 'POST /gists', { description: clamp(description, 500), public: !!isPublic, files: { [name]: { content: text } } }, 'Create gist'));
}

async function deleteGist(token, id) {
  try {
    return await mutate(token, 'DELETE /gists/{gist_id}', { gist_id: assertGistId(id) }, 'Delete gist');
  } catch (err) { if (err && err.status === 404) return null; throw err; }
}

async function updateGistDescription(token, id, description) {
  return shape(await mutate(token, 'PATCH /gists/{gist_id}', { gist_id: assertGistId(id), description: clamp(description, 500) }, 'Update gist'));
}

async function replaceGistFile(token, id, filename, content) {
  if (!FILE_NAME.test(String(filename))) throw new Error('That isn’t a valid file name.');
  if (!String(content || '').trim()) throw new Error('A gist file can’t be empty.');
  return shape(await mutate(token, 'PATCH /gists/{gist_id}', { gist_id: assertGistId(id), files: { [filename]: { content: String(content) } } }, 'Update gist'));
}

module.exports = { assertGistId, listGists, getGist, createGist, deleteGist, updateGistDescription, replaceGistFile };
