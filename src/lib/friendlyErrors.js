/**
 * Plain-language explanations for the GitHub rejections people actually run into (v1.2.5-multi).
 *
 * Before this, a rule GitHub enforces on purpose (you cannot approve your own pull request, a branch is
 * protected, a conversation is locked …) reached the person as raw API text — `Unprocessable Entity:
 * "Review Can not approve your own pull request" - https://docs.github.com/…` — followed by "Try again.",
 * which can never work. `explain()` turns each known case into:
 *
 *   { reason, next, retryable }
 *
 *   reason    one calm sentence saying what GitHub said, in words a non-developer follows
 *   next      what to do instead (or null)
 *   retryable true ONLY when trying again can actually help (busy, timeout, a moved branch…)
 *
 * It is pure (no I/O) so it is easy to test, and it returns null for anything it does not recognise —
 * callers then fall back to `clean()`, which at least strips the noise out of the raw message.
 */

const URL_TAIL = /\s*-?\s*https?:\/\/docs\.github\.com\S*/gi;

/** The most readable form of a raw GitHub/Octokit message: no docs link, no "Unprocessable Entity:" boilerplate. */
function clean(message) {
  let m = String(message == null ? '' : message).replace(URL_TAIL, '').replace(/\s+/g, ' ').trim();
  // Octokit: `Unprocessable Entity: "Review Can not approve your own pull request"` → the quoted part
  const quoted = /^(?:Unprocessable Entity|Validation Failed|Forbidden|Not Found|Conflict|Method Not Allowed|Gone)\s*:\s*"([^"]+)"\s*$/i.exec(m);
  if (quoted) m = quoted[1];
  m = m.replace(/^Validation Failed:\s*/i, 'GitHub rejected the input: ');
  m = m.replace(/\s*-\s*$/, '');
  return m.length > 240 ? `${m.slice(0, 237)}…` : m;
}

/** First useful sentence out of a 422 "errors" array, e.g. "head: invalid". */
function firstValidationDetail(err) {
  try {
    const errs = (err && err.response && err.response.data && err.response.data.errors) || [];
    for (const e of errs) {
      if (typeof e === 'string') return e;
      if (e && e.message) return e.message;
      if (e && e.field && e.code) return `${e.field} (${String(e.code).replace(/_/g, ' ')})`;
    }
  } catch (_) { /* fall through */ }
  return null;
}

