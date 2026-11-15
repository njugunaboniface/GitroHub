/**
 * Worker-thread entry for archive extraction (v1.2.1-multi).
 *
 * Runs the EXISTING, unit-tested readers (lib/archive.js, lib/tarReader.js)
 * unchanged — only where they run changes: on a worker thread, so inflating a
 * large archive can't stall the main thread (and with it every other user's
 * button taps). All the safety limits (output-capped inflate, entry counts,
 * path sanitising, junk filtering) are inside those readers and still apply.
 */
const { parentPort, workerData } = require('worker_threads');
const archive = require('./archive');

function toTransfer(entries, transfer) {
  return entries.map((e) => {
    const out = { ...e };
    if (Buffer.isBuffer(e.data)) {
      // Exact-size ArrayBuffer so transferring doesn't drag along a pooled slab.
      const ab = e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength);
      out.data = ab; out.__buf = true;
      transfer.push(ab);
    }
    return out;
  });
}

try {
  const { op, opts } = workerData;
  const input = Buffer.from(workerData.buffer);
  const transfer = [];
  let result;
  if (op === 'zip') {
    const r = archive.readZip(input, opts);
    result = { ...r, entries: toTransfer(r.entries, transfer) };
  } else if (op === 'gunzip') {
    const out = archive.gunzipBounded(input, opts.maxBytes);
    const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    transfer.push(ab);
    result = { buffer: ab };
  } else if (op === 'tar') {
    const r = require('./tarReader').extractTar(input);
    result = { ...r, entries: toTransfer(r.entries, transfer) };
  } else {
    throw new Error(`unknown archive op: ${op}`);
  }
  parentPort.postMessage({ ok: true, result }, transfer);
} catch (err) {
  parentPort.postMessage({ ok: false, error: { name: err && err.name, code: err && err.code, message: err && err.message } });
}
