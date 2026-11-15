const format = require('../lib/format');
const inline = require('../keyboards/inline');
const { safeEditMessageText } = require('../lib/safeEdit');
const adminInfo = require('../lib/adminInfo');
const users = require('../lib/users');
const oauth = require('../lib/oauth');
const nav = require('../lib/nav');

/**
 * /help — updated for v2.0.0-multi (2×2 Home bar: My Repos, Workspace, Settings, Notifications).
 *
 * One command with everything nested inside it: feature topics, an FAQ, Contact Admin and
 * the legal documents. Every topic is plain text (headings, paragraphs, bullet lists) in
 * the TOPICS / FAQ data below; render() turns it into Telegram MarkdownV2 (escaping every
 * special character for you) and paginate() splits anything longer than one message into
 * numbered pages. A test (scripts/v123-tests.js) fails if a page is too long or contains
 * unescaped text, so editing Help never means hand-escaping punctuation.
 *
 * The one exception to the static topics is 🔗 Account Connection, whose text and button
 * depend on whether the viewer is already connected (see showConnectTopic).
 */

const PAGE_LIMIT = 1500; // rendered characters per message — Telegram's hard limit is 4096

const h = (text) => ({ h: text });
const p = (text) => ({ p: text });
const ul = (...items) => ({ ul: items });

