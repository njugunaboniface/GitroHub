#!/usr/bin/env node
'use strict';

/**
 * GitroHub Phase 4 — isolated handler integration harness.
 *
 * This is the first phase that actually feeds synthetic Telegram updates
 * through the real Telegraf bot middleware/router and executes real handler
 * code. Telegram, Redis, Postgres and GitHub are replaced with deterministic
 * in-memory service doubles, so a test can never mutate the real account.
 *
 * It is intentionally NOT a live Telegram E2E test.
 */

const path = require('path');
const Module = require('module');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const ROOT = path.join(__dirname, '..');
const CRAWLER = path.join(__dirname, 'bot-navigation-crawler.js');
const BOT_PATH = path.join(ROOT, 'src', 'bot.js');

function loadScenarios() {
  const { execFileSync } = require('child_process');
  return JSON.parse(execFileSync(process.execPath, [CRAWLER, '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  }));
}

function makeServiceDoubles() {
  const sessions = new Map();
  const sent = [];
  const calls = [];

  const fakeUser = {
    telegram_id: 900000001,
    github_username: 'test-user',
    is_admin: true,
    is_blocked: false,
  };

  const repos = [{
    name: 'demo-repo',
    full_name: 'test-user/demo-repo',
    owner: { login: 'test-user' },
    default_branch: 'main',
    private: false,
    fork: false,
    language: 'JavaScript',
    stargazers_count: 3,
    watchers_count: 3,
    size: 12,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    pushed_at: '2026-09-01T00:00:00Z',
    html_url: 'https://github.com/test-user/demo-repo',
    clone_url: 'https://github.com/test-user/demo-repo.git',
    license: { spdx_id: 'MIT' },
  }];

  const github = new Proxy({}, {
    get(target, prop) {
      const operation = String(prop);
      calls.push({ service: 'github', operation });
      if (prop === 'getRepos' || prop === 'listRepos') return async () => repos;
      if (prop === 'getRepo') return async () => repos[0];
      if (prop === 'getContents' || prop === 'getContent') return async () => ({ data: { content: '', encoding: 'base64', sha: 'fake-sha', name: 'README.md', path: 'README.md', type: 'file' } });
      if (prop === 'getTree' || prop === 'getBranch') return async () => ({ tree: [] });
      if (prop === 'getCollaborators') return async () => [];
      if (prop === 'getIssues' || prop === 'getPulls' || prop === 'getReleases' || prop === 'getTags') return async () => [];
      if (prop === 'deleteRepo' || prop === 'createRepo' || prop === 'updateRepo' || prop === 'createOrUpdateFile' || prop === 'deleteFile') return async () => ({ ok: true, data: {} });
      if (prop === 'downloadZip' || prop === 'downloadFile') return async () => Buffer.from('mock');
      if (prop === 'searchRepos' || prop === 'searchCode') return async () => [];
      return async () => ({ ok: true, data: {} });
    }
  });

  const postgres = {
    pool: {
      query: async (sql) => {
        calls.push({ service: 'postgres', operation: 'query', sql: String(sql).slice(0, 160) });
        const text = String(sql).toLowerCase();
        if (text.includes('select') && text.includes('users')) return { rows: [fakeUser] };
        return { rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
    },
    ping: async () => ({ ok: true, ms: 1 }),
    close: async () => {},
  };

  const redisClient = {
    get: async (key) => sessions.get(key) ? JSON.stringify(sessions.get(key)) : null,
    set: async (key, value) => { sessions.set(key, JSON.parse(value)); return 'OK'; },
    del: async (key) => { sessions.delete(key); return 1; },
    exists: async (key) => sessions.has(key) ? 1 : 0,
    ping: async () => 'PONG',
  };

  const redis = {
    client: redisClient,
    connect: async () => {},
    ping: async () => ({ ok: true, ms: 1 }),
    close: async () => {},
  };

  const users = {
    ensureUser: async () => fakeUser,
    isConnected: async () => true,
    getDecryptedToken: async () => 'mock-github-token',
    recordActivity: async () => {},
    incrementRateLimitHits: async () => {},
    isCurrentlyBanned: async () => false,
    isCurrentlySuspended: async () => false,
    getUser: async () => fakeUser,
    getNotificationPrefs: async () => ({ staleNudge: false }),
    flushActivity: async () => {},
    get: async () => fakeUser,
  };

  const repoCache = {
    getRepos: async () => repos,
    getUser: async () => fakeUser,
    getRepo: async () => repos[0],
    getTreeStats: async () => ({ sizeBytes: 12288 }),
    invalidate: async () => {},
  };

  const common = new Proxy({}, {
    get(target, prop) {
      if (prop === 'list' || prop === 'recent' || prop === 'all' || prop === 'getAll') return async () => [];
      if (prop === 'get' || prop === 'find' || prop === 'getById') return async () => null;
      if (prop === 'isConnected') return async () => true;
      if (prop === 'set' || prop === 'save' || prop === 'clear' || prop === 'remove' || prop === 'delete') return async () => {};
      return async () => {};
    }
  });

  return { sessions, sent, calls, github, postgres, redis, users, repoCache, common };
}

function installMocks(d) {
  process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk';
  process.env.BOT_USERNAME = process.env.BOT_USERNAME || 'GitroHubTestBot';
  process.env.ADMIN_IDS = process.env.ADMIN_IDS || '900000001';
  process.env.OWNER_ID = process.env.OWNER_ID || '900000001';
  process.env.GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'test-client';
  process.env.GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || 'test-secret';
  process.env.BASE_URL = process.env.BASE_URL || 'https://example.test';
  process.env.SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET || 'test-session-secret';
  process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test.invalid/test';
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://test.invalid:6379';
  process.env.NODE_ENV = 'test';

  const accessControl = async () => async (ctx, next) => {
    ctx.state = ctx.state || {};
    ctx.state.isAdmin = true;
    ctx.state.user = await d.users.ensureUser();
    return next();
  };

  const sessionStore = {
    async get(key) { return d.sessions.get(key); },
    async set(key, value) { d.sessions.set(key, value); },
    async delete(key) { d.sessions.delete(key); },
  };

  const exact = new Map([
    [path.resolve(ROOT, 'src/middleware/accessControl.js'), accessControl],
    [path.resolve(ROOT, 'src/middleware/redisSessionStore.js'), sessionStore],
    [path.resolve(ROOT, 'src/db/postgres.js'), d.postgres],
    [path.resolve(ROOT, 'src/db/redis.js'), d.redis],
    [path.resolve(ROOT, 'src/lib/users.js'), d.users],
    [path.resolve(ROOT, 'src/lib/github.js'), d.github],
    [path.resolve(ROOT, 'src/lib/repoCache.js'), d.repoCache],
    [path.resolve(ROOT, 'src/lib/pins.js'), d.common],
    [path.resolve(ROOT, 'src/lib/tags.js'), d.common],
    [path.resolve(ROOT, 'src/lib/activity.js'), d.common],
    [path.resolve(ROOT, 'src/lib/savedViews.js'), d.common],
    [path.resolve(ROOT, 'src/lib/defaults.js'), d.common],
    [path.resolve(ROOT, 'src/lib/pathMemory.js'), d.common],
    [path.resolve(ROOT, 'src/lib/searchHistory.js'), d.common],
    [path.resolve(ROOT, 'src/lib/maintenance.js'), d.common],
    [path.resolve(ROOT, 'src/lib/limits.js'), d.common],
    [path.resolve(ROOT, 'src/lib/roles.js'), d.common],
  ]);

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    try {
      if (request.startsWith('.') && parent && parent.filename) {
        const resolved = Module._resolveFilename(request, parent);
        if (exact.has(path.resolve(resolved))) return exact.get(path.resolve(resolved));
      }
    } catch (_) {}
    return originalLoad.call(this, request, parent, isMain);
  };

  return () => { Module._load = originalLoad; };
}

function installNetworkGuards() {
  const blocked = (name) => function () {
    throw new Error('OFFLINE_TEST_NETWORK_BLOCKED: attempted ' + name);
  };
  const originals = {
    fetch: global.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    tlsConnect: tls.connect,
  };
  global.fetch = blocked('fetch');
  http.request = blocked('http.request');
  http.get = blocked('http.get');
  https.request = blocked('https.request');
  https.get = blocked('https.get');
  net.connect = blocked('net.connect');
  net.createConnection = blocked('net.createConnection');
  tls.connect = blocked('tls.connect');
  return () => {
    global.fetch = originals.fetch;
    http.request = originals.httpRequest;
    http.get = originals.httpGet;
    https.request = originals.httpsRequest;
    https.get = originals.httpsGet;
    net.connect = originals.netConnect;
    net.createConnection = originals.netCreateConnection;
    tls.connect = originals.tlsConnect;
  };
}

function patchTelegram(bot, d) {
  bot.telegram.callApi = async function(method, payload) {
    d.calls.push({ service: 'telegram', operation: method });
    if (method === 'answerCallbackQuery') return true;
    if (method === 'sendMessage' || method === 'editMessageText' || method === 'deleteMessage') {
      d.sent.push({ method, payload });
      return { message_id: 1000 + d.sent.length, chat: { id: 900000001 }, text: payload && payload.text };
    }
    if (method === 'sendDocument' || method === 'sendPhoto' || method === 'sendVideo') {
      d.sent.push({ method, payload });
      return { message_id: 1000 + d.sent.length, chat: { id: 900000001 } };
    }
    return {};
  };
}

function makeUpdate(data) {
  return {
    update_id: 400000000,
    callback_query: {
      id: 'phase4-test-callback',
      from: { id: 900000001, is_bot: false, first_name: 'Phase4' },
      chat_instance: 'phase4',
      message: {
        message_id: 42,
        date: 1767225600,
        chat: { id: 900000001, type: 'private' },
        text: 'Phase 4 test message',
      },
      data,
    },
  };
}

async function run() {
  const report = loadScenarios();
  if (!report || !Array.isArray(report.scenarios)) throw new Error('Phase 2 produced an invalid scenario report.');
  const d = makeServiceDoubles();
  const restore = installMocks(d);
  const restoreNetwork = installNetworkGuards();

  let bot;
  try {
    delete require.cache[require.resolve(BOT_PATH)];
    const createBot = require(BOT_PATH);
    bot = createBot();
    patchTelegram(bot, d);
    // Telegraf's default bot.catch() intentionally swallows handler errors.
    // Re-throw here so a real handler failure cannot become a false PASS.
    bot.catch(async (err) => { throw err; });

    const results = [];
    for (const scenario of report.scenarios) {
      const session = {
        currentRepo: 'demo-repo',
        currentBrowseDir: '',
        currentAdminTarget: 900000002,
      };
      const key = '900000001';
      d.sessions.set(key, session);
      d.sent.length = 0;
      d.calls.length = 0;

      let error = null;
      let timeoutId;
      try {
        const handler = bot.handleUpdate(makeUpdate(scenario.input.data), {});
        const timeout = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('handler timeout after 5000ms')), 5000);
        });
        await Promise.race([handler, timeout]);
      } catch (err) {
        error = { name: err.name, message: err.message };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      const newCalls = d.calls.slice();
      const newSent = d.sent.slice();
      results.push({
        id: scenario.id,
        callback: scenario.input.data,
        status: error ? 'FAIL' : 'PASS',
        error,
        telegramOperations: newCalls.filter(x => x.service === 'telegram').map(x => x.operation),
        replies: newSent.length,
      });
    }

    const failed = results.filter(x => x.status === 'FAIL');
    const output = {
      phase: 4,
      mode: 'isolated-handler-integration',
      realHandlerExecution: true,
      realExternalSideEffects: false,
      scenarios: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      results,
    };

    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log('\n🧪 GitroHub Phase 4 — Isolated Handler Integration');
      console.log('════════════════════════════════════════════════════');
      console.log('Scenarios executed:      ' + output.scenarios);
      console.log('Real handlers executed:  yes');
      console.log('Real external effects:   no');
      console.log('PASS:                    ' + output.passed);
      console.log('FAIL:                    ' + output.failed);
      if (failed.length) {
        console.log('\n❌ Failures');
        for (const item of failed.slice(0, 50))
          console.log('   • ' + item.callback + ' — ' + item.error.message);
        if (failed.length > 50) console.log('   … ' + (failed.length - 50) + ' more');
      }
      console.log('\n⚠️ This executes real GitroHub handlers against deterministic service doubles.');
      console.log('It never contacts Telegram, GitHub, Postgres or Redis.\n');
    }

    process.exitCode = failed.length ? 1 : 0;
  } finally {
    restoreNetwork();
    restore();
  }
}

run().catch((err) => {
  console.error('❌ Phase 4 harness crashed:', err.stack || err.message);
  process.exitCode = 1;
});
