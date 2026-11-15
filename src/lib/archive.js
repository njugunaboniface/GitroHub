/**
 * Safe archive helpers shared by the upload flow and Trash restore.
 *
 * Why this exists (v1.1.7-multi): the old code trusted two things it must
 * not trust when the archive comes from an arbitrary user —
 *
 *   1. `zlib.gunzipSync(buffer)` decompressed the WHOLE .tar.gz before any
 *      size check ran. gzip reaches ~1000:1, so a 1MB upload could expand to
 *      ~1GB in one synchronous call (blocking the event loop, so even the
 *      memory watchdog couldn't react) and OOM-kill the shared process.
 *   2. The zip guard summed the sizes DECLARED in the zip headers, and those
 *      headers are attacker-controlled — a forged header can claim 10 bytes
 *      for an entry that really inflates to gigabytes.
 *
 * Every decompression here therefore runs with a hard `maxOutputLength`
 * (Node aborts the inflate the moment the output would exceed it), and the
 * ACTUAL bytes produced — not the declared ones — are what get counted.
 *
 * The zip reader is hand-rolled (central directory + local headers, methods
 * 0/8, ZipCrypto) for the same reason tarReader.js is: it only needs the
 * stable, documented PKWARE layout, it has no dependency, and — unlike a
 * library that can't be installed in every environment — it is fully
 * unit-tested (scripts/unit-tests.js, including forged-header bombs and a
 * real `zip --password` archive).
 */

const zlib = require('zlib');

