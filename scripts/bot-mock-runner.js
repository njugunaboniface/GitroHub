#!/usr/bin/env node
'use strict';

/** GitroHub Phase 3 — offline mock execution harness. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CRAWLER = path.join(__dirname, 'bot-navigation-crawler.js');

function getReport() {
  const raw = execFileSync(process.execPath, [CRAWLER, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024, // full navigation graph JSON is several MB
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(raw);
}

function sourceText(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function findRouteBlock(source, routeValue) {
  const escaped = routeValue.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const exact = new RegExp('(?:data|cb)\\s*===\\s*([\'"])' + escaped + '\\1');
  const prefix = new RegExp('(?:data|cb)\\.startsWith\\(\\s*([\'"])' + escaped + '\\1');
  const action = new RegExp('(?:bot|router|composer)\\.action\\(\\s*([\'"])' + escaped + '\\1');
  const negExact = new RegExp('(?:data|cb)\\s*!==\\s*([\'"])' + escaped + '\\1'); // wizard-scene guard
  const match = exact.exec(source) || prefix.exec(source) || action.exec(source) || negExact.exec(source);
  if (!match) return '';

  const open = source.indexOf('{', match.index);
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
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function mockExecute(edge) {
  const source = sourceText(edge.route.file);
  const block = findRouteBlock(source, edge.route.value);
  if (!block) {
    return { status: 'FAIL', reason: 'Discovered route branch could not be located.' };
  }

  const events = [];
  if (/ctx\.answerCbQuery\s*\(/.test(block)) events.push('answerCbQuery');
  if (/ctx\.reply\s*\(/.test(block)) events.push('reply');
  if (/safeEditMessageText\s*\(/.test(block) || /ctx\.editMessageText\s*\(/.test(block)) events.push('editMessage');

  for (const match of block.matchAll(/ctx\.scene\.enter\(\s*['"]([^'"]+)['"]/g)) {
    events.push('scene.enter:' + match[1]);
  }
  if (/ctx\.scene\.leave\s*\(/.test(block)) events.push('scene.leave');

  const external = [];
  if (/\bgithub\./i.test(block)) external.push('github');
  if (/\bpool\.(query|connect)\s*\(/.test(block)) external.push('postgres');
  if (/\b(?:redisDb|redis)\./i.test(block)) external.push('redis');
  if (/\bfetch\s*\(/.test(block)) external.push('network');

  if (!events.length && !edge.likelyTargets.length) {
    return {
      status: 'FAIL',
      reason: 'No observable mock operation or handler target found.',
      events,
      externalDependencies: external
    };
  }

  return {
    status: 'PASS',
    events,
    handlerTargets: edge.likelyTargets,
    externalDependencies: external,
    note: external.length
      ? 'Contract passed; external side effects were intentionally not executed.'
      : 'Contract passed without detected external side effects.'
  };
}

let report;
try {
  report = getReport();
} catch (err) {
  console.error('❌ Phase 3 could not load Phase 2 report:', err.message);
  process.exitCode = 1;
  process.exit();
}

if (!report || !Array.isArray(report.scenarios) || !Array.isArray(report.graph)) {
  console.error('❌ Phase 2 produced an invalid crawler report.');
  process.exitCode = 1;
  process.exit();
}

const results = [];
const seen = new Set();

for (const scenario of report.scenarios) {
  const edge = report.graph.find(item => item.callback === scenario.input.data);
  if (!edge || seen.has(scenario.input.data)) continue;
  seen.add(scenario.input.data);
  let result;
  try {
    result = mockExecute(edge);
  } catch (err) {
    result = { status: 'FAIL', reason: 'Mock contract crashed: ' + err.message };
  }
  results.push({
    id: scenario.id,
    callback: scenario.input.data,
    route: edge.route,
    result
  });
}

const failed = results.filter(x => x.result.status === 'FAIL');
const external = results.filter(x => x.result.externalDependencies && x.result.externalDependencies.length);
const output = {
  phase: 3,
  mode: 'offline-mock-contract',
  scenarios: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  routesWithExternalDependencies: external.length,
  results
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = failed.length ? 1 : 0;
} else {
  console.log('\n🧪 GitroHub Phase 3 — Mock Execution Harness');
  console.log('══════════════════════════════════════════════');
  console.log('Scenarios executed:      ' + output.scenarios);
  console.log('Contract passes:         ' + output.passed);
  console.log('Contract failures:       ' + output.failed);
  console.log('External-dependent:      ' + output.routesWithExternalDependencies);

  if (failed.length) {
    console.log('\n❌ Failures');
    for (const item of failed) console.log('   • ' + item.callback + ' — ' + item.result.reason);
  }

  console.log('\n📋 Sample execution events');
  console.log('──────────────────────────────────────────────');
  for (const item of results.slice(0, 30)) {
    console.log('   ' + item.callback + ' → ' + item.result.status +
      (item.result.events && item.result.events.length ? ' [' + item.result.events.join(', ') + ']' : ''));
  }

  console.log('\n⚠️ External calls are intentionally not executed.');
  console.log('This is a deterministic offline contract test, not a Telegram/GitHub E2E test.');
  console.log('Done.\n');
  process.exitCode = failed.length ? 1 : 0;
}