// ── Topics ───────────────────────────────────────────────────────────────────
const TOPICS = {
  start: {
    title: '🚀 Getting Started',
    blocks: [
      p('GitroHub lets you manage your GitHub repositories from Telegram. The bar at the bottom of the chat is your map: 📁 My Repos, 💼 Workspace, ⚙️ Settings and 🔔 Notifications on Home, and a ⬅️ Back button on every other page that returns to where you came from. Buttons under a message do things on that screen.'),
      h('First steps'),
      ul(
        'Tap 🔗 Connect GitHub Account on the welcome message. GitHub\u2019s own login page opens — you never type a GitHub password into this chat.',
        '📁 My Repos lists your repos (the ones you own). Tap one to open it.',
        '➕ New Repo (inside 📁 My Repos, or the /new command) walks you through creating a repo: name, description, visibility, licence, .gitignore and an optional starter template. You can create it now or schedule it for later.',
        '💼 Workspace → 🔍 Search finds one of your repos by name, searches code, or looks up any public GitHub repo from a link.',
        '💼 Workspace → ⚙️ Settings holds your accounts, automation, preferences, history, data and help — and 🚪 Disconnect.'
      ),
      h('Handy commands'),
      ul('/start — Main Menu', '/help — this guide', '/legal — Terms and Privacy', '/settings — Settings (also on the Home bar)', '/report — tell the admins about a problem', '/cancel — back out of whatever you were typing', '/reset — Full Reset of your saved data (asks you to confirm)', '/repos and /new also work if you type them.'),
      p('Stuck mid-way? Send /cancel or tap ❌ Cancel. Nothing you were in the middle of is saved until you confirm it.'),
    ],
  },
  repos: {
    title: '📁 Repos & Uploads',
    blocks: [
      h('Opening a repo'),
      p('Tap a repo in 📁 My Repos. You\u2019ll see its description, size, language, visibility and tags, and buttons for ⬆️ Upload, 📁 Browse Files, ⬇️ Download Repo, 🔒 Visibility, ⚖️ License, tags, pinning, live alerts, renaming and deleting.'),
      h('Uploading'),
      ul(
        'Send one or more files, or a ZIP, then choose where they go: browse to a folder, the repo root, your default folder (or the folder your tags suggest), or one you\u2019ve been using a lot.',
        'Before anything is committed you see exactly what will happen: 🆕 New, ✏️ Modified (with a line-by-line preview for text files) or ➖ Unchanged for every file. Nothing is written until you tap ✅ Commit.',
        'A ZIP is unpacked safely (junk files are skipped, and strict size and file-count caps apply). 🔁 Replace Folder syncs a folder with an upload: it adds, updates and — after showing you the list — removes files that are no longer in the upload.',
        'Uploads keep an executable file\u2019s permission when you overwrite it, and are one atomic commit. Your ⚙️ My Defaults commit message is used, with {filename}, {repo}, {date} and {count} filled in.',
        'You can schedule an upload for later instead of committing now.'
      ),
      h('Other repo actions'),
      ul(
        '🔒 Visibility switches public/private after a confirmation. The button names the state it sets, so tapping twice can\u2019t flip it back.',
        '⚖️ License adds or replaces a licence file. ✏️ Rename updates your tags, pins, alerts and pending schedules for you.',
        '⬇️ Download Repo sends the default branch as a ZIP (up to 50 MB — Telegram\u2019s limit for files a bot can send).',
        '🗑 Delete Repo makes a backup first (see 🗑️ Trash & Restore).'
      ),
      p('📁 My Repos lists repos owned by the account you are viewing: you, or an organisation you picked in 💼 Workspace → Organisations. Repos you merely collaborate on are not shown. For pull requests, issues, branches, releases, CI and more, tap ⚡ Manage inside a repo.'),
    ],
  },
  files: {
    title: '📂 Browse, Edit & Download Files',
    blocks: [
      p('📁 Browse Files walks a repo\u2019s folders. Tap a file to preview it.'),
      ul(
        'Text files show inline; images show as photos (up to 10 MB). Anything else, or anything too long to preview, can be sent with Send as File — any size up to 50 MB.',
        '✏️ Edit works for plain-text files: send the full new content as a message (up to 4096 characters), or upload the new version as a file for anything longer. You see a +/− preview before committing, and the file\u2019s line endings and final newline are kept. Use 🔁 Replace for binary files.',
        'If the file changes on GitHub while you\u2019re editing, the commit is refused instead of overwriting the newer version.',
        '🗑 Delete File asks you to confirm, then commits the deletion.',
        '🔍 Search Files finds a file by name inside the repo; ⬆️ Upload Here uploads straight into the folder you\u2019re looking at.'
      ),
      p('Very large repositories may be too big for GitHub to list in full; if so, Browse and the upload preview say so rather than silently showing a partial picture.'),
    ],
  },
  search: {
    title: '🔍 Search & Organize',
    blocks: [
      h('Finding repos'),
      ul(
        '🔍 Search Repo matches on name, description and more, and understands typos. Paste a github.com link to look up any public repo: you can download it as a ZIP or fork it to your account.',
        '🔎 Filter (in My Repos) narrows by language, tag, visibility or forks; ↕️ Sort orders by recently updated, name, stars, created or language. Save a combination as a Smart Folder to reuse it.',
        '⚡ Quick Access merges your pinned repos, recently viewed repos and search history in one place.'
      ),
      h('Pins and sections'),
      p('⭐ Pinned keeps your favourites at the top. Use ⬆️ ⬇️ to reorder inside a group and 📂 to move a repo into a named section (or create a new one). Sections group the Pinned screen; a repo with no section sits in the plain "Pinned" group.'),
      h('Tags'),
      ul(
        'Add tags from a repo\u2019s 🏷️ Tags screen. A tag has an emoji, an optional colour (shown as a coloured dot) and can be nested under another tag — filtering by a parent also finds repos with any of its sub-tags.',
        '⚙️ Manage All Tags (on the Tags screen) is where you change a tag\u2019s colour, nest it, delete it, or set Defaults For This Tag: a visibility, upload folder or commit message used for repos carrying that tag instead of your global defaults.',
        'Typing the name of a tag that already exists simply reuses it; it never overwrites its emoji, colour or nesting.'
      ),
    ],
  },
  bulk: {
    title: '🧹 Bulk Actions',
    blocks: [
      p('🧹 Bulk Select (in My Repos) lets you tick many repos — one by one, by tag, by filter, or all stale ones — and act on them together.'),
      ul(
        'Actions: 🗑 Delete All, 🔒 Make All Private, 🌐 Make All Public, ⬇️ Download All as Zips.',
        'Up to 100 repos per run. The confirmation lists them before anything happens.',
        'Bulk Delete does what a single delete does: it sends you a ZIP backup of each repo and stores it in 🗑️ Trash first, and it does NOT delete a repo it couldn\u2019t back up.',
        'Progress updates live; the summary lists what succeeded and what failed (with a plain reason). Failed items get a 🔁 Retry button.',
        'Visibility changes can be reversed: ↩️ Recent Changes (Undo) shows your last five bulk visibility changes, each undoable for an hour. Deleting cannot be undone — restore from Trash instead.'
      ),
      p('Every bulk run is written to your 📜 Activity like any other action.'),
    ],
  },
  trash: {
    title: '🗑️ Trash & Restore',
    blocks: [
      p('When you delete a repo through the bot, GitroHub downloads GitHub\u2019s ZIP of the default branch, sends it to your chat and keeps a reference in 🗑️ Trash (open it from Settings → Data & Trash).'),
      ul(
        'How long: 30 days by default; choose another period, or "Never", in ⚙️ My Defaults → Trash retention.',
        '♻️ Restore recreates the repo and commits the files. You can ✏️ Edit the name and description first. The backup is read and checked before anything is created on GitHub, and if a restore fails afterwards, the empty repo it just created is removed again — so you can simply retry.',
        'What a restore brings back: files, description, visibility. What it doesn\u2019t: commit history, issues, stars, webhooks, topics, and your tags and pins for it.',
        'Backups over 20 MB are marked 📦 ZIP only: you can download them again, but Telegram doesn\u2019t let a bot read them back, so they can\u2019t be restored in place. Over 50 MB a backup can\u2019t be made, so the repo is not deleted through the bot.',
        '⬇️ ZIP re-sends a backup; 🗑 Delete Forever removes the entry (and its stored reference) immediately.'
      ),
      p('Repos deleted directly on GitHub, or by an administrator, don\u2019t go through Trash.'),
    ],
  },
  automation: {
    title: '🤖 Automation',
    blocks: [
      p('⚙️ Settings → 🤖 Automation has three parts: 🔧 Rules, 📅 Schedule and ⚙️ Defaults.'),
      h('Rules'),
      ul(
        'Auto-Tag assigns a tag to repos that match a rule, Auto-Mute silences live alerts for matching repos, and Auto-Backup includes matching repos in a weekly ZIP backup.',
        'A rule matches on language, a name pattern (use * as a wildcard, e.g. api-*), visibility, or fork status. Patterns are limited to 100 characters and 8 wildcards.',
        '▶️ Run Rules Now applies them immediately.'
      ),
      h('Schedule'),
      ul(
        '📅 Scheduled Repos create a repo at a time you pick (set your timezone first). Scheduled Uploads commit files at a time you pick. You get a message when each one runs or fails, with a plain reason.',
        'If the bot restarts while a scheduled repo is being created, it finishes the job instead of failing with "already exists".'
      ),
      h('Weekly routines'),
      p('If you turn them on: a Monday-morning backup of your Auto-Backup repos, and a nudge about repos nobody has committed to in a long time. They arrive around 9 am in your timezone, and never inside your Quiet Hours — if your quiet hours cover that time they wait until the window ends the same day.'),
    ],
  },
  notifications: {
    title: '🔔 Notifications',
    blocks: [
      p('Open it from ⚙️ Settings → 🤖 Automation → ⚙️ Defaults (My Defaults) → 🔔 Notifications.'),
      h('Five on/off alert types'),
      ul(
        'GitHub activity — live alerts from your repos',
        'System alerts — maintenance notices and brief technical issues',
        'Long operations — a ping when a big bulk or batch job finishes (3+ items)',
        'Token health — a heads-up if GitHub stops accepting your connection',
        'Stale nudges — the weekly reminder about quiet repos'
      ),
      h('Live alerts'),
      p('Tap 🔔 Enable Live Alerts on a repo and GitHub sends its events to the bot. Events are combined into one short digest per repo (about two minutes after the first one), e.g. "3× 1 new commit pushed → my-repo". If more events arrive than can be shown at once, the digest says how many were left out. 🔕 Mute silences one repo; muted repos stay muted until you unmute them.'),
      h('Rollups and quiet hours'),
      ul(
        '🧾 Rollup digests are an optional daily or weekly summary — repos touched, changes made through the bot, pushes received — cycled off / daily / weekly with one tap.',
        '🌙 Quiet Hours is a window in your own timezone (it may wrap past midnight). Live-alert digests, rollups, nudges and weekly backups are held until it ends instead of arriving in the middle of the night.'
      ),
      p('Disconnecting removes your live-alert webhooks from GitHub. If you ever see alerts for a repo you didn\u2019t enable, mute it and tell an admin.'),
    ],
  },
  settings: {
    title: '⚙️ Settings, Defaults & Limits',
    blocks: [
      h('Settings'),
      p('⚙️ Settings shows your connected GitHub account and its permissions, your GitHub rate-limit status, your last activity, and your notification summary. Settings is on the Home bar: 👤 Accounts & access, 🤖 Automation, 🎛️ Preferences, 📜 History, 📦 Data & Trash and ❓ Help & support.'),
      h('⚙️ My Defaults (Settings → 🤖 Automation → ⚙️ Defaults)'),
      ul(
        'Visibility for new repos, the default commit message (with {filename}, {repo}, {date}, {count}), the default upload folder, repo sort and filter, trash retention and more.',
        'Learn from me: after you repeat a choice enough times the bot offers to make it your default — one tap to accept or decline. Choose Off to stop the suggestions.',
        '📜 Change History lists the last changes to your defaults: what changed, from what, to what, and whether it was you, an import or a suggestion.',
        'Per-tag overrides live in 🏷️ Manage All Tags.'
      ),
      h('🎚️ Your Limits'),
      p('Shows your current size limits for uploads and your hourly action allowance. The limits protect the service for everyone; an admin can raise them for you if you need more.'),
      h('Disconnect'),
      p('🚪 Disconnect removes the active GitHub account (if you connected several, the next one takes over) — its live alerts GitroHub added to your repos, revokes GitroHub\u2019s access token on GitHub and deletes the stored copy. It never deletes or changes your repos. If your saved connection ever becomes unreadable, the bot simply asks you to reconnect.'),
    ],
  },
  manage: {
    title: '⚡ Manage a Repo',
    blocks: [
      p('Open a repo and tap ⚡ Manage for the tools that go beyond files. Every screen is paged and every risky action asks you to confirm first.'),
      h('🔀 Pull requests'),
      ul('List open or closed, read a PR, its files and comments.', 'Merge with a merge commit, squash or rebase; close or reopen; approve, request changes or comment; update the branch.', '➕ New from a branch opens a PR from any branch that is ahead of the default branch.'),
      h('🐞 Issues & 🎯 Milestones'),
      ul('Create issues, comment, close (completed or not planned) and reopen.', 'Add or remove labels, assign people, set a milestone. Milestones can be created, closed, reopened and deleted.'),
      h('🌿 Branches'),
      ul('Create, rename, delete and make a branch the default. 📍 Work on this branch makes Browse, Upload and Edit use that branch instead of the default one (shown as 🌿 in the file list).', '🔒 Protection rules: require reviews, block force pushes and deletion, and more — changing one rule never resets the others. Private repos need a paid GitHub plan for this.', '🔄 On a fork, sync with upstream (fast-forward only — conflicts are reported, nothing is forced).'),
      h('📜 Commits'),
      ul('Browse history per branch, read a commit and each file’s diff.', '↩️ Revert adds a new commit that undoes one commit. If any of its files changed since, nothing is touched and you see which ones. Merge commits and commits over 60 files are refused.'),
      h('🚀 Releases & tags'),
      ul('Create releases (with notes you write or GitHub generates), edit title/notes, mark draft or pre-release, delete (optionally the tag too).', 'Create and delete tags.'),
      h('⚙️ Actions / CI'),
      ul('See runs, jobs and which step failed; re-run everything or only failed jobs; cancel a run.', 'Start a workflow by hand (it needs on: workflow_dispatch), enable or disable workflows.', '🔐 Secrets are encrypted before they leave the bot and can’t be read back; I delete the message you typed the value in. 📦 Variables are plain text.'),
      h('🔑 Access'),
      ul('Collaborators: invite, change permission (Read, Triage, Write, Maintain, Admin), remove, cancel an invitation.', 'Deploy keys (public SSH keys only — a private key is refused), topics, and transferring the repo to another user or organisation.'),
      h('🛡️ Security & 📊 Insights'),
      ul('Dependabot, code scanning and secret scanning alerts, and Dependabot alerts on/off. Dismiss a Dependabot alert with a reason.', 'Stars, forks, size, contributors, a 52-week commit chart and 14-day traffic (traffic needs push access).'),
      h('⏪ Undo & Restore'),
      ul('Recent changes lists what the bot changed for you (commits, reverts, deleted branches and releases), each with an Undo when it is safe.', 'Go back to an earlier version of one file (type its path), revert a merged PR, or put a deleted branch or tag back.', 'Roll a whole branch back to an earlier commit: a backup branch is made first, protected branches are refused, and nothing is forced unless the history allows it.', 'If an undo would clash with newer changes you choose: stop, keep mine or keep theirs, and the bot says which files are affected.'),
      p('An admin can switch any of these areas off; a switched-off area simply disappears.'),
    ],
  },
  workspace: {
    title: '💼 Workspace',
    blocks: [
      p('💼 Workspace holds tools for your whole GitHub account, not one repo. Tiles marked 🔒 need one more GitHub permission — tap to grant it.'),
      ul(
        '📝 Gists: list, read, create from pasted text or a file, edit the description, delete. Needs one extra GitHub permission (gist).',
        '🌐 Search GitHub: code (in your repos or all of GitHub with a filter such as language:js), or any public repo.',
        '🧯 Restore center: one timeline of what you can undo or bring back — repo changes, Trash, bulk visibility changes, settings and defaults, and tags, rules, schedules, pins and saved views removed in the last 30 days.',
        '📋 Projects: browse GitHub Projects boards and add draft items. Needs the project permission.',
        '🏢 Organisations: pick whose repos 📁 My Repos, ➕ New Repo and ⚡ Manage use — you or one of your organisations. Repos never mix. Needs read:org.',
        '🔔 Notifications (Home bar): Inbox, 🔀 Pull requests, 🐞 Issues and ❌ Failing checks, with counts only when something needs you. The bar also has ✅ Mark all read and 🔕 Alert settings (alert types, live alerts, quiet hours, daily summary).',
        '⚙️ Settings (Home bar): 👤 Accounts & access (connect up to 5 GitHub accounts, switch, disconnect, permissions), 🤖 Automation, 🎛️ Preferences (defaults, timezone), 📜 History (activity, 🛡️ safety log of sensitive actions, sign-ins), 📦 Data & Trash, 📊 Status & usage and ❓ Help & support. Admins also get 🛡️ Admin here: 📥 Attention, 👥 People, 🛰️ Watch, 📢 Broadcast and 🛠️ System.'
      ),
      h('Extra permissions'),
      p('Features that need more than the base permission show one button to grant it. GitHub keeps what you approved before, and nothing changes until you approve. Notifications, Actions, secrets, protection and security alerts need no extra permission.'),
      h('Several accounts'),
      p('Everything works on the active account. 🚪 Disconnect removes only the active one and switches to the next. Tags, pins, schedules and live alerts are saved by repo name, so two accounts (or an organisation) with a repo of the same name share them — live alerts refuse to be enabled twice for one name.'),
    ],
  },
  storage: {
    title: '📦 Storage, Export & Privacy',
    blocks: [
      p('⚙️ Settings → 📦 Data & Trash shows how much the bot keeps for you and lets you manage it.'),
      ul(
        '📤 Export gives you a file of your settings and data. 💾 Export / Import can also bring settings back into this account: tags (existing tags keep their emoji, colour and nesting unless the file sets them), per-tag defaults, rules, pins, defaults, notification preferences, scheduled repos and Trash entries. Anything invalid in a file is skipped and counted, never half-applied, and importing the same file twice doesn\u2019t duplicate things.',
        'Clear options: activity history, pins, tags, defaults, Quick Access (recently viewed and search history) — each separately. 🗑 Everything (Full Reset) clears pins, tags (with colours, nesting and defaults), defaults, activity history, automation rules and remembered upload folders; type RESET to confirm. It does NOT touch your GitHub connection, your Trash, or anything you have scheduled.',
        'Activity retention is your choice: 30 days, 90 days (default), 1 year or forever.'
      ),
      h('What is stored, and for how long'),
      p('See 📜 Legal → Privacy for the full list. In short: your token is encrypted, repo contents are never stored, and Delete account (ask an admin) removes everything the bot holds about you.'),
    ],
  },
  safety: {
    title: '🛡️ Safety, Limits & Reports',
    blocks: [
      ul(
        'Hourly action limit: the bot allows a number of actions per hour per account. If you hit it you\u2019ll be told when it resets.',
        'Size limits apply to uploads and archives (zips are inspected safely and capped); see 🎚️ Your Limits.',
        'Warden: a monitoring feature that watches for unusual activity so admins can look into abuse or a compromised account. It only observes — it never bans or restricts anyone on its own — and you may receive a plain-language notice if your pattern looks unusual. Details are in 📜 Legal → Monitoring.',
        'Warden Watch: sensitive actions (transfer, delete, access changes, forced rollbacks) are noted. A burst of them can alert admins, and the Owner may require approval for a few of them. Admins can pause one feature for one account; you are told what is paused and why.',
        'Admins can warn, suspend or ban accounts that abuse the service; they cannot see your GitHub token.',
        '/report (or 📞 Contact Admin → 🚩 Report a Problem) sends a message to the admins. You can send one report a minute and have up to five waiting at a time.'
      ),
      p('If your Telegram or GitHub account may be compromised: 🚪 Disconnect here, then revoke GitroHub at github.com/settings/applications.'),
    ],
  },
};
const TOPIC_ORDER = ['start', 'connect', 'repos', 'files', 'manage', 'workspace', 'search', 'bulk', 'trash', 'automation', 'notifications', 'settings', 'storage', 'safety'];