// [status or null, message regex, builder]
const RULES = [
  // ── Reviews ────────────────────────────────────────────────────────────────────────────────────
  [422, /can(?: ?not|'t) approve your own pull request/i, () => ({
    reason: 'You can’t approve your own pull request — GitHub doesn’t allow it.',
    next: 'Ask a collaborator to review it, or leave a comment instead.', retryable: false,
  })],
  [422, /can(?: ?not|'t) request changes on your own pull request/i, () => ({
    reason: 'You can’t request changes on your own pull request.',
    next: 'Leave a comment instead.', retryable: false,
  })],
  [422, /(pending review|user can only have one pending review)/i, () => ({
    reason: 'You already have a review in progress on this pull request.',
    next: 'Submit or discard it on GitHub first.', retryable: false,
  })],
  // ── Merging ────────────────────────────────────────────────────────────────────────────────────
  [405, /not mergeable|merge conflict|conflicts? must be resolved/i, () => ({
    reason: 'This pull request can’t be merged yet — it has conflicts with the base branch.',
    next: 'Resolve the conflicts on GitHub (or update the branch), then try again.', retryable: false,
  })],
  [405, /required status check|status checks? (?:are|is) (?:expected|failing|pending)|checks? (?:have|has) not (?:passed|completed)/i, () => ({
    reason: 'The required checks haven’t passed yet, so GitHub won’t merge this.',
    next: 'Wait for the checks to finish (see ⚙️ Actions), then merge.', retryable: false,
  })],
  [405, /approving review|review is required|reviews? required|code owner/i, () => ({
    reason: 'This branch requires an approving review before it can be merged.',
    next: 'Ask a reviewer to approve it first.', retryable: false,
  })],
  [405, /(merge|squash|rebase)[^.]*(not allowed|disabled|not permitted)|not allowed on this repository/i, () => ({
    reason: 'This repository doesn’t allow that kind of merge.',
    next: 'Choose a different merge style (merge commit, squash or rebase).', retryable: false,
  })],
  [409, /head branch was modified|base branch was modified/i, () => ({
    reason: 'The branch changed while you were merging.',
    next: 'Open the pull request again and retry.', retryable: true,
  })],
  [405, /already been merged|is already merged|pull request is closed/i, () => ({
    reason: 'This pull request is already merged or closed.', next: null, retryable: false,
  })],
  // ── Creating things that already exist / have nothing to do ────────────────────────────────────
  [422, /no commits between/i, () => ({
    reason: 'There’s nothing to open a pull request for — the two branches are identical.',
    next: 'Commit a change on the branch first.', retryable: false,
  })],
  [422, /a pull request already exists/i, () => ({
    reason: 'A pull request for these two branches already exists.', next: 'Open it from the pull request list.', retryable: false,
  })],
  [422, /reference already exists/i, () => ({
    reason: 'A branch or tag with that name already exists.', next: 'Pick a different name.', retryable: false,
  })],
  [422, /reference does not exist|not a valid ref|invalid ref/i, () => ({
    reason: 'That branch, tag or commit doesn’t exist (it may have been deleted or renamed).',
    next: 'Refresh the list and pick it again.', retryable: false,
  })],
  [422, /(tag|release)[^.]*already[ _]exists|already_exists/i, () => ({
    reason: 'That tag or release already exists.', next: 'Choose a different tag name.', retryable: false,
  })],
  [422, /sha (?:was )?not supplied|sha does not match|does not match/i, () => ({
    reason: 'The file changed on GitHub while you were editing it.', next: 'Open it again and redo the change.', retryable: false,
  })],
  [409, /(sha|does not match)/i, () => ({
    reason: 'The file changed on GitHub while you were editing it.', next: 'Open it again and redo the change.', retryable: false,
  })],
  [409, /git repository is empty/i, () => ({
    reason: 'This repository is empty — it has no commits yet.', next: 'Add a first file, then try again.', retryable: false,
  })],
  [409, /(already|conflict)/i, () => ({
    reason: 'Something changed on GitHub while this was running.', next: 'Refresh and try again.', retryable: true,
  })],
  // ── Permissions and protection ────────────────────────────────────────────────────────────────
  [403, /saml|single sign-on|sso/i, () => ({
    reason: 'This organization requires you to authorize GitroHub for single sign-on first.',
    next: 'Open github.com → Settings → Applications → GitroHub and authorize it for the organization.', retryable: false,
  })],
  [403, /(protected branch|branch protection|cannot delete this branch|cannot force.?push|required .* before merging)/i, () => ({
    reason: 'This branch is protected, so GitHub won’t allow that change.',
    next: 'Change the branch protection rules, or use a pull request.', retryable: false,
  })],
  [422, /(protected branch|cannot delete this branch|branch protection)/i, () => ({
    reason: 'This branch is protected, so GitHub won’t allow that change.',
    next: 'Change the branch protection rules, or use a pull request.', retryable: false,
  })],
  [403, /(is locked|conversation is locked|issue is locked|unable to create comment because)/i, () => ({
    reason: 'This conversation is locked, so new comments can’t be added.', next: 'Unlock it first (if you’re allowed to).', retryable: false,
  })],
  [403, /(must have admin|admin rights|resource not accessible|not accessible by|requires admin|insufficient|forbidden)/i, () => ({
    reason: 'You don’t have permission to do that on this repository.',
    next: 'You need admin (or write) access — ask the owner.', retryable: false,
  })],
  [404, /not found/i, () => ({
    reason: 'GitHub couldn’t find that — it may have been deleted, renamed, or you may not have access to it.',
    next: 'Refresh the list and try again.', retryable: false,
  })],
  [410, /issues are disabled|has issues disabled/i, () => ({
    reason: 'Issues are turned off for this repository.', next: 'Turn them on in the repository’s settings on GitHub.', retryable: false,
  })],
  [410, /./, () => ({ reason: 'That no longer exists on GitHub.', next: null, retryable: false })],
  [451, /./, () => ({ reason: 'GitHub has blocked access to this repository.', next: null, retryable: false })],
  // ── Collaborators / orgs ──────────────────────────────────────────────────────────────────────
  [422, /(is already a collaborator|already a member)/i, () => ({
    reason: 'That person already has access.', next: null, retryable: false,
  })],
  [422, /(invitation|invited) .*already/i, () => ({
    reason: 'An invitation is already waiting for that person.', next: null, retryable: false,
  })],
  [422, /(not a valid user|user does not exist|could not resolve to a user)/i, () => ({
    reason: 'GitHub doesn’t know a user with that name.', next: 'Check the spelling of the username.', retryable: false,
  })],
  // ── Actions ────────────────────────────────────────────────────────────────────────────────────
  [409, /(workflow|run) .*(not|cannot|can't).*(cancel|re-?run|complete)/i, () => ({
    reason: 'That run can’t be changed right now (it may have already finished).', next: 'Refresh the run list.', retryable: false,
  })],
  [422, /(workflow does not have|workflow_dispatch|no ref found)/i, () => ({
    reason: 'That workflow can’t be started manually, or the branch you chose doesn’t exist.',
    next: 'Pick a branch that exists, and make sure the workflow allows manual runs.', retryable: false,
  })],
  [403, /(actions .*(disabled|not enabled)|workflow .*disabled)/i, () => ({
    reason: 'GitHub Actions is turned off for this repository.', next: 'Turn it on in the repository’s settings.', retryable: false,
  })],
  // ── Temporary trouble (these ARE worth retrying) ──────────────────────────────────────────────
  [502, /./, () => ({ reason: 'GitHub had a temporary problem on its side.', next: 'Try again in a minute.', retryable: true })],
  [503, /./, () => ({ reason: 'GitHub is temporarily unavailable.', next: 'Try again in a minute.', retryable: true })],
  [504, /./, () => ({ reason: 'GitHub took too long to answer.', next: 'Try again in a minute.', retryable: true })],
  [500, /./, () => ({ reason: 'GitHub had a problem on its side.', next: 'Try again in a minute.', retryable: true })],
];

