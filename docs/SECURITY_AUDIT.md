<div align="center">

# 🛡️ Security & isolation audit

**GitroHub v2.3.3-multi** · [← README](../README.md) · [Privacy & Terms: `/legal` in the bot](../src/handlers/legal.js)

</div>

**Method.** Read the code paths, then add tests for every behaviour that changed. *Verified* = checked by reading the code. *Tested* = an automated test covers it. Nothing here was exercised against a live deployment, and no penetration or fuzz testing was done.

## 📅 Review history

| Release | Scope |
|---|---|
| **v1.2.1** | First audit: OAuth lifecycle, webhooks, user isolation, admin authorization, destructive-operation honesty |
| **v1.2.2** | Fixes from that audit: HS256 pinning, bounded OAuth exchange, encrypted webhook secrets, identical responses for unknown repo / bad signature |
| **v1.2.3** | Full code, docs and in-bot-text review (this page's *v1.2.3 findings* section) |
| **v1.2.4** | Review of the new surface: Manage / Workspace, multiple accounts, organisations, extra OAuth scopes (this page's *v1.2.4 notes* section) |

## 🔐 OAuth lifecycle

| Property | Result |
|---|---|
| Signed state, short expiry, purpose claim | Verified (JWT, 10 min, `purpose` checked) |
| One-time use / replay protection | Verified — `jti` consumed in Redis *before* the code exchange (fails closed) |
| Algorithm confusion | **Fixed in 1.2.2** — `verify` pins `HS256` (it relied on the library default) |
| Hung GitHub on code exchange | **Fixed in 1.2.2** — 10 s timeout (`OAUTH_EXCHANGE_TIMEOUT_MS`) |
| Token encryption at rest | Verified — AES-256-GCM, random IV, auth tag |
| Unreadable stored token (key changed, damaged row) | **Fixed in 1.2.3** — `tryDecrypt` returns `null`; the person is asked to reconnect; Disconnect / Ban / Delete still complete |
| Scopes | `repo` + `delete_repo`. `repo` is broad, but GitHub offers no narrower scope that covers private repositories. Confirmation page, no-store / no-frame headers: Verified |
| Revoking access on GitHub | **Added in 1.2.3** — Disconnect revokes the token, Ban / Delete revoke the whole authorization (`DELETE /applications/{client_id}/token` or `/grant`), best-effort and never blocking |
| Linking one GitHub account to two Telegram users | Not prevented (allowed); webhook routing is safe for it (below) |

## 🪝 Webhooks
- Signature is verified against the stored secret *before* any processing; constant-time compare.
- **Fixed in 1.2.2:** identity is `owner login` **and** repo name, and *every* registration for that pair is tried — only the registration whose own secret signed the payload receives the event, so an event can never reach an account that did not register it.
- **Fixed in 1.2.2:** secrets are **encrypted at rest** (`enc1:` + AES-256-GCM); legacy plaintext rows still verify and are upgraded on first read. Rotation = register the webhook again.
- **Fixed in 1.2.2:** an unregistered repo and a bad signature return the identical response (no enumeration).
- **Hardened in 1.2.3:** a secret that can't be decrypted is skipped — it can never be matched with an empty key (an empty HMAC key is computable by anyone).
- **Fixed in 1.2.3:** a delivery acknowledged but not processed (rate-limited or shed) is un-marked so *Redeliver* works, and dropped events are counted and reported to the person.
- **Fixed in 1.2.3:** the stored GitHub login (which the lookup joins on) is refreshed when it changes.
- Tested: encryption / legacy / upgrade, dedupe, rate cap, bounded processing, forget-on-drop.

## 👥 User isolation
- **GitHub clients / caches** are all keyed by token fingerprint (client cache, coalescing, ETag/TTL cache, `repoCache`). Tested: two users with identically named repos never share a request or a cached result.
- **Callback references** are content-addressed (`~id` = hash of the data, integrity-checked on resolve) and carry only a repo name or path — never a user id or token. A tap always runs with the *tapping* user's token and session, and Telegram clients cannot forge callback data.
- **Repo listing (1.2.3):** only repos the person *owns* are listed (`affiliation=owner`). Previously collaborator/organization repos were listed too, and an action on one could land on the person's own same-named repo.
- **Shared `/tmp` files** were removed in 1.2.1 (exports and README sends are served from memory).
- **Per-user update serialization** is a tested component with a backlog cap, fronted by a rapid duplicate-tap guard (1.2.3).

## 🧑‍💼 Admin authorization
- Every exported handler in `admin.js`, `wardenAdmin.js` and `wardenBoard.js` re-checks the role itself (`requireAdmin` / `requireRole` / `requireOwner`) — UI hiding is never the only protection. The route also drops non-admin callbacks, and Lockdown is enforced inside `requireAdmin`. *Verified again in 1.2.3.*
- Bulk admin operations require **super_admin**. **Permanent Delete User now also requires super_admin** (1.2.3 — the README said so; the code only checked `admin`).
- Owner-only: Lockdown, Repo Shield, Warden decisions and the GitHub Traffic levers (which write to the audit log).
- `executeDeleteUserRepo` / `executeRepoVisibility` / licence use `requireRole(ctx,'admin')` plus a private-repo block and `assertRepoModerationAllowed`.
- Reports go to everyone who can resolve them (read from the roles table), are limited to one a minute and five open per person (1.2.3).
- Residual: ordinary users cannot write the audit log through any route found, but not every callback was fuzzed with forged roles.

## ✅ Destructive-operation honesty
Repo delete, visibility, rename, file delete, bulk operations and admin moderation report an **unconfirmed** write as unconfirmed ("GitHub did not confirm…") instead of "nothing was removed". Destructive calls are never retried automatically; the read-back check decides.
**1.2.3:** a repo is backed up to Trash before deletion (single *and* bulk); a repo that can't be backed up is not deleted.

## 🔎 v1.2.3 findings (full review)

| Area | Finding | Resolution |
|---|---|---|
| Availability | Auto-rule name patterns became regular expressions; a pattern like `a*a*a*a*a*a*b` against a 100-character name blocked the single process for ~9.5 s (longer with more `*`). One user could stall everyone. | Linear-time glob matcher; ≤ 100 characters and ≤ 8 wildcards; validated on create **and import**. |
| Integrity | Settings import wrote unvalidated values (defaults, rules, schedules) from a user-edited file. | Per-field validation; invalid items skipped and counted. |
| Integrity | Double taps could flip toggles twice; confirm buttons acted on "the opposite of now". | Rapid-tap guard; buttons carry their target state. |
| Privacy | Delete User left Warden rows behind. | Purged with the account. |
| Privacy | The Privacy Policy omitted Warden and overstated "fixed" retention. | `/legal` rewritten from the code. |
| Disclosure | The Fleet Stats chart was rendered by an external service. | Rendered locally; no outbound call. |
| Robustness | A token that couldn't be decrypted broke Disconnect, Ban and Delete. | Fail-safe `tryDecrypt`; shared teardown routine. |

## 🆕 v1.2.4 notes — the new surface

- **Every Manage / Workspace button goes through one dispatcher** that checks, in order: connected → feature switch → OAuth scope → repo-name validity → handler. A repo or branch name taken from a button is validated again server-side (`lib/repoName`, `assertBranchName`, `assertTagName`); usernames, numeric ids and node ids are validated before they reach a URL or GraphQL variable. Tests feed hostile callback data and assert nothing is written.
- **Writes verify, never guess.** Merge, branch create/delete, release create, revert, topics and transfer read GitHub back when the answer was lost. Revert only ever moves a branch fast-forward (`force: false`) and refuses if any file changed since.
- **Secrets:** the value is encrypted client-side with libsodium's sealed box against the repo's public key; the person's message is deleted right after reading; the value is never logged, echoed or stored (a test asserts it never appears in any request). A private SSH key sent as a deploy key is refused.
- **Scopes:** the base grant is unchanged. `gist`, `read:org`, `project` are requested on first use only, from a fixed whitelist (anything else is refused), and the grant is added to — not replacing — what GitHub already holds. OAuth `state` handling and the callback page are unchanged.
- **Accounts:** each account's token is stored AES-256-GCM like the first; Disconnect / Ban / Delete tear down only that account's webhooks with that account's token; Ban and Delete User remove all of them. Migration export/import re-keys every stored account token.
- **Revoked-token handling** only reacts to a *confirmed* 401 from `GET /user`; the probe is single-flight per person, and 403/5xx/timeouts never disconnect anyone.
- **Residual:** tags, pins, schedules and alerts are keyed by repo name, so same-named repos across accounts/organisations share them (live alerts refuse a conflicting registration). Org admins can limit third-party OAuth apps; if an organisation hasn't approved GitroHub its repos won't list — the Organisations screen says so.

## 🆕 v1.2.5 notes
- Warden Watch only *observes and notes*; the single hold (Owner switch) applies to ordinary people for transfer, branch rollback and forced revert, never to admins, and needs a one-time Owner approval.
- Rollbacks make a backup branch first, refuse protected branches and non-ancestor targets; commits are fast-forward only (`force:false`).
- The OAuth `state` is signed and now carries the requested scopes only for display; the grant is whatever GitHub issues.
- The status page shows states and plain words only — no counts, versions of dependencies or identifiers.
- Owner import validates structure, runs in one transaction and rolls back on any error.

## ⚠️ Other findings fixed earlier
- Broadcast swallowed *every* send error (Telegram flood control silently lost messages) — now paced, honours `retry_after` (bounded), and reports blocked vs failed.
- During a DB/Redis outage users saw raw driver text — now a short, non-leaky "temporarily unavailable" message.
- Redis offline queue was unbounded — now fails fast with jittered reconnect backoff (`REDIS_OFFLINE_QUEUE=1` restores the old behaviour).
- Unbounded in-process caches — all LRU / weight-capped and swept.

## 🚧 Not verified / residual risk
- No live OAuth / GitHub / Telegram traffic was exercised; no penetration or fuzz testing.
- Two Telegram accounts may link the same GitHub account; Warden and Repo Shield treat them as separate users.
- `PG_POOL_MAX` is left at 3 on purpose; the pool reports saturation (metrics, `/health`, and a rate-limited log hint) so it can be raised from evidence.
- The database holds each person's encrypted token; protect `TOKEN_ENCRYPTION_KEY` and database backups accordingly.
