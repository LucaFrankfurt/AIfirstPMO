/**
 * What a markdown editor does to the text while somebody types in it.
 *
 * All of it is pure: text and a caret in, text and a caret out. The editor is a
 * plain `<textarea>` — deliberately, because a rich-text surface would mean the
 * document and what is on screen were two different things, and this app stores
 * markdown — so every convenience here is a small, testable rewrite of a string
 * rather than a behaviour hidden inside a component.
 *
 * The rule they all follow: **do nothing unless the line asks for it.** Each
 * returns `null` when the key should do its ordinary thing, so a plain Enter in
 * a paragraph is still a plain Enter.
 */

/** A rewrite of the whole text, and where the caret goes afterwards. */
export interface Edit {
  text: string;
  caret: number;
}

/**
 * A list item, taken apart.
 *
 * `marker` is what is repeated on the next line — a bullet as it stands, an
 * ordered number incremented, a quote's `>`. `box` is the checkbox that may
 * follow it, and `content` is what is left, which is how an *empty* item is
 * recognised: an empty item means somebody pressed Enter twice to get out.
 */
interface ListLine {
  indent: string;
  marker: string;
  ordered: number | null;
  box: boolean;
  content: string;
}

const LIST = /^(\s*)(?:([-*+])|(\d+)([.)])|(>))\s+(\[([ xX])\]\s+)?(.*)$/;

function parseLine(line: string): ListLine | null {
  const match = LIST.exec(line);
  if (!match) return null;
  const [, indent, bullet, digits, delimiter, quote, box, , content] = match;
  return {
    indent,
    marker: bullet ?? quote ?? `${digits}${delimiter}`,
    ordered: digits === undefined ? null : Number(digits),
    box: box !== undefined,
    content,
  };
}

const lineStart = (text: string, caret: number): number => text.lastIndexOf('\n', caret - 1) + 1;

/**
 * Enter, inside a list.
 *
 * Continues it: another bullet, the next number, another empty checkbox, the
 * same indent. On an item somebody left empty it ends the list instead, because
 * pressing Enter twice is how every editor that does this lets you stop — and a
 * list that cannot be stopped is worse than one that never continued.
 *
 * A quote continues the same way. `> ` is a prefix, not a marker with a body,
 * so an empty one ends it too.
 */
export function enterInList(text: string, caret: number): Edit | null {
  const start = lineStart(text, caret);
  const line = parseLine(text.slice(start, caret));
  if (!line) return null;

  if (!line.content && !line.box) {
    // An empty item: take the marker away and leave the caret on a bare line.
    const next = `${text.slice(0, start)}${text.slice(caret)}`;
    return { text: next, caret: start };
  }
  if (!line.content && line.box) {
    // An empty checkbox is empty too — the box is not content.
    const next = `${text.slice(0, start)}${text.slice(caret)}`;
    return { text: next, caret: start };
  }

  const marker = line.ordered === null ? line.marker : line.marker.replace(/^\d+/, String(line.ordered + 1));
  const prefix = `${line.indent}${marker} ${line.box ? '[ ] ' : ''}`;
  const next = `${text.slice(0, caret)}\n${prefix}${text.slice(caret)}`;
  return { text: next, caret: caret + 1 + prefix.length };
}

/**
 * Tab and Shift-Tab, inside a list.
 *
 * Two spaces on or off the front of every line the selection touches — the same
 * two spaces the renderer reads as one level of nesting. Outside a list this
 * returns null and Tab goes back to inserting an indent where the caret is,
 * which is what somebody writing a code block wants.
 */
export function indentList(text: string, start: number, end: number, outdent: boolean): Edit | null {
  const from = lineStart(text, start);
  const to = text.indexOf('\n', end) === -1 ? text.length : text.indexOf('\n', end);
  const lines = text.slice(from, to).split('\n');
  if (!parseLine(lines[0])) return null;

  let moved = 0;
  const shifted = lines.map((line) => {
    if (!parseLine(line)) return line;
    if (!outdent) {
      moved += 2;
      return `  ${line}`;
    }
    const taken = /^ {1,2}/.exec(line)?.[0].length ?? 0;
    moved -= taken;
    return line.slice(taken);
  });
  if (!moved) return null;

  const next = `${text.slice(0, from)}${shifted.join('\n')}${text.slice(to)}`;
  // The caret keeps its place in the line rather than jumping to the end of it.
  const first = parseLine(lines[0]) && !outdent ? 2 : -Math.min(2, /^ {0,2}/.exec(lines[0])![0].length);
  return { text: next, caret: Math.max(from, start + first) };
}

/* ------------------------------------------------------- ticking a box off */

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s)/;

/**
 * Flip the nth checkbox in the source.
 *
 * "nth" is counted the way the renderer counts it — top to bottom, skipping
 * fenced code, so a `- [ ]` inside an example is not a checkbox in either place
 * and the indices cannot drift apart. That shared counting is the whole
 * mechanism: the rendered checkbox carries its index, a click hands the index
 * back, and the text is what actually changes.
 */
export function toggleTask(source: string, index: number): string {
  const lines = String(source ?? '').split('\n');
  let seen = -1;
  /** The marker that opened the block we are inside, or empty out in the open. */
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    // Tildes as well as backticks, and a fence closes only on its own marker —
    // the same rule the renderer applies. Counting them differently is how the
    // box a click lands on stops being the box the reader ticked.
    const mark = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (mark) {
      if (!fence) fence = mark[1][0];
      else if (mark[1][0] === fence) fence = '';
      continue;
    }
    if (fence) continue;
    const match = TASK.exec(lines[i]);
    if (!match) continue;
    seen += 1;
    if (seen !== index) continue;
    const checked = match[2].toLowerCase() === 'x';
    lines[i] = `${match[1]}${checked ? ' ' : 'x'}${match[3]}${lines[i].slice(match[0].length)}`;
    return lines.join('\n');
  }
  return String(source ?? '');
}
