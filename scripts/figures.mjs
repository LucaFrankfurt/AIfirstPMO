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
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

/* ------------------------------------------------------------ the sources */

/**
 * Tools and prompts used to share a file and had to be told apart by which
 * list they sat in. They are separate files now — eleven groups under
 * `lib/mcp/tools/`, the prompts with the JSON-RPC envelope — so each is
 * counted where it lives.
 */
const toolsDir = 'packages/server/src/adapters/mcp/tools';
const tools = readdirSync(join(ROOT, toolsDir))
  .filter((name) => name.endsWith('.ts'))
  .flatMap((name) => [...read(join(toolsDir, name)).matchAll(/^    name: '([a-z_]+)'/gm)].map((m) => m[1]));
const promptNames = [...read('packages/server/src/adapters/mcp/index.ts')
  .matchAll(/^    name: '([a-z_]+)'/gm)].map((m) => m[1]);

/**
 * A prose pattern that survives a line wrap.
 *
 * The documents here are wrapped at a hundred columns, so every space in a
 * sentence is a newline waiting to happen, and a pattern written with a plain
 * space stops matching the day somebody reflows the paragraph. That fails
 * loudly rather than silently, but it is still a false alarm — and a false
 * alarm is what teaches people to reach for `--fix` without reading. So a space
 * written here means "whitespace", and the match is still a real substring of
 * the file, which is what `--fix` needs to put the new number back.
 */
const prose = (source) => new RegExp(source.replace(/ /g, '\\s+'));

/** The text between two markers — enough parsing for a literal list. */
const between = (text, start, end) => {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`figures.mjs: "${start}" is not in that file any more`);
  return text.slice(from + start.length).split(end)[0];
};

/**
 * The module graph, from `modules.mjs`, so the argument about the rings is
 * checked against the code rather than against whoever last counted.
 *
 * It is here rather than left as prose because both halves of that argument
 * have been wrong in writing already. The first version of the fifth-ring
 * paragraph miscounted the modules and the dependents, in a paragraph whose
 * whole point was that the number decides the answer; and the table of ring
 * crossings sat at `12` and `1` for two commits after the answers became `0`
 * and `8`, because a table nobody measures is prose with lines around it.
 */
const { capabilities, rings } = (() => {
  /*
   * `modules.mjs` exits non-zero when one of its own rules is broken, which
   * makes `execSync` throw and throw the output away with it. That is the
   * moment this check is least useful as a stack trace: a repository with a
   * layering problem would report a crash here instead of the figures. So the
   * status is ignored and the first line — the JSON, printed before the
   * summary — is read either way.
   */
  const run = spawnSync('node', ['scripts/modules.mjs', '--graph'], { cwd: ROOT, encoding: 'utf8' });
  const line = (run.stdout ?? '').split('\n')[0];
  if (!line.startsWith('{')) throw new Error('figures.mjs: modules.mjs printed no module graph');
  return JSON.parse(line);
})();

