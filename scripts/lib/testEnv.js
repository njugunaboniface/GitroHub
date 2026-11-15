/**
 * Shared offline test environment (v1.2.3-multi): sets the environment variables
 * config.js needs and replaces every external package (pg, redis, telegraf, ...) with
 * an in-memory stand-in, exactly like scripts/unit-tests.js does, so tests and ad-hoc
 * checks of src/ modules run with only Node's standard library.
 */
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

Object.assign(process.env, {
  BOT_TOKEN: 'unit-test-token',
  BOT_USERNAME: 'UnitTestBot',
  ADMIN_IDS: '1,2',
  OWNER_ID: '1',
  GITHUB_CLIENT_ID: 'unit-test',
  GITHUB_CLIENT_SECRET: 'unit-test',
  BASE_URL: 'https://example.com',
  SESSION_JWT_SECRET: 'unit-test-secret',
  TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
  DATABASE_URL: 'postgres://fake:fake@localhost:5432/fake',
  REDIS_URL: 'redis://localhost:6379',
});

const queries = [];
let queryHandler = () => ({ rows: [], rowCount: 0 });
const redisStore = new Map();
const redisClient = {
  isReady: true,
  on() { return this; },
  async connect() {},
  async set(key, value, opts = {}) {
    if (opts.NX && redisStore.has(key)) return null;
    redisStore.set(key, value);
    return 'OK';
  },
  async get(key) { return redisStore.has(key) ? redisStore.get(key) : null; },
  async del(key) { return redisStore.delete(key) ? 1 : 0; },
  async exists(key) { return redisStore.has(key) ? 1 : 0; },
  async eval() { return 1; },
  async quit() {},
};

function fakeJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return {
    sign(payload, secret, { expiresIn } = {}) {
      const body = { ...payload, exp: Math.floor(Date.now() / 1000) + Number(expiresIn || 600) };
      const head = b64({ alg: 'HS256', typ: 'JWT' });
      const data = `${head}.${b64(body)}`;
      return `${data}.${mac(data, secret)}`;
    },
    verify(token, secret) {
      const [h, p, sig] = String(token).split('.');
      if (!h || !p || !sig || mac(`${h}.${p}`, secret) !== sig) throw new Error('invalid signature');
      return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    },
  };
}

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') {
    class Pool {
      on() {}
      async query(sql, params) { queries.push({ sql, params }); return queryHandler(sql, params); }
      async connect() {
        // A handler may offer real sessions (scripts/lib/realPg.js) so BEGIN/COMMIT genuinely span statements.
        if (typeof queryHandler.connect === 'function') return queryHandler.connect();
        const self = this; return { query: (sql, params) => self.query(sql, params), release() {} };
      }
      async end() {}
    }
    return { Pool, types: { setTypeParser() {} } };
  }
  if (request === 'redis') return { createClient: () => redisClient };
  if (request === '@octokit/rest') return { Octokit: class { constructor() { this.rest = {}; } } };
  if (request === 'telegraf') {
    const btn = (text, extra) => ({ text, ...extra });
    const kb = (rows) => ({ reply_markup: { inline_keyboard: rows }, resize() { return this; } });
    return {
      Markup: {
        inlineKeyboard: kb, keyboard: kb, removeKeyboard: () => ({}),
        button: { callback: (text, data) => btn(text, { callback_data: data }), text: (text) => btn(text), url: (text, url) => btn(text, { url }) },
      },
      Scenes: {
        WizardScene: class { constructor() { this.steps = [...arguments].slice(1); } },
        // A plain scene that just records its handlers, so tests can drive it (enter / text / callback_query).
        BaseScene: class {
          constructor(id) { this.id = id; this.h = {}; }
          enter(fn) { this.enterFn = fn; }
          on(kind, fn) { (this.h[kind] = this.h[kind] || []).push(fn); }
          use() {} action() {} hears() {} command() {}
        },
        Stage: class {},
      },
    };
  }
  if (request === 'express') {
    // The real package when it is installed; otherwise a no-op stand-in so server modules can be loaded offline.
    try { return realLoad.call(this, request, parent, isMain); } catch (_) {
      const mw = () => (req, res, next) => next && next();
      const express = () => ({ use() {}, get() {}, post() {}, put() {}, delete() {}, set() {}, disable() {}, listen() {} });
      express.static = mw; express.json = mw; express.urlencoded = mw; express.raw = mw; express.text = mw;
      return express;
    }
  }
  if (request === 'dotenv') return { config() { return {}; } };
  if (request === 'pino') {
    const noop = () => {};
    const p = () => ({ info: noop, warn: noop, error: noop });
    p.stdTimeFunctions = { isoTime: () => '' };
    return p;
  }
  if (request === 'jsonwebtoken') {
    try { return realLoad.call(this, request, parent, isMain); } catch (_) { return fakeJwt(); }
  }
  return realLoad.call(this, request, parent, isMain);
};

const SRC = path.join(__dirname, '..', '..', 'src');
const req = (p) => require(path.join(SRC, p));

module.exports = {
  req,
  queries,
  redisStore,
  setQueryHandler(fn) { queryHandler = fn; },
  resetQueries() { queries.length = 0; queryHandler = () => ({ rows: [], rowCount: 0 }); },
};
