/**
 * 📈 GitroHub's own chart renderer (v1.2.3-multi) — draws a real PNG on the bot's own
 * server with nothing but Node's standard library. It replaces the QuickChart HTTP call
 * the Fleet Stats chart used to make, so no data leaves the process, nothing needs to be
 * disclosed as a third-party service, and the chart works with no internet access.
 *
 * The chart type is called a "Pulse" chart: a dark card, a smoothed glowing line over a
 * soft gradient fill, a dashed average line, the PEAK marked with its value, and the latest
 * value in a badge at the end of the line. Everything is drawn by hand:
 *   - a tiny software rasterizer working at 3x resolution and averaged down (anti-aliasing),
 *   - a built-in 5x7 bitmap font (uppercase letters, digits and basic punctuation),
 *   - a minimal PNG encoder (zlib from Node core + CRC32).
 *
 * Like before, it is a best-effort enhancement: callers wrap it in try/catch and still show
 * the text stats if anything goes wrong.
 */
const zlib = require('zlib');

const SS = 3; // supersampling factor

// ── 5x7 bitmap font ───────────────────────────────────────────────────────────
// Each glyph: 7 rows of 5 columns; '#' = ink. Lower-case input is drawn as upper-case.
const GLYPHS = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.####|#....|#....|#....|#....|#....|.####', D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.####|#....|#....|#.###|#...#|#...#|.###.', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.', J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.', P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.', V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####', 3: '.###.|#...#|....#|..##.|....#|#...#|.###.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.', 9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
  ' ': '.....|.....|.....|.....|.....|.....|.....', '-': '.....|.....|.....|#####|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.##..|.##..', ',': '.....|.....|.....|.....|.##..|..#..|.#...',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....', '/': '....#|....#|...#.|..#..|.#...|#....|#....',
  '+': '.....|..#..|..#..|#####|..#..|..#..|.....', '%': '##..#|##..#|...#.|..#..|.#...|#..##|#..##',
  '(': '..#..|.#...|#....|#....|#....|.#...|..#..', ')': '..#..|...#.|....#|....#|....#|...#.|..#..',
  '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
};
const GLYPH_ROWS = Object.fromEntries(Object.entries(GLYPHS).map(([k, v]) => [k, v.split('|')]));

// ── pixel canvas ──────────────────────────────────────────────────────────────
class Canvas {
  constructor(width, height, background) {
    this.w = width * SS;
    this.h = height * SS;
    this.px = new Uint8Array(this.w * this.h * 3);
    for (let i = 0; i < this.px.length; i += 3) {
      this.px[i] = background[0]; this.px[i + 1] = background[1]; this.px[i + 2] = background[2];
    }
  }

