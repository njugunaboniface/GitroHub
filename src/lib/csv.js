/**
 * Minimal CSV writer for 📤 CSV export (Audit Log, Fleet Stats) — quotes
 * and escapes per RFC 4180 (double any embedded quote, wrap in quotes
 * whenever the value contains a comma, quote, or newline). No dependency
 * pulled in for something this small — package.json stays free of a csv
 * library for two export buttons.
 */
function escapeCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/** `columns` is an array of { label, value(row) } — `label` becomes the
 * header cell, `value` extracts and formats that column from one row. */
function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCell(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCell(c.value(row))).join(','));
  return [header, ...lines].join('\r\n');
}

module.exports = { toCsv };
