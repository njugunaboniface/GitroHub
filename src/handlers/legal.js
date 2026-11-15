const inline = require('../keyboards/inline');
const format = require('../lib/format');
const { safeEditMessageText } = require('../lib/safeEdit');
const nav = require('../lib/nav');

/**
 * /legal — rewritten for v1.2.3-multi, scopes/accounts updated in v1.2.4-multi.
 *
 * Terms of Use and Privacy Policy for this bot, describing what GitroHub actually does and
 * stores according to the code (see README.md, docs/SECURITY.md and src/config.js for the
 * limits and retention values quoted here).
 *
 * How it's built: each section is plain text — headings, paragraphs and bullet lists — in
 * the SECTIONS array below. render() turns that into Telegram MarkdownV2 (escaping every
 * special character for you), and paginate() splits anything longer than one Telegram
 * message into numbered pages. So editing a policy never means hand-escaping punctuation,
 * and a section can grow without breaking the 4096-character message limit. A test
 * (scripts/v123-tests.js) fails if any page is too long or any text is left unescaped.
 *
 * This is a thorough, plain-language draft of how the bot behaves. It is not legal advice:
 * the operator of an instance should have it reviewed before relying on it.
 */

const UPDATED = 'October 14, 2026';
const PAGE_LIMIT = 1500; // rendered characters per message — Telegram's hard limit is 4096

const h = (text) => ({ h: text });
const p = (text) => ({ p: text });
const ul = (...items) => ({ ul: items });

