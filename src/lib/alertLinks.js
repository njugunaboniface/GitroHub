/**
 * Deep-link buttons for live-alert digests (v1.2.5-multi): "🔀 Open PR #12", "🐞 Open issue #4", "▶️ Open run".
 * The alert says what happened; the button takes you straight to it. Best-effort: no buttons is always fine.
 *
 * A button opens the in-bot screen when the repo belongs to the owner the person is currently looking at
 * (the in-bot screens work on that owner), otherwise a plain link to GitHub — never a button that would
 * open the wrong account's repo.
 */
const { Markup } = require('telegraf');
const style = require('../keyboards/buttonStyle');
const ownerScope = require('./ownerScope');

const MAX_BUTTONS = 3;
const ORDER = ['pr', 'issue', 'run'];

/** The newest link of each kind from a digest's events. */
function pick(events) {
  const latest = new Map();
  for (const e of events || []) if (e && e.link && ORDER.includes(e.link.type)) latest.set(e.link.type, e.link);
  return ORDER.filter((k) => latest.has(k)).map((k) => latest.get(k)).slice(0, MAX_BUTTONS);
}

function label(link) {
  if (link.type === 'pr') return `🔀 Open PR #${link.number}`;
  if (link.type === 'issue') return `🐞 Open issue #${link.number}`;
  return '▶️ Open run';
}

async function keyboard(telegramId, repo, events) {
  const links = pick(events);
  if (!links.length) return null;
  const mine = await ownerScope.current(telegramId).catch(() => null);
  const buttons = [];
  for (const link of links) {
    const inBot = mine && link.owner && String(link.owner).toLowerCase() === mine;
    if (inBot) {
      const data = link.type === 'pr' ? `manage:pulls:view:${repo}:${link.number}`
        : link.type === 'issue' ? `manage:issues:view:${repo}:${link.number}`
          : `manage:actions:run:${repo}:${link.runId}`;
      buttons.push(style.callback(label(link), data));
    } else if (link.url) {
      buttons.push(style.url(label(link), link.url));
    }
  }
  return buttons.length ? Markup.inlineKeyboard(buttons.map((b) => [b])) : null;
}

module.exports = { keyboard, pick, label };
