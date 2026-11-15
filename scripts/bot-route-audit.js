#!/usr/bin/env node
'use strict';
/**
 * GitroHub offline bot route audit.
 * Scans source only. No Telegram, GitHub, Postgres, Redis or network access.
 * Automatically discovers callback buttons, callback routes, reply handlers,
 * commands and scene entries, then reports uncovered callback_data.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const BT = String.fromCharCode(96);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(SRC);
if (!files.length) {
  console.error('❌ No source JavaScript files found under ' + SRC);
  process.exitCode = 1;
  process.exit();
}
const sources = files.map(file => ({
  file: path.relative(ROOT, file).replaceAll(path.sep, '/'),
  text: fs.readFileSync(file, 'utf8')
}));
const unique = a => [...new Set(a)];
const lineOf = (s, i) => s.text.slice(0, i).split('\n').length;
const clean = s => s.replace(/\\(['"\\])/g, '$1');

function scanQuoted(text, from, quoteChars) {
  // Skip whitespace to find the next opening quote from `from`. Returns
  // null if what follows isn't one of the given quote characters (e.g. a
  // variable or expression instead of a string literal \u2014 not something
  // this offline, parser-free scanner can safely follow).
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length || quoteChars.indexOf(text[i]) === -1) return null;
  const q = text[i];
  let j = i + 1, value = '';
  while (j < text.length) {
    if (text[j] === '\\' && j + 1 < text.length) { value += text[j] + text[j + 1]; j += 2; continue; }
    if (text[j] === q) break;
    value += text[j++];
  }
  if (j >= text.length) return null; // unterminated string \u2014 give up on this one
  return { value, endIndex: j + 1 };
}

/** style.callback(text, data, ...) / Markup.button.callback(text, data, ...)
 * \u2014 the callback_data that actually has to match a bot.js route is the
 * SECOND argument, not the first (which is just the button's visible
 * label). Skips the label, then the comma after it, before capturing the
 * value this audit actually cares about. */
