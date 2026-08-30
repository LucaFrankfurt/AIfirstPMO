/**
 * A line diff, for "what changed" between two versions of a page.
 *
 * The classic Myers algorithm would be the thorough answer; this is the
 * longest-common-subsequence table, which is O(n·m) and entirely fine for a
 * wiki page — a document long enough to matter is a few hundred lines, and the
 * table is built once when somebody opens the history.
 *
 * Written out rather than pulled in for the same reason as the CSV parser: it
 * is small, it is read by people looking at their own writing, and a diff you
 * can read is worth more than one you have to trust.
 */

export type DiffOp = 'same' | 'added' | 'removed';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the old text, when the line exists there. */
  before?: number;
  /** 1-based line number in the new text, when the line exists there. */
  after?: number;
}

/** Guard rail: past this the table is not worth building and nobody reads it anyway. */
const MAX_LINES = 4000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = split(before);
  const b = split(after);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    // Honest degradation: say the whole thing changed rather than hang.
    return [
      ...a.map((text, index): DiffLine => ({ op: 'removed', text, before: index + 1 })),
      ...b.map((text, index): DiffLine => ({ op: 'added', text, after: index + 1 })),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i…] and b[j…].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i], before: i + 1, after: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: 'removed', text: a[i], before: i + 1 });
      i++;
    } else {
      out.push({ op: 'added', text: b[j], after: j + 1 });
      j++;
    }
  }
  while (i < a.length) out.push({ op: 'removed', text: a[i], before: ++i });
  while (j < b.length) out.push({ op: 'added', text: b[j], after: ++j });
  return out;
}

/** How much moved, for a one-line summary above the diff. */
export const diffSummary = (lines: DiffLine[]): { added: number; removed: number } => ({
  added: lines.filter((line) => line.op === 'added').length,
  removed: lines.filter((line) => line.op === 'removed').length,
});

/**
 * Unchanged runs longer than `context` collapse to a marker, so a one-word fix
 * in a long page is one screen rather than a scroll to find the green line.
 */
export function collapse(lines: DiffLine[], context = 3): (DiffLine | { op: 'skipped'; count: number })[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.op === 'same') return;
    for (let at = index - context; at <= index + context; at++) keep.add(at);
  });

  const out: (DiffLine | { op: 'skipped'; count: number })[] = [];
  let run = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (run) {
        out.push({ op: 'skipped', count: run });
        run = 0;
      }
      out.push(line);
    } else {
      run++;
    }
  });
  if (run) out.push({ op: 'skipped', count: run });
  return out;
}

/**
 * An empty document is zero lines, not one empty one.
 *
 * `''.split('\n')` gives `['']`, which would make creating a page show as one
 * line removed and one added — a change nobody made.
 */
function split(text: string): string[] {
  const normalised = String(text ?? '').replace(/\r\n?/g, '\n');
  return normalised === '' ? [] : normalised.split('\n');
}