class ArchiveError extends Error {
  /** @param {'CORRUPT'|'NEEDS_PASSWORD'|'BAD_PASSWORD'|'TOO_LARGE'|'TOO_MANY'|'UNSUPPORTED'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

// ── CRC-32 (IEEE) ──────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Bounded gzip ───────────────────────────────────────────────────────
/**
 * gunzip with a hard output cap. Throws ArchiveError('TOO_LARGE') the moment
 * the output would exceed `maxBytes` (never allocating past it) and
 * ArchiveError('CORRUPT') for anything that isn't a valid gzip stream.
 */
function gunzipBounded(buffer, maxBytes) {
  let out;
  try {
    // +1 so "exactly maxBytes" is allowed but "maxBytes + 1" is detectable.
    out = zlib.gunzipSync(buffer, { maxOutputLength: Math.max(1, maxBytes + 1) });
  } catch (err) {
    if (err && err.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ArchiveError('TOO_LARGE', `decompresses to more than ${maxBytes} bytes`);
    }
    throw new ArchiveError('CORRUPT', 'not a valid gzip stream');
  }
  if (out.length > maxBytes) throw new ArchiveError('TOO_LARGE', `decompresses to more than ${maxBytes} bytes`);
  return out;
}

// ── Path hygiene ───────────────────────────────────────────────────────
/**
 * Normalises an archive entry name into a safe repo-relative path, or
 * returns null if it can't be made safe (absolute paths, `..` traversal,
 * drive letters, NUL bytes, `.git` components GitHub's tree API rejects).
 */
function sanitizeArchivePath(name) {
  if (typeof name !== 'string' || name.includes('\0')) return null;
  let p = name.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    if (seg.toLowerCase() === '.git') return null;
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  return parts.join('/');
}

/** macOS Finder / bsdtar leftovers that should never land in a repo. */
function isMacJunk(path, allPaths) {
  const segs = path.split('/');
  if (segs[0] === '__MACOSX') return true;
  const base = segs[segs.length - 1];
  if (base === '.DS_Store') return true;
  if (base.startsWith('._') && base.length > 2) {
    // AppleDouble resource-fork companion — only junk when the real file it
    // belongs to is also in the archive (a lone `._x` might be intentional).
    const sibling = [...segs.slice(0, -1), base.slice(2)].join('/');
    return allPaths.has(sibling);
  }
  return false;
}

/**
 * Turns raw `{ name, data }` entries into upload-ready `{ path, data }`
 * entries: sanitises paths, drops macOS junk (unless dropJunk:false — Trash
 * restore wants a faithful copy), de-duplicates (last entry wins), and strips
 * a single shared top-level folder.
 *
 * @returns {{ entries: {path:string,data:Buffer}[], junkSkipped:number, unsafeSkipped:number }}
 */
function prepareEntries(rawEntries, { dropJunk = true } = {}) {
  let unsafeSkipped = 0;
  const cleaned = [];
  for (const e of rawEntries) {
    const path = sanitizeArchivePath(e.name);
    if (path === null) { unsafeSkipped++; continue; }
    cleaned.push({ path, data: e.data });
  }

  let junkSkipped = 0;
  let kept = cleaned;
  if (dropJunk) {
    const allPaths = new Set(cleaned.map((e) => e.path));
    kept = cleaned.filter((e) => {
      if (isMacJunk(e.path, allPaths)) { junkSkipped++; return false; }
      return true;
    });
  }

  // De-duplicate — a tree with the same path twice is rejected by GitHub.
  const byPath = new Map();
  for (const e of kept) byPath.set(e.path, e);
  let entries = [...byPath.values()];

  // Strip one shared top-level folder ("project/…" → "…").
  if (entries.length > 0) {
    const tops = new Set(entries.map((e) => e.path.split('/')[0]));
    if (tops.size === 1) {
      const only = [...tops][0];
      if (entries.every((e) => e.path.startsWith(`${only}/`))) {
        entries = entries.map((e) => ({ path: e.path.slice(only.length + 1), data: e.data }));
      }
    }
  }
  return { entries, junkSkipped, unsafeSkipped };
}

// ── ZipCrypto (traditional PKWARE encryption — what `zip -P` writes) ──
function zipCryptoDecrypt(encrypted, password, crc, dosTime, flags) {
  const keys = [0x12345678, 0x23456789, 0x34567890];
  const updateKeys = (b) => {
    keys[0] = (CRC_TABLE[(keys[0] ^ b) & 0xff] ^ (keys[0] >>> 8)) >>> 0;
    keys[1] = (keys[1] + (keys[0] & 0xff)) >>> 0;
    keys[1] = (Math.imul(keys[1], 134775813) + 1) >>> 0;
    keys[2] = (CRC_TABLE[(keys[2] ^ (keys[1] >>> 24)) & 0xff] ^ (keys[2] >>> 8)) >>> 0;
  };
  for (const b of Buffer.from(password, 'utf8')) updateKeys(b);

  const out = Buffer.allocUnsafe(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    const k = (keys[2] | 2) & 0xffff;
    const plain = encrypted[i] ^ ((Math.imul(k, k ^ 1) >>> 8) & 0xff);
    out[i] = plain;
    updateKeys(plain);
  }
  if (out.length < 12) throw new ArchiveError('CORRUPT', 'encrypted entry too short');
  const check = out[11];
  const okByCrc = check === ((crc >>> 24) & 0xff);
  const okByTime = (flags & 0x8) !== 0 && check === ((dosTime >>> 8) & 0xff);
  if (!okByCrc && !okByTime) throw new ArchiveError('BAD_PASSWORD', 'wrong password');
  return out.subarray(12);
}

// ── Zip reader ─────────────────────────────────────────────────────────
const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ArchiveError('CORRUPT', 'no zip directory found');
}

/**
 * Reads a .zip fully in memory with hard limits.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {string} [opts.password]      ZipCrypto password, if any entry is encrypted
 * @param {number} opts.maxTotalBytes   cap on the ACTUAL decompressed bytes, all entries combined
 * @param {number} [opts.maxEntries]    cap on the number of file entries
 * @param {boolean} [opts.dropJunk]     drop macOS junk (default true)
 * @returns {{ entries: {path:string,data:Buffer}[], junkSkipped:number, unsafeSkipped:number, encrypted:boolean }}
 * @throws {ArchiveError}
 */