// ── Connect topic (text depends on the viewer) ───────────────────────────────
const CONNECT_TITLE = '🔗 Account Connection & Two-Factor Authentication';
const CONNECT_DISCONNECTED = [
  p('Tap 🔗 Connect GitHub Account below — that opens GitHub\u2019s own login page, not a form inside this chat. GitroHub never sees your GitHub password or any 2FA code; you type those into github.com, not here.'),
  p('If you have two-factor authentication (2FA) turned on, GitHub asks for it right there on that same page, exactly like signing into github.com from any browser. There\u2019s nothing extra to set up on GitroHub\u2019s side either way.'),
  p('What you\u2019re agreeing to: GitroHub asks for the repo permission (read and change your repositories, including private ones) and delete_repo (only used when you choose to delete a repo). You can review or remove that access any time at github.com/settings/applications.'),
  p('To turn on 2FA: on github.com go to Settings → Password and authentication → Two-factor authentication. GitHub recommends an authenticator app as your main method, with a passkey or security key as a backup.'),
  p('Turning 2FA on or off later never breaks an existing connection — it only changes how you log into github.com, not the access token GitroHub holds. You\u2019d only need to reconnect if you revoke GitroHub\u2019s access on GitHub or use 🚪 Disconnect here.'),
];
const CONNECT_CONNECTED = [
  p('You\u2019re already connected — see ⚙️ Settings for your linked account and its permissions, and 🚪 Disconnect if you ever want to unlink it. Disconnecting also revokes GitroHub\u2019s access token on GitHub.'),
  p('If you have 2FA enabled on GitHub, it doesn\u2019t affect this connection: 2FA only applies at github.com\u2019s own login page, and GitroHub only ever holds the access token from when you first connected — not your password or any 2FA code.'),
  p('To review or remove GitroHub\u2019s access yourself: GitHub → Settings → Applications → Authorized OAuth Apps.'),
];

