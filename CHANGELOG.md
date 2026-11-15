<div align="center">

# 📋 GitroHub Changelog

Every release, newest first. Click a version to expand it.

</div>

---

See **[README.md](./README.md)** for the current feature set and setup. Versions are `MAJOR.MINOR.PATCH-multi`; the "-multi" suffix marks the open, multi-user line of GitroHub.

## 🧭 Release index

| Version | Highlights |
|---|---|
| **v2.3.3-multi** | Uploads: live progress card (extracting → comparing → committing n/total), automatic pause & resume through GitHub rate limits, ❌ Cancel, far fewer GitHub requests per commit, restart recovery |
| **v2.3.2-multi** | Fixes: uploading a whole-project zip no longer trips GitHub’s secondary rate limit (preview requests are capped), and a GitHub “slow down” is one short friendly line everywhere instead of “Something went wrong” / “Couldn’t load files” |
| **v2.3.1-multi** | Fixes: the bottom keyboard no longer stays stuck on the previous page after /admin, /help, /legal and other typed commands; Warden’s eye icon replaced by a calm shield-and-pulse mark (web panel and Telegram) |
| **v2.3.0-multi** | Owner panel: Warden tab, live badges and refresh, Undo, charts, scheduled announcements, admin team, sessions, errors feed, search, bulk tools, installable app, desktop layout; fixes for people counts and the Audit / Errors pages |
| **v2.2.1-multi** | Bug fix: the owner panel's “Open the panel” button (and every panel action) was refused by the server — “Cannot POST /owner/go” |
| **v2.2.0-multi** | New: owner-only web panel at /owner (single-use 2-minute links from the bot, full actions), SVG icons with real logos and animation on every web page (no emoji) |
| **v2.1.5-multi** | Bug-fix release: version bump only — no code changes (re-release after a build-host failure) |
| **v2.1.4-multi** | Fixes: Security › Dependabot “page parameter not supported”, the Linux-kernel-sized repo that tripped GitHub's rate limit on 📊 Details (and then every other button), one short friendly rate-limit message; /start now above /admin |
| **v2.1.3-multi** | Fixes: taps whose warning was swallowed (the pause toggles and ~every “🔒 …needed” toast), PR lists/pages show date, time and year; admins get their dashboard on the not-connected bar and a /admin shortcut |
| **v2.1.2-multi** | Fixes: the bar marker (📂 Repository…) now sits above its page, 📤 Upload works again, pull requests you open now show on Start and in Notifications, and Files on an empty repo is a small friendly note |
| **v2.1.1-multi** | Fixes: New Repo crashed on its first prompt (unescaped dots), a safety net for bad formatting, faster replies, a watchdog so one stuck update can't freeze your taps, and errors inside a flow no longer leave you stuck |
| **v2.1.0-multi** | One rule for every bar (no duplicated buttons), a dynamic Start card in the new layout, and adding another GitHub account works again (account picker) |
| **v2.0.0-multi** | Layout and UX overhaul: a 2×2 Home bar, one navigation bar on every page (Back lives only there), five repos per page, a glance card per repo, redesigned New Repo / Upload / Rename / Edit flows, standard result cards, and a reorganised Workspace, Notifications and Settings |
| **v1.4.0-multi** | Navigation, simplified: one Back trail that never dead-ends (Help, Legal, Settings), short screens (glance → 📊 Details), and a bottom bar that follows where you are (📂 repo shortcut) |
| **v1.3.0-multi** | Navigation redesign: a one-row menu, 💼 Workspace as the home of everything, inline Settings, 🧯 Restore center, grouped ⚡ Manage, and the 🛡️ Admin dashboard inside Workspace |
| **v1.2.6-multi** | Reconnect asks for every permission, 🔔 unread notifications on the start card, 💼 Workspace replaces ➕ New Repo on the main menu, honest "already connected" result |
| **v1.2.5-multi** | Multi-account done properly, ⏪ Undo & Restore, 📌 Needs attention, 🛰️ Warden Watch & tiered monitoring, friendlier errors, owner import/export for the new structure, redesigned web pages |
| **v1.2.4-multi** | Two fixes (Owner + ADMIN_IDS, revoked GitHub access) and the biggest feature release yet: ⚡ Manage per repo, 💼 Workspace, organisations and multiple accounts |
| **v1.2.3-multi** | Safer deletes, a local chart engine, honest docs, and a full code-review pass |
| **v1.2.2-multi** | security & resilience pass, snapshot-import fix, GitHub Traffic screen fix |
| **v1.2.1-multi** | GitHub traffic control, resource gates, and a scaling audit |
| **v1.2.0-multi** | Warden Brain: an observer, not an enforcer. Evidence → baseline → confidence → decision, an Owner Board, Repo Shield, JSONL |
| **v1.1.24-multi** | Fix: people (and the owner) wrongly restricted by Warden; owner exempt from limits and private from other admins; Warden menu redesigned |
| **v1.1.23-multi** | Reviewed merge of the parallel "1.1.49-gpt" branch: scheduled jobs can no longer run twice, safer webhook digests & data erasure, double-… |
| **v1.1.22-multi** | Fix: typed-answer prompts no longer go silent after an error |
| **v1.1.21-multi** | Perf: My Repos / Pinned / Repo View no longer stall on big repos; friendlier GitHub-connect confirmation page |
| **v1.1.20-multi** | Fix: "wrong input, then correct input gets ignored" across ~10 flows; the ⬅️ Back button in Create Repo never actually went back; a repea… |
| **v1.1.19-multi** | Fix: repo-creation inline ❌ Cancel did nothing; offline bot test scripts merged in and repaired |
| **v1.1.18-multi** | Fix: signups-paused bypass at the actual link step, sibling-connection visibility, 5 admin permission-check gaps |
| **v1.1.17-multi** | Stability pass: dead adaptive rate-limit backoff wired up, logging/consistency cleanup |
| **v1.1.16-multi** | Fix: successful actions showing a false "activity_log_pkey" / "access_log_pkey" error |
| **v1.1.15-multi** | Admin: undo ledger, deeper repo moderation, audit-log filters |
| **v1.1.14-multi** | Weekly auto-backup, stale-repo nudges, size history |
| **v1.1.13-multi** | 📦 Storage & Data, Recently Viewed and Search History |
| **v1.1.12-multi** | Tags, nesting groundwork and pin sections (data layer) |
| **v1.1.11-multi** | Quiet hours, rollup digests and per-person timezones |
| **v1.1.10-multi** | Smart Folders and the composable filter builder |
| **v1.1.9-multi** | Trash polish: Edit & Restore, ZIP re-send, delete forever |
| **v1.1.8-multi** | Lockdown Mode, broadcast hub, Global Config expansion, 🗑️ Trash retention |
| **v1.1.7-multi** | Security & robustness pass: archive bombs, OAuth link-injection, BIGINT ids, rate limits, data erasure |
| **v1.1.6-multi** | GitHub email on /start, username styling |
| **v1.1.5-multi** | Fix: three more misdiagnosed/duplicated error messages |
| **v1.1.4-multi** | Fix: misreported rate-limit error on bulk uploads |
| **v1.1.3-multi** | Fix: MarkdownV2 crash on /repos and /new while disconnected; multi-file scheduling |
| **v1.1.2-multi** | Deep debug pass: 9 bugs found and fixed |
| **v1.1.1-multi** | Fix: demotion had no path to a fully normal user |
| **v1.1.0-multi** | Promote any user, protected Owner, promote/demote clarity |
| **v1.0.9-multi** | Report categories, CSV export |
| **v1.0.8-multi** | Roles, repo moderation depth, timed bans, on-demand chart |
| **v1.0.7-multi** | Admin Dashboard: analytics, filters, scheduling, reports, attachments |
| **v1.0.6-multi** | Admin Dashboard: five real gaps closed |
| **v1.0.5-multi** | `/legal` audited against the code the same way `/help` was |
| **v1.0.4-multi** | Fixing the v1.0.3-multi `/help` rewrite's own accuracy gaps |
| **v1.0.3-multi** | `/help` filled back out to match what the bot actually does |
| **v1.0.2-multi** | Real /legal text, `/repos` & `/new` commands |
| **v1.0.1-multi** | Help menu fix |
| **v1.0.0-multi** | Production release |

## 📦 Releases

<details open>
<summary><b>v2.3.3-multi</b> — Uploads: live progress, pause and resume through GitHub rate limits, Cancel, far fewer requests</summary>

#### New
- **A live progress card follows every upload.** One message, edited in place: 📦 Extracting → 🔍 Comparing → ⬆️ Committing with a bar and a count (`▰▰▰▱▱▱▱▱▱▱  40 / 300 files`). The commit card you tap becomes this card and then becomes the result, so no stale Commit button is left behind. Edits are throttled (about one every 2 s, backing off if Telegram pushes back).
- **“⏸ Paused by GitHub — resuming in 60s”.** When GitHub asks the bot to slow down, the upload no longer dies: the card shows the countdown, waits, and carries on from where it stopped — files already sent are never sent twice. Up to four pauses of up to five minutes each; past that it stops with the usual friendly message and nothing changed.
- **❌ Cancel upload.** On the card until the last step. It stops the commit before the branch moves, so nothing in the repo changes. Once the final step has started it is too late, and the card says so by finishing as a success.
- **Restart recovery.** An upload cut off by a deploy used to leave “Committing…” on screen forever. Each card leaves a heartbeat; a card that goes quiet is rewritten to “Upload interrupted — most likely nothing was changed, check the repo”.

#### Changes
- **Far fewer GitHub requests per commit.** GitHub allows roughly 80 content-creating requests a minute, and a whole-project zip used to make one blob request per file. Text files now travel *inside* the tree request (GitHub makes the blob itself), in chunks of up to 100 files / 1.5 MB; only binaries, empty files and very large files still get a blob, and those are paced (about 66 a minute) once there are more than 30. A 300-file text zip went from 300+ content requests to 3 tree requests (about 8 requests in total with the reads and the commit).
- **The commit runs as a background job.** Previously the whole upload ran inside one Telegram update, which meant anything the person tapped meanwhile — including Cancel — queued behind it, and a long GitHub pause would have hit Telegram’s 90-second handler limit. The job is independent of the chat’s session, so “Make this my default upload folder” is now worked out when you tap it.
- **“This screen is out of date” is now traceable.** Whenever it appears, the log records which button or Back target was stale.

</details>

<details>
<summary><b>v2.3.2-multi</b> — Fixes: zip uploads tripping GitHub’s rate limit; one friendly line for every “slow down”</summary>

#### Fixes
- **Uploading a zip of a whole project no longer hammers GitHub.** The upload summary fetched the old content of every *modified* file (one GitHub request each) to draw a line-by-line preview. When you upload a new version of a project, nearly every file is “modified”, so that was hundreds of requests at once — enough to trip GitHub’s secondary rate limit, after which the bot (correctly) holds every request for a minute or more and the upload died with “GitHub needs a short break”. Only the first 8 modified files now get a line preview; the rest are compared by SHA and show their old size straight from the file list (no extra requests), and if GitHub says slow down mid-way the remaining previews are skipped.
- **A GitHub “slow down” is now one short line everywhere.** After a failed upload the bot reloaded the Files page, which failed again with a second red “Couldn’t load files…” error, and taps that hit the same limit showed “Something went wrong: GitHub secondary rate limit…”. Both now show the single friendly “⏳ GitHub needs a short break — try again in about …” line.

</details>

<details>
<summary><b>v2.3.1-multi</b> — Fixes: stuck bottom keyboards after typed commands; Warden gets a calmer icon</summary>

#### Fixes
- **The bottom keyboard no longer stays stuck on the page you just left.** Opening a screen with a typed command (`/admin`, `/help`, `/legal`, `/owner`, `/report`, …) or an Admin / Warden / Export tap used to leave the previous page's bar underneath it — for example the Files bar (Upload Here / Replace Folder / Find Files) under the Admin dashboard, or the My Repos bar under Help. Previously only the Home bar was reset, and only until you tapped ⬅️ Back or sent /start. Now every page-specific bar (My Repos, Repository, Files, Notifications, Search GitHub) is swapped for the small ⬅️ Back bar the moment a page that doesn't belong to it opens, and the marker sits above that page like it does from Home. Pages that pick their own bar (`/repos`, `/settings`, `/new`, …) are untouched.
- **Connecting GitHub from the browser no longer leaves Home’s 2×2 stuck.** The connect page sends the Home bar straight to the chat, but the bot’s saved session kept naming the old bar, so the next page that wanted that bar thought it was already up and never sent it. The session now learns about the Home bar the moment the page sends it.

#### Changes
- **Warden's eye is gone.** The web panel's Warden mark (bottom bar, header, Overview, user cases, search) is now a shield with a steady pulse line, and the Telegram messages that used 👁 for Warden (observing stage, Keep monitoring, snoozed) now use 🔵 / 🛡 / 💤. Other eyes that mean "view" (View Content, repo Traffic, Guest role) are unchanged.

</details>

<details>
<summary><b>v2.3.0-multi</b> — Owner panel: Warden, undo, charts, announcements, team, sessions, search, bulk tools, installable, desktop layout</summary>

#### Fixes to the 2.2 panel (found while wiring the new pages to the real library code)
- **Overview showed `?` for users, active today, connected, new and commits.** The fleet overview returns camelCase names (`totalUsers`, `newThisWeek` …) and the panel read snake_case ones. Fixed; the test now uses the real shape.
- **Audit log and Errors would have failed on real data.** Both libraries return `{ rows, total }`, not a plain list. Fixed everywhere (audit, user history, errors), and the audit log now shows people by name and the real total.
- **A slow answer, or a delayed refresh, could draw an old page over the one you had moved to** (for example, "send now" refreshed Announcements 0.8 s later even if you had already opened another page). Every page load now paints only while it is still the page on screen; found by the new click-everything test and covered by a regression test.
- The tests for these pages now stub the libraries with their **real** return shapes and feed the server's actual answers to the panel script, so this class of mistake can't pass silently again.

#### Warden has its own tab
- **Cases:** fleet stage bar and counts, open cases with stage, risk and confidence, filters (all flagged / enhanced and above / review candidates). A case page shows why Warden is watching, the timeline, the evidence and earlier cases, and lets you **dismiss** (false alarm), **snooze**, suspend or ban, or open the person.
- **Watch:** flagged sensitive actions (mark reviewed) and recent changes people made.
- **Approvals:** held actions waiting for you, with **Approve** (needs a fresh sign-in) and **Deny**; the person is told, exactly as from the bot.
- **Log:** everything Warden decided, paged, and dataset **exports** (fresh sign-in).
- **Settings:** Warden on / off, case alerts, and **emergency lockdown** (lock every admin out; fresh sign-in).
- Warden only reports; every decision is yours and is audit-logged (`[web]`).

