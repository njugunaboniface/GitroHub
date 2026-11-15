/**
 * 🌐 /owner and the Admin Dashboard's "Web panel" button (v2.2.0-multi): the owner (and only the owner) gets a private,
 * single-use link to the web panel. The link sits behind a button (never in the message text, so no link preview can
 * touch it), works once and expires after 2 minutes; the message removes itself shortly after.
 */
const { Markup } = require('telegraf');
const ownerWeb = require('../lib/ownerWeb');
const roles = require('../lib/roles');

async function sendLink(ctx) {
  if (!ctx.from || !roles.isOwner(ctx.from.id)) return; // anyone else: silence, as for an unknown command
  if (!ownerWeb.enabled()) return ctx.reply('The owner web panel is switched off (OWNER_WEB=off).');
  let link;
  try { link = await ownerWeb.issueLink(ctx.from.id); } catch (err) { return ctx.reply(`Could not create the link: ${err.message}`); }
  const minutes = Math.round(link.expiresInSeconds / 60);
  const msg = await ctx.reply(
    `Your owner panel link. It opens once and expires in ${minutes} minutes.`,
    { __keep: true, ...Markup.inlineKeyboard([[Markup.button.url('Open owner panel', link.url)]]) },
  );
  const timer = setTimeout(() => { ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}); }, (link.expiresInSeconds + 10) * 1000);
  if (timer.unref) timer.unref();
  return msg;
}

module.exports = { sendLink };