  blend(x, y, color, alpha) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || alpha <= 0) return;
    const i = (y * this.w + x) * 3;
    const a = alpha > 1 ? 1 : alpha;
    this.px[i] += (color[0] - this.px[i]) * a;
    this.px[i + 1] += (color[1] - this.px[i + 1]) * a;
    this.px[i + 2] += (color[2] - this.px[i + 2]) * a;
  }

  rect(x0, y0, x1, y1, color, alpha = 1) {
    for (let y = Math.max(0, Math.floor(y0 * SS)); y < Math.min(this.h, Math.ceil(y1 * SS)); y++) {
      for (let x = Math.max(0, Math.floor(x0 * SS)); x < Math.min(this.w, Math.ceil(x1 * SS)); x++) this.blend(x, y, color, alpha);
    }
  }

  roundRect(x0, y0, x1, y1, radius, color, alpha = 1) {
    const r = radius * SS;
    const left = x0 * SS; const top = y0 * SS; const right = x1 * SS; const bottom = y1 * SS;
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(this.h, Math.ceil(bottom)); y++) {
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(this.w, Math.ceil(right)); x++) {
        const cx = x < left + r ? left + r : x > right - r ? right - r : x;
        const cy = y < top + r ? top + r : y > bottom - r ? bottom - r : y;
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) this.blend(x, y, color, alpha);
      }
    }
  }

  circle(cx, cy, radius, color, alpha = 1) {
    const r = radius * SS;
    const ccx = cx * SS; const ccy = cy * SS;
    for (let y = Math.floor(ccy - r); y <= Math.ceil(ccy + r); y++) {
      for (let x = Math.floor(ccx - r); x <= Math.ceil(ccx + r); x++) {
        if ((x - ccx) * (x - ccx) + (y - ccy) * (y - ccy) <= r * r) this.blend(x, y, color, alpha);
      }
    }
  }

  /** A thick line along a polyline: every segment is a capsule (round caps and joins). */
  stroke(points, width, color, alpha = 1) {
    const r = (width * SS) / 2;
    for (let i = 0; i < points.length - 1; i++) {
      const ax = points[i][0] * SS; const ay = points[i][1] * SS;
      const bx = points[i + 1][0] * SS; const by = points[i + 1][1] * SS;
      const dx = bx - ax; const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      for (let y = Math.floor(Math.min(ay, by) - r); y <= Math.ceil(Math.max(ay, by) + r); y++) {
        for (let x = Math.floor(Math.min(ax, bx) - r); x <= Math.ceil(Math.max(ax, bx) + r); x++) {
          let t = ((x - ax) * dx + (y - ay) * dy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + t * dx - x; const py = ay + t * dy - y;
          if (px * px + py * py <= r * r) this.blend(x, y, color, alpha);
        }
      }
    }
  }

  /** Fills the area between a polyline (a function of x) and `baseY`, fading from alphaTop (at the plot top) to alphaBottom. */
  areaUnder(points, baseY, color, alphaTop, alphaBottom, topY) {
    const bottom = baseY * SS;
    const span = Math.max(1, bottom - topY * SS);
    for (let i = 0; i < points.length - 1; i++) {
      const x0 = Math.round(points[i][0] * SS); const x1 = Math.round(points[i + 1][0] * SS);
      // A column shared by two neighbouring segments must be filled once, or it is blended
      // twice and shows as a faint vertical stripe — so every segment stops before its end
      // except the last one.
      const lastX = i === points.length - 2 ? x1 : x1 - 1;
      for (let x = x0; x <= lastX; x++) {
        const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
        const lineY = (points[i][1] + (points[i + 1][1] - points[i][1]) * t) * SS;
        for (let y = Math.max(0, Math.floor(lineY)); y < Math.min(this.h, Math.floor(bottom)); y++) {
          const k = Math.min(1, Math.max(0, (y - topY * SS) / span));
          this.blend(x, y, color, alphaTop + (alphaBottom - alphaTop) * k);
        }
      }
    }
  }

  /** Draws text; `align` is 'left' | 'right' | 'center' relative to x. Returns the drawn width in px (unscaled by SS). */
  text(str, x, y, scale, color, align = 'left', alpha = 1) {
    const text = String(str).toUpperCase();
    const adv = 6 * scale; // 5 columns + 1 spacing
    const widthPx = text.length * adv - scale;
    const startX = align === 'right' ? x - widthPx : align === 'center' ? x - widthPx / 2 : x;
    for (let c = 0; c < text.length; c++) {
      const rows = GLYPH_ROWS[text[c]] || GLYPH_ROWS['?'];
      for (let ry = 0; ry < 7; ry++) {
        for (let rx = 0; rx < 5; rx++) {
          if (rows[ry][rx] !== '#') continue;
          this.rect(startX + c * adv + rx * scale, y + ry * scale, startX + c * adv + (rx + 1) * scale, y + (ry + 1) * scale, color, alpha);
        }
      }
    }
    return widthPx;
  }

  /** Box-filters the supersampled canvas down to the final size and returns raw RGB rows. */
  downsample() {
    const outW = this.w / SS; const outH = this.h / SS;
    const out = Buffer.alloc(outW * outH * 3);
    const n = SS * SS;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        let r = 0; let g = 0; let b = 0;
        for (let sy = 0; sy < SS; sy++) {
          let i = ((y * SS + sy) * this.w + x * SS) * 3;
          for (let sx = 0; sx < SS; sx++) { r += this.px[i]; g += this.px[i + 1]; b += this.px[i + 2]; i += 3; }
        }
        const o = (y * outW + x) * 3;
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
      }
    }
    return { width: outW, height: outH, rgb: out };
  }
}

// ── PNG encoding ──────────────────────────────────────────────────────────────
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

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng({ width, height, rgb }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height); // each scanline starts with filter byte 0 (None)
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── chart geometry ────────────────────────────────────────────────────────────
/** A whole-number axis ceiling that splits into 4 equal "nice" intervals; returns { max, step }. */
function niceScale(maxValue) {
  const m = Math.max(1, maxValue);
  const exp = Math.pow(10, Math.floor(Math.log10(m / 4)));
  const f = m / 4 / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  const step = Math.max(1, Math.ceil(nice * exp)); // counts are whole numbers
  return { max: step * 4, step };
}