function readZip(buffer, opts = {}) {
  const { password, maxTotalBytes, maxEntries = 2000, dropJunk = true } = opts;
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) throw new Error('readZip: maxTotalBytes is required');
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new ArchiveError('CORRUPT', 'too small to be a zip');

  const eocd = findEocd(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ArchiveError('UNSUPPORTED', 'zip64 archives are not supported');
  }
  if (cdOffset + cdSize > buffer.length) throw new ArchiveError('CORRUPT', 'zip directory is truncated');

  // Pass 1 — metadata only. Nothing is decompressed yet.
  const metas = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== SIG_CEN) throw new ArchiveError('CORRUPT', 'bad zip directory entry');
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const dosTime = buffer.readUInt16LE(pos + 12);
    const crc = buffer.readUInt32LE(pos + 16);
    const compSize = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    if (pos + 46 + nameLen > buffer.length) throw new ArchiveError('CORRUPT', 'bad zip directory entry');
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry
    metas.push({ name, flags, method, dosTime, crc, compSize, size, localOffset });
  }

  if (metas.length > maxEntries) throw new ArchiveError('TOO_MANY', `contains ${metas.length} files (limit ${maxEntries})`);

  // Decide what to keep BEFORE decompressing, so junk never eats the budget.
  const named = [];
  let unsafeSkipped = 0;
  for (const m of metas) {
    const p = sanitizeArchivePath(m.name);
    if (p === null) { unsafeSkipped++; continue; }
    named.push({ ...m, path: p });
  }
  const allPaths = new Set(named.map((m) => m.path));
  let junkSkipped = 0;
  const keep = dropJunk
    ? named.filter((m) => { if (isMacJunk(m.path, allPaths)) { junkSkipped++; return false; } return true; })
    : named;

  const encrypted = keep.some((m) => (m.flags & 0x1) !== 0);
  if (encrypted && !password) throw new ArchiveError('NEEDS_PASSWORD', 'archive is password-protected');

  // Cheap early reject on the DECLARED sizes (an honest archive is caught
  // here without decompressing anything). Not trusted for safety — the
  // capped inflate below is what actually enforces the limit.
  const declared = keep.reduce((s, m) => s + m.size, 0);
  if (declared > maxTotalBytes) throw new ArchiveError('TOO_LARGE', `declares ${declared} bytes uncompressed`);

  // Pass 2 — decompress with a shrinking budget of ACTUAL bytes.
  let total = 0;
  const raw = [];
  for (const m of keep) {
    if (m.flags & 0x40) throw new ArchiveError('UNSUPPORTED', 'strong (AES/PKWARE) encryption is not supported');
    if (m.method !== 0 && m.method !== 8) {
      throw new ArchiveError('UNSUPPORTED', m.method === 99 ? 'AES-encrypted zips are not supported' : `compression method ${m.method} is not supported`);
    }
    const lo = m.localOffset;
    if (lo + 30 > buffer.length || buffer.readUInt32LE(lo) !== SIG_LOC) throw new ArchiveError('CORRUPT', 'bad local file header');
    const start = lo + 30 + buffer.readUInt16LE(lo + 26) + buffer.readUInt16LE(lo + 28);
    const end = start + m.compSize;
    if (end > buffer.length) throw new ArchiveError('CORRUPT', 'entry data is truncated');
    let payload = buffer.subarray(start, end);

    const isEnc = (m.flags & 0x1) !== 0;
    if (isEnc) payload = zipCryptoDecrypt(payload, password, m.crc, m.dosTime, m.flags);

    const remaining = maxTotalBytes - total;
    let data;
    if (m.method === 0) {
      data = payload;
    } else if (payload.length === 0) {
      data = Buffer.alloc(0);
    } else {
      try {
        data = zlib.inflateRawSync(payload, { maxOutputLength: Math.max(1, remaining + 1) });
      } catch (err) {
        if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw new ArchiveError('TOO_LARGE', `decompresses to more than ${maxTotalBytes} bytes`);
        throw new ArchiveError(isEnc ? 'BAD_PASSWORD' : 'CORRUPT', isEnc ? 'wrong password' : 'entry is corrupted');
      }
    }
    if (data.length > remaining) throw new ArchiveError('TOO_LARGE', `decompresses to more than ${maxTotalBytes} bytes`);
    if (data.length !== m.size || crc32(data) !== m.crc) {
      throw new ArchiveError(isEnc ? 'BAD_PASSWORD' : 'CORRUPT', isEnc ? 'wrong password' : 'entry failed its integrity check');
    }
    total += data.length;
    raw.push({ name: m.path, data });
  }

  // Paths are already sanitised above; prepareEntries still de-dupes and
  // strips the shared top-level folder (junk was handled pre-decompression).
  const prepared = prepareEntries(raw, { dropJunk: false });
  return { entries: prepared.entries, junkSkipped, unsafeSkipped, encrypted };
}

module.exports = {
  ArchiveError,
  crc32,
  gunzipBounded,
  sanitizeArchivePath,
  isMacJunk,
  prepareEntries,
  readZip,
};