const SECTIONS = [
  {
    title: '📜 Terms of Use',
    blocks: [
      p(`Last updated: ${UPDATED}.`),
      p('These Terms of Use ("Terms") are an agreement between you ("you") and the person or organization that runs this GitroHub instance (the "Operator" — reachable through ❓ Help → 📞 Contact Admin). By sending a message to this bot, running /start, or connecting a GitHub account through it, you accept these Terms. If you do not agree, do not use the bot.'),
      h('1. What GitroHub is'),
      p('GitroHub is software that turns instructions you give in Telegram into actions on GitHub, using an access token you grant when you connect your GitHub account. It acts only on your instructions. It is not GitHub, is not affiliated with or endorsed by GitHub or Telegram, and has no control over their services, uptime or policies.'),
      h('2. Your responsibilities'),
      ul(
        'You are responsible for everything done through the bot while your Telegram account is connected to a GitHub account — including by anyone else who can use your Telegram session or device.',
        'You must have the right to manage every repository, file and piece of content you create, upload, edit, download or delete through the bot.',
        'You must follow GitHub\u2019s and Telegram\u2019s own terms. GitroHub does not give you any right those services do not.',
        'Destructive actions (deleting repos or files, changing visibility, bulk actions) do what you confirm. Read the confirmation screens.'
      ),
      h('3. Acceptable use'),
      p('Do not use the bot to attack, overload or probe it or GitHub; to bypass its limits, access controls or the Warden monitoring; to store or distribute unlawful content; to harass others; to automate abuse; or to access another person\u2019s account. The bot enforces per-hour action limits and size limits; trying to evade them is a violation.'),
      h('4. Changes to the service'),
      p('Features may be added, changed or removed at any time. Planned downtime is announced through Maintenance Mode where practical; unplanned downtime may not be announced.'),
    ],
  },
  {
    title: '⚖️ Accounts, Suspension & Liability',
    blocks: [
      h('Eligibility'),
      p('You must be old enough to use Telegram and GitHub where you live (GitHub requires users to be at least 13, and higher where local law requires), and able to enter into this agreement. One Telegram account can have one GitHub connection at a time.'),
      h('Suspension and termination'),
      p('The Operator may warn, restrict, suspend or ban an account at any time — for example for abuse, for security reasons, or if required by law — and may delete an account and its data. A ban disconnects your GitHub connection and revokes GitroHub\u2019s access on GitHub. Suspensions and bans may be temporary or permanent and can be accompanied by a message explaining the reason. You can stop using the bot at any time with 🚪 Disconnect.'),
      h('No warranty'),
      p('The bot is provided "as is" and "as available". The Operator does not promise it will be uninterrupted, error-free, secure against every threat, or fit for a particular purpose. GitHub\u2019s API can fail, rate-limit or behave unexpectedly, and GitroHub may not always be able to tell whether a write succeeded; when that happens it says so instead of guessing.'),
      h('Backups are a convenience, not a guarantee'),
      p('🗑️ Trash keeps a ZIP of a repo you delete through the bot, for the retention period you choose. The ZIP is GitHub\u2019s snapshot of the default branch: it does not contain commit history, issues, stars, webhooks or settings, and very large repos (over 20 MB zipped) are kept as a ZIP only, not restorable in place. Keep your own backups of anything you cannot afford to lose.'),
      h('Limitation of liability'),
      p('To the fullest extent the law allows, the Operator is not liable for indirect, incidental or consequential loss, lost data, lost profits or lost repositories arising from use of the bot, and total liability for any claim is limited to the amount you paid to use it (which is normally nothing). Nothing here limits liability that cannot be limited by law.'),
      h('Governing law and changes'),
      p('These Terms are governed by the laws of the Operator\u2019s jurisdiction. The Operator may update these Terms; the date at the top shows the latest version, and continuing to use the bot after a change means you accept it.'),
    ],
  },
  {
    title: '🔐 Privacy: What We Collect',
    blocks: [
      p('This section lists the data GitroHub stores about you, so nothing is a surprise. Repository contents and GitHub metadata are read live from GitHub when you use a feature and are not kept in the database.'),
      h('From Telegram'),
      ul('Your numeric Telegram ID, first name and @username (if you have one).', 'The commands, button taps and text you send the bot, and files you upload to it for a repo action.'),
      h('From GitHub'),
      ul(
        'Your GitHub username and the scopes you granted (repo and delete_repo, plus gist, notifications, read:org or project only if you approved them for a feature that needs them). If you connect several GitHub accounts, each account\u2019s username, scopes and encrypted token are kept.',
        'Your GitHub access token — stored encrypted, never shown to anyone, and never written to logs.',
        'When you connected and, if relevant, disconnected.'
      ),
      h('Your organisation of repos and settings'),
      ul(
        'Tags (name, emoji, colour, nesting, per-tag defaults) and which repos carry them; pins and pin sections; saved views and search history; recently viewed repos; remembered upload folders.',
        'Your defaults (visibility, commit message, upload folder, sort, filter), notification preferences, quiet hours, timezone, time format, retention choices, and a history of changes to your defaults.',
        'Automation rules (mute, backup and auto-tag), scheduled repos and scheduled uploads — including the contents of files waiting to be uploaded, until they run or are cancelled.',
        'Trash entries: the deleted repo\u2019s name, description, visibility, and the Telegram file reference of the backup ZIP that was sent to your own chat.',
        'Live-alert registrations: which repos you enabled alerts on and the (encrypted) secret that proves a message really came from GitHub; temporary buffers of recent alert summaries.',
        'Short-lived bulk-undo records (one hour).'
      ),
      h('Usage records'),
      ul(
        'An Activity Log of what you did through the bot (a short summary, an optional detail, whether it was an error, and the time).',
        'An Access Log of security-relevant events (an event type, a detail and the time), plus counters such as total actions, last-active time and rate-limit hits.',
        'Messages you send through 🚩 Report a Problem.'
      ),
      h('Moderation and monitoring records'),
      ul(
        'Admin-side records: notes, warnings, ban/suspension reasons and dates, a trusted flag, limit overrides, and a Repo Shield flag.',
        'An admin audit log of actions administrators took (who, which account, what, when).',
        'Warden monitoring data (see "Monitoring, Alerts & Warden").'
      ),
      h('What we do not collect'),
      p('Your GitHub or Telegram password; the contents of your repos (except transiently in memory while an action runs); contacts or messages with other people; advertising or analytics identifiers. GitroHub does not store IP addresses in its database; the web server that handles the GitHub login redirect and GitHub\u2019s webhook calls may keep ordinary connection logs, as hosting providers do.'),
    ],
  },
  {
    title: '🔎 Privacy: How We Use It',
    blocks: [
      p('GitroHub uses your data to run the features you ask for, keep the service secure, and operate it fairly. It does not sell your data, show ads, or use it for advertising or profiling unrelated to running the bot.'),
      ul(
        'To act on your instructions: reading and changing your repos on GitHub with your token, remembering your settings, and sending you the results.',
        'To deliver what you turned on: live alerts, daily or weekly rollups, stale-repo nudges, weekly backups, scheduled repos and uploads, and system or token-health notices — respecting your quiet hours.',
        'To keep the bot secure and available: rate limiting, abuse prevention, error diagnosis, capacity planning and backups.',
        'To moderate: reviewing reports, applying warnings, suspensions and bans, and keeping an audit trail of what administrators did.',
        'To protect accounts and the service through Warden (see below).',
        'To meet legal obligations and to establish, exercise or defend legal claims.'
      ),
      p('GitroHub does not use your repository contents to train models, and does not read your files except to perform the action you requested.'),
    ],
  },
  {
    title: '🛡️ Security & Your GitHub Token',
    blocks: [
      p('Your token is the key to your GitHub account, so it gets the strongest protection in the system.'),
      ul(
        'Stored encrypted with AES-256-GCM using a key held outside the database. If the key is ever lost or changed, a stored token simply stops working and you are asked to reconnect — nothing breaks or leaks.',
        'Only decrypted in memory at the moment it is needed, never displayed to anyone (including administrators), and never written to logs.',
        'The GitHub login uses a signed, single-use, time-limited state value and a confirmation page before anything is exchanged; webhook messages from GitHub are verified with a per-repo secret (HMAC) and rejected if they do not match.',
        'The bot asks only for the scopes it needs: repo (to read and change repositories — GitHub offers no narrower scope that covers private repos) and delete_repo (only used when you choose to delete a repo). A feature that needs more (gist, read:org, project) asks for that one permission at the moment you first use it, and never before.',
        'Every account\u2019s requests are rate limited and isolated so one person\u2019s activity cannot see or affect another\u2019s data.',
        'Administrator actions are role-restricted (guest, moderator, admin, super admin, owner) and recorded in an audit log. Administrators cannot read tokens.'
      ),
      p('No system is perfectly secure. If you suspect your Telegram or GitHub account is compromised, use 🚪 Disconnect and revoke access on GitHub.'),
    ],
  },
  {
    title: '🐙 GitHub Access & Disconnecting',
    blocks: [
      h('What the access lets GitroHub do'),
      p('The repo scope lets the bot read and change your repositories, including private ones, on your instruction; delete_repo lets it delete a repo when you confirm. It can also create and remove webhooks on repos where you enable 🔔 Live Alerts. The repo scope also covers the ⚡ Manage tools (pull requests, issues, branches, releases, Actions, collaborators, deploy keys, security alerts); every change is made only when you tap a button, and risky ones ask you to confirm. Secret values you send for Actions are encrypted on the bot before they are sent to GitHub, the message you typed them in is deleted, and the value is never stored or logged.'),
      h('Ending the connection'),
      p('Tapping 🚪 Disconnect (Settings) now does all of the following, in this order: removes the live-alert webhooks GitroHub added to your repos, revokes GitroHub\u2019s access token on GitHub, forgets your alert registrations and mutes, and deletes the stored token. If GitHub cannot be reached, the local connection is still ended and you can revoke access yourself at github.com/settings/applications. Disconnecting never deletes or changes your repos, files or GitHub settings.'),
      p('An administrator who bans or deletes your account triggers the same clean-up, and additionally removes the whole authorization on GitHub.'),
      h('Your repos stay yours'),
      p('GitroHub has no ownership of, and takes no licence in, your repositories or their contents.'),
    ],
  },
  {
    title: '🤖 Monitoring, Alerts & Warden',
    blocks: [
      h('Warden'),
      p('Warden is a monitoring feature that watches for unusual activity patterns so an administrator can look into abuse or a compromised account. It stores, per account: hourly counts of actions, errors, repeated actions, rate-limit hits, sessions, active minutes and peak bursts; a statistical profile of what is normal for that account; and, when something looks unusual, a case with a short summary and the evidence behind it. It never reads the content of your repos or messages.'),
      ul(
        'Warden is observe-only. It does not ban, suspend, restrict or delete anyone on its own. It may notify the Owner, and an administrator may then decide to act — and, in some cases, you may receive a plain-language notice that your activity looked unusual.',
        'Per-account data is used only for this monitoring and for moderation, and is removed when your account is deleted.'
      ),
      h('Live alerts, rollups and nudges'),
      p('If you enable them, GitroHub receives events from GitHub for the repos you chose and sends you a short digest. If many events arrive at once, the digest tells you how many were not shown. Rollups, nudges and weekly backups are sent only inside the hours you allow (quiet hours use your own timezone).'),
      h('Limits'),
      p('To keep the service available for everyone, accounts have an hourly action limit and size limits for uploads. Reaching a limit is recorded; repeated or abusive patterns may lead to moderation.'),
    ],
  },
  {
    title: '🗑️ Trash, Backups & Exports',
    blocks: [
      p('When you delete a repo through the bot, GitroHub first downloads GitHub\u2019s ZIP of its default branch and sends it to you in your own Telegram chat. It then stores a reference to that file (the repo\u2019s name, description, visibility and the Telegram file reference) so 🗑️ Trash can restore it. The ZIP itself lives in Telegram, under Telegram\u2019s own storage terms — not in GitroHub\u2019s database.'),
      ul(
        'Retention: 30 days by default. You can choose another period, or keep entries indefinitely, in ⚙️ My Defaults. Expired entries are removed automatically (the copy in your Telegram chat is yours to keep or delete).',
        'Restore recreates the repo with the files, description and visibility. It does not bring back commit history, issues, stars, webhooks, topics, or your GitroHub tags and pins for it.',
        'Backups over 20 MB can be downloaded again as a ZIP but cannot be restored in place, because Telegram only lets a bot read back files up to 20 MB. Backups over 50 MB cannot be made, so such a repo is not deleted through the bot.',
        'Bulk Delete makes the same backup for each repo first, and does not delete a repo it could not back up.'
      ),
      p('📤 Export / Import and Storage & Data → Export let you download your own settings and data as a file. Keep exports private: they contain your organisation of repos, your settings and Trash references.'),
    ],
  },
  {
    title: '⏳ How Long We Keep Data',
    blocks: [
      ul(
        'GitHub token: until you disconnect, or an administrator removes the connection.',
        'Activity Log: 90 days by default; you can choose 30 days, 90 days, 1 year or forever under Storage & Data. Cleared automatically each day.',
        'Access Log: 90 days by default (the Operator can change this). Cleared automatically each day.',
        'Trash: 30 days by default, or the period you choose; "Never" keeps entries until you delete them.',
        'Scheduled repos and uploads: until they run or you cancel them; the contents of uploaded files are removed once an upload has finished or been cancelled.',
        'Live-alert buffers: normally minutes; never more than 3 days.',
        'Bulk-undo records: 1 hour.',
        'Session state and temporary upload buffers: up to 24 hours of inactivity (upload buffers: 30 minutes).',
        'Warden activity counts: 90 days by default. Warden cases, evidence and action history: 1 year by default.',
        'Admin audit log: kept for accountability and not automatically deleted. It records what administrators did, not your content.',
        'Settings, tags, pins, defaults, rules and similar organisation data: until you clear them or your account is deleted.'
      ),
      p('Operators may adjust some of these periods in their own deployment. Backups of the database taken by the Operator for disaster recovery are kept for a limited time and are overwritten on the Operator\u2019s schedule.'),
    ],
  },
  {
    title: '🧾 Your Choices & Rights',
    blocks: [
      ul(
        'See and export: 💾 Export / Import and 📦 Storage & Data → Export give you a copy of your settings and data.',
        'Change or clear: change any default or notification at any time; clear pins, tags, defaults, activity history or everything (Full Reset) under Storage & Data. Full Reset leaves your GitHub connection, Trash and anything scheduled untouched.',
        'Disconnect: 🚪 Disconnect ends the GitHub connection and revokes GitroHub\u2019s access (see above).',
        'Delete your account: ask an administrator through ❓ Help → 📞 Contact Admin. Deleting an account removes your settings, tags, pins, rules, schedules, Trash entries, activity and access logs, reports, and Warden data, and disconnects and revokes GitHub access. The admin audit log keeps a record that an administrator action took place.',
        'Other rights: depending on where you live, you may have rights to access, correct, delete, restrict or object to our use of your data, or to complain to a data-protection authority. Contact the Operator and they will respond within a reasonable time.'
      ),
      p('Telegram and GitHub keep their own copies of what you send them; GitroHub cannot delete those.'),
    ],
  },
  {
    title: '🧑‍💼 Administrators & Moderation',
    blocks: [
      p('Administrators can see account information needed to run the service: your Telegram name and ID, whether you are connected, activity summaries, counters, reports you sent, notes and warnings, and your repo list. They can warn, suspend, ban or delete accounts, change limits, and respond to reports.'),
      ul(
        'They cannot read your GitHub token.',
        'The Owner can turn on 🛡 Repo Shield for accounts, which stops other administrators from viewing, downloading, changing or deleting those accounts\u2019 repos from the Dashboard; blocked attempts are written to the audit log.',
        'Roles are limited by level: viewing, moderation, administration and super-administration (broadcasts, permanent account deletion, global settings, bulk operations and role management) are separate permissions.',
        'Every administrator action that affects an account is written to the audit log.'
      ),
    ],
  },
  {
    title: '🌐 Third Parties & Hosting',
    blocks: [
      p('GitroHub relies on a few services to work, and data passes through them as needed:'),
      ul(
        'Telegram — delivers your messages and files, and hosts the backup ZIPs sent to your chat.',
        'GitHub — the service your repos live on; GitroHub calls its API with your token.',
        'The Operator\u2019s hosting, database and cache providers — where the bot runs and where the data described above is stored.'
      ),
      p('GitroHub does not send your data to analytics, advertising or chart-rendering services. Charts shown to administrators are drawn by the bot itself. Your data is not sold or shared with anyone else except where required by law or to protect rights and safety. Data may be processed in the country where the Operator\u2019s providers operate.'),
    ],
  },
  {
    title: '✉️ Contact & Changes',
    blocks: [
      p('Questions, requests about your data, or concerns about these documents: use ❓ Help → 📞 Contact Admin, or send a 🚩 report.'),
      p(`We may update these Terms and this Privacy Policy as the bot changes. The date at the top of the Terms (${UPDATED}) shows the latest version. If a change materially affects how your data is used, the Operator will announce it in the bot where practical.`),
      p('This text describes the software\u2019s behaviour in plain language. It is a draft and is not legal advice.'),
    ],
  },
];

