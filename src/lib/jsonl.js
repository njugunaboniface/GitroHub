/** JSON Lines export helpers: one self-describing record per line, UTC ISO
 * timestamps, stable field names, no quoting/escaping pitfalls (unlike CSV),
 * and trivially streamable / greppable / loadable with `jq` or pandas. */
const SCHEMA = 'gitrohub.warden/1';

function record(type, data) {
  return { schema: SCHEMA, record_type: type, ...data };
}

/** @param {Array<object>} records */
function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

function filename(dataset, now = new Date()) {
  return `warden_${dataset}_${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z.jsonl`;
}

module.exports = { SCHEMA, record, toJsonl, filename };
