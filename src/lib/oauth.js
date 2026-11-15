const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const STATE_PURPOSE = 'github-oauth';
const STATE_TTL_SECONDS = 10 * 60;

/**
 * Builds the GitHub "Authorize" URL for the Web Application Flow.
 * The `state` param is a short-lived signed JWT carrying the Telegram
 * user id — this is how /callback knows which Telegram chat to reply to
 * once GitHub redirects back.
 *
 * v1.1.7-multi hardening: the state now also carries a random one-time id
 * (`jti`) that /callback burns on first use (see consumeState), so a state
 * — and therefore an authorize link — can be completed exactly once, and a
 * `purpose` claim so no other JWT signed with the same secret can ever be
 * replayed as an OAuth state. The link-injection defence itself (someone
 * handing a victim THEIR link) is the confirmation page in server/app.js,
 * which shows which Telegram account is about to be linked before any code
 * is exchanged.
 */
function buildAuthorizeUrl(telegramId, { extraScopes = [] } = {}) {
  const requested = require('./scopes').authorizeScope(extraScopes);
  const state = jwt.sign(
    // v1.2.5-multi: the scopes ride along in the (signed) state so the confirm page can say exactly what is being asked for.
    { telegramId, purpose: STATE_PURPOSE, jti: crypto.randomBytes(12).toString('hex'), scope: requested },
    config.SESSION_JWT_SECRET,
    { expiresIn: STATE_TTL_SECONDS, algorithm: 'HS256' }
  );
  const params = new URLSearchParams({
    client_id: config.GITHUB_CLIENT_ID,
    redirect_uri: `${config.BASE_URL}/callback`,
    // v1.1.8: user:email REMOVED. It briefly existed (v1.1.7) so the
    // account's primary email could be shown on the "welcome back" card
    // — that display is gone now, so requesting access to a person's
    // email with nothing to show for it was scope creep with no
    // purpose. Back to the minimum this bot actually needs: repo access
    // and the ability to delete a repo it created.
    // v1.2.4-multi: base scopes plus any extra a feature asked for (lib/scopes.js
    // validates them against a whitelist). Plain connects pass nothing.
    scope: requested,
    state,
    allow_signup: 'false',
    // v2.1.0-multi: always show GitHub's account picker. Without it GitHub silently re-uses the account the browser is
    // signed in as (and an app it already authorised redirects straight back), which made adding a second account impossible.
    prompt: 'select_account',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * v1.2.5-multi: true for someone who has never connected (no user row, or no first-connection time). Informational only:
 * every new connection, including a reconnect after Disconnect, asks for all permissions (see connectUrl).
 */
async function isFirstConnect(telegramId) {
  try {
    const user = await require('./users').getUser(telegramId);
    return !user || !user.connected_at;
  } catch (_) {
    return false; // when unsure, ask for the minimum
  }
}

/**
 * The link for ANY new connection — first time, reconnect after Disconnect or a revoke, or adding another account:
 * everything is asked for at once, so the person is never interrupted later with "grant one more permission".
 * (Only the on-demand "grant one extra permission" button of an already-connected person uses buildAuthorizeUrl directly.)
 */
async function connectUrl(telegramId) {
  return buildAuthorizeUrl(telegramId, { extraScopes: require('./scopes').firstConnectExtras() });
}

/** Verifies + decodes the state param without consuming it. Throws if
 * invalid/expired/tampered or not an OAuth state. */
function inspectState(state) {
  if (typeof state !== 'string' || !state) throw new Error('missing state');
  // Algorithm pinned: never let the token header choose how it is verified.
  const payload = jwt.verify(state, config.SESSION_JWT_SECRET, { algorithms: ['HS256'] });
  if (payload.purpose !== STATE_PURPOSE || !payload.jti || !Number.isFinite(Number(payload.telegramId))) {
    throw new Error('not an OAuth state');
  }
  return { telegramId: Number(payload.telegramId), jti: payload.jti, scopes: typeof payload.scope === 'string' ? payload.scope.split(',').filter(Boolean) : [] };
}

/** Back-compat: verify + return just the Telegram id. */
function verifyState(state) {
  return inspectState(state).telegramId;
}

/** Burns a state's one-time id. Returns true the first time, false if it
 * was already used. Fails CLOSED: if Redis can't be reached this throws,
 * and the callback refuses to link anything. */
async function consumeState(jti) {
  const { client } = require('../db/redis');
  const result = await client.set(`oauth-state-used:${jti}`, '1', { NX: true, EX: STATE_TTL_SECONDS + 60 });
  return result === 'OK';
}

/** Exchanges the temporary `code` for a real GitHub access token */
async function exchangeCodeForToken(code) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    // v1.2.1-multi: bounded — a hung GitHub must not hold this request (and the user's browser) open forever.
    signal: AbortSignal.timeout(Number(process.env.OAUTH_EXCHANGE_TIMEOUT_MS) || 10000),
    body: JSON.stringify({
      client_id: config.GITHUB_CLIENT_ID,
      client_secret: config.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${config.BASE_URL}/callback`,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange returned HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }
  return data; // { access_token, scope, token_type }
}

module.exports = { buildAuthorizeUrl, isFirstConnect, connectUrl, inspectState, verifyState, consumeState, exchangeCodeForToken };
