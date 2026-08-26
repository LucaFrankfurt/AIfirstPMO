/**
 * Numbers the documentation states, checked against the thing they count.
 *
 * A figure in prose is a claim with no compiler behind it. "MCP exposes 23
 * tools" was written when there were 23; there are fifty now, and nothing
 * anywhere noticed — not the tests, not the typechecker, not the person adding
 * the twenty-fourth. The same had happened to the test count, the size of
 * `app.css` and both of the guide's figures.
 *
 * So each one is written down here beside the expression that produces it, and
 * a number that no longer matches its source fails the build.
 *
 *   node scripts/figures.mjs        # check
 *   node scripts/figures.mjs --fix  # rewrite the ones that are wrong
 *
 * **Only figures whose source is exact and cheap belong here.** A count that
 * needs a browser is asserted in `smoke.mjs`, which is already counting it. A
 * count that changes on every `npm install` — how many packages are in the
 * tree — should not be in prose at all, because it is stale before the reader
 * gets to it; say the thing that stays true instead.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

/* ------------------------------------------------------------ the sources */

const mcp = read('packages/server/src/lib/mcp.ts');
/** Prompts and tools are both `name:` at the same indent; the prompt list names itself. */
const promptNames = [...(mcp.match(/const PROMPTS = \[[\s\S]*?\n\];/) ?? [''])[0]
  .matchAll(/^    name: '([a-z_]+)'/gm)].map((m) => m[1]);
const everyName = [...mcp.matchAll(/^    name: '([a-z_]+)'/gm)].map((m) => m[1]);
const tools = everyName.filter((name) => !promptNames.includes(name));

/** The text between two markers — enough parsing for a literal list. */
const between = (text, start, end) => {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`figures.mjs: "${start}" is not in that file any more`);
  return text.slice(from + start.length).split(end)[0];
};

const FIGURES = [
  {
    what: 'MCP tools',
    actual: tools.length,
    claims: [
      { file: 'README.md', pattern: /\*\*(\d+) tools\*\*/ },
      { file: 'README.md', pattern: /with (\d+) tools, \d+ prompts/ },
      { file: 'TODO.md', pattern: /MCP exposes (\d+) tools/ },
    ],
  },
  {
    what: 'MCP prompts',
    actual: promptNames.length,
    claims: [
      { file: 'README.md', pattern: /\*\*(\d+) prompts\*\*/ },
      { file: 'README.md', pattern: /with \d+ tools, (\d+) prompts/ },
    ],
  },
  {
    what: 'custom field kinds',
    actual: between(read('packages/shared/src/types.ts'), 'FIELD_KINDS = [', ']').split(',').length,
    claims: [{ file: 'README.md', pattern: /custom fields in (nine|\d+) kinds/, words: true }],
  },
  {
    what: 'screens check:responsive walks',
    actual: between(read('scripts/responsive.mjs'), 'const SCREENS = [', '\n];')
      .split('\n').filter((line) => line.trim().startsWith('[')).length,
    claims: [{ file: 'README.md', pattern: /(\d+) screens, 340px/ }],
  },
];

/* -------------------------------------------------------------- the check */

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty'];
const spell = (n) => WORDS[n] ?? String(n);

const fix = process.argv.includes('--fix');
const edits = new Map();
let wrong = 0;
let checked = 0;

for (const figure of FIGURES) {
  for (const claim of figure.claims) {
    const before = edits.get(claim.file) ?? read(claim.file);
    const match = claim.pattern.exec(before);
    if (!match) {
      console.error(`  MISSING  ${claim.file}: nothing matches ${claim.pattern} — the sentence moved, or the figure was dropped`);
      wrong++;
      continue;
    }
    checked++;
    const stated = match[1];
    // A figure may be spelled out. Compare by value, and put back whichever
    // form was there — rewriting "nine kinds" as "9 kinds" is a worse sentence.
    const asNumber = /^\d+$/.test(stated) ? Number(stated) : WORDS.indexOf(stated);
    if (asNumber === figure.actual) continue;

    wrong++;
    const replacement = /^\d+$/.test(stated) ? String(figure.actual) : spell(figure.actual);
    console.error(`  STALE    ${claim.file}: ${figure.what} — says ${stated}, is ${figure.actual}`);
    if (fix) {
      edits.set(claim.file, before.replace(match[0], match[0].replace(stated, replacement)));
    }
  }
}

if (fix && edits.size) {
  for (const [file, text] of edits) writeFileSync(join(ROOT, file), text);
  console.log(`\nRewrote ${edits.size} file(s).`);
  process.exit(0);
}

if (wrong) {
  console.error(`\n${wrong} figure(s) no longer match what they count. \`node scripts/figures.mjs --fix\` rewrites them.`);
  process.exit(1);
}
console.log(`${checked} figures across ${new Set(FIGURES.flatMap((f) => f.claims.map((c) => c.file))).size} files, all matching what they count.`);