// ── rendering ────────────────────────────────────────────────────────────────
function renderBlock(block) {
  if (block.h !== undefined) return `*${format.escapeMd(block.h)}*`;
  if (block.p !== undefined) return format.escapeMd(block.p);
  return block.ul.map((item) => `• ${format.escapeMd(item)}`).join('\n');
}

/** Splits one section into one or more pages that each fit comfortably in a Telegram message. */
function paginate(section) {
  const rendered = section.blocks.map(renderBlock);
  const pages = [];
  let current = [];
  let length = 0;
  rendered.forEach((text, n) => {
    if (current.length && length + text.length + 2 > PAGE_LIMIT) {
      // A heading must never be the last thing on a page, away from the text it introduces.
      const carry = section.blocks[n - 1] && section.blocks[n - 1].h !== undefined ? current.pop() : null;
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
      ? `*${format.escapeMd(section.title)}* ${format.escapeMd(`(${i + 1}/${pages.length})`)}`
      : `*${format.escapeMd(section.title)}*`;
    return `${heading}\n\n${parts.join('\n\n')}`;
  });
}

const PAGES = [];
const INDEX = [];
SECTIONS.forEach((section) => {
  INDEX.push({ title: section.title, index: PAGES.length });
  paginate(section).forEach((text) => PAGES.push({ title: section.title, text }));
});

async function showIndex(ctx, { edit = false } = {}) {
  const text =
    `📜 *Legal*\n\n` +
    `Terms of Use and Privacy Policy for this bot — what it does, what it stores about you, for how long, and your choices\\. Pick a section:`;
  const keyboard = inline.legalIndexMenu(INDEX, nav.backRow(ctx, 'legal'));
  if (edit) {
    if (await safeEditMessageText(ctx, text, { parse_mode: 'MarkdownV2', ...keyboard })) return;
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard });
}

async function handleStart(ctx) {
  nav.resetToHome(ctx); // typed /legal: clean trail, so Back leads to Help & support rather than a stale screen
  await showIndex(ctx);
}

async function showSection(ctx, index) {
  const i = Number(index);
  const page = PAGES[i];
  if (!page) return ctx.answerCbQuery('Unknown section.').catch(() => {});
  const keyboard = inline.legalSectionMenu(i, PAGES.length, nav.backRow(ctx, 'legalsection'));
  const ok = await safeEditMessageText(ctx, page.text, { parse_mode: 'MarkdownV2', ...keyboard });
  if (!ok) await ctx.reply(page.text, { parse_mode: 'MarkdownV2', ...keyboard });
}

module.exports = { handleStart, showIndex, showSection, PAGES, INDEX, SECTIONS };
