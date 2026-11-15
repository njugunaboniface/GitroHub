/**
 * Archive extraction runner (v1.2.1-multi): GATE + WORKER THREAD.
 *
 *   caller → archiveGate (global + per-user concurrency, bounded queue)
 *          → worker thread (CPU work off the main event loop)
 *          → result (entries as Buffers) / the same ArchiveError the sync API throws
 *
 * Why both: the gate bounds how many extractions can hold memory/CPU at once
 * (100 users × a "safe" archive is not safe), and the worker keeps the bot
 * responsive for everyone else while one extraction runs. Falls back to
 * running the same reader inline (still inside the gate) if a worker cannot
 * be started, so extraction never silently stops working.
 *
 * The compressed input is COPIED for the worker (the caller still needs its
 * buffer for password retries / cache release), so peak memory per job is
 * ~2× the archive plus its output — which is exactly what the gate bounds.
 */
const path = require('path');
const { Worker } = require('worker_threads');
const archive = require('./archive');
const { archiveGate } = require('./gate');
const logger = require('./logger');

const WORKER_TIMEOUT_MS = Number(process.env.ARCHIVE_TIMEOUT_MS) || 60000;
const WORKER_FILE = path.join(__dirname, 'archiveWorker.js');

function rebuildError(e) {
  if (e && e.name === 'ArchiveError') return new archive.ArchiveError(e.code, e.message);
  const err = new Error((e && e.message) || 'archive processing failed');
  if (e && e.code) err.code = e.code;
  return err;
}

function fromWorkerResult(op, r) {
  if (op === 'gunzip') return Buffer.from(r.buffer);
  return { ...r, entries: r.entries.map(({ __buf, ...e }) => (__buf ? { ...e, data: Buffer.from(e.data) } : e)) };
}

function inline(op, buffer, opts) {
  if (op === 'zip') return archive.readZip(buffer, opts);
  if (op === 'gunzip') return archive.gunzipBounded(buffer, opts.maxBytes);
  return require('./tarReader').extractTar(buffer);
}

function runInWorker(op, buffer, opts) {
  return new Promise((resolve, reject) => {
    let worker;
    const copy = new Uint8Array(buffer.length);
    copy.set(buffer);
    try {
      worker = new Worker(WORKER_FILE, { workerData: { op, opts, buffer: copy.buffer }, transferList: [copy.buffer], resourceLimits: { maxOldGenerationSizeMb: 192 } });
    } catch (err) {
      return reject(Object.assign(err, { __noWorker: true }));
    }
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(v); };
    const timer = setTimeout(() => finish(reject, new archive.ArchiveError('TOO_LARGE', 'took too long to process')), WORKER_TIMEOUT_MS);
    timer.unref();
    worker.once('message', (m) => (m.ok ? finish(resolve, fromWorkerResult(op, m.result)) : finish(reject, rebuildError(m.error))));
    worker.once('error', (err) => finish(reject, Object.assign(err, { __noWorker: !settled && /Cannot find module|ERR_WORKER/.test(String(err && err.message)) })));
    worker.once('exit', (code) => { if (!settled && code !== 0) finish(reject, new Error(`archive worker exited with code ${code}`)); });
  });
}

/**
 * @param {'zip'|'gunzip'|'tar'} op
 * @param {Buffer} buffer
 * @param {object} opts  readZip options, or { maxBytes } for gunzip
 * @param {{userId?:any, onQueued?:Function, signal?:AbortSignal}} ctx
 */
function run(op, buffer, opts = {}, { userId, onQueued, signal } = {}) {
  return archiveGate().run(userId, async () => {
    try {
      return await runInWorker(op, buffer, opts);
    } catch (err) {
      if (err && err.__noWorker) {
        logger.warn('Archive worker unavailable — extracting inline', { message: err.message });
        await new Promise((r) => setImmediate(r)); // let pending I/O run first
        return inline(op, buffer, opts);
      }
      throw err;
    }
  }, { onQueued, signal });
}

module.exports = {
  readZip: (buffer, opts, ctx) => run('zip', buffer, opts, ctx),
  gunzipBounded: (buffer, maxBytes, ctx) => run('gunzip', buffer, { maxBytes }, ctx),
  extractTar: (buffer, ctx) => run('tar', buffer, {}, ctx),
};
