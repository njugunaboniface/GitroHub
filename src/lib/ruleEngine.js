/**
 * Shared condition matcher for every rule type in 🤖 Automation — Auto-Tag
 * rules (lib/tags.js) and Auto-Mute rules (lib/automationMuteRules.js) both
 * store the same {field, op, value} shape and both match through here, so
 * "what a rule means" is defined in exactly one place.
 *
 * Rule shapes:
 *   {"field":"language",   "op":"eq",      "value":"Python"}
 *   {"field":"name",       "op":"matches", "value":"api-*"}
 *   {"field":"visibility", "op":"eq",      "value":"private"|"public"}
 *   {"field":"fork",       "op":"eq",      "value":"fork"|"notfork"}
 */
function fieldValueFor(rule, repo) {
  if (rule.field === 'language') return repo.language;
  if (rule.field === 'name') return repo.name;
  if (rule.field === 'visibility') return repo.private ? 'private' : 'public';
  if (rule.field === 'fork') return repo.fork ? 'fork' : 'notfork';
  return undefined;
}

/**
 * Case-insensitive glob match where '*' is the only wildcard. Runs in
 * O(pattern x text) with no backtracking explosion, unlike the old
 * RegExp('.*') chain: a pattern such as "a*a*a*a*a*a*b" against a 100-char
 * name used to block the single shared event loop for seconds (v1.2.3 fix).
 */
function globMatch(pattern, text) {
  const p = String(pattern).toLowerCase();
  const t = String(text).toLowerCase();
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = ti;
    } else if (pi < p.length && p[pi] === t[ti]) {
      pi++;
      ti++;
    } else if (star !== -1) {
      pi = star + 1;
      ti = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

function matchesRule(rule, repo) {
  if (!rule || typeof rule.value !== 'string') return false;
  const fieldValue = fieldValueFor(rule, repo);
  if (fieldValue == null) return false;
  if (rule.op === 'eq') return fieldValue === rule.value;
  if (rule.op === 'matches') return globMatch(rule.value, fieldValue);
  return false;
}

const MAX_VALUE_LENGTH = 100;
const MAX_WILDCARDS = 8;
const VALID_FIELDS = new Set(['language', 'name', 'visibility', 'fork']);
const VALID_OPS = new Set(['eq', 'matches']);

/**
 * Validate and normalise a rule coming from a text prompt OR an imported
 * file. Returns { ok: true, rule } with a trimmed value (and consecutive
 * wildcards collapsed), or { ok: false, error } with a user-facing reason.
 */
function validateRule(rule) {
  if (!rule || typeof rule !== 'object') return { ok: false, error: 'That rule is empty.' };
  if (!VALID_FIELDS.has(rule.field)) return { ok: false, error: 'Unknown rule field.' };
  if (!VALID_OPS.has(rule.op)) return { ok: false, error: 'Unknown rule operator.' };
  if (typeof rule.value !== 'string') return { ok: false, error: 'A rule value must be text.' };
  let value = rule.value.trim();
  if (!value) return { ok: false, error: 'A rule value can\u2019t be empty.' };
  if (value.length > MAX_VALUE_LENGTH) return { ok: false, error: `Keep rule values under ${MAX_VALUE_LENGTH} characters.` };
  if (rule.field === 'visibility' && value !== 'private' && value !== 'public') return { ok: false, error: 'Visibility must be private or public.' };
  if (rule.field === 'fork' && value !== 'fork' && value !== 'notfork') return { ok: false, error: 'Fork rules must be fork or notfork.' };
  if (rule.op === 'matches') {
    value = value.replace(/\*{2,}/g, '*');
    const wildcards = (value.match(/\*/g) || []).length;
    if (wildcards > MAX_WILDCARDS) return { ok: false, error: `Use at most ${MAX_WILDCARDS} * wildcards in a name pattern.` };
  }
  return { ok: true, rule: { field: rule.field, op: rule.op, value } };
}

/** Throwing variant for library callers. */
function assertValidRule(rule) {
  const check = validateRule(rule);
  if (!check.ok) {
    const err = new Error(check.error);
    err.code = 'INVALID_RULE';
    throw err;
  }
  return check.rule;
}

/** Human-readable one-liner for a rule object (or a null/undefined rule). */
function describeRule(rule) {
  if (!rule) return 'No rule set';
  if (rule.field === 'language') return `💻 Language = ${rule.value}`;
  if (rule.field === 'name') return `📛 Name matches "${rule.value}"`;
  if (rule.field === 'visibility') return `🔒 Visibility = ${rule.value === 'private' ? 'Private' : 'Public'}`;
  if (rule.field === 'fork') return `🍴 ${rule.value === 'fork' ? 'Is a fork' : 'Not a fork'}`;
  return 'Unrecognized rule';
}

module.exports = { matchesRule, describeRule, globMatch, validateRule, assertValidRule, MAX_VALUE_LENGTH, MAX_WILDCARDS };
