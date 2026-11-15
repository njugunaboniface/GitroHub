/**
 * Tiny in-process metrics registry (v1.2.1-multi).
 *
 * Why hand-rolled instead of prom-client: the bot has a 512MB budget and a
 * deliberately small dependency list, and what's needed is small — counters,
 * gauges and fixed-bucket histograms with BOUNDED label cardinality, rendered
 * either as Prometheus text (GET /metrics) or as a plain object snapshot
 * (consumed by the Admin screen and by Warden, which only ever OBSERVES).
 *
 * Safety properties (all enforced here, not left to callers):
 *  - Cardinality is capped per metric (MAX_SERIES). Past the cap, new label
 *    combinations collapse into one `{overflow="true"}` series instead of
 *    growing memory without bound.
 *  - Label values are truncated and stripped of anything that is not a
 *    harmless identifier character, and label NAMES that look like secrets
 *    (token, authorization, secret, password, key) are dropped outright —
 *    a metric can't leak a credential even if a caller passes one by mistake.
 */
const MAX_SERIES = 200;
const MAX_LABEL_LEN = 48;
const FORBIDDEN_LABEL = /token|authorization|secret|password|key|cookie/i;

const DEFAULT_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

function cleanValue(v) {
  return String(v == null ? '' : v).replace(/[^\w.:/\- ]/g, '_').slice(0, MAX_LABEL_LEN);
}

function labelKey(labels) {
  const entries = Object.entries(labels || {})
    .filter(([k]) => !FORBIDDEN_LABEL.test(k))
    .map(([k, v]) => [k, cleanValue(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { key: entries.map(([k, v]) => `${k}=${v}`).join(','), entries };
}

class Metric {
  constructor(type, name, help, buckets) {
    this.type = type;
    this.name = name;
    this.help = help;
    this.buckets = buckets || null;
    this.series = new Map(); // key -> { entries, value | {sum,count,counts} }
  }

  _slot(labels) {
    const { key, entries } = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= MAX_SERIES) {
        const overflow = this.series.get('overflow=true');
        if (overflow) return overflow;
        s = { entries: [['overflow', 'true']], value: 0 };
        if (this.type === 'histogram') s.value = { sum: 0, count: 0, counts: new Array(this.buckets.length + 1).fill(0) };
        this.series.set('overflow=true', s);
        return s;
      }
      s = { entries, value: 0 };
      if (this.type === 'histogram') s.value = { sum: 0, count: 0, counts: new Array(this.buckets.length + 1).fill(0) };
      this.series.set(key, s);
    }
    return s;
  }

  inc(labels, n = 1) { this._slot(labels).value += n; }
  set(labels, v) { this._slot(labels).value = Number(v) || 0; }
  observe(labels, v) {
    const h = this._slot(labels).value;
    const x = Number(v);
    if (!Number.isFinite(x)) return;
    h.sum += x;
    h.count += 1;
    let i = 0;
    while (i < this.buckets.length && x > this.buckets[i]) i++;
    h.counts[i] += 1;
  }
}

const registry = new Map();

function define(type, name, help, buckets) {
  if (registry.has(name)) return registry.get(name); // idempotent: modules may be re-required in tests
  const m = new Metric(type, name, help, type === 'histogram' ? (buckets || DEFAULT_BUCKETS_MS) : null);
  registry.set(name, m);
  return m;
}

const counter = (name, help) => define('counter', name, help);
const gauge = (name, help) => define('gauge', name, help);
const histogram = (name, help, buckets) => define('histogram', name, help, buckets);

function fmtLabels(entries, extra) {
  const all = extra ? entries.concat([extra]) : entries;
  if (!all.length) return '';
  return `{${all.map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

/** Prometheus text exposition format. */
function renderPrometheus() {
  const lines = [];
  for (const m of registry.values()) {
    lines.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`);
    for (const s of m.series.values()) {
      if (m.type === 'histogram') {
        let cum = 0;
        m.buckets.forEach((b, i) => {
          cum += s.value.counts[i];
          lines.push(`${m.name}_bucket${fmtLabels(s.entries, ['le', b])} ${cum}`);
        });
        cum += s.value.counts[m.buckets.length];
        lines.push(`${m.name}_bucket${fmtLabels(s.entries, ['le', '+Inf'])} ${cum}`);
        lines.push(`${m.name}_sum${fmtLabels(s.entries)} ${s.value.sum}`);
        lines.push(`${m.name}_count${fmtLabels(s.entries)} ${s.value.count}`);
      } else {
        lines.push(`${m.name}${fmtLabels(s.entries)} ${s.value}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Plain-object snapshot: { name: [{ labels, value | {sum,count,avg} }] }. */
function snapshot() {
  const out = {};
  for (const m of registry.values()) {
    out[m.name] = [...m.series.values()].map((s) => {
      const labels = Object.fromEntries(s.entries);
      if (m.type === 'histogram') {
        return { labels, sum: s.value.sum, count: s.value.count, avg: s.value.count ? s.value.sum / s.value.count : 0 };
      }
      return { labels, value: s.value };
    });
  }
  return out;
}

function reset() { for (const m of registry.values()) m.series.clear(); }

module.exports = { counter, gauge, histogram, renderPrometheus, snapshot, reset, MAX_SERIES };