function scanCallbackButtons(source) {
  const out = [];
  const quoteChars = ["'", '"', BT];
  const callRe = /(?:style\.callback|Markup\.button\.callback)\s*\(/g;
  let m;
  while ((m = callRe.exec(source.text))) {
    const label = scanQuoted(source.text, callRe.lastIndex, quoteChars);
    if (!label) continue; // first arg isn't a plain string literal \u2014 skip
    let k = label.endIndex;
    while (k < source.text.length && /\s/.test(source.text[k])) k++;
    if (source.text[k] !== ',') continue; // no second argument at all
    const data = scanQuoted(source.text, k + 1, quoteChars);
    if (!data) continue;
    out.push({ value: clean(data.value), file: source.file, line: lineOf(source, m.index) });
    callRe.lastIndex = data.endIndex;
  }
  return out;
}

function scanRoutes(source) {
  const out = [];
  let m;
  const exact = /data\s*===\s*(['"])(.*?)\1/g;
  while ((m = exact.exec(source.text))) out.push({ type: 'exact', value: clean(m[2]), file: source.file, line: lineOf(source, m.index) });
  // Wizard-scene steps (createRepo/editFile/renameRepo/uploadFile) commonly
  // route by an early-return guard — `if (ctx.callbackQuery.data !== 'x')
  // return ...` — rather than the bot.js-style affirmative `data === 'x'`
  // dispatch. Functionally this IS the route for 'x' (the rest of the step
  // only runs when data equals it), so it counts the same as an exact match
  // — without this, every scene confirm/cancel button falsely shows as
  // "uncovered" even though it's fully wired up.
  const negExact = /data\s*!==\s*(['"])(.*?)\1/g;
  while ((m = negExact.exec(source.text))) out.push({ type: 'exact', value: clean(m[2]), file: source.file, line: lineOf(source, m.index) });
  const prefix = /data\.startsWith\(\s*(['"])(.*?)\1\s*\)/g;
  while ((m = prefix.exec(source.text))) out.push({ type: 'prefix', value: clean(m[2]), file: source.file, line: lineOf(source, m.index) });
  const action = /(?:bot|router|composer)\.action\(\s*(['"])(.*?)\1/g;
  while ((m = action.exec(source.text))) out.push({ type: 'exact', value: clean(m[2]), file: source.file, line: lineOf(source, m.index) });
  return out;
}

function scanSimple(source, re) {
  const out = []; let m;
  while ((m = re.exec(source.text))) out.push({ value: clean(m[2]), file: source.file, line: lineOf(source, m.index) });
  return out;
}

function matches(button, route) {
  if (route.type === 'prefix') return button.startsWith(route.value);
  if (button === route.value) return true;
  const marker = '$' + '{';
  if (route.value.includes(marker)) return button.startsWith(route.value.split(marker)[0]);
  // Button built by a shared keyboard factory with a dynamic piece (e.g.
  // `${scenePrefix}:cancel:confirm`): treat each ${...} as a wildcard and
  // see whether some concrete route fits. Requires >= 4 literal characters
  // so a bare `${a}:${b}` can't match everything.
  if (button.includes(marker)) {
    const literal = button.replace(/\$\{[^}]*\}/g, '');
    if (literal.length >= 4) {
      const escaped = button.split(/\$\{[^}]*\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+');
      return new RegExp('^' + escaped + '$').test(route.value);
    }
  }
  return false;
}

const buttons = sources.flatMap(scanCallbackButtons);
const routes = sources.flatMap(scanRoutes);
const hears = sources.flatMap(s => scanSimple(s, /bot\.hears\(\s*(['"])(.*?)\1/g));
const commands = sources.flatMap(s => scanSimple(s, /bot\.command\(\s*(['"])(.*?)\1/g));
const scenes = sources.flatMap(s => scanSimple(s, /(?:ctx\.)?scene\.enter\(\s*(['"])(.*?)\1/g));

const callbackValues = unique(buttons.map(x => x.value));
const routeValues = unique(routes.map(x => x.type + ':' + x.value));
// A button that is *entirely* dynamic (e.g. `${prefix}:${page - 1}`, the shared
// pagination builder) has no literal text to check against routes, so it can't
// be verified offline — skip it rather than fail the run on every commit. Its
// concrete prefixes (admin:audit:, admin:user:<id>:history:, ...) are each
// separate literals elsewhere that ARE checked.
const unverifiableDynamic = b => b.includes('$' + '{') && b.replace(/\$\{[^}]*\}/g, '').replace(/[:_\-\s]/g, '').length < 4;
const uncovered = callbackValues.filter(b => !unverifiableDynamic(b) && !routes.some(r => matches(b, r)));
const duplicates = callbackValues
  .map(value => ({ value, count: buttons.filter(x => x.value === value).length }))
  .filter(x => x.count > 1);

const namespaces = {};
for (const b of callbackValues) {
  const ns = b.split(':')[0] || b;
  namespaces[ns] = (namespaces[ns] || 0) + 1;
}

const report = {
  phase: 1,
  mode: 'offline-structural',
  filesScanned: files.length,
  callbackButtons: callbackValues.length,
  callbackRoutes: routeValues.length,
  uncoveredCallbacks: uncovered,
  duplicateCallbacks: duplicates,
  hears: unique(hears.map(x => x.value)),
  commands: unique(commands.map(x => x.value)),
  scenesEntered: unique(scenes.map(x => x.value)),
  namespaces
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = uncovered.length ? 1 : 0;
} else {
  console.log('\n🤖 GitroHub Offline Bot Route Audit');
  console.log('══════════════════════════════════════');
  console.log('Files scanned:          ' + files.length);
  console.log('Callback buttons found: ' + callbackValues.length);
  console.log('Callback routes found:  ' + routeValues.length);
  console.log('Reply handlers found:   ' + report.hears.length);
  console.log('Commands found:         ' + report.commands.length);
  console.log('Scenes entered:         ' + report.scenesEntered.length);

  console.log('\n📊 Callback coverage');
  console.log('──────────────────────────────────────');
  console.log('Buttons with a matching route: ' + (callbackValues.length - uncovered.length));
  console.log('Uncovered buttons:             ' + uncovered.length);

  if (uncovered.length) {
    console.log('\n❌ Uncovered callback_data:');
    for (const value of uncovered) {
      const hit = buttons.find(x => x.value === value);
      console.log('   • ' + value + '  (' + hit.file + ':' + hit.line + ')');
    }
  } else {
    console.log('✅ Every statically discoverable callback button has a matching route.');
  }

  if (duplicates.length) {
    console.log('\n🔁 Duplicate callback literals:');
    for (const d of duplicates) console.log('   • ' + d.value + ' ×' + d.count);
  }

  console.log('\n🧭 Callback namespaces');
  console.log('──────────────────────────────────────');
  Object.entries(namespaces).sort((a,b) => b[1]-a[1])
    .forEach(([name,count]) => console.log('   ' + name.padEnd(22) + count));

  console.log('\n⌨️ Commands');
  console.log('──────────────────────────────────────');
  console.log(report.commands.length ? report.commands.map(x => '   /' + x.replace(/^\//, '')).join('\n') : '   none');

  console.log('\n💬 Reply-keyboard handlers');
  console.log('──────────────────────────────────────');
  console.log(report.hears.length ? report.hears.map(x => '   ' + x).join('\n') : '   none');

  console.log('\n🧩 Scenes entered');
  console.log('──────────────────────────────────────');
  console.log(report.scenesEntered.length ? report.scenesEntered.map(x => '   ' + x).join('\n') : '   none');

  console.log('\nDone. Fully offline — no external services used.\n');
  process.exitCode = uncovered.length ? 1 : 0;
}