/** True for connection-level failures (no HTTP status at all). */
function isNetworkError(err) {
  return !!(err && !err.status && /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed/i.test(`${err.code || ''} ${err.message || ''}`));
}

/**
 * { reason, next, retryable } for a known GitHub rejection, or null.
 * Looks at the HTTP status AND the message text (GitHub reuses 422/403 for many different causes).
 */
function explain(err) {
  if (!err) return null;
  const status = Number(err.status || (err.response && err.response.status) || 0) || null;
  const message = `${err.message || ''} ${(err.response && err.response.data && err.response.data.message) || ''} ${firstValidationDetail(err) || ''}`;
  if (isNetworkError(err)) {
    return { reason: 'The connection to GitHub dropped.', next: 'Try again in a moment.', retryable: true };
  }
  for (const [ruleStatus, re, build] of RULES) {
    if (ruleStatus !== null && status !== ruleStatus) continue;
    if (re.test(message)) return build(err);
  }
  return null;
}

/**
 * One line for places that only have room for a sentence (background jobs, short notices): the friendly
 * reason when known, otherwise the cleaned-up raw message.
 */
function oneLine(err) {
  const known = explain(err);
  if (known) return known.reason;
  const detail = firstValidationDetail(err);
  const base = clean(err && err.message);
  return detail && !base.includes(detail) ? `${base} (${detail})` : (base || 'an unknown error');
}

/**
 * A finished "⚠️ What failed: reason.\nwhat to do" message for a failed GitHub call. "Try again" is only added
 * when retrying can help (a known temporary problem, or a failure with no clear cause such as a dropped
 * connection); a rule GitHub enforces on purpose gets what to do INSTEAD.
 */
function message(what, err, fallbackNext = 'Try again.') {
  const known = explain(err);
  if (known) {
    const next = known.next || (known.retryable ? 'Try again in a moment.' : null);
    return `\u26A0\uFE0F ${what}: ${known.reason.replace(/\.$/, '')}.${next ? `\n${next}` : ''}`;
  }
  const transient = !err || !err.status || err.status >= 500;
  return `\u26A0\uFE0F ${what}: ${oneLine(err).replace(/\.$/, '')}.${transient && fallbackNext ? `\n${fallbackNext}` : ''}`;
}

module.exports = { explain, clean, oneLine, message, isNetworkError, firstValidationDetail };
