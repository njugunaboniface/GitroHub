/**
 * v1.2.0-multi — line-level diff for the Upload Summary screen. Previously
 * a "Modified" file only showed a byte-size delta (e.g. "1.2KB → 1.4KB"),
 * which says nothing about WHAT changed. This adds real +added/-removed
 * line counts plus a short sample of the actual changed lines.
 *
 * Deliberately a simple LCS-based line diff, not a full Myers algorithm —
 * good enough for "what changed at a glance" on files that are realistic
 * to preview inside a Telegram message anyway. Capped at MAX_DIFF_LINES
 * per file: LCS is O(n*m) in both time and memory, so an uncapped diff on
 * a huge file would be a real cost for a feature that's just a preview.
 * Past the cap, callers should fall back to the existing size-only
 * comparison instead of calling this at all.
 */
const MAX_DIFF_LINES = 600;

function computeLineDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) return null;

  const n = oldLines.length;
  const m = newLines.length;
  // Standard LCS length table.
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      lcs[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? lcs[i - 1][j - 1] + 1
        : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }

  // Walk the table backwards to recover which lines were added/removed —
  // standard LCS backtrack, produces changes in reverse (newest-diff-last)
  // order, so the two output arrays get reversed once at the end.
  const added = [];
  const removed = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      i--; j--;
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      removed.push(oldLines[i - 1]);
      i--;
    } else {
      added.push(newLines[j - 1]);
      j--;
    }
  }
  while (i > 0) { removed.push(oldLines[i - 1]); i--; }
  while (j > 0) { added.push(newLines[j - 1]); j--; }
  added.reverse();
  removed.reverse();

  return { added, removed, addedCount: added.length, removedCount: removed.length };
}

/** Best-effort text decode — returns null for anything that doesn't look
 * like UTF-8 text (binary files should never be diffed line-by-line). */
function tryDecodeText(buffer, maxBytes = 200 * 1024) {
  if (!buffer || buffer.length > maxBytes) return null;
  // Cheap binary sniff: a NUL byte pretty reliably means "not text" —
  // real text files essentially never contain one.
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

module.exports = { computeLineDiff, tryDecodeText, MAX_DIFF_LINES };
