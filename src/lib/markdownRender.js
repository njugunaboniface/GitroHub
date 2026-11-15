const format = require('./format');

/**
 * v1.2.0-multi — README preview used to dump every text file (including
 * .md ones) into a raw ``` code block, so a README's actual formatting
 * (headers, bold, links, lists) never rendered — just showed the literal
 * "# Heading" / "**bold**" syntax as plain text.
 *
 * Converting Markdown to Telegram's MarkdownV2 safely is genuinely
 * fiddly: MarkdownV2 has no heading syntax at all, its bold/italic
 * delimiters differ from GitHub's, and getting escaping wrong here is
 * exactly the class of bug that broke the Admin Dashboard twice already
 * this session. So the approach is deliberately conservative: recognized
 * syntax (headers, bold, italic, inline code, fenced code blocks, links,
 * list bullets) gets pulled out into placeholder tokens FIRST. Then
 * everything else — the plain prose in between — gets escaped as pure
 * literal text via the exact same escapeMd() used everywhere else in the
 * bot. Only at the very end do the placeholders get swapped back in,
 * carrying their own correctly-escaped-for-their-role content. Nothing
 * can leak through un-escaped by accident, because nothing bypasses the
 * escape pass except text that went through a token.
 */

let tokenCounter = 0;
function makeToken() {
  tokenCounter += 1;
  return `\u0000TOK${tokenCounter}\u0000`;
}

function renderMarkdownToTelegram(md) {
  tokenCounter = 0;
  const tokens = {};

  function stash(value) {
    const token = makeToken();
    tokens[token] = value;
    return token;
  }

  let text = md;

  // 1. Fenced code blocks first — their content must NOT have markdown
  // syntax inside them interpreted (a `**` inside a code sample is
  // literal, not bold), so pull the whole block out before anything else
  // gets a chance to match inside it.
  text = text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_, lang, body) => {
    const trimmedBody = body.replace(/\n$/, '');
    return stash('```' + lang + '\n' + format.escapeCodeBlock(trimmedBody) + '\n```');
  });

  // 2. Inline code spans — same reasoning, one level down.
  text = text.replace(/`([^`\n]+)`/g, (_, body) => stash('`' + format.escapeCodeBlock(body) + '`'));

  // 3. Headers (# through ######) — MarkdownV2 has no heading concept at
  // all, so the closest honest equivalent is bold text. Matched per-line;
  // the leading #'s and the one required space are consumed and dropped.
  text = text.replace(/^#{1,6}[ \t]+(.+)$/gm, (_, body) => stash('*' + format.escapeMd(body.trim()) + '*'));

  // 4. Links — [text](url). URL escaping rules differ slightly from plain
  // text (only `)` and `\` are reserved inside the URL portion per
  // Telegram's spec), so it gets its own narrower escape, not the general
  // escapeMd used for the visible text and everywhere else.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const safeUrl = url.replace(/([)\\])/g, '\\$1');
    return stash('[' + format.escapeMd(label) + '](' + safeUrl + ')');
  });

  // 5. Bold — **text** or __text__ (GitHub supports both; check the
  // double-char forms before single-char italic below, so "**x**" isn't
  // first consumed as two adjacent italics).
  text = text.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_, a, b) => stash('*' + format.escapeMd(a || b) + '*'));

  // 6. Italic — remaining single * or _ pairs, now that bold's doubled
  // delimiters are already spoken for.
  text = text.replace(/\*([^*\n]+)\*|_([^_\n]+)_/g, (_, a, b) => stash('_' + format.escapeMd(a || b) + '_'));

  // 7. List bullets — "- item" / "* item" at the start of a line becomes
  // a plain bullet character, which needs no escaping of its own.
  text = text.replace(/^[ \t]*[-*][ \t]+/gm, '• ');

  // 8. Everything that's left is plain prose (or was never real markdown
  // syntax to begin with) — escape it exactly the way any other dynamic
  // text in the bot gets escaped before this function ever ran.
  text = format.escapeMd(text);

  // 9. Swap every placeholder back in — their content was already
  // escaped appropriately for its own role back when it was stashed, so
  // this step must NOT run through escapeMd again.
  text = text.replace(/\u0000TOK(\d+)\u0000/g, (_, n) => tokens[`\u0000TOK${n}\u0000`] || '');

  return text;
}

module.exports = { renderMarkdownToTelegram };
