#!/usr/bin/env node
'use strict';

/**
 * GitroHub offline navigation crawler.
 * Phase 2: callback -> route -> handler graph + deterministic scenarios.
 * Structural only: it never starts the bot or contacts external services.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const sourceFiles = walk(SRC);
if (!sourceFiles.length) {
  console.error('❌ No source JavaScript files found under ' + SRC);
  process.exitCode = 1;
  process.exit();
}

const files = sourceFiles.map(file => ({
  file: path.relative(ROOT, file).replaceAll(path.sep, '/'),
  text: fs.readFileSync(file, 'utf8')
}));

const unique = values => [...new Set(values)];
const lineOf = (source, index) => source.slice(0, index).split('\n').length;
const clean = value => value.replace(/\\(['"\\])/g, '$1');

function scanQuoted(text, from, quoteChars) {
  // Next string literal at/after `from` (whitespace skipped); null if the
  // argument isn't a plain string literal (variable, expression, ...).
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
  if (j >= text.length) return null;
  return { value, endIndex: j + 1 };
}

// style.callback(text, data, ...) / Markup.button.callback(text, data, ...):
// the value that has to match a route is the SECOND argument (callback_data).
// The first is only the visible label, which previously got scanned instead
// \u2014 so every button "failed to match" and no navigation edges were found.
function callbackButtons(item) {
  const out = [];
  const BT = String.fromCharCode(96);
  const quoteChars = ["'", '"', BT];
  const callRe = /(?:style\.callback|Markup\.button\.callback)\s*\(/g;
  let match;

  while ((match = callRe.exec(item.text))) {
    const label = scanQuoted(item.text, callRe.lastIndex, quoteChars);
    if (!label) continue;
    let k = label.endIndex;
    while (k < item.text.length && /\s/.test(item.text[k])) k++;
    if (item.text[k] !== ',') continue;
    const data = scanQuoted(item.text, k + 1, quoteChars);
    if (!data) continue;
    out.push({ value: clean(data.value), file: item.file, line: lineOf(item.text, match.index), index: match.index });
    callRe.lastIndex = data.endIndex;
  }
  return out;
}

function literalMatches(source, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(source))) {
    out.push({ value: clean(m[2]), index: m.index, line: lineOf(source, m.index) });
  }
  return out;
}

function routes(item) {
  const out = [];
  const exact = /(?:data|cb)\s*===\s*(['"])(.*?)\1/g;
  const prefix = /(?:data|cb)\.startsWith\(\s*(['"])(.*?)\1\s*\)/g;
  const action = /(?:bot|router|composer)\.action\(\s*(['"])(.*?)\1/g;
  const negExact = /(?:data|cb)\s*!==\s*(['"])(.*?)\1/g; // wizard-scene guard: `if (data !== 'x') return`

  for (const hit of literalMatches(item.text, negExact))
    out.push({ type: 'exact', value: hit.value, file: item.file, line: hit.line, index: hit.index });
  for (const hit of literalMatches(item.text, exact))
    out.push({ type: 'exact', value: hit.value, file: item.file, line: hit.line, index: hit.index });
  for (const hit of literalMatches(item.text, prefix))
    out.push({ type: 'prefix', value: hit.value, file: item.file, line: hit.line, index: hit.index });
  for (const hit of literalMatches(item.text, action))
    out.push({ type: 'exact', value: hit.value, file: item.file, line: hit.line, index: hit.index });

  return out;
}

function matches(button, route) {
  if (route.type === 'prefix') return button.startsWith(route.value);
  if (button === route.value) return true;
  const marker = '$' + '{';
  if (route.value.includes(marker)) {
    return button.startsWith(route.value.split(marker)[0]);
  }
  if (button.includes(marker)) {
    const literal = button.replace(/\$\{[^}]*\}/g, '');
    if (literal.length >= 4) {
      const escaped = button.split(/\$\{[^}]*\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+');
      return new RegExp('^' + escaped + '$').test(route.value);
    }
  }
  return false;
}
function blockAfter(source, index) {
  const open = source.indexOf('{', index);
  if (open < 0) return '';
  let depth = 0;
  let quote = null;

  for (let i = open; i < source.length; i++) {
    const c = source[i];

    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }

    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function likelyTargets(block) {
  const targets = [];
  const call = /(?:return\s+)?(?:await\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;
  let m;

  while ((m = call.exec(block))) {
    const value = m[1];
    if (!/^ctx\.(reply|answerCbQuery|deleteMessage|editMessageText|telegram)\./.test(value))
      targets.push(value);
  }

  const scene = /ctx\.scene\.enter\(\s*['"]([^'"]+)['"]/g;
  while ((m = scene.exec(block))) targets.push('scene:' + m[1]);

  return unique(targets);
}

const buttonList = files.flatMap(callbackButtons);
const routeList = files.flatMap(routes);
const graph = [];
const unmatched = [];

for (const button of buttonList) {
  const matchesForButton = routeList.filter(route => matches(button.value, route));
  if (!matchesForButton.length) {
    // Entirely dynamic (e.g. `${prefix}:${page - 1}`, the shared pagination
    // builder): no literal text to match offline, and its concrete prefixes
    // are separate literals that are checked. Not a failure.
    const dynamicOnly = button.value.includes('$' + '{') &&
      button.value.replace(/\$\{[^}]*\}/g, '').replace(/[:_\-\s]/g, '').length < 4;
    if (!dynamicOnly) unmatched.push(button);
    continue;
  }

  // Most specific route wins: an exact match beats a prefix match, and a
  // longer prefix beats a shorter one. Taking the first hit paired e.g.
  // `search:recent:<q>` with the broad `data.startsWith('search:')` gate
  // instead of the handler that actually does the work.
  const route = matchesForButton.slice().sort((a, b) =>
    (b.type === 'exact') - (a.type === 'exact') || b.value.length - a.value.length)[0];
  const source = files.find(f => f.file === route.file);
  const block = source ? blockAfter(source.text, route.index) : '';
  const targets = likelyTargets(block);

  graph.push({
    callback: button.value,
    button: { file: button.file, line: button.line },
    route: { type: route.type, value: route.value, file: route.file, line: route.line },
    likelyTargets: targets,
    targetCount: targets.length
  });
}

const uniqueCallbacks = unique(buttonList.map(x => x.value));
const uniqueRoutes = unique(routeList.map(route => route.type + ':' + route.value));
const duplicateCallbacks = uniqueCallbacks
  .map(value => ({ value, count: buttonList.filter(x => x.value === value).length }))
  .filter(x => x.count > 1);

const namespaces = {};
for (const value of uniqueCallbacks) {
  const namespace = value.split(':')[0] || value;
  namespaces[namespace] = (namespaces[namespace] || 0) + 1;
}

const scenarios = graph.map((edge, index) => ({
  id: index + 1,
  name: 'callback-' + (index + 1),
  input: { type: 'callback_query', data: edge.callback },
  expected: { route: edge.route.value, handlerTargets: edge.likelyTargets }
}));

const report = {
  phase: 2,
  mode: 'offline-structural',
  filesScanned: files.length,
  callbackButtons: uniqueCallbacks.length,
  callbackRoutes: uniqueRoutes.length,
  graphEdges: graph.length,
  unmatchedCallbacks: unmatched.map(x => ({ value: x.value, file: x.file, line: x.line })),
  duplicateCallbacks,
  namespaces,
  graph,
  scenarios
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = unmatched.length ? 1 : 0;
} else {
  console.log('\n🕷️ GitroHub Offline Navigation Crawler');
  console.log('══════════════════════════════════════════════');
  console.log('Files scanned:          ' + files.length);
  console.log('Callback buttons:       ' + uniqueCallbacks.length);
  console.log('Callback routes:        ' + uniqueRoutes.length);
  console.log('Graph edges:            ' + graph.length);
  console.log('Generated scenarios:    ' + scenarios.length);
  console.log('Unmatched callbacks:    ' + unmatched.length);
  console.log('Duplicate literals:     ' + duplicateCallbacks.length);

  if (unmatched.length) {
    console.log('\n❌ Unmatched callbacks');
    for (const item of unmatched)
      console.log('   • ' + item.value + ' (' + item.file + ':' + item.line + ')');
  }

  console.log('\n🧭 Navigation sample');
  console.log('──────────────────────────────────────────────');
  for (const edge of graph.slice(0, 40)) {
    const targets = edge.likelyTargets.length ? edge.likelyTargets.join(', ') : 'no static target detected';
    console.log('   ' + edge.callback + ' → ' + targets);
  }
  if (graph.length > 40) console.log('   … ' + (graph.length - 40) + ' more edges');

  console.log('\n🧪 Scenario generation');
  console.log('──────────────────────────────────────────────');
  console.log('   One deterministic callback scenario was generated per discovered button.');
  console.log('   These scenarios are inputs for the future mock-handler runner.');
  console.log('   They do NOT claim Telegram/GitHub/database side effects succeeded.');
  console.log('\nDone. Fully offline — no external services used.\n');

  process.exitCode = unmatched.length ? 1 : 0;
}
