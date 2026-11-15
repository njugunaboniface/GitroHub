const format = require('./format');
const github = require('./github');
const friendly = require('./friendlyErrors');

/** True for GitHub API auth failures — expired/revoked token, bad credentials */
function isAuthError(err) {
  return !!(err && (err.status === 401 || /bad credentials/i.test(err.message || '')));
}

/**
 * True specifically for a repo-name-collision 422 (create/rename/fork all
 * return this the same way) — as opposed to any OTHER validation failure
 * GitHub also reports as 422 (an org policy blocking repo creation,
 * private repos not permitted on the current plan, a description that's
 * too long, etc.). Four call sites used to treat EVERY 422 on these
 * endpoints as "the name is taken," which would misdiagnose one of those
 * other cases and send the person off to rename something when renaming
 * was never going to fix it — same class of bug as conflating GitHub's
 * primary and secondary rate limits (a status code alone isn't a
 * specific enough signal; the message text is what actually distinguishes
 * the cause). Matches GitHub's own real wording for this specific case,
 * same text handlers/search.js's fork-collision check already relied on.
 */
function isNameCollisionError(err) {
  return !!(err && err.status === 422 && /name already exists/i.test(err.message || ''));
}

/**
 * Replies to a failed GitHub API call with the right message for the
 * situation:
 * - Secondary/abuse rate limit hit (a burst of requests, unrelated to
 *   the hourly quota) → its own message using `retry-after`, never the
 *   primary limit's reset time (checked first, before the primary branch
 *   below, so a burst-triggered 403 can't fall through to it and show a
 *   number that has nothing to do with the actual wait).
 * - Primary rate limit hit → shows the actual reset time (we already
 *   have this data via the same headers Settings reads), instead of a
 *   generic error.
 * - Auth failure (token expired/revoked mid-action) → the specific
 *   "reconnect" message + button, and if Token Health notifications are
 *   on, records it as a distinct security event in the Access Log.
 * - Anything else → generic error with the real message.
 *
 * Returns `true` if it was an auth error (so callers can skip anything
 * that implies "still fully connected", like showing the normal main
 * menu bar), `false` otherwise.
 */