/** Catmull-Rom spline through the points, sampled densely, clamped so it never dips outside the plot. */
function smooth(points, samples, minY, maxY) {
  if (points.length < 3) return points.slice();
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]; const p1 = points[i]; const p2 = points[i + 1]; const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 0; s < samples; s++) {
      const t = s / samples; const t2 = t * t; const t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      let y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      y = Math.min(maxY, Math.max(minY, y));
      out.push([x, y]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function shortLabel(label) {
  const s = String(label);
  const iso = s.match(/^\d{4}-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}` : s.slice(0, 8);
}

const PALETTE = {
  page: [8, 13, 24], card: [15, 23, 42], grid: [51, 65, 85], text: [226, 232, 240], muted: [148, 163, 184],
  accent: [56, 189, 248], accent2: [129, 140, 248], peak: [251, 191, 36],
};

/**
 * @param {{ title: string, labels: string[], data: number[], subtitle?: string }} opts
 * @returns {Buffer} a PNG image (900 x 480)
 */
function renderLineChartSync({ title, labels, data, subtitle }) {
  if (!Array.isArray(data) || data.length === 0) throw new Error('A chart needs at least one data point');
  const W = 900; const H = 480;
  const cv = new Canvas(W, H, PALETTE.page);
  cv.roundRect(12, 12, W - 12, H - 12, 22, PALETTE.card);

  const left = 78; const right = W - 44; const top = 118; const bottom = H - 70;
  const values = data.map((v) => Math.max(0, Number(v) || 0));
  const total = values.reduce((a, b) => a + b, 0);
  const avg = total / values.length;
  const peakValue = Math.max(...values);
  const peakIndex = values.indexOf(peakValue);
  const { max, step } = niceScale(peakValue);

  // Title block
  cv.text(title || 'CHART', 44, 38, 3, PALETTE.text);
  cv.text(subtitle || `TOTAL ${total}   AVG ${avg.toFixed(1)}   PEAK ${peakValue}`, 44, 74, 2, PALETTE.muted);

  // Grid + y labels
  for (let tick = 0; tick <= 4; tick++) {
    const y = bottom - ((bottom - top) * tick) / 4;
    cv.rect(left, y - 0.5, right, y + 0.5, PALETTE.grid, tick === 0 ? 0.9 : 0.45);
    cv.text(String(step * tick), left - 12, y - 7, 2, PALETTE.muted, 'right');
  }

  // Points
  const n = values.length;
  const xAt = (i) => (n === 1 ? (left + right) / 2 : left + ((right - left) * i) / (n - 1));
  const yAt = (v) => bottom - ((bottom - top) * v) / max;
  const pts = values.map((v, i) => [xAt(i), yAt(v)]);
  const curve = smooth(pts, 14, top, bottom);

  // Dashed average line
  if (n > 1) {
    const ay = yAt(avg);
    for (let x = left; x < right; x += 14) cv.rect(x, ay - 0.75, Math.min(x + 7, right), ay + 0.75, PALETTE.accent2, 0.65);
  }

  // Area, glow, line
  cv.areaUnder(curve, bottom, PALETTE.accent, 0.38, 0.02, top);
  cv.stroke(curve, 13, PALETTE.accent, 0.10);
  cv.stroke(curve, 8, PALETTE.accent, 0.20);
  cv.stroke(curve, 3.2, PALETTE.accent, 1);
  if (n <= 45) {
    pts.forEach(([x, y]) => {
      cv.circle(x, y, 3.6, PALETTE.card, 1);
      cv.circle(x, y, 2.2, PALETTE.accent, 1);
    });
  }

  // Peak marker
  if (peakValue > 0 && n > 1) {
    const [px, py] = pts[peakIndex];
    cv.circle(px, py, 8, PALETTE.peak, 0.25);
    cv.circle(px, py, 4.6, PALETTE.peak, 1);
    const label = String(peakValue);
    const bw = label.length * 12 + 18;
    const bx = Math.min(right - bw / 2, Math.max(left + bw / 2, px));
    cv.roundRect(bx - bw / 2, py - 36, bx + bw / 2, py - 14, 6, PALETTE.peak, 1);
    cv.text(label, bx, py - 31, 2, PALETTE.page, 'center');
  }

  // Latest-value badge
  const [lx, ly] = pts[n - 1];
  const lastLabel = String(values[n - 1]);
  const lw = lastLabel.length * 12 + 18;
  const badgeX = Math.min(W - 18 - lw, lx + 10);
  const badgeY = Math.min(bottom - 26, Math.max(top - 6, ly - 11));
  cv.circle(lx, ly, 6, PALETTE.accent, 1);
  cv.circle(lx, ly, 2.6, PALETTE.card, 1);
  cv.roundRect(badgeX, badgeY, badgeX + lw, badgeY + 22, 6, PALETTE.accent, 1);
  cv.text(lastLabel, badgeX + lw / 2, badgeY + 5, 2, PALETTE.page, 'center');

  // x labels: at most 6, evenly spaced
  const wanted = Math.min(6, n);
  for (let k = 0; k < wanted; k++) {
    const i = wanted === 1 ? 0 : Math.round(((n - 1) * k) / (wanted - 1));
    cv.text(shortLabel(labels && labels[i] != null ? labels[i] : String(i + 1)), xAt(i), bottom + 16, 2, PALETTE.muted, 'center');
  }
  cv.text('GITROHUB', W - 44, 40, 2, PALETTE.grid, 'right');

  return encodePng(cv.downsample());
}

/** Async wrapper kept so existing callers (`await chartRender.renderLineChart(...)`) work unchanged. */
async function renderLineChart(opts) {
  return renderLineChartSync({ title: opts.title, labels: opts.labels, data: opts.data, subtitle: opts.subtitle });
}

module.exports = { renderLineChart, renderLineChartSync, niceScale, encodePng, crc32 };