#### Everything else you asked for
- **Live badges and refresh:** counts on Reports, Warden and More (and in the browser tab title); pages that show live data refresh quietly every 30 seconds while visible — never while you're typing or a dialog is open, and only repainting when something actually changed.
- **Undo:** the audit log lists what can still be reversed (bans, suspensions, bulk actions — the bot's own one-hour undo ledger) with an Undo button; after a ban or suspension a toast offers Undo straight away.
- **Charts:** sign-ups, active people, bot actions, commits, errors and rate-limited actions over 14 / 30 / 90 days as animated SVG (still for reduced motion); two on the Overview. GitHub's own request history isn't stored, so the live GitHub state stays on the Overview.
- **Announcements page:** send now, **schedule** (once, daily, weekly or every few days, with an end date), cancel, **send again**, and history. Sent from the web, they're recorded in the same history as the bot's (so the poller can never send one twice).
- **Admin team:** the roster with roles and lock state; add, change role, revoke, lock out / unlock; emergency lockdown state.
- **Sessions:** your signed-in devices (“Chrome on Android”, masked address), sign out one or all others; sign-in history. Sign-ins are audited with the device and a masked address.
- **Errors & jobs:** errors, anomalies and scheduled jobs, with load-more.
- **Search everywhere:** press `/` or Ctrl/Cmd+K (or the search button) to find people, Warden cases, reports and pages.
- **Bulk tools:** suspend (everyone inactive / everyone), mute or unmute all, nudge people who never connected, remove never-connected accounts, delete banned people's data (type DELETE), with live counts; all need a fresh sign-in. **Exports:** all users (JSON) and Warden datasets as real downloads.
- **Users:** filter chips (admins, blocked, suspended, never connected, connected), load more, Warden status and recent sensitive actions on each person.
- **Installable:** a web app manifest and icon, so the panel can be installed to the home screen (Install button on Sessions / More; iPhone: Share → Add to Home Screen). It caches nothing.
- **Desktop layout:** a sidebar with every section and badges; Users and Warden cases open side by side (list left, detail right). Phones keep the bottom tabs: Overview, Users, Warden, Reports, More.

#### Safety
- New fresh-sign-in actions: Warden **approve**, **lockdown**, admin **team** changes, **bulk** actions, **exports**, scheduled / repeated announcements. Locking an admin out and denying a request never need it (they only reduce risk).
- Destructive bulk actions need the word `DELETE` typed — checked on the server too. Search terms are parameterised and `%` / `_` escaped. Downloads are attachments with `nosniff`, no caching and sanitised file names. Session ids are never shown (only a hash reference). Responses never include tokens.
- Content-Security-Policy gains only `manifest-src 'self'`.

#### Under the hood
- The panel's browser code and styles now live in real files (`src/server/ownerClient/*`), joined at start-up, and the API is split into modules (`src/server/ownerApi/*`). New Redis key `ownerweb:index` (see docs/REDIS_KEYS.md).

#### Tests
- New `scripts/v230-tests.js` (24 tests): the real-shape API tests for every endpoint, fresh-sign-in coverage, bulk safety, sessions, manifest, the search palette, and the panel script both rendering every page and **clicking every button, switch and field on every page** (dialogs auto-confirmed) in phone and desktop layouts, against the server's real answers, with hostile text escaped and no script error or server crash allowed.
- Ban, suspend and the bulk actions now return their undo id, so the Undo button in the toast needs no lookup.

</details>

<details>
<summary><b>v2.2.1-multi</b> — Owner panel sign-in fix</summary>

- **Fixed:** pressing **Open the panel** showed “Cannot POST /owner/go”, and no panel action could have worked either. The panel's pages told browsers `Referrer-Policy: no-referrer`; with that policy browsers send **`Origin: null`** on every form post and API call, and the server's own forgery check refused exactly that. (My tests sent an ordinary Origin header, so they never saw it.)
- **Now:** the pages use `Referrer-Policy: same-origin` (nothing is sent to other sites; our own server gets a proper Origin), and the same-origin check trusts the browser's unforgeable `Sec-Fetch-Site` header when it is present. Without it (older browsers) the Origin must be ours and a bare `Origin: null` is still refused. The CSRF token is still required on every change either way.
- **Still refused (and tested):** other sites, cross-site and same-site (sibling subdomain) requests, and a bare `Origin: null` with no browser attestation.
- If your 2-minute link had already been used or expired when this happened, just send `/owner` again for a new one.

#### 🧪 Tests
- New `scripts/v221-tests.js` (5 tests) using the headers a real browser sends, the forged-request cases, the referrer policy on both pages and the version.

</details>

<details>
<summary><b>v2.2.0-multi</b> — Owner web panel, SVG icons everywhere on the web</summary>

#### 🌐 Owner web panel (`/owner`)
- A private web page for the **owner only**, on your existing domain (`<BASE_URL>/owner`). No new domain, no BotFather setup, no passwords.
- **Access through the bot:** `/owner` (owner only; it appears in the owner's “/” menu under /start and /admin) or **Web panel** on the Admin Dashboard sends a button with a **single-use link that expires after 2 minutes**. The link is never in the message text (so no preview can touch it) and the message deletes itself.
- **Opening it is two steps on purpose:** the link first shows an *Open the panel* button and spends nothing, so a chat app previewing the link can't use it up. Pressing the button spends it (two racing requests: exactly one wins) and starts a **12-hour session** in an HttpOnly, SameSite=Strict, Secure cookie, stored server-side in Redis (only a hash of the id is kept).
- **Strangers get the ordinary 404**, on every path and method — the panel doesn't reveal that it exists. Malformed requests from strangers look the same. Link guessing and API hammering are rate-limited.
- **The owner role is re-checked on every request**, so moving the owner role ends access at once. **Sign out** ends the session. `OWNER_WEB=off` switches the whole panel off.
- **Actions from day one**, all through the same library code as the bot's dashboard (so the same rules apply) and all written to the same audit log, tagged `[web]`:
  - **Overview:** health, database, cache, GitHub traffic state, memory, event loop, uptime, user counts, open reports, maintenance and sign-up switches.
  - **Users:** search; role (set / revoke), ban / unban, suspend / lift, pause / resume a feature, notes, send a message; per-user history. The owner can't be banned, demoted or paused from here.
  - **Reports:** open / resolved / dismissed, resolve or dismiss.
  - **Audit log:** filter by action and admin.
  - **Controls:** switches and limits (maintenance mode, pause sign-ups, Warden options, size and rate limits, feature switches) with “use default”, and an **announcement** to everyone — sent in the background, one at a time, with the result delivered to your chat.
  - **Webhooks:** registered hooks and live counters.
- **Safety rails:** every change needs a CSRF token and our own origin (cross-site requests are refused); roles, bans, announcements and switches that affect everyone need a **fresh sign-in** (a link opened in the last 10 minutes), otherwise the page asks you to send /owner again; strict Content-Security-Policy with a per-response nonce (no inline handlers, no `unsafe-inline`), no caching, `noindex`, no framing. Tokens, encrypted tokens and secrets never leave the server.
- Mobile-first, dark/light, no framework and no build step — same style as the status page.

#### 🎨 SVG icons instead of emoji on every web page
- One icon registry (`server/icons.js`) for all web pages: **no emoji characters on the status page, the connect pages or the owner panel**. (Telegram messages keep their emoji — Telegram can't show SVG there.)
- **Real marks:** GitHub, Telegram and the GitroHub logo. PostgreSQL and Redis use a clean database / cache icon; drop the official `postgresql.svg` / `redis.svg` into `public/icons/brands/` and they are used automatically.
- **Animated, CSS only:** a drawn check for healthy, a gently shaking triangle / cross for warnings and outages, a pulsing cache, a layered queue, a ticking clock, spinners while loading. All of it stops for people who ask their device for reduced motion.
- **Status page:** tile, state, banner, theme and Telegram-button icons are all SVG. Live refresh only repaints tiles that changed, so the one-time animations don't replay every 10 seconds. `/status.json` now carries icon *names*, not glyphs.
- **Connect pages:** the text caret on the steps toggle is now an SVG chevron.

#### 🧪 Tests
- New `scripts/v220-tests.js` (23 tests): icon registry and reduced motion, drop-in brand logos, no emoji on any web page, links (single-use, racing, expiry), sessions (cookie flags, owner re-check), strangers get nothing, the two-step sign-in, CSP and nonce, secrets never in responses, CSRF and origin checks, fresh-session rule, owner protection and input validation, audit tagging, background one-at-a-time broadcast, sign-out and `OWNER_WEB=off`, rate limits, the bot's `/owner`, the menus and wiring, the panel script rendering every view against a mocked API (with hostile text escaped), and the version.
- The offline test environment now stands in for `express` when it isn't installed, so server modules can be loaded in tests.

</details>

<details>
<summary><b>v2.1.5-multi</b> — Bug-fix release (re-release)</summary>

- Patch version bump so the 2.1.4 changes can be built and deployed again after the build host reported *“failed to list workers … buildkitd.sock: use of closed network connection”*. That message comes from the build daemon on the host losing its own connection, not from the bot's code: **there are no code changes in this release.** If it appears again, simply re-run the build.

</details>

<details>
<summary><b>v2.1.4-multi</b> — Security paging, huge repos, friendly rate limits</summary>

#### 🛡️ Security › Dependabot
- **Fixed:** “⚠️ Security: Pagination using the `page` parameter is not supported.” GitHub's Dependabot alerts only do cursor paging, but the bot asked for “page 1, 2, 3…”. The list now follows GitHub's cursors (remembered per repo, so ‹ Prev / Next › still work), and the overview counts no longer send a page number at all.
- **Safety net for every list:** if GitHub ever answers that the `page` parameter isn't supported, the same request is repeated once without it. I went through every GitHub route the bot calls: Dependabot was the only cursor-only one.

#### 🐧 Huge repositories (the Linux kernel fork)
- **Cause:** the repo card read the repo's whole file tree to count files, folders and size. For a 6 GB repo that is a multi-megabyte answer GitHub treats as too much too fast, so it answered with a *secondary rate limit* — and then the bot's own protection held back **every** GitHub call for ~40 s, which is why every other button failed after 📊 Details. 📊 Details itself repeated the whole load a second time.
- **Fix:** repos over ~250 MB are never tree-scanned; the card, My Repos and Pinned use GitHub's own size for them (a repo that big has no meaningful exact count anyway). Normal repos are unchanged.
- **📊 Details** now reuses what the card just loaded (kept for 90 s): no extra GitHub calls at all in the normal case.

#### ⏳ One short, friendly rate-limit message
- The three long messages (“secondary rate limit — requests are paused for about 41s (held locally)”, “…the wait is longer than I can hold this open…try again shortly..”, and the generic “Couldn't open … Go back and refresh your repo list”) are replaced by one line: *“⏳ GitHub needs a short break — try again in about 45s.”* (plus “Nothing was changed.” only when the bot itself held the request back, so it can never be wrong). Repo cards add a **🔄 Try again** button.
- The stray “..” at the end of some error messages is gone.

#### 🧭 Admin menu
- Admins' “/” menu now lists **/start** first and **/admin** right under it.

#### 🧪 Tests
- New `scripts/v214-tests.js` (11 tests): menu order, Link-header cursors, the no-`page` retry, cursor walking across pages, the huge-repo guard (card, lists, batch), Details reuse, the friendly messages (local and GitHub-side), the “..” fix, `replyGithubError`, and the version.

</details>

<details>
<summary><b>v2.1.3-multi</b> — Toggles that talk back, PR dates with year, admin dashboard when not connected, /admin</summary>

#### 🔘 Taps that looked ignored (the “Pause a feature” toggles — and every screen like them)
- **Root cause:** Telegram lets a button tap be answered only **once**. Most handlers answer straight away with a bare `answerCbQuery()` (to stop the spinner) and only afterwards find out they have something to say — “🔒 Admin access needed for this.”, “The owner can't be paused.”, “Already handled…”. That second, real answer was silently dropped, so the tap looked dead. About 400 call sites work this way.
- **Fix, once for all of them (`lib/chrome.js`):** a bare answer is now held back until the handler finishes (or 1.5 s, so a slow handler still stops the spinner), and any message/alert wins over it. Every update still gets exactly one answer.
- **Pause a feature:** the owner can't be paused, and that message was one of the swallowed ones. The Activity screen no longer offers “Pause / resume” for the owner, and the picker says so in plain words if it is reached anyway.

#### 🗓 Pull requests show date, time and year
- PR list: every PR is listed with when it was opened / merged / closed (e.g. “23 Oct 2026, 09:24”).
- PR page: **Opened**, **Merged** or **Closed**, and **Updated** — with the year, plus the timezone used.
- PR comments: the exact time next to “3h ago”. 🔀 PRs & issues lists (review / changes / failing / opened by me / assigned): opened and updated times.
- Times use your timezone and 12h/24h choice from My Defaults (UTC if none is set).

#### 🛡️ Admins who aren't connected to GitHub
- The not-connected bar's second row is now **🛡️ Admin Dashboard** for admins (everyone else still has ❓ Help / 📜 Legal; admins already have /help and /legal). Roles belong to the Telegram account, so the dashboard works without a GitHub connection.
- **/admin** — new, admins only: opens the dashboard directly. For anyone else it does nothing at all. It also shows up in the admin's own “/” menu (a chat-scoped command list: set at boot for every admin, and updated the moment a role is granted or revoked); nobody else's menu changes.

#### 🧪 Tests
- New `scripts/v213-tests.js` (11 tests): swallowed-toast fix (toast wins, bare answer sent once, slow handler), the admin bar, the label guard, /admin, the “/” menu sync, date/time/year on every PR screen, the owner pause message, and the version.

</details>

<details>
<summary><b>v2.1.2-multi</b> — Marker above its page, Upload fixed, your open pull requests show up, friendly empty repos</summary>

#### 🧭 The bar marker sits above its page
- **Fixed:** when a tap changed the bottom bar (opening a repo, Files, Workspace, Notifications, Settings, Search GitHub…), the small marker (“📂 Repository”) was posted *below* the page it belongs to, because the page was edited in place in an older message. Now the marker is posted first and the page is sent right under it (the old page is removed), on every screen. Pages that don't change the bar are still edited in place.
- An inner page opened while the Home 2×2 is still up (a typed `/help`, a stale button) now gets its “back” marker first as well, instead of after.

#### 🔀 Pull requests you open now show up
- **Fixed:** a pull request you had just opened was nowhere — not on the Start card and not in 🔔 Notifications. Both only counted PRs *waiting on you* (a review requested from you, or changes requested on yours), and GitHub never sends you a notification about your own PR.
- Every open PR you opened is now counted: Start shows “🔀 N open pull requests of yours”, 🔔 Notifications shows it in the **Pull requests** tile and its summary, 📬 Needs attention has a **My open PRs** row, and the Start jump buttons gained **🔀 My open PRs (N)**. The “🔀 Pull requests” toggle in ⚙️ What to count switches it off.
- The counts are now kept for 1 minute instead of 5, so a PR opened a moment ago appears on your next look (🔄 Refresh in Notifications always re-checks). GitHub's own search can take a few seconds to list a brand-new PR.

#### 📤 Upload
- **Fixed:** the repo bar's **📤 Upload** (and the Files bar's **📤 Upload Here**) were ignored. Inside the upload flow these labels were treated as “leave this flow”, so opening the flow immediately closed and re-opened it in a loop. They are now recognised as the way *into* the flow, like the old ⬆️ labels were.

#### 📭 Empty repos
- **Fixed:** 📂 Files on an empty repo showed “Couldn't load files … Not Found”. An empty repo has no branch and no tree yet; that is now treated as “no files”, with one short line — *“📭 Nothing here yet. Tap 📤 Upload to add your first file.”* — and an Upload button. The same applies to everything else that reads a repo's file list (search, upload classification, size stats).

#### 🧪 Tests
- New `scripts/v212-tests.js` (10 tests): marker-before-page ordering, in-place edits when the bar doesn't change, the Home card keeping its 2×2, every Upload-type bar label being a self-entry label of the upload scene, empty-repo tree and message, open-PR counting (including the toggle and cache lifetime), the Start card line, and the version.

</details>

<details>
<summary><b>v2.1.1-multi</b> — Fixes: New Repo crash, speed, and never getting stuck</summary>

#### 🐞 Fixed
- **New Repo failed with “Character '.' is reserved”.** Three of its messages had unescaped dots: the first prompt (“e.g.”), the **.gitignore** picker title and the custom .gitignore prompt. The first one crashed the very first step and left the flow open, so later taps (including 📤 Upload) were swallowed by the half-open flow.
- **Errors inside a flow no longer trap you.** If anything throws while a flow (New Repo, Upload, Rename, Edit) is open, the flow is closed and you are put back on the page you came from, with that page's bar.
- **Nothing is silently ignored any more.** A bar button that slips past its own handler still runs, and typed text nobody is waiting for gets a short hint that removes itself.

#### 🛟 Safety net
- If Telegram ever rejects a message's formatting, the same words are re-sent as plain text (and logged) instead of failing the screen.

#### ⚡ Faster replies
- Deleting old screens and bar markers no longer holds up the reply (they used to be waited on one after the other).
- Home fetches repos, pins, activity and Needs-you at the same time with a short deadline each, instead of one after another with a 4-second wait.
- **Watchdog:** one update that never finishes (a hung network call) used to block every later tap from that person; after 60 seconds (`USER_UPDATE_TIMEOUT_MS`) the queue moves on.

#### 🧪 Tests
- `scripts/v210-tests.js` now taps every button of every bar, runs the whole New Repo scene and the hub screens through a MarkdownV2 validity check, and tests the plain-text fallback and the watchdog. The shared test environment gained a plain-scene stand-in so scenes can be driven offline.

</details>

<details>
<summary><b>v2.1.0-multi</b> — Clean bars, a dynamic Start card, and adding another GitHub account works again</summary>

#### 🧹 No duplicated buttons
- **One rule for every bottom bar:** a bar holds only the page's own actions plus ⬅️ Back (last). The Home-level buttons — 📁 My Repos, 💼 Workspace, ⚙️ Settings, 🔔 Notifications — appear on Home alone. Before, the Workspace bar repeated Notifications, Settings and My Repos, and the Settings bar repeated Workspace, Notifications and My Repos.
- Workspace and Settings bars are now just ⬅️ Back; Search GitHub drops "📁 Search my repos" (that search lives in My Repos).
- New test (`scripts/v210-tests.js`) fails if a bar repeats a Home button, repeats a label, shares a page button with another bar, or if a screen's inline buttons repeat a button of its own bar or each other.

#### 🏠 Start card
- New layout: `🌌 Good night, name` · `✨ All clear. Nothing needs you right now.` · `📊 YOUR GITHUB` (quoted, two even columns: repos, public, private, stars, pinned, last activity, latest repo) · `🧭 HELP` (/help, /legal).
- Dynamic: the greeting follows your own timezone (🌅 morning, ☀️ afternoon, 🌆 evening, 🌌 night); "All clear" becomes a quoted **NEEDS YOU** list (PRs, issues, failing checks, unread, and for admins reports and flagged accounts) whenever something waits. Zero counts stay hidden.

#### 🔗 Add another account
- **Fixed:** "Add another account" (and reconnecting after Disconnect) sent you straight through, because GitHub silently re-used the account your browser was signed in as. The connect link now always opens GitHub's **account picker** (`prompt=select_account`), where you can choose *Use a different account*. Hints in Accounts, Help and the connect page were updated.

</details>

<details>
<summary><b>v2.0.0-multi</b> — Layout and UX overhaul: one bar for navigation, one format for results</summary>

#### 🧭 Navigation
- **Home bar 2×2:** 📁 My Repos · 💼 Workspace / ⚙️ Settings · 🔔 Notifications. Every other page swaps in its own bar with ⬅️ Back always last; no inline Back buttons, no duplicated buttons.
- 💼 Workspace is now Search GitHub, Gists, Projects, Organisations and Restore center. PRs and Issues moved to 🔔 Notifications; Accounts and 🛡️ Admin moved to ⚙️ Settings (Admin and the bot version are admin-only).
- Typing prompts get a ❌ Cancel bar and return you to the page you came from. Your own messages are tidied away, and a screen that is superseded is deleted so the chat stays short.

#### 📁 Repos
- My Repos: five repos per page, 🔎 Filter · ↕️ Sort · 🧹 Select · 📊 Stats, pinned and recent shortcuts, Smart Folders in Filter; everything edits in place.
- Repo card: a short glance card, [⚡ Manage | 📌 Pin] / [🔔 Alerts | 📊 Details] / [⋯ More]. Tags and Delete live in More.
- Files: cleaner headers with counts, one pager, actions on the bar.

#### ✨ Flows
- ➕ New Repo: type the name, then one setup card (visibility, README, description, license, .gitignore, template, schedule) and a single Create button.
- 📤 Upload: destination card with a real folder browser, a ready-to-push summary and one Commit button (pre-filled message). Rename and Edit file follow the same pattern.
- Results use one standard card (title, subject, details, link) and are never auto-deleted. Zero counts are hidden everywhere.

#### 🔧 Under the hood
- New `lib/chrome.js` (bars, live-screen tracking, central Back), `lib/barActions.js`, `lib/resultCard.js`; `keyboards/bbtb.js` rewritten onto the bars. The unused repo "dock" and legacy create-repo keyboards were removed. Tests updated for the new layout.
- Not verified here: the full `npm run verify` (needs `npm install`); the offline suites, check-patterns and a lint pass were run instead.

</details>

<details>
<summary><b>v1.4.0-multi</b> — Navigation, simplified: one Back trail, short screens, a bottom bar that follows you</summary>

Every button now does exactly one of three jobs, each in one place: **step back** (the footer row of a screen), **do something here** (the screen's own inline buttons) and **jump somewhere** (the bottom bar).

#### ⬅️ Back that always works
- New `src/lib/nav.js`: a short trail of the screens you passed through. **⬅️ Back goes to where you actually came from** — Help → Legal → Back returns to Help; Settings → Legal → Back returns to Settings.
- **Fixed:** inside Help & support → Features & FAQ (and Legal) there was no way back up. Help's menu had no Back button at all, and every Help/Legal page pointed at that menu. Now Help menu → Help & support → Settings → Workspace, and Legal behaves the same.
- An empty, stale or unrelated trail (typed `/legal`, an old message, a restart) rebuilds a sensible default path instead of dead-ending. The Back button carries the parent screen's own callback, so old messages keep working.

#### ✂️ Shorter screens
- **Repo card is a glance:** name, language · visibility · size · license, stars/forks/updated, description, files and last commit. Languages, README preview, recent commits and the small print moved behind **📊 Details** (edited in place, ⬅️ Back to repo edits the card back).
- **Help and Legal pages are about 1,500 characters** instead of 3,500, and a heading is never left alone at the bottom of a page.

#### 🧭 A bottom bar that follows you
- Opening a repo adds a third dock button, **📂 \<repo\>**, a one-tap jump back to the repo you were working in while you browse Workspace or My Repos. It is offered once per repo (one short marker message, because Telegram only changes a bottom keyboard when a message carrying it is sent).
- Input flows still swap the bar for ❌ Cancel, as before.

#### 🔧 Under the hood
- `npm run test:v140` (10 tests) covers the trail, Back on every Help/Legal screen, page length, the repo keyboard, the dock and a **no-dead-ends audit**; the Manage/Workspace crawler (`test:v124:areas`) now fails on any screen that offers no way out. `package.json` and docs headers are 1.4.0-multi.
- Not changed in this release: the ⚡ Manage areas and the Admin dashboard keep their existing explicit parents (they already end in ⬅️ Back and 💼 Workspace) and can move onto the trail later.

</details>

<details open>
<summary><b>v1.3.0-multi</b> — Navigation redesign: one-row menu, 💼 Workspace home, inline Settings, 🧯 Restore center, grouped ⚡ Manage, 🛡️ Admin inside Workspace</summary>

Verified offline: `npm test` 64 · `test:v123` 41 · `test:v124` 32 · `test:v124:areas` 13 · `test:v125` 18 · `test:v130` 13 · `test:v130:restore` 4. The route audit covers all 535 buttons.

#### 🧭 One menu, one home
- **Bottom keyboard is one row for everyone** — `📁 My Repos` · `💼 Workspace` (admins get no extra row; before connecting: `🔗 Connect GitHub` · `💼 Workspace`). Temporary Cancel / Back / Skip keyboards appear only while you type an answer.
- **💼 Workspace** is the inline home: 🔔 Notifications (count) · 🔀 Pull requests · 🐞 Issues · 🔍 Search · 📝 Gists · 📋 Projects · 🏢 Organisations · 🧯 Restore center · ⚙️ Settings · 🛡️ Admin (admins). A 🔒 marks a tile whose GitHub permission is missing; the Admin tile jumps to the top with a count when something waits; a one-tap account switch shows when you have several accounts. Before connecting, Workspace shows a Connect button and a limited Settings.
- **🔔 Notifications** now has Inbox · Needs me · Alert settings (alert types, live alerts, quiet hours, daily summary, start-line switches). **"My work" is gone** — it became 🔀 Pull requests and 🐞 Issues.
- **🔍 Search** asks what you want to find: my repos, code, or any public repo.
- **⚙️ Settings** (inside Workspace): 👤 Accounts & access (switch, add, remove, disconnect, permissions, sign-ins) · 🤖 Automation · 🎛️ Preferences · 📜 History (activity, 🛡️ safety log, sign-ins) · 📦 Data & Trash · 📊 Status & usage · ❓ Help & support. `/settings` still works when typed but no longer appears in the "/" menu.
- **🧯 Restore center:** one timeline (All · Repos · Settings · Other) of the change journal, Trash, bulk visibility changes, settings and defaults history, and a **30-day soft-delete** for tags, rules, schedules, pins and saved views. Per-repo ⏪ Undo & Restore stays.
- **Repo screen regrouped** (Manage + Files, Upload + Download, Pin + Tags + Alerts, ⋯ More with Delete last). **⚡ Manage** is in four groups: 🤝 Collaborate · 💻 Code · 🤖 Automate · 📈 Insights.

#### 🛡️ Admin dashboard inside Workspace
- Five inline tiles: **📥 Attention** · **👥 People** (incl. Bulk) · **🛰️ Watch** (merges Oversight, Monitoring and Warden) · **📢 Broadcast** · **🛠️ System**. The admin bottom keyboards are retired.
- **Attention** is the admin inbox with one-tap actions: allow / deny held actions (Owner), resolve / dismiss reports, mark flagged actions reviewed. The first tile reads "Reports" for moderators and "Attention" for admins; tiers behave as before.
- The user card is one inline card with Profile · Accounts · Activity & pauses · Limits · Notes · Actions.

#### 🧰 Tidier chat
- One live message per screen, edited in place; every inline screen ends with ⬅️ Back and 💼 Workspace. After you type an answer the bot removes your message and its prompt so the result lands at the bottom with its next-step buttons. Old buttons say "This screen is out of date" with one tap to refresh. Old bottom-keyboard labels still work for this version (admins who still hold the old keyboard get the new menu on their first tap).

</details>

<details>
<summary><b>v1.2.6-multi</b> — Reconnect asks for every permission, 🔔 unread notifications on the start card, 💼 Workspace on the main menu, honest "already connected"</summary>

- **Every new connection asks for all permissions at once** — first time, reconnecting after Disconnect or a revoke, and ➕ Add another account. Only the on-demand "grant one extra permission" button stays minimal.
- **Start card shows unread notifications** (`🔔 4 unread`) next to PRs, issues and failing checks, with a 🔔 Unread button; also in 📬 Needs attention, the daily summary and the "What to count" switches.
- **Main menu:** 💼 Workspace replaces ➕ New Repo (one row fewer for everyone). Creating a repo is in 📁 My Repos → ➕ New Repo and `/new`.
- **Adding an account that is already linked** now says so (result page and Telegram message), refreshes its permissions, and explains how to add a different account instead of reporting a plain success.

</details>

<details>
<summary><b>v1.2.5-multi</b> — Multi-account done properly, ⏪ Undo & Restore, 📌 Needs attention, 🛰️ Warden Watch & tiered monitoring, redesigned web pages</summary>

Verified offline: `npm test` 64 · `test:traffic` 39 · `test:github` 30 · `test:resources` 25 · `test:warden` 23 · `test:v123` 41 · `test:v124` 32 · `test:v124:areas` 13 · `test:v125` 18. The route audit covers all 516 buttons.

#### 👥 Multi-account
- Every screen, list, search, pin, tag, schedule and webhook is scoped to the **active account** (older rows with no owner stay visible under every account) and shows which account it is acting as.
- Every new connection (first, after Disconnect, another account) asks for all permissions once (`FIRST_CONNECT_ALL_SCOPES=off` restores the on-demand flow). A disconnected admin keeps the Admin button. Admin roles are Telegram IDs and never depend on GitHub.

#### ⏪ Undo & Restore
- Change journal; restore one file; go back to a commit; revert a merged PR; recover deleted branches/tags; roll a branch back with a backup branch first; conflict modes (stop / keep mine / keep theirs).

#### 📌 Needs attention · 🛡️ Safety
- Review-requested, changes-requested, failing-check and assigned-issue counts; a one-line start-card hint; daily summary; alert deep links; **My safety log**.

#### 🛰️ Warden Watch & monitoring tiers
- Sensitive-action scoring with burst and new-account bonuses, once-only admin alerts, per-person feature pauses, optional Owner approval holds, a daily briefing. Moderators see counts, admins flagged activity, super admins the audit trail and rules, the Owner the hold switch.

#### 🧰 Owner import / export
- Round trip verified on a real PostgreSQL: parents before children (tags no longer fail on their own foreign key), one up-front clear, stray tables cleared, multi-account rows rebuilt, webhook secrets re-keyed.

#### 💬 Friendlier errors and 🌐 web pages
- GitHub errors say what happened and what to do next. Connect and result pages are compact and responsive; the status page is server-rendered (works without JavaScript) with tiles, themes and auto-refresh.

</details>

<details>
<summary><b>v1.2.4-multi</b> — Two fixes (Owner + ADMIN_IDS, revoked GitHub access) and the biggest feature release yet: ⚡ Manage per repo, 💼 Workspace, organisations and multiple accounts</summary>

Verified offline: `npm test` 64 · `test:traffic` 39 · `test:github` 30 · `test:resources` 25 · `test:warden` 23 · `test:v123` 41 · `test:v124` 32 · `test:v124:areas` 13 — all green. The route audit covers all 509 buttons.

#### 🐞 Fixes
- **The Owner now works together with `ADMIN_IDS`.** Setting `ADMIN_IDS` used to make `OWNER_ID` stop counting as an administrator unless it was repeated inside the list. The roster is now the union of `OWNER_ID`, `ADMIN_ID` and `ADMIN_IDS` (deduplicated, Owner first), and the Owner is always a super admin. Every older single-variable setup behaves exactly as before.
- **A revoked GitHub connection no longer ends in "⚠️ Something went wrong: Bad credentials".** When GitHub answers 401, the bot asks GitHub itself (`GET /user`) whether the token is really dead. Only a confirmed 401 disconnects that account locally (no GitHub cleanup calls — the token is already dead), records a `token_rejected` access-log event, resets whatever the person was typing, and sends the Connect screen — or, if they have another connected account, switches to it and says so. A fluke 401, an outage, a rate limit or any other error never logs anyone out. The same check runs for the scheduled-repo and scheduled-upload pollers (the person is told once, the job is skipped, not retried forever), and ten simultaneous failures cause one probe.

#### ⚡ Manage — every repo (new)
- **🔀 Pull requests** — list, read (files, comments, reviews), merge / squash / rebase, close, reopen, approve, request changes, comment, update branch, **create a PR from a branch**.
- **🐞 Issues · 🎯 Milestones** — create, comment, close (completed / not planned), reopen, labels, assignees, milestones.
- **🌿 Branches** — create, rename, delete, set default, **work on a branch** (Browse, Upload, Edit, Delete File now honour it), **protection rules** (a change to one rule never resets the others), **fork sync**.
- **📜 Commits** — history, per-file diff, **revert** through the Git Data API (refuses and lists files if anything changed since; fast-forward only; merge commits and over 60 files refused).
- **🚀 Releases & tags**, **⚙️ Actions / CI** (re-run, cancel, trigger, enable/disable, **secrets** encrypted with libsodium's sealed box, variables), **🔑 Access** (collaborators, invitations, deploy keys, topics, transfer), **🛡️ Security** (Dependabot, code scanning, secret scanning), **📊 Insights** (stats, contributors, 52-week commit chart, traffic).
- Writes are *honest*: when GitHub's answer is lost (502, dropped connection), the bot reads the result back and reports what really happened — a merge, a new branch, a release or a revert is never reported as failed when it landed, nor as done when it didn't.

#### 💼 Workspace (new, on the Main Menu)
- 🔔 Notifications inbox · 🧰 My work · 📝 Gists (from text or a file) · 🔎 Code search · 📋 Projects (v2) · 🏢 Organisations · 🔔 Alert types · 👤 Accounts.
- **Organisations:** one owner switcher decides whose repos 📁 My Repos, ➕ New Repo, forks and every Manage tool use — the repo list never mixes owners.
- **Multiple GitHub accounts** (up to 5): add another, switch with one tap. Disconnect removes only the active account and activates the next; Ban / Delete User still remove everything.
- **More alerts:** pushes now list their commits and branch; stars, forks, branch/tag creation and deletion, comments and PR reviews are available. Each person chooses which types they want (stars and forks default on; the noisier ones default off). *Update my repo alerts* brings hooks created by older versions up to date.
- **Permissions on demand:** `gist`, `read:org`, `project` are requested with one button the first time a feature needs them; the base sign-in is unchanged. (`repo` already covers Actions, secrets, protection, deploy keys, notifications and security alerts.)

#### 🛠️ Admin
- **🧩 Feature Switches** (Global Config): switch any Manage / Workspace area off or on for everyone, live. A switched-off area disappears from the menus and its buttons say so.

#### 🧱 Under the hood
- `src/lib/github.js` is now the core; feature calls live in `src/lib/github/*` and share one request helper, so they go through the same traffic manager, retries, deadlines and "unknown outcome" handling.
- One dispatcher (`handlers/manage`) guards every button in the same order: connected → feature switch → OAuth scope → repo name → handler. Typed answers go through one input hook that can't swallow unrelated text, drops secrets from the chat, and re-arms after a bad answer.
- New tables/columns (idempotent): `github_accounts`, `users.active_owner`, `repo_webhooks.owner_login` / `account_login`, `alert_event_prefs`. Settings export/import re-keys account tokens with the migration key.
- Tests: the `test:v124:areas` crawler taps every button of every area against a fake GitHub and checks MarkdownV2 validity, message and callback limits; the GitHub end-to-end suite now also covers the feature modules.

#### ⚠️ Worth knowing
- Tags, pins, schedules and live alerts are still saved by repo **name**: two accounts (or an account and an organisation) with a same-named repo share them. Enabling live alerts for a name already registered under a different owner is refused instead of overwritten.
- Secrets need `libsodium-wrappers` (added to `package.json`; run `npm install`).
- Granting an extra permission, or adding another account, shows as a "Scope changed" / new-account entry in the Access Log — expected.

</details>

<details>
<summary><b>v1.2.3-multi</b> — Safer deletes, a local chart engine, honest docs, and a full code-review pass</summary>

A release built from a complete read-through of the code, documentation and in-bot text. Every item below was found by reading or running the code, fixed, and covered by a test (`npm run test:v123` — 41 new tests; the five existing suites are unchanged and green; the route audit covers all 506 buttons).

#### 🔒 Security & safety
- **One user could freeze the whole bot.** Auto-Tag / Auto-Mute / Auto-Backup name patterns were turned into regular expressions with a `.*` per `*`; a pattern like `a*a*a*a*a*a*b` against a 100-character name blocked the single shared process for ~9.5 seconds (and far longer with more wildcards). Matching now uses a linear-time glob, patterns are limited to 100 characters and 8 wildcards, and rules are validated everywhere they can enter — the prompts, Auto-Rules, **and Import**.
- **The repo list only shows repos you own.** `GET /user/repos` also returns collaborator and organization repos, but every action addresses `<your login>/<name>` — so those entries 404 on open and, on a name clash, an action (bulk delete and visibility included) landed on *your own* same-named repo. The list now asks for `affiliation=owner`.
- **Disconnect, Ban and Delete User now revoke GitroHub's access on GitHub** (token for a disconnect, the whole authorization for a ban/delete), remove the live-alert webhooks first, and *always complete* — even when GitHub can't be reached or the stored token can't be decrypted. Previously a token that couldn't be opened (for example after a `TOKEN_ENCRYPTION_KEY` change) made Disconnect, Ban and Delete throw. One shared routine, `lib/connectionTeardown.js`, does it all.
- **Unreadable secrets fail safe.** `tryDecrypt` returns `null` instead of throwing; a user with an unreadable token simply gets the reconnect prompt, and a webhook registration whose secret can't be opened is skipped — never matched against an empty key.
- **Permanent Delete User requires `super_admin`** — what the README always said; the code only checked for `admin`. The button is hidden for other roles.
- **Delete User now removes everything:** the legacy `warden_user_state` row and the `warden_action_log` rows that named the account were left behind.
- **Import is validated item by item.** Defaults, rules, tags, tag defaults, scheduled repos and Trash entries from a settings file go through the same validation as typing them; anything invalid is skipped and *counted*, never half-applied. Importing the same file twice no longer duplicates scheduled repos or Trash entries.
- **Reports can't flood the admins.** One report a minute, five open at a time, and pings go to the live admin roster (not just the `.env` list).

#### 🗑️ Trash, deletes and restore
- **Trash entries kept with retention "Never" could never be restored** (a NULL expiry was read as 1970). Fixed.
- **Restore reads the backup first.** The ZIP is downloaded and parsed *before* anything is created on GitHub; if a later step fails, the empty repo it just created is removed again — but only after confirming it still holds nothing of the backup. The success message states what a restore brings back (files, description, visibility) and what it doesn't (history, issues, stars, webhooks, topics, tags/pins).
- **Telegram's two file limits are no longer confused:** a bot can *send* 50 MB but *download* only 20 MB. Backups of 20–50 MB used to be created and then could never be restored; they are now flagged **ZIP only** (downloadable, no Restore button). Over 50 MB the repo isn't deleted through the bot at all.
- **Bulk Delete now backs up to Trash** (it used to bypass it while Help promised otherwise) and refuses to delete a repo it couldn't back up. A single delete whose GitHub call fails no longer leaves a Trash entry for a repo that still exists.
- Expired-but-not-yet-swept entries are unavailable everywhere, not just on Restore.

#### 👆 Double taps, toggles and undo
- A new **rapid-tap guard** drops an identical tap on the same button arriving within ~1.2 s, before it queues — the per-user serializer runs updates one after another, so a bounce used to run twice and flip toggles back.
- **Visibility, Pin and Mute buttons now name the state they set** (`…:public:`, `…:on:`, `…:mute:`), so a repeated or stale tap is a harmless no-op. *Enable Live Alerts* no longer tries to register a second webhook.
- **Bulk actions:** capped at 100 repos; progress/summary/confirm messages stay under Telegram's 4096 characters (a long failure list used to throw *after* the work was done, dropping the summary and the Retry/Undo buttons); a failed undo snapshot is now reported. **↩️ Recent Changes (Undo)** lists your last five bulk visibility changes, each undoable for an hour. The never-recorded "reversible" action types were removed.

#### 📤 Uploads, editing and files
- **Upload preview is honest:** only "repo has no commits yet" (404/409) is treated as empty — a rate limit, 5xx or network error no longer paints every file as 🆕 New and silently drops deletions from a folder sync; a truncated tree is flagged and disables deletions for that sync.
- **An overwritten executable keeps its executable bit.**
- **Edit File:** only plain-text files can be edited (binary files used to be overwritten with garbled text); the new content can be sent as a message *or uploaded as a file* (so files over 4096 characters are editable); a typed edit keeps the original CRLF line endings and final newline; the confirm screen shows a real +/− preview; unchanged content isn't committed; and the default commit message now applies.
- **Large files:** *Send as File* works up to 50 MB and images up to 10 MB preview (GitHub's contents API stops at 1 MB; the blob API is used beyond that).
- **One repo-name validator** for Create, Rename, Scheduled Repos and Trash restore: rejects `.`, `..`, names ending in `.git` and names over 100 characters up front instead of at the last step; rename uses the name GitHub returns and rejects a same-name rename.
- **Rename and delete clean up after themselves:** a pending scheduled upload follows a renamed repo (and is cancelled if the repo is deleted); Recently Viewed drops deleted repos.

#### 🏷️ Features that existed in the database but not on screen — now reachable
- **🏷️ Tag Manager** (Tags → ⚙️ Manage All Tags): colours (shown as a dot wherever a tag appears), nesting under another tag (cycle-proof; deleting a parent now moves its sub-tags up instead of deleting them), and **per-tag defaults** for visibility, upload folder and commit message — which are now actually applied.
- **📂 Pin sections:** group pins into named sections from the Pinned screen; reordering works inside a section.
- **Commit-message placeholders** `{filename} {repo} {date} {count}` are expanded (they were committed literally).
- **"Learn from me" for upload folders** now actually offers its one-tap suggestion; **📜 Change History** on My Defaults shows every change to your defaults.
- **Typing an existing tag name reuses it** instead of overwriting its emoji, colour and nesting; Import only changes the fields a file really sets.
- **Quiet Hours now hold everything the Help text promised** — live-alert digests, rollups, nudges and weekly backups — and a held rollup/nudge goes out when the window ends the same day instead of being skipped.
- **Full Reset** says exactly what it clears (and no longer silently cancels pending scheduled repos).
- The notification summary no longer counts `rollup: "off"` or the quiet-hour numbers as "categories" (it now reads e.g. `4/5 alert types on · daily rollup`).

#### 🔔 Webhooks, alerts and identity
- Events dropped by the per-repo rate limit, shed under load, or trimmed from a full buffer are **counted and reported** in the digest ("+3 more events not shown") instead of vanishing.
- A delivery that was acknowledged but not processed is un-marked, so GitHub's manual **Redeliver** isn't dropped as a duplicate for an hour.
- **A renamed GitHub username is picked up** (the stored login was only written at connect time, so webhook lookups — which join on it — silently stopped matching).
- The rollup's "repos touched" parses every Activity Log format correctly (it used to count `(my-repo)`, `Public)` and `(mit)` as repos) and "changes via bot" counts real commits only.

#### 🤖 Warden, admin and scheduling
- **Warden's "sustained shift" detector** now sees the quiet hours between busy ones (three busy hours on three different days used to count as one sustained run). Evaluation is **fair above the cap**: least-recently-evaluated accounts go first, the cap is configurable (`WARDEN_MAX_USERS`, default 500) and logged when hit, and accounts merely beyond the cap are no longer "settled" back to normal. The one-time recovery marker is excluded from log pruning.
- **Repo Shield:** the six protect/unprotect buttons are now **three status buttons** (`🛡 Connected 3/3`, `◐ Trusted 1/2`, `🔓 Everyone 0/4`) that edit in place and carry their target; Undo no longer overwrites accounts changed individually afterwards.
- **Bulk Suspend is atomic** and never shortens an existing, longer suspension.
- **Scheduled repos** interrupted mid-run finish instead of failing with "already exists"; background failure notices use plain-language reasons; the daily retention sweep can no longer skip a day when the hourly timer drifts.
- The dashboard's admin count reads the live roster.

#### 📈 Charts
- The Fleet Stats chart is drawn **locally** — a pure-Node PNG renderer with its own anti-aliased rasterizer and bitmap font (`lib/chartRender.js`): the "Pulse" chart (smoothed glowing line, gradient fill, dashed average, peak marker, latest-value badge). No external service, no network, nothing to disclose; QuickChart is gone.

#### 📚 Documentation and in-bot text
- `README.md`, this changelog, `docs/*.md`, `.env.example` and a ready-to-fill `.env` were rewritten from the code. `/legal` (Terms of Use + Privacy Policy) and `/help` were rewritten to cover every feature, what is stored and for how long, and your rights; both now build their MarkdownV2 from plain text and paginate automatically, with tests that fail if a page is too long or unescaped.
- `/repos` and `/new` still work when typed but are no longer in the registered command list.
- Fixed stale comments and docs found in the review (OAuth scope, `/health`, watchdog cadence, retention wording, Redis TTL claims, version labels, folder tree).

#### 🧹 Code health
- **Logger:** `logger.debug` did not exist (the Warden poller would have thrown on it) and calls written `(meta, message)` lost their message text; both orders now work.
- Removed 14 dead functions/exports, a dead keyboard set and unused helpers; renamed the Scheduled Repos handler/poller (they were still called "Scheduled Commits").

**Upgrade notes.** No manual steps: the schema migration is idempotent (`trashed_repos.restorable`, `tags.parent_id → ON DELETE SET NULL`). New optional variable: `WARDEN_MAX_USERS`. Existing "Never"-retention Trash entries become restorable immediately. Old inline buttons still work (`repo:pin:<name>`, `repo:webhook:toggle:`, etc. are accepted for messages already sitting in chats).

</details>

<details>
<summary><b>v1.2.2-multi</b> — security & resilience pass, snapshot-import fix, GitHub Traffic screen fix</summary>

**Security & resilience:** webhook secrets encrypted at rest, every registration for an owner/repo tried so events can never reach an account that didn't register them; OAuth JWT algorithm pinned and token exchange bounded; admin/user failure messages never call an unconfirmed write "unchanged"; broadcast honours Telegram flood control and reports blocked vs failed; DB/Redis outages produce a non-leaky "temporarily unavailable" reply; Redis fails fast with jittered reconnect; per-user update serializer extracted with a backlog cap (tested at 10–1,000 users); every unbounded per-user cache is now capped; the admin dashboard's nine simultaneous COUNT scans are one aggregate, cached with single-flight; Postgres pool saturation is reported instead of guessed (`PG_POOL_MAX` unchanged). See `docs/SECURITY_AUDIT.md`. Fixed: importing a snapshot from a deployment with a different schema failed and rolled back (`column "admin_moderation_protected" of relation "users" does not exist`) — the import now matches the snapshot against this database's real columns, skips unknown columns/tables (never truncating a table it can't write), reports exactly what it skipped, calls out skipped safety-related columns, and supports `IMPORT_COLUMN_ALIASES=users.old=new` for renamed columns. Fixed: the 🌐 GitHub Traffic screen failed with a MarkdownV2 error (`#` unescaped) — now covered by a validity test.

**Tests:** `test:traffic` 39, `test:resources` 25 (new: webhook secrets, Telegram flood control, dependency errors, 1,000-user update serializer, bounded caches, admin overview cache, snapshot-import schema tolerance).

</details>

<details>
<summary><b>v1.2.1-multi</b> — GitHub traffic control, resource gates, and a scaling audit</summary>

**GitHub traffic layer** (`src/lib/githubTraffic/`). Every GitHub request now flows through one manager via an Octokit `request` hook, so `github.js` kept its public API and no call site changed — including each page of `paginate()`. It provides a bounded queue; fair round-robin scheduling across users; interactive/background lanes (background can't starve taps, and an old background request still gets a slot); a global concurrency ceiling that adapts (AIMD) with **per-GitHub-account** rate-limit state, because every user has their own quota; `Retry-After`/`X-RateLimit-*` handling; exponential backoff with jitter; probe-then-ramp resume after a pause (no retry storm); a service-level circuit breaker that only reacts to GitHub-wide failures; coalescing of identical in-flight reads and a small conditional-request (ETag) cache that a write to the repo invalidates; per-request timeouts that always release the slot; and request IDs (`ghreq_…`, parented to the Telegram update) in logs. Defaults are conservative (20 concurrent, not GitHub's 100); every knob is in `githubTraffic/config.js` with its purpose.

**Mutations report what is actually known.** Outcomes are confirmed / failed / **unknown**. Writes are never blindly retried; an unconfirmed write is verified by reading GitHub back (file sha, branch tip, repo existence/visibility/description, webhook list) and reported as it really is, or as "GitHub did not confirm the final result" — never as success. `commitMultipleFiles` is clean-fail before the ref moves; only the final ref update can be unknown. The old second retry layer was removed (it multiplied attempts).

**Resource gates** (`lib/gate.js`): bounded global + per-user concurrency and a bounded, fair queue for archive extraction, downloads, uploads (including scheduled ones) and bulk operations. Archive decompression now runs on a worker thread (`archiveRunner`) with the same limits and errors; migration gzip is async; downloads refuse repositories too large to buffer. Upload buffers have a memory budget (evicted entries are still served from Redis) and a Redis budget. Export/README sends no longer write shared `/tmp/<repoName>` files (two users with same-named repos could collide).

**Webhooks:** header precheck before parsing; unregistered repos and bad signatures get the identical response (no "which repos exist" oracle); duplicate deliveries dropped; per-repo rate cap; bounded processing concurrency and backlog; digest buffer capped and TTL'd.

**Observability:** `/metrics` (Prometheus; disabled unless `METRICS_TOKEN`), event-loop lag/CPU/memory, Postgres query/pool/hold timing, Redis size, and `/health` that distinguishes HEALTHY / DEGRADED (200) / UNAVAILABLE (503). **Admin → Ops → 🌐 GitHub Traffic** (Owner only) shows state, queue, circuit, top consumers, with pause-background / reset-breaker / clear-pauses controls.

**Database:** log pruning is batched (no per-user loop, no giant deletes); Warden tables, which had no retention, are now pruned; indexes added for age-based deletes, Warden feedback joins and Repo Shield counts.

**Warden (still observe-only; the structural test now also forbids it touching traffic settings):** hour-of-week seasonality; CUSUM sustained-shift detection (needs ≥3 abnormal hours); correlation-aware evidence pooling (single class unchanged); owner dismissals feed bounded per-signal reliability; cohort priors for new users; GitHub-traffic evidence that can never count as an independent witness, and GitHub degradation as an innocent explanation.

**Buttons:** Trusted/Repo-shield controls come from one shared builder on both the case card and the user card (identical labels); Repo Shield is a full protect/unprotect grid with live counts on the Warden menu; hidden controls explain why; duplicate Export button removed.

**Tests:** `test:traffic` (38), `test:github` (17, real `github.js` against a fake GitHub), `test:resources` (18), `test:warden` (23 incl. a 10-scenario backtest), and `npm run load-test`. See `docs/LOAD_TESTING.md` for results *and their limits*, `docs/SCALING.md`, `docs/REDIS_KEYS.md`. The app remains **single-replica**.

</details>

<details>
<summary><b>v1.2.0-multi</b> — Warden Brain: an observer, not an enforcer. Evidence → baseline → confidence → decision, an Owner Board, Repo Shield, JSONL</summary>

**The principle.** Warden is a monitoring, evaluation, analysis and reporting system: *Monitor → Observe → Collect evidence → Correlate → Evaluate → Analyze → Record → Report* — never *Detect → Ban*. Restrict, suspend and ban are things a human does, from the Owner Board, with Warden's evidence in front of them. Warden has no code path that can touch an account, and a test enforces it.

**Warden can no longer act on anyone.** All automatic enforcement was removed (restrict, suspend, timed-ban, the onboarding nudge and every "allow" privilege). It also no longer messages users: no automatic warnings, nudges or notices of any kind. Its only outgoing message is an optional ping to the owner when a case reaches review. A structural test scans `lib/warden.js`, `lib/pollers/warden.js` and `lib/wardenBrain/` and fails if they ever reference an enforcement function or send a message to anyone but the owner.

**New: the Warden Brain** (`src/lib/wardenBrain/`, all pure functions over plain data so every decision can be replayed and tested):
- **Collector** — hourly counters per user (actions, errors, repeats, cap hits, sessions, active minutes, peak burst). Counts only: the "which control" signal is compared in memory for repeat detection and never stored; no repo names, file names or message text reach the database. Batched in memory, flushed every minute and on shutdown; erased with the user.
- **Personal baselines** — median/percentile of that user's own history, from history *older than the 72h evidence window* with outlier hours trimmed, so an abnormal stretch cannot teach Warden that it is normal. (Found by testing: with a 10-day account, three earlier episodes had pushed the p90 up to 90 actions/hour and hid the very behaviour being judged.) Maturity is explicit: none / low (3+ days) / mature (14+ days and 40+ active hours). Judged against strangers only as a last resort, at 40% reliability, and never beyond "observe".
- **Evidence, not points** — typed items with strength, reliability, baseline, window and an independence class (rate, failures, repetition, throttle, identity). Five connection anomalies are one witness, not five. Evidence decays with a 72h half-life.
- **Confidence engine** — *risk* (how unusual) and *confidence* (how sure it is not benign) are separate: baseline maturity × corroboration × persistence × reliability × (1 − innocent explanations).
- **"What legitimate explanation could produce this?"** — new account, a bulk operation in progress, returning after a long idle, fleet-wide spikes and fleet-wide failures (those are *our* outage, not the user).
- **Decision engine** — a progressive ladder: Normal → Observe → Flag → Enhanced monitoring → **Review candidate**. It ends there. Every rung needs all its gates; caps can only lower the result (no history → at most Observe, forming baseline → Flag, fleet-wide event → Observe, strong innocent explanation → Flag, ambiguous → Flag, ⭐ Trusted → Enhanced). Each higher stage must *hold* (15 / 45 / 90 min) and Warden moves one rung at a time, so normal → review takes at least 190 minutes. Ambiguous, conflicting or thin evidence means **do nothing**, and the reason is recorded ("why not higher").
- **Fleet check excludes the user being judged** — found by the end-to-end test: with the user included, a person's own failures made the "fleet" look like it was having an outage and excused them. A fleet now needs at least 6 active users to mean anything.

**Owner Board** (🤖 Warden → 🗂 Board). One case per user, opened only at Flagged or above, new evidence merges in. The case card is the technical version — risk, confidence, evidence with baselines, persistence, historical context, the legitimate-use check, *why not higher*, interpretation and Warden's decision. Manual actions: **⭐ Trusted** and **🛡 Repos** (state-labelled toggles), **👁 Keep watching** (snooze 7 days), **✅ Dismiss** (recorded as a labelled false positive; no new case for 7 days unless it becomes serious), **⚠️ Send warning**, **📜 Timeline**, **🔨 Enforcement…**. Cases resolve themselves after a calm day. The owner is pinged only when a case reaches review (toggle 🔔 Alerts; default on), with an "Open case" button.

**Warnings.** Every significant decision carries an explanation, rendered two ways. The user version is plain language — what was observed about *their own* activity, what it does and doesn't mean, what they can do, "Monitoring only" — with no scores, thresholds or detection logic. It is *never automatic*: ⚠️ Send warning shows the exact text first and sends only on confirm (double-tap protected), and the warning is recorded on the case timeline. Real enforcement notices (ban, suspend) are now structured too: exact reason, anything observed, any earlier warning, what it means, and how to appeal. **A specific reason (15+ characters) is now mandatory** for ban and suspend — the ban prompt used to claim the reason was "shown to no one but you" when it was in fact sent to the user, and Skip allowed reason-less bans. The Enforcement gate on the Board asks for a warning first unless the owner chooses to continue as a severe case, and tells them if the person was already warned.

**⭐ Trusted** now means *protected from the bot, not from being monitored*: never acted on, never throttled by the hourly cap, never raised to review — but still observed, with evidence and history kept.

**🛡 Repo Shield.** The owner can protect users' repositories from being viewed, downloaded, deleted or changed by other admins — per account (a state-labelled toggle on the user card) or in bulk (Warden → 🛡 Repo Shield: every connected user, every Trusted user, everyone; or unprotect connected). Bulk changes show how many accounts will change, skip accounts already in that state, never touch admins, are recorded, and can be undone in one tap. Enforced at the action layer (a stale or hand-crafted button cannot bypass it), blocked attempts are audit-logged, other admins see "protected by owner" and no Repos button, the owner is never blocked. New users start unprotected.

**📤 JSONL exports.** Decision log, Cases (with timelines), Evidence, or Everything (plus per-user stage and baseline), last 90 days: one JSON record per line, a `record_type` and `schema` version on every record, UTC ISO timestamps, stable field names. Replaces the CSV export for Warden.

**Warden menu.** Observation-only screen: status, how many people sit at each stage, last-24h stage moves, and state-labelled switches (🟢 Warden ON/OFF, 🔔 Alerts ON/OFF). Removed: the Live/Dry-run mode, every privilege toggle, the limits, Templates, Stop Now. Old buttons still in earlier messages are answered and the menu redrawn.

**Housekeeping.** The one-time 1.1.24 recovery moved to `lib/wardenRecovery.js` (it only ever lifts a limit, so it is deliberately outside Warden). New tables: `warden_activity_buckets`, `warden_profiles`, `warden_cases`, `warden_case_events`, `warden_evidence`, `repo_shield_batches`; new columns `users.repos_protected*` and `warden_config.alerts_review`. All are removed when a user's data is erased.

**Heads-up when deploying.** Warden may currently be switched off (the old circuit breaker could have stopped it). It is now safe to turn on: it only observes. Expect it to say "insufficient history" for most people for the first couple of weeks while baselines form — that is correct behaviour, not a fault. Nobody is messaged.

**Tests.** 65 unit tests (21 new): 14 synthetic scenarios (quiet user, one unusual morning, brand-new user, bulk upload, reconnects, deploy storm, uncorroborated pace, immature and young baselines, single episode vs recurrence vs ⭐ Trusted, power user, admin); a 1,500-case property test that a high stage is never produced from thin, systemic or trusted evidence; decay and progression timing; the collector (including a privacy check); end-to-end runner runs against a fake database (first pass only observes and messages nobody; a held review opens a case and pings only the owner); the "Warden cannot touch an account" scan; menu labels, routing and double-tap claims; Board handlers; Repo Shield; warning/notice content; JSONL; erasure.

</details>

<details>
<summary><b>v1.1.24-multi</b> — Fix: people (and the owner) wrongly restricted by Warden; owner exempt from limits and private from other admins; Warden menu redesigned</summary>

**What went wrong.** Users started receiving "⚠️ Your account activity has been automatically restricted. Triggered by: flagged by anomaly detection", and afterwards even the owner hit "⏳ You're sending actions faster than this bot allows" and the bot then stopped answering them. Four separate faults combined:

1. **One benign "anomaly" was enough to restrict someone.** The anomaly signal was worth 30 points — exactly the auto-restrict threshold. Anomalies are things like re-authorising GitHub twice in a day, reconnecting within 5 minutes of disconnecting, a scope change, or tapping a lot right after signing up. Any one of them capped an otherwise normal person at 10 actions/hour. The flag also never expired (any anomaly, ever, counted forever). It is now worth 15 (a silent flag only — it needs a genuinely behavioural signal such as errors or failed commits alongside it to escalate) and only anomalies from the last 7 days count.
2. **Warden had no idea admins exist.** The rest of the app never calls an admin "suspicious"; Warden's user query didn't exclude them, so the owner and other admins were restricted like anyone else — which is why the owner started seeing the rate-limit message. Warden now skips the owner, every admin (env- or role-granted) and anyone marked ⭐ Trusted (that star previously did nothing).
3. **The Warden poller could not release its own lease.** It passed 240000 as the lease TTL where the lease API takes *seconds* (about 2.8 days), then "released" it by calling `pollerLease.release()` — a function that doesn't exist (release lives on the lease object), which threw inside `finally`. After the first tick the lease was never freed, so Warden did nothing for days and then acted on a batch of people all at once — the "everyone, one at a time, out of the blue" pattern. Fixed (seconds; `lease.release()`).
4. **The 10-actions/hour restriction was harsher than it sounds.** Every tap or message counts as an action, so a single short browse hit the wall — and after one notice every later message was silently dropped for the rest of the hour, so the bot appeared to have stopped talking. Automatic restrictions now cap at 60/hour, never overwrite a cap an admin set on purpose, and the message says what the limit is. The limit notice itself no longer goes silent: it says how long until the window resets (at most one reply per minute, so a burst of taps can't cause a burst of replies) and button taps get an immediate toast instead of a spinner.

**Recovery.** On the first boot of this version Warden lifts, once (guarded by a marker row in `warden_action_log`): every admin/owner cap of exactly 10/hour, and every restriction whose *only* stated cause was "flagged by anomaly detection". Ordinary users who had been restricted are sent a short "lifted — applied by mistake, sorry" message; admins are not messaged. Restrictions for real behaviour (errors, failed commits…) are left alone.

**Owner exemption & privacy.** The owner and every dashboard admin are exempt from the hourly action cap (any override stored on an admin is ignored). Other admins can no longer touch the owner's data at all: repo list / download / delete / visibility / license, data export and limit overrides are refused at the action layer (`adminActions.assertNotOwnerTarget`, so a stale or hand-crafted button can't bypass it) with a friendly message in each dashboard handler, and the 📂 Repos / 📤 Export / 🗑 Delete buttons are hidden on the owner's card for everyone but the owner. (Ban, suspend and delete already refused protected admins; bulk actions already skip admins.)

**Circuit breaker.** Only real actions now count toward "max actions per run". Silent flags and dry-run entries used to count, so the first run after the scoring fix would have flagged a batch and switched Warden off without touching a single account. And when the breaker *does* trip, the menu now says so.

**🤖 Warden menu redesigned.** Every control shows its own state on its button and flips it in place — the message text is now a status readout instead of repeating the switches. Buttons are short enough that two fit per row without Telegram truncating them.
- New: master switch shows `🟢 Warden: ON` / `⚫ Warden: OFF` / `⏸️ Paused · resume` (turning it on also clears a breaker pause, so there is a single button for both), `⚡ Mode: LIVE` / `🧪 Mode: DRY-RUN`; a paused banner with the reason and how long ago; a last-24h summary; `🔢 Max per run` and `⏳ Cooldown` buttons (tap for the next preset — these could previously only be changed in code); a `🧪 Dry-run: SHOWN/HIDDEN` filter and action icons on the Action Log (internal recovery rows are hidden).
- Removed as redundant or non-functional: **🛑 Stop Now** (identical to switching Warden OFF), **Mute, Nudge, Broadcast** and the four **perm-ban / perm-delete Unlock+Allow** buttons — no code anywhere read those settings, so they looked like safety controls but switched nothing. Templates: the 🗑 delete buttons had no handler and could never appear (no way to create a custom template); the screen now says which template Warden actually sends (the onboarding nudge). Buttons on *old* Warden messages still get an answer (Stop Now still stops Warden; removed controls say so and redraw the menu).
- Button colours follow the project's policy (RED only for irreversible executes, GREEN only for "safe way out"): state switches are colourless.

**Tests.** 44 unit tests (12 new): scoring (a lone anomaly only flags; anomaly + real misbehaviour still restricts), Warden ignores admins/owner/trusted, admins exempt from the cap, throttle notice cadence, poller lease in seconds and released, one-time recovery runs once and notifies only ordinary users, owner protection on all seven admin actions (owner and ordinary accounts unaffected), Warden menu state labels + no shared actions + every button routed in `bot.js` + label length, handlers flip exactly one setting and edit in place, resume clears a breaker pause, and a guard that no source file is empty or truncated.

</details>

<details>
<summary><b>v1.1.23-multi</b> — Reviewed merge of the parallel "1.1.49-gpt" branch: scheduled jobs can no longer run twice, safer webhook digests & data erasure, double-tap protection, and the bugs found in that branch were left behind</summary>

A second branch (labelled 1.1.49-gpt) grew out of v1.1.21-multi in parallel with v1.1.22. It was reviewed change by change rather than copied: what it did well is merged below, everything that was wrong was fixed or rejected. **That branch does not run as delivered** — `webhookDigest.js` declares a constant twice (a syntax error, so the bot cannot boot) and `uploadFile.js` calls `processZip`/`processTar` after renaming them away (every zip/tar upload would throw). It also fails this project's own `check-patterns` and unit tests.

**Merged (with fixes where needed)**
- **⏱ Scheduled repos / uploads / broadcasts are claimed before they run** (`pending → processing → done`, atomic `FOR UPDATE SKIP LOCKED`, a heartbeat while a long job runs, and jobs abandoned by a crash are re-claimed after 10 minutes). Removes double-runs when two instances overlap during a deploy or a tick is slow. "Run now" uses the same claim and returns the job to pending on failure. `cancel` now reports whether anything was actually cancelled. New `processing_at` columns are added by `schema.sql`.
  - **Fixed in the merge:** as written in that branch, an *immediate* broadcast (and 🔁 Repost) created a `pending` row and then finalised it with an update that only matches claimed rows — it would have matched nothing, left the row `pending`, and the next poll would have **sent the broadcast to every user a second time**. Immediate sends and reposts now create their row already claimed. This also closes a window that existed before this change: the poller could pick up an immediate broadcast's row while it was still mid-send.
- **🔔 Webhook digests are no longer lost or duplicated.** Events stay buffered until Telegram accepts the digest (then are acknowledged), with a renewed lock; the blocking Redis `KEYS` call is replaced by `SCAN`; and the quiet-hours branch no longer re-pushes every event on every poll (that duplicated the whole buffer each time).
  - **Fixed in the merge:** duplicate `RELEASE_SCRIPT` declaration (boot crash); the acknowledge script trimmed the wrong end of the list (`push` uses `RPUSH`, so it would have deleted the newest events and kept the delivered ones); the quiet-hours `release()` call omitted the lock token and did nothing.
- **🛡 Double-tap protection on write confirmations.** Executing callbacks (delete repo/file, visibility/license change, bulk execute, disconnect, broadcast send, ban/delete user, role changes, purge…) are claimed per Telegram message, shared through Redis, fails open if Redis is down. A double-tapped "Send broadcast" can no longer go out twice.
  - **Fixed in the merge:** the pattern for ban/delete was unanchored, so it also matched the *ban-duration* step and would have blocked the actual Ban confirmation on that message; all patterns are now anchored and unit-tested. The claim lasts 30s instead of 120s so a failed action doesn't leave its button dead.
- **🗑 Erase-all-my-data is one transaction** — a crash or DB error part-way can no longer leave a half-deleted account (and Redis is only cleared after the commit).
- **🧠 Repo caches** are tied to the token that fetched them and de-duplicate identical in-flight requests (repo list, languages, tree stats, username). GitHub client/rate-limit maps no longer use raw tokens as keys.
- **🔌 Redis connect** is de-duplicated (no "Socket already opened" on simultaneous startup calls); shutdown waits for an in-flight connect.
- **📦 Tar reader** rejects bogus or oversized entry sizes instead of looping or reading past the buffer (surfaces as the existing "archive appears corrupted" message).
- **Feedback while working:** Telegram's "typing… / sending a file…" indicator now stays alive for long operations (browse files, activity, run rules, repo download, backups, CSV exports, fleet chart) via a new `lib/chatAction.js`, on top of the instant per-tap indicator that stays as it was.
- **Smaller fixes:** owner snapshot import can be retried after a failed download; scheduled-upload/scheduled-repo runs check the Telegram download's HTTP status and report a failed README cleanup; upload flow reports a failed Telegram download instead of processing an error page as a file; bulk actions guard against an empty selection or a missing GitHub account, and a partly-failed undo stays available; `/report` re-asks on empty text; a rejected branch update (someone else pushed) gets a clear "branch changed, retry" message; Cast History shows 🔁 repeat info for recurring pending broadcasts; scheduled broadcasts with no admin skip the confirmation DM; the weekly-automation "done today" marker is only set after a successful run; the weekly rollup retries transient send failures.
  - **Fixed in the merge:** the rollup change put the retry inside the shared loop, so one failed send aborted delivery for everyone after that person and a user who had blocked the bot would break it every hour — it is now handled per person, and permanent failures (400/403) are not retried.
- Navigation now releases *every* pending typed-input prompt (⬆️ Menu, ⬅️ Back, any menu label, any inline button), including the admin prompts and RESET — while search modes intentionally survive `search:*`/`external:*` taps so "keep typing new queries" keeps working.

**Deliberately not merged**
- Removing the instant "typing…" on every tap (a regression against the goal of the bot feeling responsive).
- A "typing" indicator started in *Run Rules Now* that was never stopped (a timer leaking a Telegram call every 4s per use); the safe wrapper is used instead.
- A Redis-backed action lock (orphaned locks after a redeploy can block an action for up to 90s; no benefit on a single instance).
- New inline ⭐ Pinned / ➕ New Repo / 🔎 Filter / ↕️ Sort / Clear-Filter buttons on the repo list — they duplicate the reply keyboard.
- Its versions of the RESET, description-edit and emoji fixes (v1.1.22's are more complete: e.g. its description fix re-armed the prompt *and* re-showed the repo card, so retyping would silently overwrite the description), a `\n` typo that ran Cast History lines together, the per-update queue-key rewrite, and the `processZip`/`processTar` rename.
- Comment stripping in `index.js` (the explanatory comments were restored).

**Tests:** 32 unit tests (7 new: claim patterns and double-tap, immediate-broadcast claim, job claim SQL, digest script/direction, tar hardening, chat-action lifecycle, "every started chat action is stopped"), plus the transactional-erase test is stricter (BEGIN/COMMIT, rollback on failure, Redis untouched on failure). `check-patterns` clean.

</details>

<details>
<summary><b>v1.1.22-multi</b> — Fix: typed-answer prompts no longer go silent after an error</summary>

- **🟠 Some "send me a value" prompts stopped responding after one rejected answer and only recovered after ❌ Cancel and starting over.** These prompts consume their pending-input flag as soon as your message arrives and only put it back for the specific mistakes they validate. If the save itself was then refused — a GitHub or database error, a value GitHub rejects — the flag was already gone, so your *next* message matched nothing and the bot just didn't answer. Fixed at both levels:
  - **Safety net (bot.js).** The text router now remembers which retry-safe prompts were open before running a handler; if the handler throws, they are put back, so the same prompt keeps listening. The error message now says so ("I'm still listening — send it again, or tap ❌ Cancel"). Covers: Smart Folder name, quiet hours, custom timezone, new tag, default commit message / upload path, auto-tag / auto-mute / auto-backup rule values, trash restore name and edit, scheduled commit and scheduled upload edits, description edit, and /report text. Destructive and admin confirmations are deliberately *not* auto re-armed.
  - **✏️ Description edit.** When GitHub rejected a description (e.g. over 350 characters) the prompt was closed and the repo card reshown, so retyping did nothing. It now stays open with a clear message; ⏭️ Skip and ❌ Cancel still work. (Auth errors still fall through to the repo card since retrying can't help.)
  - **🗑 Full reset (RESET).** Typing anything other than `RESET` (e.g. lowercase `reset`) used to bounce you out to Storage & Data. It now stays on the prompt so you can correct it in place; still requires the exact word, and any button tap or ❌ Cancel releases it.
  - **🏷 New tag emoji.** The check counted UTF-16 units (`length > 4`), so valid emoji like 👨‍💻, 🏳️‍🌈 and 👍🏽 were rejected as "too long". It now counts real characters (graphemes) and accepts exactly one emoji.
  - **⏰ Scheduled upload path.** The target path wasn't validated like the live upload flow (a leading or doubled slash was saved and only failed when the schedule fired). It is now checked on entry and re-asks on a bad path.
- New unit tests for the emoji validator and the re-arm wiring.

</details>

<details>
<summary><b>v1.1.21-multi</b> — Perf: My Repos / Pinned / Repo View no longer stall on big repos; friendlier GitHub-connect confirmation page</summary>

- **🟠 The bot felt slow (and Railway's logs showed a burst of file-tree requests) because list screens fetched a full recursive git tree for every visible repo at once, and refused to render until the slowest one came back.** Each of those is three sequential GitHub calls (get repo → get ref → get tree, and the tree can be megabytes for a large repo). My Repos did this for every repo on the page on every open/refresh, Pinned did it for every pin, and because updates are processed one at a time per user, every tap you made while it waited queued up behind it. Fixed three ways:
  - **Time-boxed list screens.** New `repoCache.getTreeStatsBatch()`: cache hits return instantly, misses are fetched with a concurrency cap of 3, and the screen is sent after at most ~2.5s. Any repo still loading falls back to GitHub's own `repo.size` (already on the list payload, zero extra calls — the same fallback the screens always used on error) while its fetch **keeps running in the background** and fills the 60s stats cache, so the next refresh shows the exact size instantly. Used by My Repos and Pinned.
  - **One fewer round trip per repo.** Tree fetches now receive the repo's `default_branch` (already known from the list / repo object), so `getRawTree` skips its own "get repo" call. It also makes the in-flight coalescing key identical across screens, so My Repos, Pinned and Repo View share one fetch instead of racing duplicates.
  - **Repo View loads in parallel.** Languages and tree stats used to be awaited one after the other, then pins/tags/README/commits after that — five independent reads back-to-back. They now start together and cost the slowest one, not the sum.
- **🎨 Redesigned the "Connect GitHub to this Telegram account?" confirmation page.** Same protections as before (the account is named up front, nothing is linked until the click, a forwarded link is easy to walk away from, still un-frameable) but it no longer reads like a warning dialog. It now greets the person by name, shows a "your Telegram → GitroHub → GitHub" header with their **Telegram profile photo** (or a coloured initial if they have none / it's private), lists name, @username and Telegram ID plainly, explains in three short lines what GitroHub will be able to do (including that deletes need confirmation in the chat), and keeps the "not your account? just close this page" guidance as a calm note instead of an amber alert. The button is now "Yes, that's me. Connect GitHub" and disables itself after one tap so a double-tap can't burn the single-use link.
  - The profile photo is downloaded server-side and inlined as a `data:` image — Telegram's file URLs contain the bot token, so they are never put in the page. The lookup runs in parallel with the DB read, is capped at ~2.5s, and any failure silently falls back to the initial.
- New unit test for the time-boxed batch (slow repo returns at the budget, failing repo degrades instead of throwing, background fetch warms the cache, `default_branch` is passed through).

</details>

<details>
<summary><b>v1.1.20-multi</b> — Fix: "wrong input, then correct input gets ignored" across ~10 flows; the ⬅️ Back button in Create Repo never actually went back; a repeat of v1.1.19's escape bug</summary>

- **🔴 The screenshot bug: Settings crashed with a raw Telegram MarkdownV2 error for anyone with a sibling GitHub connection.** The v1.1.18-multi sibling-connections feature's escapes (`\(`, `\)`, `\.`, `\+`) got silently flattened back to single backslashes during an edit in the v1.1.19-multi round — the exact bug class v1.1.19 itself was written to catch, just reintroduced afterward by a later edit that never got re-verified byte-for-byte. Re-fixed, and this time backed by something sturdier than manual review: `check-patterns.js` gained a new, precise "lone-backslash MarkdownV2 escape" check that tokenizes actual string/template/regex/comment boundaries (not a text-pattern heuristic) and flags exactly this mistake. Verified it actually catches the bug by reintroducing it in a scratch copy and confirming the check fails — then confirmed clean on the real fix.
- **🟠 Across roughly ten typed-input flows, sending something invalid and then sending the corrected value did nothing** — the input-armed flag (`ctx.session.awaitingX`) was cleared unconditionally at the top of the handler, before validation, so an invalid first attempt permanently disarmed listening; the next message (the corrected one) fell through to whatever generic handler happened to catch plain text, usually silence. Only a full Cancel-and-restart recovered. Fixed by re-arming the flag on every invalid-input path instead of clearing it only on success: quiet hours (Settings), custom timezone, admin custom-number entry, admin maintenance auto-on/off time, admin user search with zero results, and settings-import file upload (which also had a latent crash if Telegram omitted `file_name` — same guard added to the instance-migration snapshot upload). Quiet hours also gets its own Cancel keyboard now (there was no in-flow way out before) and correctly restores the normal Settings keyboard on success instead of leaving Cancel on screen.
- **🟠 `/cancel` didn't actually cancel anything typed-input-related** — unlike the ❌ Cancel button, it only showed the main menu and left every `awaitingX` flag armed, so the next message was still silently swallowed by whatever flow was active. Both now share one handler.
- **🟠 Newly re-armable prompts could swallow unrelated text after someone moved on** — e.g. leave a "type a custom number" prompt armed after an invalid entry, then tap an unrelated menu button: the next text they type could still get read as the number. Added navigation-aware middleware that clears every re-armable flag the moment an inline button or menu label is tapped.
- **🟠 Description-edit's ⏭️ Skip button was silently routed to the ban-reason handler** — a harmless no-op for that flow (the ban-reason session flag was never set), but tapping Skip while editing a description did nothing instead of clearing it.
- **🔴 The ⬅️ Back button in Create Repo (shown at the visibility/README/license/.gitignore steps) never actually went back — exactly the "same class as the create:cancel fix" the user asked about.** It moved the wizard's internal step cursor and replied "⬅️ Going back..." and then sat there with nothing on screen — no re-shown question, nothing to tap or type, because Telegraf's WizardScene doesn't auto-re-render a step. Every step's question was already about to be needed in its own function (each one now used by both the forward flow and Back, so they can never drift apart); Back now re-selects the previous step and calls the matching prompt function, with the already-entered data fully preserved. Verified with a real harness that drives the actual scene code end-to-end (not a re-read of the source) through name → Back → re-answer → visibility → description → (invalid input, then corrected) → README → Back → license → Back → .gitignore → Back, confirming the right question re-appears and every field survives each hop.
- Checked `scenes/uploadFile.js`'s separate ⬅️ Back (shown while typing an upload path) — already correct, it calls a real re-render function. Checked `editFile.js`/`renameRepo.js` — no Back button offered there, nothing to fix. Checked all ~30 typed-input handlers across the codebase against this same "flag cleared before validation" pattern; the ones not listed above (tags, scheduled commits/uploads, trash restore, automation rules, search, browse-files, myDefaults) were already re-arming correctly.

</details>

<details>
<summary><b>v1.1.19-multi</b> — Fix: repo-creation inline ❌ Cancel did nothing; offline bot test scripts merged in and repaired</summary>

- **🟠 The inline ❌ Cancel on the "Create repository" confirm screen never cancelled.** `inline.createRepoConfirm` sends `create:cancel`, but nothing in `scenes/createRepo.js` handled that value — it fell through to the step's catch-all and just replied "Tap ✅ Create Now, 📅 Schedule for Later, or ❌ Cancel above" in a loop. (Only the bottom-keyboard Cancel worked.) `handleGlobalActions` now routes `create:cancel` into the same confirm-before-discarding prompt as the keyboard Cancel. Found by the route audit below.
- **Merged the four offline bot test scripts from the earlier snapshot** (`bot-route-audit.js`, `bot-navigation-crawler.js`, `bot-mock-runner.js`, `bot-integration-runner.js`) and their `package.json` entries (`test:bot`, `test:bot:crawl`, `test:bot:mock`, `test:bot:integration`, plus the extended `verify`). None of them worked as written:
  - `bot-route-audit.js` and `bot-mock-runner.js` did not parse (a `\\'` in a string-built regex closed the string early).
  - The audit and the crawler both scanned each button's visible *label* (first argument of `style.callback(text, data)`) instead of its `callback_data`, so 100% of buttons reported as uncovered and the crawler produced 0 graph edges. They now read the second argument.
  - Route detection now also recognises wizard-scene guards (`if (data !== 'x') return`), understands buttons built with a dynamic prefix (`${scenePrefix}:cancel:confirm`), skips fully-dynamic pagination templates that can't be checked offline, and pairs each button with its most specific route (previously `search:recent:<q>` was paired with the broad `startsWith('search:')` gate).
  - The mock runner / integration runner raised the child-process buffer limit so the full navigation graph JSON no longer overflows it.
  - Result: route audit 483/483 buttons covered, crawler 552 edges / 0 unmatched, mock runner 481/481 contracts passing. The integration runner needs the real Telegraf and was syntax-checked only.

</details>

<details>
<summary><b>v1.1.18-multi</b> — Fix: signups-paused bypass at the actual link step, sibling-connection visibility, 5 admin permission-check gaps</summary>

- **🔴 A brand-new person could still fully connect while signups were paused.** `handlers/start.js` correctly hides the Connect button for a never-connected person when signups are paused, but that was the *only* place the flag was ever checked. The actual linking endpoint, `POST /callback/confirm` in `server/app.js` (the OAuth token exchange), never checked it — so anyone holding any valid authorize link (an old message, the persistent 🔗 Connect GitHub button, `/help`, an error-fallback prompt — none of which re-check the flag before generating a fresh one) could complete the link regardless. Added the same never-blocks-a-returning-user check directly at that linking choke point, since UI-level gating alone was never enough — the same lesson as v1.1.16-multi's activity_log fix: check at the point the action actually happens, not just at the point a button gets drawn.
- **New: Settings now surfaces other Telegram accounts connected to the same GitHub login.** GitHub's OAuth model has no concept of "one device", so nothing ever stopped two different Telegram accounts from each independently authorizing against the same GitHub username — that's not a bug, but it was completely invisible. `lib/users.js` gained `getSiblingConnections()`; Settings now shows a warning block naming any other currently-connected accounts and points to GitHub's own Settings → Applications → Authorized OAuth Apps to revoke a specific one (the only place that can invalidate one token without touching the others sharing that login).
- **5 admin-dashboard functions were missing the role check every sibling function in the same flow has**, reachable directly via their own callback_data even though the *final* execute step for each flow correctly re-checks and would still block a lower-tier admin: `setBanDuration`, and the four bulk-action confirm screens `askBulkPurgeConfirm`, `askBulkSuspendHours`, `askBulkSuspendConfirm`, `askBulkMuteConfirm`. In every case a `guest`-tier admin (view-only by design — see `lib/roles.js`) could reach and interact with a ban-duration or fleet-wide purge/suspend/mute confirmation screen meant to require `moderator` or `super_admin`, even though the actual destructive action itself was never actually reachable (the `execute*` functions were already correctly gated). Added the matching `requireRole`/`requireSuperAdmin` check to each, consistent with every other function in these two flows.
- Audited (no changes needed — already solid): `lib/archive.js`'s zip reader and `lib/tarReader.js`'s tar reader, both of which cap decompression on *actual* output bytes rather than attacker-declared sizes, reject zip64 and strong/AES encryption outright, and block path-traversal/`.git`-injection entries before anything is committed.

</details>

<details>
<summary><b>v1.1.17-multi</b> — Stability pass: dead adaptive rate-limit backoff wired up, logging/consistency cleanup</summary>

- **🟡 GitHub API retries never actually adapted to how close a user was to their rate limit.** `lib/github.js`'s `withRetry(fn, label, token)` widens its retry delay using that user's last-seen `x-ratelimit-remaining`/`reset` headers when quota is low — but every one of its 9 call sites (`getAuthenticatedUser`, `getRepo`, `listRepos`, `getRecentCommits`, `isStarred`, `getRawTree`, `getFileContent`, `getLanguages`, `getRateLimit`) only ever passed `(fn, label)`, never the `token`. `computeRetryDelayMs` always received `null`, always missed the per-token map, and every retry silently fell back to the flat 600ms delay regardless of actual quota — a fully-implemented feature that was never wired up. Fixed by passing `token` at every call site.
- Global `bot.catch()` handler used raw `console.error` instead of the structured `pino` logger — the one place in the codebase bypassing it, meaning the most important error path wasn't landing in Railway's logs in the same parseable format as everything else. Now uses `logger.error(...)`.
- Removed an unused `safeEditMessageText` import in `handlers/instanceMigrationAdmin.js` — that file already reimplements the same try/catch-guarded edit logic locally three times; the import was dead weight.
- `scenes/createRepo.js`'s "schedule for later" quick-pick handler could call `finalizeSchedule()` with `scheduledFor` still `undefined` if it ever received a `pick` value outside the three fixed buttons (only reachable via tampered callback_data, not through normal use) — now replies with an error instead of persisting an invalid scheduled date.
- Ran the full pattern/unit/smoke test suite (`scripts/check-patterns.js`, `scripts/unit-tests.js`, `scripts/smoke-test.js`) plus a manual audit of the GitHub API layer, Bulk Actions, and every scene wizard (create/edit/rename/upload) — no SQL injection surface, no unguarded background-poller crashes, no ReferenceErrors across all 338 exported handler functions.

</details>

<details>
<summary><b>v1.1.16-multi</b> — Fix: successful actions showing a false "activity_log_pkey" / "access_log_pkey" error</summary>

- **🔴 Disconnect, Connect GitHub, and commits could all report failure after fully succeeding.** Instance Migration's importer (`lib/instanceMigration.js`) writes rows back with their original source-instance `id`s after a `TRUNCATE ... RESTART IDENTITY`, which resets each table's id sequence to 1 without ever moving it past the ids that were just re-inserted. The action itself (disconnect, OAuth connect, a commit) always completed first; only the *audit-trail write after it* — `activity_log` or `access_log` — collided with an id that had migrated in, and that unhandled error replaced the real success reply with `bot.js`'s generic "Something went wrong: duplicate key value violates unique constraint ..." Fixed two ways: `importInstance` now re-syncs every table's sequence to `MAX(id)+1` right after inserting it, and `migrate()` (runs on every boot) does the same sweep across all tables as a self-healing repair, so an already-affected deployment fixes itself on the next restart with no manual step. Also hardened `activity.log()` and `accessLog.record()` themselves to catch and log any write failure internally rather than letting it propagate — an audit row failing to write is never a reason to tell the user the thing they just did didn't work.

</details>

<details>
<summary><b>v1.1.15-multi</b> — Admin: undo ledger, deeper repo moderation, audit-log filters</summary>

**Admin undo.** Ban, Suspend, Bulk Suspend and Bulk Mute each get a one-hour ↩️ **Undo** — the same reversible-ledger pattern the user-side Bulk Actions already used (`admin_undo` rows with an expiry; undo restores each account's *previous* state, not a blanket default).

**Repo moderation, completed.** From a connected user's Dashboard card an admin can view, download, delete, and change visibility/licence on that user's repos. Every destructive step asks for the full `owner/repo` and shows GitHub's real error text instead of a generic failure.

**Audit log.** 🔍 Filter by action type and/or by admin; 📤 CSV export respects the active filters.

**Fixes:** the Dashboard's open-reports badge no longer lags behind a resolved report; a bulk operation can no longer include an admin account (excluded in the SQL, not just hidden in the UI).

</details>

<details>
<summary><b>v1.1.14-multi</b> — Weekly auto-backup, stale-repo nudges, size history</summary>

**🗄️ Auto-Backup rules.** Pick repos by language, name pattern, visibility or fork status; every Monday around 9 am (in *your* timezone) the matching repos are zipped and sent to your chat, with a short summary. ▶️ *Backup Now* runs it on demand.

**🧹 Stale nudge.** An opt-in weekly message listing repos nobody has committed to in a long time, with one-tap Bulk Select of exactly those repos.

**📊 Size history.** Each repo card gets a rolling 30-day size trend as a text sparkline next to the current prior-vs-now delta; snapshots are taken lazily when a repo is opened, so there's no extra API traffic.

**Notes:** both weekly jobs hold a Redis lease so a redeploy overlap can't send them twice.

</details>

<details>
<summary><b>v1.1.13-multi</b> — 📦 Storage & Data, Recently Viewed and Search History</summary>

**📦 Storage & Data.** One screen that shows what GitroHub remembers about you (counts, activity span, Trash) and lets you clear it granularly — activity history, pins, tags, defaults, Quick Access — or everything with a typed `RESET` confirmation. 📤 Export produces a JSON file of your settings and data.

**⚡ Quick Access.** Pinned repos, **Recently Viewed** (a short LRU of repos you actually opened) and **Search History** in one place, each clearable on its own.

**Auto-cleanup.** Activity retention is now a per-person setting (30 days / 90 days / 1 year / forever, default 90) with a lazy per-user prune plus a daily sweep.

**Fixes:** clearing Pins no longer left orphaned section labels; the Storage screen's "activity span" no longer counted automated rows.

</details>

<details>
<summary><b>v1.1.12-multi</b> — Tags, nesting groundwork and pin sections (data layer)</summary>

**🏷️ Tag model.** Tags gain `parent_id` (nesting such as *Work → Work/Client-A*) and a fixed six-colour palette, with `tag_defaults` (per-tag visibility / upload folder / commit message) and an optional auto-rule per tag. Filtering by a parent tag includes every descendant.

**📌 Pin sections.** `pinned_repos` gets an optional section name so Pinned can be grouped; reordering is scoped within a section.

**Export / Import** carries the new fields so a settings file round-trips them.

**Notes:** this release lays the data layer and the read paths (filtering, rendering, export); the editing screens follow in later releases.

</details>

<details>
<summary><b>v1.1.11-multi</b> — Quiet hours, rollup digests and per-person timezones</summary>

**🌍 Timezone.** Each person sets their timezone under 🤖 Automation; schedules, digests and weekly jobs now use it instead of one shared UTC instant.

**🌙 Quiet Hours.** A window (that may wrap past midnight) during which live-alert digests are held — left in Redis and delivered when the window ends, never duplicated.

**🧾 Rollup digests.** Optional daily or weekly summary: *"3 repos touched, 12 changes via bot, 2 pushes received"*, cycled off / daily / weekly with one tap, sent around 8 am local time.

**Fixes:** a scheduled item created in one timezone then viewed after a timezone change now displays in the viewer's current zone.

</details>

<details>
<summary><b>v1.1.10-multi</b> — Smart Folders and the composable filter builder</summary>

**🗂️ Smart Folders.** Save a filter as a named view and reopen it in one tap.

**Filter builder.** Clauses stack — *private AND stale-90d AND tagged "side-project"* — and the same builder drives Bulk Select, so what you see is exactly what gets selected. A clause list can be saved straight from Bulk Select as a Smart Folder.

**Search.** Weighted fuzzy matching across name, description and topics, with recency and star signals as tie-breakers.

**Fixes:** filters on `language: none` now match repos GitHub reports with no language.

</details>

<details>
<summary><b>v1.1.9-multi</b> — Trash polish: Edit & Restore, ZIP re-send, delete forever</summary>

**♻️ Edit & Restore.** Before restoring a trashed repo you can change its name and description; the typed name is validated before anything is created on GitHub, and a name that already exists is reported with a clear next step.

**⬇️ ZIP** re-sends the stored backup at any time; **🗑 Delete Forever** removes an entry (and the stored file reference) on the spot, after a confirmation.

**Safety:** restore reads GitHub's own zipball through the hardened archive reader (hard cap on bytes actually produced, `.git` and traversal paths dropped) with a larger ceiling than user uploads (`MAX_RESTORE_UNCOMPRESSED_BYTES`).

**Fixes:** the Trash list no longer shows entries whose retention period had already ended.

</details>

<details>
<summary><b>v1.1.8-multi</b> — Lockdown Mode, broadcast hub, Global Config expansion, 🗑️ Trash retention</summary>

**🔒 Lockdown Mode** — a strict Owner-only switch that stops all non-admin traffic at the access gate (the same gate later reused by Warden's Owner controls).

**📢 Broadcast gets its own hub.** *Cast* (send now or schedule), **📜 Cast History**, and a recurrence choice for scheduled broadcasts — once, daily or weekly.

**⚙️ Global Config grows.** More runtime-editable knobs, each with a preset picker and the same "override, else environment default" display; admin timestamps are shown in the *admin's own* timezone, and a time typed by an admin is read in that timezone.

**🗑️ Trash retention.** New accounts default to keeping Trash entries for 30 days (`DEFAULT_TRASH_RETENTION_DAYS`); an existing account's choice is never touched.

**Changed:** the welcome screen no longer reads the account email (`user:email` is no longer requested — the scope list is now `repo` and `delete_repo`); 📞 Contact Admin gets a tappable **🚩 Report a Problem** button; Back from Fleet Stats returns to 📊 Oversight.

</details>

<details>
<summary><b>v1.1.7-multi</b> — Security & robustness pass: archive bombs, OAuth link-injection, BIGINT ids, rate limits, data erasure</summary>

Every item below came out of a full read-through of the codebase; each has a regression test in `scripts/unit-tests.js` (`npm test`) unless noted.

**Security**
- **🔴 Decompression bombs (tar.gz and zip).** `.tar.gz` used to be fully inflated with `gunzipSync` *before* any size check — gzip reaches ~1000:1, so a 1MB upload could allocate ~1GB in one blocking call and OOM-kill the shared process (open access → any user could do it). The zip guard trusted sizes *declared* in the zip headers, which an attacker controls. Both now run through the new `lib/archive.js`: hard `maxOutputLength` on every inflate, the limit is counted on the bytes **actually produced**, headers/CRCs are verified, and a bomb is rejected in milliseconds. The zip reader is hand-written (deflate + stored + classic ZipCrypto, tested against a real `zip -P` archive), so `adm-zip` and `lib/zipCrypto.js` were removed. Trash restore uses the same reader (larger, still hard, ceiling). New `MAX_ARCHIVE_FILES` (2000) bounds per-file work.
- **🟠 OAuth link-injection.** Someone could send a victim *their own* connect link; if the victim approved on GitHub, the attacker's Telegram account ended up controlling the victim's repos (including `delete_repo`). `state` now carries a purpose claim and a one-time id (burned in Redis on first use, fail-closed), and `/callback` shows a **confirmation page naming the Telegram account being linked** — the code is only exchanged after an explicit click (`POST /callback/confirm`, served with `frame-ancestors 'none'`). This adds one tap to connecting.
- **Archive path hygiene.** Entries with `..`, absolute paths, drive letters, NUL bytes or `.git` components are skipped and reported; duplicate paths are de-duplicated.

**Bugs**
- **BIGINT ids.** `pg` returns BIGINT as strings, but IDs were compared to numbers with `===`/`includes`/`Set`. The Owner badge never showed and the 👑 Admins roster listed every env-seeded admin twice. A type parser now yields numbers, and the comparison sites also coerce with `Number()`.
- **Bulk commits hit GitHub's secondary rate limit.** Every blob was created at once via `Promise.all` (v1.1.4 only re-labelled the resulting error). Blobs are now created 4 at a time (`GITHUB_BLOB_CONCURRENCY`), retried with `retry-after` backoff (safe — blob creation is content-addressed), and the commit timeout scales with the file count.
- **macOS zips** no longer upload `__MACOSX/`, `.DS_Store` or `._*` files (and no longer defeat top-folder stripping).
- **Old inline buttons acted on the wrong repo.** Browse/file buttons read `session.currentRepo`, so a button on an older message operated on whichever repo had become current. Those buttons are now bound to the repo their message showed.
- **Telegram's 64-byte `callback_data` limit** (long repo names / file paths) was logged but not fixed. Oversized values are now replaced by a short content-derived reference (`lib/callbackRefs.js`, Redis-backed, 30-day TTL) and expanded by one early middleware.
- **Webhook body limit.** `express.raw` defaulted to 100kb and rejected large push events with a 413; now 5mb, and 4xx errors keep their real status instead of a 500.
- The "GitHub Connected" message now shows the scope GitHub actually granted (it hard-coded `repo, delete_repo`).
- Trash restore now checks the Telegram download's HTTP status.

**Efficiency**
- `ensureUser` (runs on every update) now reads first and only writes when something changed; the click counter is batched into one `UPDATE` every 5s and flushed on shutdown — down from two writes per update.

**Data & privacy**
- **Full erasure was incomplete:** `deleteUserAndData` skipped `saved_views`, `defaults_changelog`, `bulk_action_log` and `user_reports`, and left the Redis session behind. All are removed now.
- **Scheduled-upload file bytes** stayed in Postgres after a schedule completed, failed or was cancelled; they are now deleted on every terminal state, and existing leftovers are swept by the daily prune.
- **Privacy text corrected** (`/legal`, updated Sept 21, 2026): the stored GitHub email is disclosed; scheduled-upload storage is disclosed; the token-handling sentence is accurate; the erasure text lists what is removed and states that moderation audit records may be retained.

**Operations**
- **Poller lease (`lib/pollerLease.js`).** Scheduled repos / uploads / broadcasts take a short Redis lease each tick, so two overlapping instances (zero-downtime deploy) can't double-commit or double-send. Fails open if Redis is unreachable. The rest of the in-process state is still single-instance — see README → Known limitations.
- **Repo hygiene:** added the previously-missing `.env.example`, `.eslintrc.json` and `.gitignore`; new `npm test`; the CHANGELOG gained the "Pre-1.0.0 development history" note explaining the duplicate version numbers; README corrected (OAuth scope, Redis write-through, version badge) and extended.

**Not verified in this pass** (be upfront): `npm run lint` and `npm run smoke-test` need the real dependencies installed, which weren't available while this was written — `.eslintrc.json` is untested, and the OAuth confirm page, the callback middleware and the new SQL were only checked by syntax, a TypeScript-based undefined-name scan, and unit tests against in-memory stand-ins, not against a live Telegram/Postgres. No `package-lock.json` is shipped (it can't be generated offline); `npm install` creates one.

</details>

<details>
<summary><b>v1.1.6-multi</b> — GitHub email on /start, username styling</summary>

Answering the scope question directly: no, `user:email` wasn't requested anywhere before this — the OAuth scope was `repo,delete_repo` only, confirmed in `lib/oauth.js` and matching the Settings screenshot ("Scope: delete_repo, repo").

- **📧 Added `user:email` to the OAuth scope** and store the account's primary email (`users.github_email`) alongside the username at connect time. This only takes effect for an account that connects (or reconnects) going forward — an OAuth scope isn't retroactive, so an already-connected account won't have an email on file until they disconnect and reconnect once.
- **On /start's "WELCOME BACK" card**: the GitHub username no longer shows as `@username` — it's bold, without the `@`, since that's a Telegram-mention convention that didn't really fit a GitHub handle. The email shows on its own line right underneath it, when there is one on file; omitted entirely (not a blank line) for an account that hasn't reconnected since this shipped.
- This message switched from plain text to MarkdownV2 to support the bold styling, which meant re-escaping everything else in it by hand (the username, the email, the version string, and the one literal period in the message all needed it) — the exact class of bug this project has hit more than once, so every dynamic value here went through `format.escapeMd()` and got manually re-verified before shipping.

Not changed, in case it's wanted later: ⚙️ Settings' "GitHub: username" line still shows only the username, no email — the ask was specifically about /start, so I left Settings alone rather than assume it should match.

</details>

<details>
<summary><b>v1.1.5-multi</b> — Fix: three more misdiagnosed/duplicated error messages</summary>

Same bug family as v1.1.4's rate-limit fix — went looking for other places matching an error by status code alone (or by text that GitHub doesn't actually use), and found three real ones.

- **🔴 Delete Repo and Change Visibility could show two error messages stacked for the same failure** — both called `errorHelpers.replyGithubError` (which already replies) and then unconditionally sent a second, different reply for anything that wasn't specifically a 401 auth error. A rate-limit hit on either of these used to show its correct, specific message immediately followed by an unrelated "check your token permissions" one.
- **🔴 Change Visibility's "admin rights" hint could never actually fire** — it checked `err.message.includes('403')`, looking for the literal digits "403" in GitHub's error text. GitHub doesn't put status codes in its messages (a real one reads like "Must have admin rights to Repository."), so this always fell through to the raw message instead. Fixed to check `err.status === 403` directly, and restructured so it no longer double-replies either.
- **🔴 Any 422 on Create/Rename/Fork/Scheduled-Repo was reported as "name already exists," even when it wasn't** — a 422 from GitHub also covers other validation failures (an org policy blocking creation, private repos not permitted on the plan, etc.). Four call sites assumed 422 always meant a name collision; added `errorHelpers.isNameCollisionError`, which also checks GitHub's actual message text (same reliable pattern `handlers/search.js`'s fork-collision check already used correctly), and pointed all four at it.

Also checked and ruled out as NOT bugs, for the record: cache-invalidation scope after Description/License/Visibility changes (each correctly invalidates only what that specific change could affect — differentiated on purpose, not an oversight), and a few other status-only checks (404/304/401) that are already unambiguous on their own.

</details>

<details>
<summary><b>v1.1.4-multi</b> — Fix: misreported rate-limit error on bulk uploads</summary>

Spotted from a real screenshot: uploading 107 files failed with "GitHub's API rate limit was reached — resets in about 53 minutes," but ⚙️ Settings showed 4816/5000 core requests still remaining. The 53-minute figure was real — just for the wrong thing.

- **Root cause** — `lib/github.js`'s `isRateLimitError` matched any 403 containing the phrase "rate limit," which is true for both of GitHub's genuinely different 403s: the **primary** 5000/hour quota, and a completely separate **secondary/abuse-detection** limit that trips from bursts of activity (like committing 107 files at once) regardless of how much primary quota is left. Both got the same message, computed from the primary limit's `x-ratelimit-reset` header — accurate for one, meaningless for the other.
- **Fix** — added `isSecondaryRateLimitError`, checked first in `lib/errorHelpers.js`'s `replyGithubError` (the one shared function every GitHub-touching handler already routes through — delete, rename, upload, edit, bulk actions, create repo, download — so this is a single fix, not ten). Secondary-limit hits now say plainly that it isn't the hourly quota and use GitHub's `retry-after` header (seconds, typically well under a minute) instead of the primary limit's hour-long reset window.

</details>

<details>
<summary><b>v1.1.3-multi</b> — Fix: MarkdownV2 crash on /repos and /new while disconnected; multi-file scheduling</summary>

- **🔴 `/repos` and `/new` crashed with a raw Telegram 400 error when GitHub wasn't connected** — traced to `handlers/start.js`'s `sendConnectPrompt`: its `intro` parameter was documented as "pass pre-escaped MarkdownV2," but that's exactly the kind of contract that's easy to get right once and wrong the next time — one caller (`settings.js`) pre-escaped correctly, another (`lib/requireConnected.js`, the one both `/repos` and `/new` hit while disconnected) passed plain text straight through with `parse_mode: 'MarkdownV2'` still active, and Telegram rejected the unescaped period. Fixed at the root: `sendConnectPrompt` now takes plain text and escapes it itself, so a third caller added later can't reintroduce the same bug by forgetting to pre-escape.
- **🟠 `/new` used to let you fill out the entire create-repo wizard (name, description, visibility) before failing at the very last step** if you weren't connected. Now checks upfront, at step 0, before asking anything — `/repos` already failed fast, this brings `/new` in line with it. (`editFile`/`renameRepo`/`uploadFile` weren't affected — they're only ever reachable by first selecting an existing repo, which already requires being connected to get that far.)
- **📅 Scheduled uploads now support extracted zip/tar contents, not just a single file** — previously "📅 Schedule for Later" only appeared for a single self-contained file; extracting a multi-file archive always committed immediately with no option to defer it. Multi-file schedules store every file's bytes directly (a new `scheduled_upload_files` table) at schedule-creation time rather than re-downloading and re-extracting the original archive hours or days later — deliberately not the same "re-fetch from Telegram" approach the single-file path uses, to avoid re-running extraction logic unattended in a background poller. A 🔁 Replace Folder sync (or anything that also deletes files) still always commits immediately — that still needs to diff against the repo's live state, which is a correctness concern scheduling doesn't solve for. The 📤 Scheduled Uploads management screen (list, detail, ▶️ Run Now, ✏️ Edit) is multi-file-aware throughout; per-file path editing isn't supported yet for a multi-file schedule — cancel and re-schedule if a path needs to change.

</details>

<details>
<summary><b>v1.1.2-multi</b> — Deep debug pass: 9 bugs found and fixed</summary>

A full audit pass across the roles system and its downstream effects, requested explicitly for stability rather than new features. Every item below was found, written up, and only fixed after confirmation.

- **🔴 Bulk actions and 🚩 Suspicious flagging didn't know about promoted admins** — `bulkSuspend`, `bulkPurgeNeverConnected`, `bulkDeleteBanned`, and the Suspicious filter/badge all read `users.is_admin`, a column that was only ever set once at `/start` time from `config.ADMIN_IDS`. A user promoted via 👑 Set Role since v1.1.0 could still get caught by any of these.
- **🔴 Root cause, actually fixed** — traced this to `lib/users.js`'s `ensureUser`, which runs on *every message* and was resetting `is_admin` back to config-only truth each time, which would have silently undone any simpler "sync the column" fix on the promoted user's very next message. `ensureUser` now computes `is_admin` from `config.ADMIN_IDS` **OR** `admin_roles` in the same query (one EXISTS subquery, zero extra round-trips) — every downstream reader (bulk actions, Suspicious, the OAuth callback's post-connect menu, `/report`'s menu choice) is correct as a side effect of this one fix. `lib/roles.js`'s `setRole`/`revokeRole` also stamp `users.is_admin` directly now, for instant effect rather than waiting on the target's next message.
- **🔴 `downloadUserRepoZip` was passing `null` as the git ref** — every other `downloadZip()` call site in the codebase always passes an explicit branch; this was the one exception, very likely producing a broken request. Now takes the real `default_branch` from the already-fetched repo object.
- **🔴 License picker and 👑 role-change menu both had a stale-button bug** — both apply directly on tap with no separate yes/cancel confirm, and neither was disarming its own buttons afterward — a second stray tap on a *different* option (a different license, or "Demote to Guest" right after "Set: Moderator") would fire a second real write. Both now go through the same `confirmFlow.resolveConfirmation` guard every other confirm screen in the project already uses.
- **🟠 Removed a redundant DB query on the single hottest path in the bot** — `accessControl.js` used to run its own separate `roles.hasRole()` query on every message from every non-admin user, on top of `ensureUser`'s own query, for information `ensureUser`'s result already contained. Now reads `user.is_admin` straight off it — net result of this pass is one fewer query per message for the common case, not more.
- **🟠 Repos screen had no error handling for a dead/revoked token** — `showUserRepos` now catches a GitHub failure and shows a clear message instead of a raw error bubbling to the bot's generic fallback handler, matching how delete/visibility/license already behaved.
- **🟡 📣 Nudge never excluded admins** — now filters `is_admin = FALSE`, matching Purge/Suspend/Delete Banned.
- **🟡 Guest-tier ban-immunity — kept as-is, documented as deliberate** — promoting someone to Guest (view-only) also makes them immune to a peer's one-tap Ban, same as every other tier. This was flagged as "worth a decision, not clearly a bug"; the decision is to keep it, since it's the safer default and 🗑️ Revoke Completely already exists for the "no, really remove their standing" case. The code comment now says this explicitly instead of leaving it implicit.
- **Also found and fixed on the way (not in the original list):** the timed-ban `blocked_until` column was missing from `ensureUser`'s self-heal CASE list entirely (an oversight from when timed bans were added) — an admin auto-unlocked by the self-heal could be left with a stale `blocked_until` timestamp sitting in their row even though `is_blocked` was correctly cleared. Fixed as part of the same query rewrite.

</details>

<details>
<summary><b>v1.1.1-multi</b> — Fix: demotion had no path to a fully normal user</summary>

"⬇️ Demote to Guest" was the lowest option in the role picker, but Guest is still a role — it still shows up in 👑 Admins, still gets Dashboard view access, still makes `isProtectedAdmin` refuse Ban/Suspend/Delete on that account. There was no way to actually put someone back to being a completely ordinary user with zero Dashboard standing.

- **🗑️ Revoke Completely (Normal User)** — new button on the role menu, separate from the four promote/demote options above it. Deletes the `admin_roles` row entirely rather than setting it to `'guest'`.
- Same guardrails as a normal role change (can't target the Owner, can't revoke yourself, can't revoke the last remaining super_admin) plus one specific to revoke: a `config.ADMIN_IDS` member can't be revoked this way at all — their row would just get silently re-seeded on the next restart, which would make the revoke look like it worked and then quietly reverse itself. Removing an env-configured admin still requires editing `ADMIN_IDS` directly.

</details>

<details>
<summary><b>v1.1.0-multi</b> — Promote any user, protected Owner, promote/demote clarity</summary>

- **👑 Promote any user directly to a role** — previously role management only worked among people already in `ADMIN_IDS` (env-configured). Now a super_admin can open ANY user's 👤 detail card and tap "👑 Set Role" to grant them guest/moderator/admin/super_admin on the spot — no `.env` edit, no redeploy. `admin_roles` is now the real source of truth for Dashboard access; `ADMIN_IDS` is just its initial seed data. Ban/Suspend/Delete correctly disappear for a newly-promoted user immediately (previously this check only looked at a stale `is_admin` column set at `/start` time).
- **🏆 Protected Owner** — a new `OWNER_ID` (falls back to `ADMIN_ID`, then the first `ADMIN_IDS` entry, so nothing needs to change on upgrade) marks one account whose role can **never** be changed by anyone — not even another super_admin. Enforced at both the "open role menu" and "apply role change" steps.
- **⬆️⬇️ Promote/demote made explicit** — the role picker now labels every option "⬆️ Promote to X" or "⬇️ Demote to X" (color-coded blue/red) instead of a flat "Set: X" list, so which direction a tap goes is obvious without doing tier-order math in your head.

</details>

<details>
<summary><b>v1.0.9-multi</b> — Report categories, CSV export</summary>

- **🏷️ Report categories** — `/report` now asks 🐛 Bug / 🚨 Abuse / ❓ Other after the description, so the 🚩 Reports queue and each report's detail card show a category tag instead of every row needing to be opened to know what kind of problem it is.
- **📤 CSV export** — new buttons on 📜 Audit Log ("📤 Export CSV," respects whatever filter is currently active) and 📊 Fleet Stats ("📤 CSV," the 30-day growth series) for anyone who wants to work the data outside Telegram.

</details>

<details>
<summary><b>v1.0.8-multi</b> — Roles, repo moderation depth, timed bans, on-demand chart</summary>

- **👑 Admin Roles** — four tiers within the existing `ADMIN_IDS` allowlist: guest (view-only) < moderator (ban/suspend/message/notes/trust) < admin (repo moderation, delete user, limits, resolve reports) < super_admin (broadcast, bulk hub, global config, role management). New `admin_roles` table, seeded automatically from your current `ADMIN_IDS`/`SUPER_ADMIN_IDS` at boot — **upgrading changes nobody's access**. New 👑 Admins screen on the Dashboard (viewable by all, manageable by super_admins only), with two guardrails: you can't change your own role, and the last remaining super_admin can't be demoted. Role changes are logged to the existing Audit Log (`role_change`), filterable like everything else there.
- **📂 Repo browse, download & moderate** — tapping a repo now opens a detail card (link, size, license, branch, last push) instead of doing nothing. Added ⬇️ Download ZIP, 🔒/🌐 change visibility, and ⚖️ change license (writes a LICENSE file, MIT/Apache/GPL/BSD). Every confirmation shows the full `owner/repo` name, not just the bare repo name.
- **🔄 Safe error handling on repo actions** — delete/visibility/license changes now await GitHub's real response *before* touching the audit log or notifying anyone; a rejected API call throws immediately, so a failure can never be followed by a false "success" message. (Delete already worked this way; visibility and license changes are built the same way from the start.)
- **🔕 Silent repo moderation by default** — a new 🔔 Notify Users toggle on ⚙️ Global Config (off by default) controls whether the affected user is told about a repo delete/visibility/license change. Off means checking someone's repos never itself alerts them. Ban/suspend/message notices are unaffected — those are inherent to what those actions are, not incidental.
- **⏳ Timed bans** — Ban now offers 7 days / 30 days / Permanent, same shape Suspend's 24h/7d picker already used. Auto-expires the same way Suspend already does (a live check, no poller needed) — no schema-breaking change for existing permanent bans.
- **📈 Chart is now on-demand** — was sending automatically every time Fleet Stats opened; now there's a dedicated "📈 Chart" BBTB button, sent only when tapped.

</details>

<details>
<summary><b>v1.0.7-multi</b> — Admin Dashboard: analytics, filters, scheduling, reports, attachments</summary>

Five more additions, each folded into an existing screen rather than bolted on separately, so the Dashboard gains depth instead of just more buttons:

- **📈 Fleet Stats gets a real chart** — a 30-day new-signups line chart, rendered as an actual PNG (via QuickChart's public API, `lib/chartRender.js`) and sent alongside the existing text stats, not an ASCII sparkline standing in for one. Best-effort: a slow/unreachable chart service never breaks the text stats it's attached to.
- **📜 Audit Log gets real filters** — 🔍 Filter by action type or by admin (built dynamically from `admin_action_log`'s actual contents, never a hardcoded list that could drift), stacking as AND. The per-user History card intentionally doesn't expose this — it's already scoped to one person.
- **📢 Broadcast gets Schedule + History** — Send Now or ⏰ Schedule for Later (same time-picker presets/custom-input pattern Scheduled Uploads already uses), plus a new 📜 Cast History screen. One table (`scheduled_broadcasts`) serves as both the pending queue and the sent-history log, so History always reflects exactly what went out — immediate and scheduled sends share the exact same delivery code path.
- **🚩 User Reports** — the first inbound channel a user has to flag something *to* an admin (`/report`), landing in a new 🚩 Reports queue on the Dashboard (badge shows open count) with View User / Message User / Resolve / Dismiss actions.
- **💬 Message gets attachments** — photo and document support (with optional caption), not text-only. Uses the same session-based flow as before, routed through the existing document/photo input dispatch.

Re-verified with `scripts/check-patterns.js` at zero strict findings across the full `src/` tree, plus a manual MarkdownV2 escaping pass on every new screen (the exact class of bug — unescaped `.`/`-` in MarkdownV2 prose — that check-patterns.js doesn't catch on its own).

</details>

<details>
<summary><b>v1.0.6-multi</b> — Admin Dashboard: five real gaps closed</summary>

Five things the Dashboard was missing were identified and built, not just documented as known limitations:

- **💬 Direct Message** — the per-user detail card can now send one free-text message straight to that person, distinct from 📢 Broadcast (everyone) and 📣 Nudge (a fixed template to never-connected accounts). Prefixed `💬 Message from an admin:` so it's never mistaken for an unlabelled DM.
- **📝 Admin Notes** — a freeform, admin-only note per account (`users.admin_notes`), for handoff context between admins ("known issue, watching") — never shown to the user, never a factor in any automated decision.
- **🎚️ Super-admin tier** — `SUPER_ADMIN_IDS` (subset of `ADMIN_IDS`, config.js) now gates the Dashboard's fleet-wide/destructive-at-scale actions: permanent Delete User, 📢 Broadcast, and the whole 🗂️ Bulk hub (Purge, Bulk Suspend, Bulk Mute, Delete Banned). Ordinary per-user moderation (ban/suspend/trust/limits/message/notes/repo removal) stays open to every admin. Backward-compatible: unset `SUPER_ADMIN_IDS` means every existing admin keeps full access, zero `.env` changes required.
- **↩️ Undo** — Ban, Suspend, Bulk Suspend, and Bulk Mute now write a reversible entry to a new `admin_undo_log` table (1-hour window, same TTL pattern as the existing per-user Bulk Actions undo ledger) and surface an ↩️ Undo button right after the confirmation. Delete/Purge/Delete-Banned are deliberately excluded — `deleteUserAndData()` actually removes the rows, so there is no previous state left to restore, and an undo button that can't really undo would be worse than none.
- **📂 Repo moderation** — the user detail card gained a 📂 Repos button (shown only when that account is connected to GitHub) listing their repos with a per-repo 🗑️ delete, using the target's own token (there's no admin-wide GitHub credential). Logged to the audit trail and mirrored as a clearly-attributed line in the affected user's own Activity Log, so it's never a silent, unexplained repo disappearance to them.

Re-verified with `scripts/check-patterns.js` at zero strict findings.

</details>

<details>
<summary><b>v1.0.5-multi</b> — `/legal` audited against the code the same way `/help` was</summary>

Same treatment as v1.0.4-multi, applied to `/legal` this time: every factual claim checked against the actual handler/schema code instead of trusting the v1.0.2-multi first draft.

**The real fix: Data Retention, Export & Deletion (and the Privacy Policy / Suspension & Termination sections referencing it) overstated self-service deletion.** The old text said Storage & Data lets a user "fully delete your data with a typed confirmation." Checking `dataStore.fullReset()`: it clears pins, tags, defaults, activity history, automation rules, and saved upload-path memory — and *deliberately* leaves 🗑️ Trash and the GitHub connection itself untouched (the code's own comment explains why: a reset shouldn't be able to cost you a repo you might still want back). It also never touches search history, Smart Folders, webhook subscriptions, or the Access Log. A genuine complete erasure exists — `users.deleteUserAndData()` wipes every table row tied to a Telegram ID plus the account record — but it's admin-triggered only (`adminActions.deleteUser()`), not something a connected user can run themselves. Rewrote the Privacy Policy's "Your choices" clause, the whole Data Retention & Deletion section, and the Suspension & Termination closing paragraph to describe what Full Reset actually does and doesn't clear, and that full erasure goes through 📞 Contact Admin — instead of a legal document promising a button that doesn't exist as described. Fixed the identical overstatement in `/help`'s 📦 Storage & Privacy topic.

**Smaller corrections:**
- The old text's example of "clear specific categories" (Recently Viewed, Search History) named real features but the wrong screen — those two one-tap clears live on ⚡ Quick Access, not inside Storage & Data's own Clear Data menu (which is Activity Log / Pins / Defaults). Both docs now name the right screen for each.
- Named the actual encryption algorithm (AES-256-GCM, from `lib/crypto.js`) in the Privacy Policy instead of leaving it as vague "encrypted."

**Confirmed accurate, unchanged:** upload limits (1MB zip / 15MB uncompressed / 5MB single file, `config.js`), 90-day Activity/Access Log retention, one GitHub connection per Telegram account at a time, silent no-reply behavior for banned/suspended accounts, OAuth scope shown in Settings, and token deletion on Disconnect — all matched the code exactly.

Re-verified with the same standalone MarkdownV2 escaping + bold-balance check on every section, plus `scripts/check-patterns.js` at zero strict findings.

</details>

<details>
<summary><b>v1.0.4-multi</b> — Fixing the v1.0.3-multi `/help` rewrite's own accuracy gaps</summary>

Went back over the `/help` content added in v1.0.3-multi against the actual handler/keyboard code line-by-line rather than trusting the first draft, and found it had picked up exactly the kind of inaccuracy that made the old version shallow in the first place — just newer ones:

- **Notifications topic named "Automation results" as a category** — that's not a real toggle. The actual five are GitHub Activity, System Alerts, Long Operations, Token Health, and Stale Repo Nudge (`lib/users.js`'s `getNotificationPrefs`); Long Operations and Token Health weren't mentioned anywhere in `/help` at all before this. Now names and explains all five.
- **Automation topic invented a "Scheduled Commits" feature** distinct from Scheduled Repos — there isn't one; `handlers/scheduledCommits.js` is the (legacy-named) view/manage screen *for* Scheduled Repos, not a third thing. Fixed to the real two: Scheduled Repos and Scheduled Uploads.
- **Automation topic implied ▶️ Run Rules Now covers Auto-Backup** — it doesn't; `runAllRulesNow()` only re-applies Auto-Tag and Auto-Mute retroactively. Auto-Backup runs on its own fixed weekly cadence plus a deliberately separate ▶️ Backup Now button (`automation.js`'s own comment explains why: zipping and sending a whole repo is much heavier than a tag/mute metadata write). Fixed to describe Auto-Backup's real trigger and cadence instead of pointing at "the schedule."
- **Repos & Uploads topic claimed Repo View shows the README "rendered, not raw markdown"** — Repo View only shows a short plain-text preview (`repoView.js` passes it through `escapeMd`, not the renderer); the actual MarkdownV2 rendering (real bold/headers/links) happens when opening README.md through 📁 Browse Files (`lib/markdownRender.js`), which the old wording didn't distinguish. Also corrected the Browse Files emoji (📁, not 📂) to match the real BBTB button.

Same verification pass as before (standalone MarkdownV2 escaping + bold-balance check on every topic, `scripts/check-patterns.js` at zero strict findings) re-run after these fixes.

</details>

<details>
<summary><b>v1.0.3-multi</b> — `/help` filled back out to match what the bot actually does</summary>

`/help` had drifted well behind the feature set — it dated from v1.3.0-multi (five thin topics, one line each for things that had since grown into whole subsystems) and was never revisited as Tags, Smart Folders, Bulk Actions, Storage & Data, Trash, Rollup Digests, and the rest of the v1.1–v1.3 releases landed. Rewritten topic-by-topic against the actual handlers/keyboards, not the old copy:

- **📁 Repos & Uploads** — now actually covers 📂 Browse Files (view/send/edit/delete), 📥 Batch Upload, 🔁 Replace (single file and whole-folder sync with a delete preview), ⬆️ Upload Here, ⬇️ Download of external repos, and 🍴 Fork / ⭐ Star — none of which were mentioned before at all.
- **🤖 Automation** — now names all four 🔧 Rules & Insights rule types (Auto-Tag, Auto-Mute, Auto-Backup, Stale Repos) instead of a vague "recurring behavior," plus 📅 Schedule (Scheduled Commits/Uploads/Repos) and where 🌍 Timezone actually lives and why it matters.
- **🔍 Search & Organize** — now covers 🏷️ Tags (including nesting and per-tag defaults) and 🗂️ Smart Folders, both previously undocumented anywhere in `/help`.
- **🧹 Bulk Actions** (new topic) — the filter-builder multi-select flow, retry-failed-only, and the 1-hour undo window on visibility changes had no help coverage at all before this.
- **📦 Storage & Privacy** (new topic) — what's actually stored, export, per-category clearing, full deletion, and 🗑️ Trash (recoverable deleted repos) — previously undocumented; also cross-references `/legal`'s Data Retention section for the exact retention window instead of duplicating the number.
- **⚙️ Settings & Limits** and **🔔 Notifications** — expanded to mention 🎚️ Your Limits explicitly, the live GitHub webhook receiver (🔔 Live Alerts, with digest batching), 🧾 Rollup Digests, 🌙 Quiet Hours, and the Activity-Log-vs-Access-Log distinction.
- **❓ FAQ** — grown from 5 entries to 9: added Trash/accidental-deletion recovery, Tags-vs-Smart-Folders (a real point of confusion once both exist), why a scheduled job didn't fire (timezone, almost always), and why the bot goes fully silent for banned/suspended accounts.

`inline.helpMenu()` gained two new buttons (🧹 Bulk Actions, 📦 Storage & Privacy) for the two new topics; every topic still routes through the same generic `help:topic:<id>` handler, so no new routing code was needed. Re-verified against `scripts/check-patterns.js` (zero strict findings) plus a standalone MarkdownV2 escaping/bold-balance check on every topic body before shipping.

</details>

<details>
<summary><b>v1.0.2-multi</b> — Real /legal text, `/repos` & `/new` commands</summary>

**`/legal` now ships real, detailed Terms of Use / Privacy Policy content instead of the draft placeholder.** `handlers/legal.js`'s `SECTIONS[]` — the "swap this for real text" TODO left in v1.3.0-multi — is now filled in: 13 sections (Terms of Use, Eligibility & Accounts, Privacy Policy, Data Retention/Export/Deletion, GitHub Access & Permissions, Uploads & Data Storage, Acceptable Use, Suspension & Termination, Disclaimer & Limitation of Liability, Indemnification, Changes to These Terms, Governing Law & Disputes, Contact), each written from exactly what this codebase does — the real upload limits, the real 90-day log retention, the real token-encryption behavior — not generic boilerplate. The "⚠️ Draft placeholder" banner on the `/legal` index is gone accordingly. The pagination/index structure in `legal.js` is unchanged, as originally intended — only the strings moved.

**Text/slash-command fallback for repo actions, previously called out in Known Limitations as missing, added:** `/repos` (jumps straight to 👤 My Repos) and `/new` (enters the same ➕ New Repo wizard as the button). Both route through the exact same guarded handler/scene as their BBTB equivalents, so `requireConnected()`, the hourly action cap, and every other existing gate applies identically — this is a second entry point into existing, already-safe code, not new surface area. Registered in `bot.telegram.setMyCommands()` alongside the existing commands.

**Admin Dashboard's help line trimmed.** The dashboard used to spell out exactly which admin screens live on the main keyboard vs. the Users sub-keyboard in a sentence of its own; removed as redundant now that every admin screen already has its own clearly-labeled BBTB row (v1.3.0-multi's admin redesign) — the keyboard itself is the map, it doesn't need a caption describing it too.

</details>

<details>
<summary><b>v1.0.1-multi</b> — Help menu fix</summary>

**Fixed: tapping "🔗 Connecting & 2FA" on the ❓ /help menu crashed with `inline.helpConnectMenu is not a function`.** The function was defined in `src/keyboards/inline.js` but never added to that file's `module.exports`, so any caller pulling it off the `inline` object got `undefined` instead — this had nothing to do with the handler in `help.js`, which was calling it correctly all along. Added `helpConnectMenu` to the exports list.

**Renamed the "🔗 Connecting & 2FA" topic to "🔗 Account Connection"** for a clearer label — updated the help-menu button, its section heading, and the matching in-code comments. The topic's content (connecting GitHub, plus how 2FA interacts with that connection) is unchanged.

</details>

<details>
<summary><b>v1.0.0-multi</b> — Production release</summary>

**Versioning reset.** The multi-user rewrite had been climbing through 1.1.x–1.3.x while still feeling like a pre-1.0 series in its own right — this build is the first one considered genuinely done and production-ready, so it's tagged v1.0.0-multi rather than v1.3.5-multi: a fresh 1.0 baseline for the multi-user line, not a continuation of the old numbering. Everything below this entry (v1.1.0-multi through v1.3.4-multi) is kept as-is — it's the real development history that led here, and in-code comments citing those version numbers for when a specific feature landed are still accurate and were left alone rather than churned for the renumbering.

**❓ /help now actually explains connecting, GitHub 2FA included.** The help menu had no way to start connecting — someone stuck mid-flow, or just re-reading /help before committing, had no button to tap, only /start's original prompt. Added a "🔗 Connecting & 2FA" topic with a real Connect GitHub Account button (a fresh per-person OAuth link, same as /start's), plus a plain explanation of how two-factor authentication interacts with the connection: 2FA happens on GitHub's own login page, not inside this chat; GitroHub never sees a password or 2FA code; and turning 2FA on, off, or switching methods later never breaks an existing connection. Content paraphrased from GitHub's own documentation, not copied.

**🚩 Suspicious detection deepened — and a real inconsistency fixed.** The heuristic had drifted out of sync with itself: the Users list and the per-user detail card computed "suspicious" inline from only 2 signals (rate-cap hits, no-GitHub-connection-but-lots-of-clicks), while the actual `suspicious` filter query in `users.js` additionally checked for flagged anomaly events — meaning a user could show up under the 🚩 Suspicious filter without ever getting a 🚩 badge next to their name. Centralized all three call sites onto one shared `users.isSuspicious()` (and a new `users.suspiciousReasons()` for a plain-language breakdown, so a 🚩 is never just an opaque flag), and widened it from 2 signals to 4:
- repeated hourly rate-cap hits (unchanged)
- high click volume with no GitHub connection ever made (unchanged)
- a flagged anomalous connection event (unchanged as a signal, but now actually wired into the shared check everywhere instead of only the filter query)
- **new:** a spike of 5+ errors logged in the last 24h

And `accessLog.detectAnomaly` itself — the thing that decides what counts as "anomalous" in the first place — grew from 2 rules to 4, adding:
- 3+ GitHub connect/reconnect events inside 24h (credential-cycling pattern, not routine re-auth)
- an unusually high action count on an account that was created less than 2 minutes before its first-ever GitHub connection (probing before bothering to authenticate)

Still explicitly rule-based pattern matching, not real behavioral/ML analysis — see README's "Known limitations" for the honest framing, unchanged.

**Bug fixes, found during a full pass over the project:**
- **The logo wasn't rendering, anywhere it was used.** Both the README and the OAuth callback page loaded it from a hardcoded `raw.githubusercontent.com/<owner>/gitrohub/main/...` URL — which only resolves once this exact code is pushed to a public GitHub repo at that exact path and branch. Anyone who deployed straight from the zip (Railway supports this directly — see README Setup) never had that repo, so the URL 404'd silently. Fixed on both fronts: the callback page now serves `/logo.png` from the same local `express.static()` mount `app.js` already uses for the rest of `public/` (works regardless of GitHub push status), and the README now references `public/logo.png` as a relative path (renders correctly once pushed to any repo, under any username). Trade-off, noted in Known limitations: opening `callback.html` directly as a local file with nothing running now shows a broken logo image specifically, since that scenario has no server to answer `/logo.png` — the rest of the page still renders via its defensive default data.
- **README's Setup env block was missing `BOT_USERNAME`** — a required variable (`config.js` calls `process.exit(1)` without it) that `.env.example` had all along, just not the shorter copy-paste block in README's own "4. Set up Railway" step. Anyone who followed that block exactly, rather than `.env.example`, would hit a boot crash. Added.
- **`.env.example`'s OAuth callback URL comment was flat-out wrong** — it read `<BASE_URL>/oauth/callback`, but the actual registered route (`app.js`) and the URL the code itself builds (`oauth.js`) are both just `<BASE_URL>/callback`. Since GitHub OAuth Apps require an exact match, anyone who trusted that comment over README's (correct) step 3 would've had every single Connect attempt fail with a GitHub-side redirect-URI mismatch error. Fixed to match the real route.
- **The README's closing tagline still said "Built for one person, on purpose."** — directly contradicting the open-access, multi-user model documented everywhere else on the same page (this was the one leftover single-owner-era line; the rest of the README already described the current model accurately). Replaced.
- `BOT_VERSION`'s example in `.env.example` was left as an active, stale `0.8.1` override — exactly the trap its own surrounding comment warns about. Commented out by default so the Settings screen reflects the real running version with zero upkeep, as the comment already recommended.

</details>

---

## 🕰️ Pre-1.0.0 development history

Everything below this line is the **development series that was released as `v1.0.0-multi`**. It was originally numbered `v0.1.0` → `v1.3.4`, and the public line was renumbered from `1.0.0` when it shipped — which is why version numbers such as `v1.1.0`, `v1.1.1` and `v1.1.2` appear twice in this file, and why comments in the code still mention versions like `v1.2.0-multi` or `v1.3.3-multi`. Those refer to *this* series (marked "dev series" below), not to the releases above.

---

<details>
<summary><b>v1.3.4-multi (dev series)</b> — Admin side is now locked in</summary>

❌ Cancel and /cancel used to always drop straight to the regular main menu — even mid-admin-flow (composing a 📢 Broadcast, typing a 🚫 ban reason, a 🩺 Maintenance message, etc.), which bounced an admin clean out of 🛡️ Admin just for backing out of one sub-action. They now stay on the admin side and land back on the Dashboard instead. ❓ /help and 📜 /legal already worked correctly inside the admin side (they only ever add an inline-keyboard message, never touching the BBTB underneath), so no change was needed there.

The only way to actually leave the admin side for the regular one is now, explicitly, the button at the bottom of the Admin Dashboard's keyboard — same as before. /start is the one exception: it always resets all the way to default, admin lock-in included, regardless of what side of the bot you were on or mid-way through doing — one predictable full reset rather than another special case to keep in sync.

Also renamed that exit button: `⬆️ Back to Menu` and Bulk Select's shorter `⬆️ Menu` were two labels for the exact same destination and handler (the latter only existed because the former was too wide for Bulk Select's 3-button row). Standardized on the short one, `⬆️ Menu`, everywhere — one label, one handler, instead of two doing the same thing.

</details>

<details>
<summary><b>v1.3.3-multi (dev series)</b> — Every admin action down to exactly one entry point</summary>

Went looking for anything else with the same "reachable two ways" problem 🩺 Maintenance had, and found three more:
- ⚙️ **Global Config** was reachable from *three* places at once: the Dashboard's inline row (removed in v1.3.2), the Dashboard's own BBTB row (kept), **and** a fourth "⚙️ Global Config" button inside Fleet Stats' inline actions — that one's gone too now.
- 🔍 **Search** and 📢 **Broadcast** had the same split as Maintenance did: an inline button on the Dashboard AND a separate BBTB button on the 👥 Users screen, both firing the identical `admin.askSearch`/`admin.askBroadcast`. Dropped the Dashboard inline pair — Search and Broadcast now live only on Users' BBTB.
- The paginated 👥 Users list itself had its own extra inline "🔍 Search" row at the bottom of the user list, on top of that same screen's BBTB Search button. Removed the inline one.

The Admin Dashboard's inline row is down to just 🔄 Refresh now — the one action here with no BBTB equivalent, since it's a content refresh, not navigation. Every other admin feature has exactly one door.

</details>

<details>
<summary><b>v1.3.2-multi (dev series)</b> — 🩺 Maintenance down to a single entry point</summary>

Maintenance Mode was reachable from four different spots at once: an inline button on the Admin Dashboard, the Dashboard's own BBTB row, an inline button on Global Config, AND Global Config's own BBTB row — plus Maintenance's screen linked back to Config, which linked back to Maintenance. All of that's gone except one: the 🩺 Maint button on the Admin Dashboard's BBTB row is now the only way in. Global Config (inline menu and BBTB) is back to a plain nav-only hub with no Maintenance shortcut, and Maintenance's own BBTB dropped its reciprocal Config link too.

</details>

<details>
<summary><b>v1.3.1-multi (dev series)</b> — /help no longer surfaces Admin Dashboard</summary>

Removed the "🛡️ Admin Dashboard" entry from `/help` entirely, for every account, admin or not. It was correctly gated (only rendered/enterable when `config.ADMIN_IDS.includes(ctx.from.id)`), so nothing was ever actually reachable by a non-admin — but showing admin-only content inside a general-audience help screen at all, even to admins themselves, was the wrong call: admins already have a permanent, always-visible 🛡️ Admin button on the main BBTB menu, so this was pure duplication with no upside and an unnecessary "why is admin stuff in here" moment. `/help` is now strictly user-facing content for everyone who opens it.

Also confirmed (no code change needed — this was already correct as of v1.3.0-multi): `/help` and `/legal` are registered via `bot.telegram.setMyCommands()` in `src/index.js`, alongside `/start`, `/settings`, and `/cancel`, so they appear in Telegram's own command menu (the "/" popup / menu button), not just as auto-linked blue text in message bodies. `setMyCommands` only runs once per bot process boot — if a running deployment doesn't show the updated list yet, it needs a restart, and the Telegram client itself can take a moment to refresh its cached command list after that.

</details>

<details>
<summary><b>v1.3.0-multi (dev series)</b> — User/Admin privacy split, 🩺 Maintenance Mode, ❓ Legal & Help, and the admin BBTB redesign</summary>

**🔒 Settings privacy fix (the reason this release exists)**
`/settings` was showing every regular user genuine operational detail it had no business seeing: live PostgreSQL/Redis connection status, the hosting provider name, the Node.js version, and raw process memory. That block is gone from the user-facing screen — replaced with a 🎚️ **Your Limits** section showing what actually applies to *that* person (their own per-user override if one's set, otherwise the current global default), pulled from the existing `lib/limits.js`. The operational detail didn't disappear, it moved to where it always should have lived: the 🛡️ Admin Dashboard's 🖥️ System Health screen, which now also shows Node version and host (previously only in the now-removed user-facing block). The opt-in "System Alerts" notification preference stays, but no longer names which backend is having trouble to a non-admin — it's a generic "technical issue" heads-up now.

**🩺 Maintenance Mode (new, admin-only)**
A real fleet-wide maintenance switch — manual toggle **and** a UTC-based auto-ON/auto-OFF schedule, both backed by the same `maintenance_enabled` flag so there's never a separate "scheduled state" to drift out of sync with a manual override (`lib/maintenance.js`, layered on the existing `admin_config` cache from Global Config rather than standing up a second table). Non-admins get a friendly, admin-editable message and nothing else while it's ON; admins always pass straight through, both to actually run the bot during the window and so this can never lock an admin out the way a bad Ban/Suspend once could. A schedule-triggered toggle (no human admin behind it) is now audit-logged too — `admin_action_log.admin_id` had to be made nullable for that to be recorded honestly as "the schedule did this."

**📢 Broadcast no longer looks like spam**
Every broadcast used to get a forced the 📢 emoji prefix and go out as flat, unformatted plain text — fine for a short notice, bad for anything meant to read like a real announcement. It now sends with the admin's own message `entities` (bold/italic/links, exactly as typed in Telegram) and no added prefix. The compose flow's "preview" is now literally the real message, sent once as a preview and once for real, so what's approved is provably identical to what goes out — not a re-escaped approximation of it.

**❓ /help and 📜 /legal (new commands)**
- `/help` — a paginated feature explainer (Repos & Uploads, Automation, Search & Organize, Settings & Limits, Notifications, plus an Admin Dashboard page for admins), with ❓ FAQ and 📞 Contact Admin nested inside it. Contact Admin looks up the admin's *live* @username via `getChat()` (cached an hour) instead of a hardcoded value that would go stale the moment an admin renames themselves.
- `/legal` — an index of paginated sections (Terms, Privacy, GitHub Access & Permissions, Uploads & Data Storage, Acceptable Use, Disclaimer & Liability, Contact), each reachable directly from the index and steppable with Prev/Next. **Placeholder content, clearly marked DRAFT in-app** — written from what the bot actually does as of this version, not reviewed by a lawyer. Swap `SECTIONS[].body` in `handlers/legal.js` for real text whenever it's ready; the pagination structure doesn't need to change.
- Both are real slash commands (in `/start`'s own text and Telegram's command menu), deliberately *not* BBTB buttons — BBTB is reserved for frequent app navigation in this codebase's own design rule, and these are occasional reference lookups. No separate "FAQ" or "Contact" top-level command either; both are one tap inside `/help`.

**🛡️ Admin BBTB redesign — "go bigger"**
Every admin sub-screen now gets its own distinct, short-labeled BBTB row instead of five different screens all sharing one generic "⬆️ Back to Admin" keyboard: 👥 Users, 📊 Stats, 🗂️ Bulk, 📜 Audit, ⚙️ Config, and the new 🩺 Maint all get distinct rows off the Dashboard; Fleet Stats gets its own six shortcuts (🏆 Top / ⚠️ Errors / 📈 Growth / 🕵️ Anomaly / 🗓️ Jobs / 🖥️ Health); Bulk Actions gets its own six (🧹 Purge / ⏸️ Suspend / 🔇 Mute / 📣 Nudge / 📤 Export / 🗑️ Banned). User Detail's keyboard now actually adds 🎚️ Limits and 📜 History shortcuts scoped to `ctx.session.currentAdminTarget` — the same "currently open X" pattern My Repos already used for `ctx.session.currentRepo`. Fixed a pre-existing bug in the process: `bbtb.adminUserDetail` was fully defined but never once actually sent to a chat; the User Detail screen was silently showing whatever BBTB happened to already be on screen.

</details>

<details>
<summary><b>v1.2.0-multi (dev series)</b> — Admin Dashboard expansion, abuse-detection groundwork, and the held-back README items</summary>

**🛡️ Admin Dashboard — six new screens/actions**
- 🕵️ **Anomaly Feed** — fleet-wide surfacing of the anomaly detection that already existed per-user (`lib/accessLog.js`'s reconnect-after-disconnect / GitHub scope-change detection), now visible across everyone instead of buried per-account. This is the real substance behind the abuse-detection promise from earlier versions — folded into the 🚩 Suspicious filter too, so the two signals aren't siloed. Still rule-based heuristics, not genuine behavioral/ML analysis — stated plainly, not oversold.
- 🔓 **Access Log** (per-user) — the admin-facing view of a user's own connection history, one tap from their detail card.
- ⚙️ **Global Config** — live-editable default upload/rate-cap limits, no redeploy needed. Backed by a new `admin_config` table + a self-refreshing in-memory cache (`lib/globalConfig.js`) so this sits cheaply on the same hot path as every upload check.
- 📣 **Nudge Never-Connected** — a fixed, templated re-engagement message to accounts that signed up but never finished connecting GitHub.
- 📤 **Bulk Export All** — fleet-wide metadata export (counts and metadata only, same privacy boundary as everywhere else in the Dashboard).
- 🗓️ **Scheduled Jobs Overview** — visibility into everyone's pending/recently-failed scheduled uploads and repo creates, for support without needing to ask first.

**📋 Repo Templates**
A small curated set of starter file sets (Node.js, Python, Static HTML) on New Repo's confirm screen, committed via the same multi-file commit API every upload already uses. Works for both immediate and scheduled repo creation.

**📄 README MarkdownV2 rendering**
`.md` file previews now render actual formatting (headers as bold, real bold/italic, tappable links, list bullets) instead of dumping the raw `# Heading` / `**bold**` syntax into a code block. Implemented as a careful token-based converter (`lib/markdownRender.js`) — recognized syntax is pulled into placeholder tokens before anything gets escaped, so nothing recognized can leak through unescaped by accident.

**⚡ Unified Quick Access panel**
Pinned, Recently Viewed, and Search History — previously three separate, scattered surfaces — merged into one glance-able screen, reachable from My Repos. Doesn't replace any of the originals; 📌 Manage Pins still opens the full pin-management screen.

**🔍 Line-level diff preview**
`replaceFolder` uploads now show real `+added/−removed` line counts for modified files (not just a byte-size delta), with a "🔍 View Diff" option showing a sample of the actual changed lines. Best-effort and capped — binary files and anything over 600 lines per file fall back to the size-only comparison, never a hard failure.

**♻️ Resumable zip uploads across a restart**
The single biggest architecture change in this release. File buffers during the Upload wizard used to live in-process memory only — a deliberate trade-off documented directly in the code, accepted because "a rare mid-flow restart losing one in-progress upload is far cheaper than every normal upload straining memory." Revisited on request: `lib/fileBufferCache.js` now write-through/read-through caches to Redis (base64-encoded, same TTL as before, capped at config's existing 15MB-per-upload uncompressed limit) in addition to the in-process Map, so a restart mid-upload no longer loses the person's progress. Touched 11 call sites across `uploadFile.js` converting synchronous cache calls to async.

**📂 Large-repo tree handling**
`getRawTree()`/`getTree()`/`getTreeStats()` now detect GitHub's own truncation flag on oversized repos, plus a defensive 20,000-entry hard cap independent of that — previously silently ignored, meaning a huge repo's file listing could look complete when it quietly wasn't. Surfaced with a warning note in both Repo View and Browse Files. (Per-screen pagination for large folder listings already existed — this was specifically about the underlying fetch never flagging incompleteness.)

**📝 Structured logging**
`lib/logger.js` is now backed by `pino` instead of a hand-rolled formatter — same `info/warn/error(message, meta)` call signature everywhere else in the codebase, so no other file needed to change.

**Smaller fixes bundled in**
- The Octokit client cache size limit and tree-etag cache limit both raised further as real multi-user traffic patterns became clearer.
- A stale single-owner comment in `github.js` finally updated.
- Caught and fixed three bugs in my own new code before they shipped this round: a wizard-step double-advance bug in the Repo Templates confirm flow, a dropped `escapeMd()` on a filename in the new README-rendering code, and an inconsistent `require()` pattern in Nudge Never-Connected that the codebase's own require-scope checker (`scripts/check-patterns.js`) correctly flagged.

</details>

<details>
<summary><b>v1.1.2-multi (dev series)</b> — MarkdownV2 escaping bugs in the Admin Dashboard</summary>

Two real, user-reported crashes when opening a user's detail card or the Set Limits screen — both "400: Bad Request: can't parse entities" from Telegram, both my mistake, both fixed:

- `⏳ Rate-limit hits:` had a literal, unescaped hyphen typed directly into the label — every other piece of dynamic text on that screen went through the proper escaping helper, but this one static string was typed by hand and missed it.
- `format.formatBytes()` (e.g. "1.0 MB") produces a literal decimal point via `.toFixed(1)`, and three call sites in the new Admin Dashboard code — the User Detail card's Limits line, and both lines of the Set Limits screen — used its output directly instead of wrapping it in `format.escapeMd()` first, which is the established pattern the rest of the codebase (`repoView.js`, `myRepos.js`, `browseFiles.js`) already follows correctly for this exact function.

Both fixed, plus a full manual re-sweep of every hyphen and period across all MarkdownV2 screens in `handlers/admin.js` to check for anything similar.

</details>

<details>
<summary><b>v1.1.1-multi (dev series)</b> — Admin Dashboard hardening & expansion</summary>

**🛡️ Admin Dashboard, expanded**
- 🗂️ **Bulk Actions** is now a real hub instead of a standalone Purge button: 🧹 Purge Never-Connected (7d / 30d / 90d / **Never** — no age filter at all), ⏸️ Bulk Suspend (pause a filtered group at once for maintenance), 🔇 Bulk Mute (fleet-wide notification pause/resume), 🗑️ Bulk Delete Banned (permanently clean out already-banned accounts — can only ever touch accounts already banned, never a live one).
- 🔍 **Search** — by Telegram ID, @username, or GitHub username, backed by a real `pg_trgm` + GIN index so it stays fast as the user base grows.
- 🖥️ **System Health** — live Postgres/Redis status right in the Dashboard, sharing the exact same check as the `/health` HTTP route (extracted to `lib/healthCheck.js` so the two can't drift apart), plus memory and uptime.
- 📈 **Growth** — a 14-day signups-per-day bar chart.
- 📜 **Audit Log** is now actually viewable — every admin action was already being written to `admin_action_log`, but there was no screen to read it back. Fixed, fleet-wide and per-user (a "History" tab on each user's detail card).
- 🎚️ **Set Limits** — a real preset menu (1/5/20MB zip, 1/5/20MB file, 50/200/unlimited hourly actions, or Clear) per user. The database columns and enforcement existed already; there was simply no UI to use them.
- 🚫 **Ban** now prompts for a typed reason first (Skip allowed), logged to the Audit Log.
- 🚩 **Suspicious filter** — a 6th Users filter plus a new persisted `rate_limit_hits` counter, flagging accounts that repeatedly hit their hourly action cap or show heavy bot interaction with zero GitHub connection ever made. Worth being precise about what this is: **basic rule-based heuristics, not real spam/abuse detection** — that bigger item is still tracked separately below.
- The whole Dashboard was redesigned to fit exactly 3 BBTB rows (Users / Fleet Stats / Bulk Actions / Audit Log / Back to Menu), with everything else — Search, Broadcast, Leaderboards, Error Feed, System Health, Growth — reached via inline buttons on the relevant screen instead.
- Small: the Dashboard header shows which admin is logged in (and how many total admins exist, if more than one); the per-user detail card shows account age and rate-limit-hit count.

**Multi-admin support**
`ADMIN_ID` → `ADMIN_IDS` (comma-separated Telegram IDs), so more than one person can hold admin access. Fully backward-compatible with the single-value `ADMIN_ID`/`OWNER_ID` — nothing to change if you only ever want one admin.

**Admin self-lockout fix**
Nothing originally stopped an admin from banning, suspending, or deleting their own account through the Dashboard — and this happened for real during testing. Fixed at two independent layers: `lib/users.js`'s `ensureUser` now self-heals (an admin ID's ban/suspend flags clear automatically the next time they message the bot at all, no manual DB fix needed), and `middleware/accessControl.js` separately bypasses the block/suspend check for every admin ID regardless of what the database says. On top of that, Ban/Suspend/Delete are now structurally unavailable against ANY admin account — hidden from the UI, refused server-side, and excluded from every bulk operation at the SQL level.

**Other fixes**
- The "Return to Telegram" link/button shown right after connecting GitHub was hardcoded to `https://t.me/GitroHubBot` — the original author's bot username, not a value derived from your own deployment. Every fork or rename would silently send people back to the WRONG bot after connecting. Added a new **required** `BOT_USERNAME` env var (just your bot's @username).

**🚧 Known limitation, deferred to the next update:** there is currently no real spam/abuse detection beyond the basic 🚩 Suspicious heuristic above. Tracked for v1.2.0-multi.

</details>

<details>
<summary><b>v1.1.0-multi (dev series)</b> — Open multi-user access + Admin Dashboard</summary>

The single biggest architectural shift since launch: GitroHub is no longer a private, owner-only bot. Anyone can now `/start` it and connect their own GitHub account, freely, with no approval step. The person named by `ADMIN_ID` (renamed from `OWNER_ID`, which still works as a fallback) is a normal user themselves, plus the only one who sees the new 🛡️ Admin button.

**Open access**
- `middleware/ownerGate.js` → `middleware/accessControl.js`: anyone messaging the bot gets an account on first contact. No approval, no waitlist.
- Banned or currently-suspended users are still silently ignored — no reply, no log spam, no downstream processing of any kind.

**🛡️ Admin Dashboard** — third row on the Main Menu, admin-only, a genuinely separate side of the bot:
- 👥 **Users** — filterable (all / banned / suspended / connected / never-connected), paginated list; tap into any user for their detail card.
- Per-user detail: commit count, live GitHub API budget remaining, total actions ("clicks"), last-active time, error count. Counts and metadata only — **never** repo contents, file paths, or commit messages.
- 🚫 **Ban** (revokes their GitHub token + tears down any webhooks GitroHub created, same teardown Disconnect uses) / ✅ **Unban**
- ⏸️ **Suspend** (24h or 7d, auto-expires, does NOT touch their GitHub connection) / ▶️ **Unsuspend**
- ⭐ **Trust badge** (scaffolding for future tiered features)
- 📤 **Export** a user's data and 🗑️ **Delete** their account permanently
- 📊 **Fleet Stats**, 🏆 **Leaderboards**, ⚠️ **Global Error Feed**, 📢 **Broadcast**, 🧹 **Bulk Purge**
- Every admin action written to a new `admin_action_log` audit table.

**Concurrency fixes that open access made necessary**
- The per-process update queue was one shared chain for every Telegram update from anyone — correct only under a single owner. Now keyed per-user.
- GitHub rate-limit tracking was a single shared module-level variable. Now keyed per-token.
- The GitHub webhook receiver matched inbound events by repo name alone — two different users' GitHub accounts can have identically-named repos. Now matches repo name + owner login.
- The Octokit client cache was capped at 3 entries ("a single-owner bot only ever has one token"). Raised to 50.

</details>

<details>
<summary><b>v0.1.0 (dev series)</b> — Initial release</summary>

The first release of GitroHub: a private, owner-only Telegram bot for managing your GitHub account end-to-end from a phone.

**Core**
- Owner-only gate — the bot responds to exactly one Telegram ID (`OWNER_ID`); everyone else is silently ignored, with zero processing and zero log noise.
- GitHub OAuth connect flow with a signed-JWT `state` parameter (binds the callback to the right Telegram chat) and an animated HTML confirmation page (particle background, circuit-line animation, live status feed, countdown auto-redirect back into Telegram).
- Access tokens encrypted at rest with AES-256-GCM, `repo`-scope only.
- One Node process running both the Telegraf bot (webhook or long-polling) and a small Express server for `/callback` and `/webhook/github`.

**Repos**
- Create, rename, delete, and toggle visibility.
- List with filter, sort, and fuzzy + weighted search (name, description, recency, star count).
- Fork any public repo; star/unstar from Search's external-repo screen.
- Clone URL shown in all three variants — HTTPS, SSH, `gh repo clone` — each tap-to-copy.
- Repo View: description, license, last 3 commits, README preview or full-file send, health flag, "last synced" size timestamp, Open in Browser.
- A repo rename cascades its tags, pin position, upload-path memory, mute state, and live webhook registration onto the new name in one transactional step.

**Files**
- Full tree navigation (Browse Files), view/send/edit/delete any file.
- Upload a single file or a `.zip` (auto-strips the GitHub-style wrapper folder), with 🆕 New / ✏️ Modified / ➖ Unchanged detection before committing.
- Batch Upload — collect several loose files into one combined commit and summary.
- Replace — swap a single file's content by sending a new one, or fully sync a folder (add/update/delete) with an explicit delete preview before committing.
- Upload Here — upload straight into the folder you're currently browsing, path pre-filled.
- Download any of your repos, or any public external repo pasted as a link.

**Organization**
- Pinned Repos, grouped into named sections, with drag-style reorder scoped per section.
- Tags — nested (e.g. "Work" → "Work/Client-A"), a fixed 6-color palette, optional auto-rules (language match, name pattern), and per-tag defaults for visibility/upload-path/commit-message.
- Smart Folders — save a composable filter (visibility + language + staleness + tag + name) as a named quick-access view.
- Recently Viewed and Search History, each clearable independently.

**Bulk actions**
- Multi-select with a composable filter builder (clauses stack — e.g. private AND stale-90d AND tagged "side-project"), plus a "Save as Smart Folder" shortcut.
- Delete, change visibility, or download in one pass, with live progress and honest per-item failure reporting.
- Retry Failed Only after a partial failure.
- Undo for bulk visibility changes — up to 5 actions held at once, each independently reversible for an hour. (Delete and rename are excluded — delete is permanent on GitHub's side, and rename is collision-prone, so neither is a safe undo candidate.)

**Notifications**
- A real GitHub webhook receiver (`/webhook/github`, HMAC-verified per repo) driving push/issues/PR/release/CI (`workflow_run`, terminal state only)/deployment-status alerts.
- Rapid-fire events digest into one message instead of several, via a durable Redis-backed buffer that survives a bot restart mid-window.
- Per-repo mute, independent of the global notification toggles.
- Optional quiet-hours window that holds digests rather than delivering them immediately.
- Optional daily/weekly rollup summary ("3 repos touched, 12 changes via bot, 2 pushes received").

**Settings & visibility into the bot itself**
- Live Postgres/Redis health, GitHub rate-limit budget (color-coded, read passively off headers already present on outgoing calls — no extra request spent), memory/uptime, bot version.
- Activity Log, filterable to errors-only.
- Access Log — connection history with rules-based anomaly flags (reconnect shortly after a disconnect; GitHub scope changed between sessions).
- My Defaults — saved visibility/commit-message/upload-path/sort/filter, a "learn from me" nudge when your actual usage diverges from the current default, and an old→new changelog of every default change.
- Storage & Data — see exactly what GitroHub remembers about you, clear it granularly or fully (typed confirmation required), export it, and auto-cleanup of old activity.
- Rolling 30-day size history per repo, shown as a text sparkline alongside the current prior-vs-now delta.
- `GET /health` — `200`/`ok` or `503`/`degraded` based on live Postgres + Redis reachability, meant for Railway's health check to catch a degraded instance proactively.

**Under the hood**
- GitHub API layer: passive rate-limit tracking, adaptive retry backoff that widens under a low budget, request coalescing for duplicate in-flight reads, and an ETag-conditional cache on the (expensive, frequently-hit) recursive tree fetch so an unchanged tree costs nothing against the rate limit.
- Memory-hardened for Railway's 512MB free tier: a V8 heap ceiling via `NODE_OPTIONS=--max-old-space-size=384`, a self-imposed RSS watchdog that shuts down cleanly before the kernel force-kills the process, and upload file bytes kept in a short-lived in-process cache instead of round-tripping through Redis session state.
- Telegram updates processed one at a time with pending updates dropped on boot, so a restart can't trigger a delivery burst.
- Postgres pool capped at `PG_POOL_MAX` (default 3) and GitHub API clients cached per token.
- `migrate.js` runs `schema.sql` on every boot using `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` throughout, so the schema is always current without any manual step.

</details>