// ── FAQ ──────────────────────────────────────────────────────────────────────
const qa = (q, a) => [h(q), p(a)];
const FAQ_BLOCKS = [
  ...qa('I deleted a repo by mistake — can I get it back?', 'Open ⚙️ Settings → 📦 Data & Trash → 🗑️ Trash. Repos you delete through the bot (one at a time or in bulk) are backed up there, usually for 30 days, and can be restored with ♻️. Backups over 20 MB are kept as a ZIP you can download. Repos deleted directly on GitHub aren\u2019t covered.'),
  ...qa('Does a restore bring everything back?', 'It brings back files, the description and the visibility. Commit history, issues, stars, webhooks and topics are not part of the ZIP, so they can\u2019t be restored.'),
  ...qa('Why can\u2019t I see a repo I collaborate on?', 'GitroHub lists and manages repos owned by the account you are viewing — you, or an organisation you pick under 💼 Workspace → Organisations (it needs the read:org permission). Repos that someone else owns and you only collaborate on aren\u2019t listed, so an action can never land on the wrong repo.'),
  ...qa('How do I use more than one GitHub account?', '⚙️ Settings → 👤 Accounts: tap Add another account, then choose “Use a different account” on GitHub’s account picker. You can connect up to 5 and switch with one tap. 🚪 Disconnect only removes the active one.'),
  ...qa('GitHub says Bad credentials / the bot asked me to connect again.', 'You (or GitHub) revoked GitroHub\u2019s access. The bot checks this itself, disconnects that account and sends you straight to Connect — your tags, pins and settings are kept.'),
  ...qa('Why didn\u2019t a scheduled repo or upload run?', 'Check your timezone under 🤖 Automation → Schedule. If it failed you get a message with the reason (for example the name already exists, or GitHub rejected your connection). If it\u2019s still waiting, it\u2019s listed under Scheduled — you can edit or cancel it there.'),
  ...qa('I\u2019m not getting live alerts.', 'Check that 🔔 GitHub activity is on, that the repo has Live Alerts enabled and isn\u2019t muted, and that you\u2019re not inside Quiet Hours (alerts are held until the window ends). If you changed your GitHub username, open any repo once so the bot learns the new name.'),
  ...qa('The bot says my GitHub connection can\u2019t be read.', 'That happens if the server\u2019s encryption key changed. Just tap Connect GitHub Account again — a new login replaces the old one.'),
  ...qa('Is my GitHub token safe?', 'It is stored encrypted, only decrypted in memory when needed, never shown to anyone (admins included) and never logged. You can revoke it any time with 🚪 Disconnect or on GitHub.'),
  ...qa('Can admins see my repos or files?', 'Admins can see account information needed to run the service and your repo list. They cannot read your token. The Owner can switch on Repo Shield, which stops other admins from viewing, downloading, changing or deleting an account\u2019s repos from the Dashboard.'),
  ...qa('What is Warden? Am I being watched?', 'Warden counts how active an account is (actions, errors, bursts) to spot abuse or a hijacked account. It does not read your repos or messages and never acts on its own. See 📜 Legal → Monitoring for the details.'),
  ...qa('How do I delete all my data?', 'Use 📦 Storage to clear things yourself, 🚪 Disconnect to end the GitHub connection, and ask an admin (📞 Contact Admin) to delete your account entirely.'),
  ...qa('I tapped a button twice — did it run twice?', 'No. Repeated taps are ignored, and buttons such as visibility, pin and mute name the state they set, so a repeat can\u2019t undo them.'),
  ...qa('Why was my upload preview wrong or incomplete?', 'If GitHub couldn\u2019t list the repo\u2019s files (a temporary error, or a very large repo), the preview says so and a folder sync won\u2019t delete anything. Try again in a moment.'),
  ...qa('Something else is wrong.', 'Use /report or 📞 Contact Admin → 🚩 Report a Problem and describe what you did and what you expected.'),
];