const FIGURES = [
  {
    what: 'capabilities',
    actual: capabilities.count,
    claims: [{ file: 'docs/modules.md', pattern: prose('There are \\*\\*(\\d+)\\*\\* capabilities') },
             { file: 'docs/modules.md', pattern: prose('generated above — (\\d+) members') }],
  },
  {
    what: 'edges between capabilities',
    actual: capabilities.edges,
    claims: [{ file: 'docs/modules.md', pattern: prose('capabilities and \\*\\*(\\d+)\\*\\* edges') },
             { file: 'docs/modules.md', pattern: prose('members, (\\d+) edges between them') },
             { file: 'docs/modules.md', pattern: prose('imports across (\\w+) module pairs') }],
  },
  {
    what: 'imports from one capability to another',
    actual: capabilities.imports,
    claims: [{ file: 'docs/modules.md', pattern: prose('(\\w+) imports across \\w+ module pairs') },
             { file: 'docs/modules.md', pattern: prose('capability → another capability \\| \\d+ \\| (\\d+) \\|') }],
  },
  {
    what: 'dependents of the most leaned-on capability',
    actual: capabilities.mostDependents,
    claims: [{ file: 'docs/modules.md', pattern: prose('and \\*\\*(\\d+)\\*\\* of them lean on it') }],
  },
  {
    what: 'capabilities nothing leans on',
    actual: capabilities.independent,
    claims: [{ file: 'docs/modules.md', pattern: prose('\\*\\*(\\d+)\\*\\* — `automation`, `chat`') }],
  },
  {
    what: 'capabilities that neither lean nor are leaned on',
    actual: capabilities.isolated,
    claims: [{ file: 'docs/modules.md', pattern: prose('and (\\w+) of those lean on nothing either') }],
  },
  {
    what: 'ways to split the capabilities into a ring and what sits above it',
    actual: capabilities.splits,
    claims: [{ file: 'docs/modules.md', pattern: prose('Of the \\*\\*(\\d+(?: \\d{3})*)\\*\\* ways to split') },
             { file: 'docs/modules.md', pattern: prose('one of the (\\d+(?: \\d{3})*) counted') }],
  },
  {
    what: 'modules in the best fifth ring available',
    actual: capabilities.bestRingSize,
    claims: [{ file: 'docs/modules.md', pattern: prose('\\*\\*(\\d+)\\*\\* modules that only') },
             { file: 'docs/modules.md', pattern: prose('would be (\\w+) modules that most') }],
  },
  {
    what: 'capabilities leaning on the best fifth ring available',
    actual: capabilities.bestRingLeaners,
    claims: [{ file: 'docs/modules.md', pattern: prose('only \\*\\*(\\d+)\\*\\* of the rest lean on') }],
  },
  {
    what: 'kernel imports of a capability',
    actual: rings['kernel->capability'],
    claims: [{ file: 'docs/modules.md', pattern: prose('kernel → a capability \\| \\d+ \\| \\*\\*(\\d+)\\*\\* \\|') }],
  },
  {
    what: 'kernel imports of an adapter',
    actual: rings['kernel->adapter'],
    claims: [{ file: 'docs/modules.md', pattern: prose('kernel → an adapter \\| \\d+ \\| \\*\\*(\\d+)\\*\\* \\|') }],
  },
  {
    what: 'capability imports of an adapter',
    actual: rings['capability->adapter'],
    claims: [{ file: 'docs/modules.md', pattern: prose('capability → an adapter \\| \\d+ \\| \\*\\*(\\d+)\\*\\* \\|') }],
  },
  {
    what: 'adapter imports of a capability',
    actual: rings['adapter->capability'],
    claims: [{ file: 'docs/modules.md', pattern: prose('adapter → a capability \\| \\d+ \\| (\\d+) \\|') },
             { file: 'docs/modules.md', pattern: prose('It does so (\\w+) times now') }],
  },
  {
    /*
     * The rules `check:modules` enforces, counted from their own headings.
     * The README said four for two of them, which is the failure mode this
     * whole file exists for: a number in prose beside a list that grew.
     */
    what: 'rules check:modules enforces',
    actual: new Set([...read('scripts/modules.mjs').matchAll(/^(?:\/\*| \*) (\d+)\. /gm)]
      .map((m) => m[1])).size,
    claims: [{ file: 'README.md', pattern: prose('the (\\w+) rules `npm run check:modules` enforces') },
             { file: 'docs/modules.md', pattern: prose('# the (\\w+) rules and the tables') }],
  },
  {
    what: 'MCP tools',
    actual: tools.length,
    claims: [
      { file: 'README.md', pattern: prose('\\*\\*(\\d+) tools\\*\\*') },
      { file: 'README.md', pattern: prose('with (\\d+) tools, \\d+ prompts') },
      { file: 'TODO.md', pattern: prose('MCP exposes (\\d+) tools') },
    ],
  },
  {
    what: 'MCP prompts',
    actual: promptNames.length,
    claims: [
      { file: 'README.md', pattern: prose('\\*\\*(\\d+) prompts\\*\\*') },
      { file: 'README.md', pattern: prose('with \\d+ tools, (\\d+) prompts') },
    ],
  },
  {
    what: 'custom field kinds',
    actual: between(read('packages/shared/src/kernel/registry/types.ts'), 'FIELD_KINDS = [', ']').split(',').length,
    claims: [{ file: 'README.md', pattern: prose('custom fields in (nine|\\d+) kinds') }],
  },
  {
    what: 'screens check:responsive walks',
    actual: between(read('scripts/responsive.mjs'), 'const SCREENS = [', '\n];')
      .split('\n').filter((line) => line.trim().startsWith('[')).length,
    claims: [{ file: 'README.md', pattern: prose('(\\d+) screens, 340px') }],
  },
];

/* -------------------------------------------------------------- the check */

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty'];
const spell = (n) => WORDS[n] ?? String(n);

// The document writes thousands with a space, as the generated tables do, so a
// figure over 999 has to be read and written back in that form or it could
// never be checked at all.
const NUMERAL = /^\d{1,3}(?:\s\d{3})+$|^\d+$/;
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** What a figure written like this says. A spelled figure may start a sentence. */
const value = (stated) => (NUMERAL.test(stated)
  ? Number(stated.replace(/\s/g, ''))
  : WORDS.indexOf(stated.toLowerCase()));

/**
 * `actual`, written the way `stated` was: spelled or in digits, spaced or not,
 * capitalised or not. Rewriting "nine kinds" as "9 kinds" is a worse sentence,
 * and rewriting "Fifteen imports" as "fifteen imports" is a broken one.
 */
const like = (stated, actual) => {
  if (NUMERAL.test(stated)) return /\s/.test(stated) ? thousands(actual) : String(actual);
  const word = spell(actual);
  return stated[0] === stated[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word;
};

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
    // A figure may be spelled out. Compare by value, and put it back in
    // whichever form was there.
    if (value(stated) === figure.actual) continue;

    wrong++;
    const replacement = like(stated, figure.actual);
    console.error(`  STALE    ${claim.file}: ${figure.what} — says ${stated}, is ${replacement}`);
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
