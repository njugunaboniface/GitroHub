/** GitHub Projects (v2) through GraphQL (v1.2.4-multi). Needs the `project` scope. */
const core = require('./core');
const github = require('../github');
const { client, withRetry, withAbortTimeout } = github.internals;

async function gql(token, query, variables = {}, { mutation = false } = {}) {
  const run = (signal) => client(token).request('POST /graphql', { query, variables, request: { signal } });
  const res = mutation ? await withAbortTimeout(run, 'Update project', undefined, { mutation: true }) : await withRetry(run, 'Read projects');
  if (res.data && res.data.errors && res.data.errors.length) {
    const e = new Error(String(res.data.errors[0].message || 'GitHub GraphQL error').slice(0, 300));
    e.status = /scope|resource not accessible|must have/i.test(e.message) ? 403 : 422;
    throw e;
  }
  return res.data.data;
}

const PROJECT_FIELDS = 'id title number url closed shortDescription';

/** owner = an organisation login, or null for the signed-in user's own projects. */
async function listProjects(token, { org = null } = {}) {
  const data = org
    ? await gql(token, `query($l:String!){ organization(login:$l){ projectsV2(first:20, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ${PROJECT_FIELDS} } } } }`, { l: org })
    : await gql(token, `query{ viewer{ projectsV2(first:20, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ${PROJECT_FIELDS} } } } }`);
  const nodes = (org ? data.organization : data.viewer).projectsV2.nodes || [];
  return nodes.filter(Boolean).map((p) => ({ id: p.id, title: p.title, number: p.number, url: p.url, closed: !!p.closed, description: p.shortDescription || '' }));
}

const NODE_ID = /^[A-Za-z0-9_\-=]{8,80}$/;
const assertNodeId = (id) => { if (!NODE_ID.test(String(id || ''))) throw new Error('Invalid project id'); return String(id); };

async function listItems(token, projectId, { first = 25 } = {}) {
  const data = await gql(token, `query($id:ID!,$n:Int!){ node(id:$id){ ... on ProjectV2 { title url items(first:$n){ nodes{ id type
    content{ ... on Issue{ title number state repository{ nameWithOwner } } ... on PullRequest{ title number state repository{ nameWithOwner } } ... on DraftIssue{ title } }
    fieldValues(first:10){ nodes{ ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2FieldCommon{ name } } } } } } } } } }`, { id: assertNodeId(projectId), n: first });
  const project = data.node;
  if (!project) throw Object.assign(new Error('Project not found.'), { status: 404 });
  return {
    title: project.title, url: project.url,
    items: ((project.items && project.items.nodes) || []).filter(Boolean).map((i) => {
      const status = ((i.fieldValues && i.fieldValues.nodes) || []).find((v) => v && v.field && v.field.name === 'Status');
      return { id: i.id, type: i.type, title: i.content && i.content.title, number: i.content && i.content.number, state: i.content && i.content.state, repo: i.content && i.content.repository && i.content.repository.nameWithOwner, status: status ? status.name : null };
    }),
  };
}

async function addDraftItem(token, projectId, title) {
  const t = core.clamp(title, 256).trim();
  if (!t) throw new Error('An item needs a title.');
  const data = await gql(token, 'mutation($p:ID!,$t:String!){ addProjectV2DraftIssue(input:{projectId:$p,title:$t}){ projectItem{ id } } }', { p: assertNodeId(projectId), t }, { mutation: true });
  return data.addProjectV2DraftIssue.projectItem.id;
}

/** Adds an existing issue/PR (by its node id from the REST API) to a project. */
async function addContentItem(token, projectId, contentNodeId) {
  const data = await gql(token, 'mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }', { p: assertNodeId(projectId), c: assertNodeId(contentNodeId) }, { mutation: true });
  return data.addProjectV2ItemById.item.id;
}

module.exports = { gql, listProjects, listItems, addDraftItem, addContentItem };