// ── rendering ────────────────────────────────────────────────────────────────
function renderBlock(block) {
  if (block.h !== undefined) return `*${format.escapeMd(block.h)}*`;
  if (block.p !== undefined) return format.escapeMd(block.p);
  return block.ul.map((item) => `• ${format.escapeMd(item)}`).join('\n');
}

/** Splits blocks into one or more MarkdownV2 pages that each fit comfortably in a Telegram message. */
function paginate(title, blocks) {
  const rendered = blocks.map(renderBlock);
  const pages = [];
  let current = [];
  let length = 0;
  rendered.forEach((text, n) => {
    if (current.length && length + text.length + 2 > PAGE_LIMIT) {
      // A heading must never be the last thing on a page, away from the text it introduces.
      const carry = blocks[n - 1] && blocks[n - 1].h !== undefined ? current.pop() : null;
      pages.push(current);
      current = carry ? [carry] : [];
      length = current.reduce((sum, t) => sum + t.length + 2, 0);
    }
    current.push(text);
    length += text.length + 2;
  });
  if (current.length) pages.push(current);
  return pages.map((parts, i) => {
    const heading = pages.length > 1
      ? `*${format.escapeMd(title)}* ${format.escapeMd(`(${i + 1}/${pages.length})`)}`
      : `*${format.escapeMd(title)}*`;
    return `${heading}\n\n${parts.join('\n\n')}`;
  });
}

