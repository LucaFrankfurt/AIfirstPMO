/**
 * Reading a CSV somebody exported from something else.
 *
 * Written out rather than pulled in, for the same reason as everything else
 * here: this is the one file every import passes through, and a parser you can
 * read is worth more than one you have to trust.
 *
 * What it handles, because real exports contain all of it:
 *
 *   - quoted fields with commas, newlines and doubled `""` inside them,
 *   - CRLF and lone CR line endings,
 *   - a UTF-8 byte-order mark, which Excel writes and nothing mentions,
 *   - semicolon and tab delimiters — a German Excel writes `;` and a file that
 *     parses as one enormous column is the most common "import is broken".
 */

/** The delimiters worth guessing between. */
const DELIMITERS = [',', ';', '\t', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/**
 * Guess the delimiter by which one gives the most consistent column count
 * across the first few lines.
 *
 * Counting occurrences alone picks the wrong one as soon as a description
 * contains prose with commas in it; consistency does not.
 */
export function sniffDelimiter(text: string): Delimiter {
  const sample = stripBom(text).split(/\r\n|\r|\n/).filter((line) => line.trim()).slice(0, 20);
  if (!sample.length) return ',';

  let best: Delimiter = ',';
  let bestScore = -1;
  for (const delimiter of DELIMITERS) {
    const counts = sample.map((line) => countOutsideQuotes(line, delimiter));
    if (counts[0] === 0) continue; // not present in the header — not the delimiter
    const consistent = counts.filter((count) => count === counts[0]).length / counts.length;
    // Consistency first, then how many columns it yields, so a file that is
    // consistent under both `,` and `;` picks the one that actually splits it.
    const score = consistent * 100 + Math.min(counts[0], 50);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === delimiter) count++;
  }
  return count;
}

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Parse into rows of raw strings. No header handling — that is `parseCsv`.
 *
 * A single pass over the characters rather than a split, because a field may
 * legitimately contain the delimiter and the line ending.
 */
export function parseCsvRows(text: string, delimiter: string = ','): string[][] {
  const source = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let hadContent = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // A trailing newline is not an empty last record.
    if (hadContent || row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    hadContent = false;
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index];

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      hadContent = true;
      continue;
    }

    if (char === '"') {
      quoted = true;
      hadContent = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\n') {
      endRow();
    } else if (char === '\r') {
      // CRLF and a lone CR both end the record; the LF is swallowed.
      if (source[index + 1] === '\n') index++;
      endRow();
    } else {
      field += char;
      if (char.trim()) hadContent = true;
    }
  }

  // Whatever is left is the last record, unless the file ended on a newline.
  if (field !== '' || row.length) endRow();
  return rows;
}

export interface CsvTable {
  /** Header names, trimmed, in file order. Duplicates are suffixed. */
  columns: string[];
  /** One object per record, keyed by column name. */
  rows: Record<string, string>[];
  delimiter: string;
}

/**
 * Parse with the first record as the header.
 *
 * Short records are padded rather than rejected: a row missing its last two
 * optional columns is a normal export, not a broken file. Long ones keep their
 * extra values under `column_5`-style names so nothing is silently dropped.
 */
export function parseCsv(text: string, delimiter?: string): CsvTable {
  const chosen = delimiter ?? sniffDelimiter(text);
  const raw = parseCsvRows(text, chosen);
  if (!raw.length) return { columns: [], rows: [], delimiter: chosen };

  const seen = new Map<string, number>();
  const columns = raw[0].map((name, index) => {
    const base = name.trim() || `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}_${count + 1}` : base;
  });

  const rows: Record<string, string>[] = [];
  for (const record of raw.slice(1)) {
    // A row of nothing but empty fields is a blank line, not a record.
    if (record.every((value) => value.trim() === '')) continue;
    const row: Record<string, string> = {};
    record.forEach((value, index) => {
      row[columns[index] ?? `column_${index + 1}`] = value.trim();
    });
    for (const column of columns) if (!(column in row)) row[column] = '';
    rows.push(row);
  }

  return { columns, rows, delimiter: chosen };
}