async function replyGithubError(ctx, err, actionDescription) {
  // v1.2.1-multi — states the GitHub traffic layer itself can report. These are
  // checked first because they are the most specific, and each message states
  // only what is actually true (never "retrying" unless it did, never "done"
  // unless GitHub confirmed it).
  if (github.isUnknownOutcome(err)) {
    await ctx.reply(format.errorMessage(
      actionDescription,
      'GitHub did not confirm the final result of this operation. I won\u2019t claim it succeeded',
      'Check the repository on GitHub before trying again, so nothing gets done twice.'
    ));
    return false;
  }
  if (err && err.name === 'GateError') {
    await ctx.reply(format.errorMessage(actionDescription, require('./gate').describeGateError(err, 'This').replace(/\.$/, ''), null));
    return false;
  }
  if (err && err.code === 'DOWNLOAD_TOO_LARGE') {
    await ctx.reply(format.errorMessage(actionDescription, err.message.replace(/\.$/, ''), null));
    return false;
  }
  if (err && err.code === 'GITHUB_QUEUE_TIMEOUT') {
    await ctx.reply(format.errorMessage(actionDescription, 'GitHub traffic is busy and your request waited too long in the queue. Nothing was changed', 'Try again in a moment.'));
    return false;
  }
  if (err && (err.code === 'GITHUB_QUEUE_FULL' || err.code === 'GITHUB_OVERLOADED')) {
    await ctx.reply(format.errorMessage(actionDescription, 'GitHub traffic is very busy right now. Nothing was changed', 'Try again in a minute.'));
    return false;
  }
  if (err && err.code === 'GITHUB_USER_QUEUE_FULL') {
    await ctx.reply(format.errorMessage(actionDescription, 'you already have many GitHub operations waiting', 'Let them finish, then try again.'));
    return false;
  }
  if (err && err.code === 'GITHUB_TIMEOUT') {
    await ctx.reply(format.errorMessage(actionDescription, 'GitHub didn\u2019t answer in time. Nothing was changed', 'Try again.'));
    return false;
  }

  // v2.1.4: every "slow down" — GitHub's own limits and the bot's local hold-back — is one short, friendly line.
  const slow = require('./rateLimitFriendly').describe(err);
  if (slow) {
    await ctx.reply(slow.text);
    return false;
  }

  // Checked BEFORE the primary rate-limit branch — a burst of activity
  // (uploading many files in one commit, like this) can trip GitHub's
  // secondary/abuse-detection limit with the primary 5000/hour quota
  // barely touched. That used to get misreported using the primary
  // limit's hourly reset time (wildly wrong — often 45+ minutes off from
  // the real, much shorter wait), because both kinds of 403 shared one
  // check. See lib/github.js's isSecondaryRateLimitError for the exact
  // distinction and why it matters here specifically.
  if (github.isSecondaryRateLimitError(err)) {
    let resetLine = 'This isn\u2019t your hourly quota — it\u2019s GitHub\u2019s burst limit, and it clears fast. Wait a minute or two and try again.';
    try {
      const retryAfter = err.response && err.response.headers && err.response.headers['retry-after'];
      if (retryAfter) {
        const secs = Number(retryAfter);
        const waitLine = secs >= 60 ? `about ${Math.ceil(secs / 60)} minute${Math.ceil(secs / 60) === 1 ? '' : 's'}` : `about ${secs} second${secs === 1 ? '' : 's'}`;
        resetLine = `This isn\u2019t your hourly quota — it\u2019s GitHub\u2019s burst limit for doing too much too fast. Wait ${waitLine} and try again.`;
      }
    } catch (_) { /* fall back to the generic line above */ }

    await ctx.reply(format.errorMessage(actionDescription, 'GitHub\u2019s secondary rate limit was hit (too many requests too quickly)', resetLine));
    return false;
  }

  if (github.isRateLimitError(err)) {
    let resetLine = 'Try again in a few minutes.';
    try {
      const resetHeader = err.response && err.response.headers && err.response.headers['x-ratelimit-reset'];
      if (resetHeader) {
        const resetMins = Math.max(1, Math.round((Number(resetHeader) * 1000 - Date.now()) / 60000));
        resetLine = `Resets in about ${resetMins} minute${resetMins === 1 ? '' : 's'}.`;
      }
    } catch (_) { /* fall back to the generic line above */ }

    await ctx.reply(format.errorMessage(actionDescription, 'GitHub\u2019s API rate limit was reached', resetLine));
    return false;
  }

  if (isAuthError(err)) {
    // v1.2.4-multi: confirm the revocation and, if real, disconnect locally and
    // send the connect flow (handleAuthFailure replies itself).
    if (await require('./revokedToken').handleAuthFailure(ctx, err)) return true;
    try {
      const users = require('./users');
      const prefs = await users.getNotificationPrefs(ctx.from.id);
      if (prefs && prefs.tokenHealth) {
        // Deliberately NOT logged as 'disconnected' — the account is still
        // shown as connected (users.disconnect() is never called here), and
        // accessLog's anomaly detection specifically watches for a
        // reconnect shortly after a 'disconnected' event. Reusing that
        // label for a mid-action token rejection would falsely flag the
        // person's next real reconnect as "reconnected shortly after
        // disconnecting" even though nothing was ever actually disconnected.
        const accessLog = require('./accessLog');
        await accessLog.record(ctx.from.id, 'token_rejected', 'Token rejected by GitHub mid-action (likely expired/revoked)');
        // The Access Log entry above is a silent record — Token Health being
        // "on" should also mean an actual push, same as every other
        // Notification category. Sent as its own message (not folded into
        // the reconnect prompt below) so it reads as a distinct alert.
        await ctx.reply(`🔔 Token Health: your GitHub token was rejected during "${actionDescription}" — it likely expired or was revoked.`);
      }
    } catch (_) { /* best-effort, never let logging failure mask the real error */ }

    const oauth = require('./oauth');
    const inline = require('../keyboards/inline');
    const url = await oauth.connectUrl(ctx.from.id);

    await ctx.reply(
      format.errorMessage(actionDescription, 'your GitHub session expired mid-action', 'Reconnect to continue.'),
      inline.connectButton(url)
    );
    return true;
  }

  // v1.2.5-multi: a rule GitHub enforces on purpose (own-PR approval, protected branch, locked thread …) gets a
  // plain explanation and what to do instead; "Try again" is only offered when trying again can actually help.
  const known = friendly.explain(err);
  if (known) {
    const next = known.next || (known.retryable ? 'Try again in a moment.' : null);
    await ctx.reply(format.errorMessage(actionDescription, known.reason.replace(/\.$/, ''), next));
    return false;
  }
  const transient = !err || !err.status || err.status >= 500;
  await ctx.reply(format.errorMessage(actionDescription, friendly.oneLine(err).replace(/\.$/, ''), transient ? 'Try again.' : null));
  return false;
}

/**
 * A short, plain-language reason for a failure that happened in the BACKGROUND (a scheduled
 * repo or upload), where there's no chat to run replyGithubError in. v1.2.3-multi: those
 * messages used to forward err.message verbatim, which could be anything from a raw stack
 * fragment to an internal crypto error. Known causes get a clear sentence; everything else
 * is shortened and stripped of newlines.
 */
function describeForUser(err) {
  if (!err) return 'an unknown error';
  if (isAuthError(err)) return 'GitHub rejected your saved connection — please reconnect from Settings';
  if (isNameCollisionError(err)) return 'a repo with that name already exists on your account';
  if (err.status === 403 && /rate limit|abuse|secondary/i.test(err.message || '')) return 'GitHub\u2019s rate limit was reached — it will not retry automatically';
  const known = friendly.explain(err);
  if (known) return known.reason.replace(/\.$/, '');
  if (err.status === 404) return 'GitHub couldn\u2019t find the repository (it may have been deleted or renamed)';
  if (err.status === 409) return 'the repository changed while this was running';
  if (err.status >= 500) return 'GitHub had a problem on its side';
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|network/i.test(err.message || '')) return 'the connection to GitHub timed out';
  const message = friendly.clean(err.message || 'an unknown error');
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}

module.exports = { isAuthError, isNameCollisionError, replyGithubError, describeForUser, explain: friendly.explain };