const TOPIC_PAGES = {};
Object.entries(TOPICS).forEach(([id, topic]) => { TOPIC_PAGES[id] = paginate(topic.title, topic.blocks); });
const FAQ_PAGES = paginate('❓ FAQ', FAQ_BLOCKS);
const CONNECT_PAGES = {
  connected: paginate(CONNECT_TITLE, CONNECT_CONNECTED),
  disconnected: paginate(CONNECT_TITLE, CONNECT_DISCONNECTED),
};

/** The titles shown on the Help menu, in order. */
const MENU_ENTRIES = TOPIC_ORDER.map((id) => ({ id, title: id === 'connect' ? '🔗 Account Connection' : TOPICS[id].title }));

async function show(ctx, text, keyboard) {
  const ok = await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard });
  if (!ok) await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function showMenu(ctx, { edit = false } = {}) {
  const text =
    `❓ *GitroHub Help*\n\n` +
    `Pick a topic below, or check the ❓ FAQ / 📞 Contact Admin if this doesn't cover it\\.`;
  const keyboard = inline.helpMenu(MENU_ENTRIES, nav.backRow(ctx, 'help'));
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function handleStart(ctx) {
  nav.resetToHome(ctx); // typed /help: start a clean trail so Back always has somewhere sensible to go
  await showMenu(ctx);
}

async function showTopic(ctx, topicId, page = 0) {
  if (topicId === 'connect') return showConnectTopic(ctx);
  const pages = TOPIC_PAGES[topicId];
  if (!pages) return ctx.answerCbQuery('Unknown topic.').catch(() => {});
  const i = Math.min(Math.max(Number(page) || 0, 0), pages.length - 1);
  return show(ctx, pages[i], inline.helpPageMenu(`help:topic:${topicId}`, i, pages.length, nav.backRow(ctx, 'helptopic')));
}

async function showConnectTopic(ctx) {
  const connected = await users.isConnected(ctx.from.id);
  const body = (connected ? CONNECT_PAGES.connected : CONNECT_PAGES.disconnected)[0];
  const url = connected ? null : await oauth.connectUrl(ctx.from.id);
  return show(ctx, body, inline.helpConnectMenu(url, nav.backRow(ctx, 'helptopic')));
}

async function showFaq(ctx, page = 0) {
  const i = Math.min(Math.max(Number(page) || 0, 0), FAQ_PAGES.length - 1);
  return show(ctx, FAQ_PAGES[i], inline.helpPageMenu('help:faq', i, FAQ_PAGES.length, nav.backRow(ctx, 'helptopic')));
}

async function showContact(ctx) {
  const contacts = await adminInfo.getAdminContacts(ctx.telegram);
  const text =
    `📞 *Contact Admin*\n\n` +
    `For anything Help/FAQ didn't answer, reach out directly:\n` +
    contacts.map((c) => `└ ${format.escapeMd(c)}`).join('\n');
  return show(ctx, text, inline.helpContactMenu(nav.backRow(ctx, 'helptopic')));
}

module.exports = { handleStart, showMenu, showTopic, showFaq, showContact, TOPICS, TOPIC_PAGES, FAQ_PAGES, CONNECT_PAGES, MENU_ENTRIES };
