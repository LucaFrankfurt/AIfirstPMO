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
const prose = (source) => new RegExp(source.replace(/ /g, '\\s+'), 'd');

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
const { capabilities, endpoints, exceptions, modules, ports, rings } = (() => {
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
             { file: 'docs/modules.md', pattern: prose('generated above — (\\d+) members') },
             { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) capabilities</b>') },
             { file: 'docs/module-map.html', pattern: prose('a sparse partial order, (\\d+) members and') }],
  },
  {
    what: 'edges between capabilities',
    actual: capabilities.edges,
    claims: [{ file: 'docs/modules.md', pattern: prose('capabilities and \\*\\*(\\d+)\\*\\* edges') },
             { file: 'docs/modules.md', pattern: prose('members, (\\d+) edges between them') },
             { file: 'docs/modules.md', pattern: prose('imports across (\\w+) module pairs') },
             { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) edges</b>') },
             { file: 'docs/module-map.html', pattern: prose('members and\\s*(\\d+) edges, no cycles') }],
  },
  {
    what: 'imports from one capability to another',
    actual: capabilities.imports,
    claims: [{ file: 'docs/modules.md', pattern: prose('(\\w+) imports across \\w+ module pairs') },
             { file: 'docs/modules.md', pattern: prose('capability → another capability \\| \\d+ \\| (\\d+) \\|') },
             { file: 'docs/module-map.html', pattern: prose('already are — (\\d+) imports across') }],
  },
  {
    what: 'dependents of the most leaned-on capability',
    actual: capabilities.mostDependents,
    claims: [{ file: 'docs/modules.md', pattern: prose('and \\*\\*(\\d+)\\*\\* of them lean on it') },
             { file: 'docs/module-map.html', pattern: prose('<b>most leaned-on: (\\d+)</b>') },
             { file: 'docs/module-map.html', pattern: prose('<code>pages</code>, and (\\d+) of the other') }],
  },
  {
    what: 'capabilities nothing leans on',
    actual: capabilities.independent,
    claims: [{ file: 'docs/modules.md', pattern: prose('\\*\\*(\\d+)\\*\\* — `automation`, `chat`') },
             { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) leaned on by nobody</b>') }],
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
             { file: 'docs/modules.md', pattern: prose('one of the (\\d+(?: \\d{3})*) counted') },
             { file: 'docs/module-map.html', pattern: prose('There are <strong>([\\d ]+)</strong> ways to split') },
             { file: 'docs/module-map.html', pattern: prose('one of the ([\\d ]+) counted above') }],
  },
  {
    what: 'modules in the best fifth ring available',
    actual: capabilities.bestRingSize,
    claims: [{ file: 'docs/modules.md', pattern: prose('\\*\\*(\\d+)\\*\\* modules that only') },
             { file: 'docs/modules.md', pattern: prose('would be (\\w+) modules that most') },
             { file: 'docs/module-map.html', pattern: prose('<strong>(\\d+) modules that \\d+ of the rest lean on</strong>') }],
  },
  {
    what: 'capabilities leaning on the best fifth ring available',
    actual: capabilities.bestRingLeaners,
    claims: [{ file: 'docs/modules.md', pattern: prose('only \\*\\*(\\d+)\\*\\* of the rest lean on') },
             { file: 'docs/module-map.html', pattern: prose('<strong>\\d+ modules that (\\d+) of the rest lean on</strong>') }],
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
             { file: 'docs/modules.md', pattern: prose('It does so (\\w+) times now') },
             { file: 'docs/module-map.html', pattern: prose('it does so (\\d+) times now') }],
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
             { file: 'docs/modules.md', pattern: prose('# the (\\w+) rules and the tables') },
             { file: 'docs/modules.md', pattern: prose('enforces the (\\w+) rules at the end') },
             { file: 'docs/modules.md', pattern: prose('and it checks (\\w+) rules') },
             { file: 'CLAUDE.md', pattern: prose('enforces the (\\w+) rules') },
             // the script's own docblock, so the tool's description of itself is checked by the tool
             { file: 'scripts/modules.mjs', pattern: prose('and (\\w+) rules are checked against it') }],
  },
  {
    /*
     * The ports, from the `@port` tags themselves. This is the figure that
     * needed a marker before it could exist: the sentence about them said six
     * and named six while there were seven, and nothing in the source said
     * which functions were ports, so nothing could count them.
     */
    what: 'modules that declare a port',
    actual: ports.modules,
    claims: [{ file: 'docs/modules.md', pattern: prose('now does it (\\w+)\\s*times') },
             { file: 'docs/modules.md', pattern: prose('across \\*\\*(\\d+)\\*\\* modules') },
             { file: 'docs/module-map.html', pattern: prose('across <strong>(\\d+) modules</strong> now') }],
  },
  {
    what: 'ports',
    actual: ports.count,
    claims: [{ file: 'docs/modules.md', pattern: prose('There are \\*\\*(\\d+)\\*\\* ports now') },
             { file: 'docs/module-map.html', pattern: prose('There are <strong>(\\d+) ports</strong>') },
             { file: 'docs/module-map.html', pattern: prose('now, and\\s*all (\\d+) are filled') }],
  },
  {
    what: 'ports something fills',
    actual: ports.filled,
    claims: [{ file: 'docs/modules.md', pattern: prose('and \\*\\*(\\d+)\\*\\* of them are filled') }],
  },
  {
    what: 'HTTP endpoints',
    actual: endpoints,
    claims: [{ file: 'docs/module-map.html', pattern: prose('<span class="v num">(\\d+)</span><span class="k">endpoints</span>') }],
  },
  {
    what: 'named layering exceptions',
    actual: exceptions.layering,
    claims: [{ file: 'docs/module-map.html', pattern: prose('<code>routes/</code> file</td> <td>[^<]*</td> <td class="n">(\\d+)</td>') }],
  },
  {
    what: 'named import-knot exceptions',
    actual: exceptions.knots,
    claims: [{ file: 'docs/module-map.html', pattern: prose('<td>No import knots</td> <td>[^<]*</td> <td class="n">(\\d+)</td>') },
             { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) knots left</b>') }],
  },
  {
    what: 'named ring exceptions',
    actual: exceptions.outward,
    claims: [{ file: 'docs/module-map.html', pattern: prose('<td>The rings point one way</td> <td>[^<]*</td> <td class="n">(\\d+)</td>') }],
  },
  {
    what: 'module cycles',
    actual: exceptions.moduleCycles,
    claims: [{ file: 'docs/module-map.html', pattern: prose('<b>(\\d+) module cycles</b>') }],
  }
,
  {
    what: 'MCP tool files still under the adapter',
    actual: readdirSync(join(ROOT, toolsDir)).filter((name) => name.endsWith('.ts')).length,
    claims: [{ file: 'docs/modules.md', pattern: prose('The \\*\\*(\\d+)\\*\\* files sit under the adapter') },
             { file: 'docs/module-map.html', pattern: prose('The <strong>(\\w+)</strong> files sit under the adapter') }],
  },
  {
    /*
     * The per-entity branches the write path handed out but nobody has turned
     * into a descriptor yet. Counted at the three sites the note names, so a
     * new one there fails the note rather than growing behind it — and if one
     * of the three moves, this throws instead of quietly counting less.
     */
    what: 'if (entity === …) branches left in the three effects',
    actual: [
      'packages/server/src/modules/notifications/effects.ts',
      'packages/server/src/adapters/webhooks/effects.ts',
      'packages/server/src/kernel/write-path/repo.ts',
    ].reduce((n, file) => n + (read(file).match(/^ *if \(entity === /gm) ?? []).length, 0),
    claims: [{ file: 'docs/modules.md', pattern: prose('\\*\\*(\\d+)\\*\\* `if \\(entity === …\\)` branches are left') },
             { file: 'docs/module-map.html', pattern: prose('<strong>(\\w+)</strong> branches, in <code>notify</code>') }],
  }
,
  {
    what: 'files in the MCP adapter',
    actual: modules['adapter/mcp'].files,
    claims: [{ file: 'docs/module-map.html', pattern: prose('The adapter is (\\d+) files now') }],
  },
  {
    what: 'lines in the largest MCP file',
    actual: modules['adapter/mcp'].biggestLines,
    claims: [{ file: 'docs/module-map.html', pattern: prose('the largest ([\\d ]+) lines') }],
  },
  {
    what: 'files in the design system',
    actual: modules['kernel/design-system'].files,
    claims: [{ file: 'docs/module-map.html', pattern: prose('now — (\\d+) files, the primitives') }],
  },
  {
    what: 'entities in the registry',
    actual: [...between(read('packages/shared/src/kernel/registry/entities.ts'), 'export type EntityName =', ';')
      .matchAll(/'([a-zA-Z]+)'/g)].length,
    claims: [{ file: 'docs/module-map.html', pattern: prose('<span class="v num">(\\d+)</span><span class="k">entities</span>') },
             { file: 'docs/modules.md', pattern: prose('entities.ts` — (\\d+) entities, six flags') },
             { file: 'scripts/modules.mjs', pattern: prose("'registry': \\['The (\\d+) entities") }],
  },
  {
    what: 'keys in a locale catalogue',
    actual: (read('packages/web/src/kernel/i18n/locales/en.ts').match(/^  '/gm) ?? []).length,
    claims: [{ file: 'docs/module-map.html', pattern: prose('catalogues of ([\\d ]+) keys') }],
  }
,
  {
    /*
     * `docs/module-map.html` is the illustrated version of the document. Its
     * tables and its inventory are generated by `modules.mjs`; these are the
     * numbers inside its *sentences*, which nothing generated could reach.
     * They are here because the page was hand-maintained until now and had
     * quietly gone stale in four places at once — `227 files`, three of the
     * four ring totals, `5 667` lines of MCP, and `5` ring exceptions after
     * the list was emptied.
     */
    what: 'lines in the MCP adapter',
    actual: modules['adapter/mcp'].lines,
    claims: [{ file: 'docs/module-map.html', pattern: prose('<code>adapter/mcp</code> is <strong>([\\d ]+)</strong>') }],
  },
  {
    what: 'lines in the notifications capability',
    actual: modules['capability/notifications'].lines,
    claims: [{ file: 'docs/module-map.html', pattern: prose('It is <strong>([\\d ]+) lines</strong> now') },
             { file: 'docs/modules.md', pattern: prose('It is \\*\\*([\\d ]+)\\*\\* now, in two files') }],
  },
  {
    what: 'lines in repo.ts',
    actual: modules['kernel/write-path'].biggestLines,
    claims: [{ file: 'docs/module-map.html', pattern: prose('It is ([\\d ]+) lines,') },
             { file: 'docs/modules.md', pattern: prose('and to \\*\\*([\\d ]+)\\*\\* later, when') }],
  },
  {
    what: 'lines in the i18n kernel module',
    actual: modules['kernel/i18n'].lines,
    claims: [{ file: 'docs/module-map.html', pattern: prose('module\\.</strong> ([\\d ]+) lines is three') }],
  },
  {
    what: 'MCP tools',
    actual: tools.length,
    claims: [
      { file: 'README.md', pattern: prose('\\*\\*(\\d+) tools\\*\\*') },
      { file: 'README.md', pattern: prose('with (\\d+) tools, \\d+ prompts') },
      { file: 'TODO.md', pattern: prose('MCP exposes (\\d+) tools') },
      { file: 'docs/module-map.html', pattern: prose('<span class="v num">(\\d+)</span><span class="k">MCP tools</span>') },
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

/**
 * Which bolded numbers are a record rather than a measurement.
 *
 * A figure this file checks is a claim about the tree *now*. A document that
 * argues from before-and-after is full of numbers that are neither wrong nor
 * checkable — `108 crossings`, `2 370 lines`, `5 464 → 13 files` — and the two
 * kinds look identical on the page. That is a trap in both directions: nobody
 * can tell which numbers are live, and somebody eventually "fixes" a record to
 * the current value and quietly deletes the evidence for an argument.
 *
 * So every bolded number in the two documents has to be one or the other. A
 * claim above makes it a measurement; an entry here makes it a record, with a
 * line saying what of. Anything that is neither is reported, which means a new
 * bolded number cannot be added without deciding which it is.
 *
 * Same shape as a claim, deliberately: a file and a pattern whose first group
 * is the number. What differs is what the entry asserts — a claim says "this
 * equals what the tree says", a record says "this is what the tree said then".
 */
const HISTORY = [
  { file: 'docs/modules.md', pattern: prose('\\*\\*(\\d+)\\*\\* reads — counted when step 9 shipped'),
    what: 'reads bypassing useQuery when step 9 shipped, counted by reading the call sites' },
  { file: 'docs/modules.md', pattern: prose('was \\*\\*(\\d+) lines\\*\\*'), what: 'notifications, before the write path handed its meaning back' },
  { file: 'docs/modules.md', pattern: prose('with \\*\\*(\\d+) raw SQL'), what: 'raw statements in the one MCP file, before it became a directory' },
  { file: 'docs/modules.md', pattern: prose('came down to \\*\\*([\\d ]+) lines\\*\\*'), what: 'repo.ts at step 7b, between 2 370 and the live figure beside it' },
  { file: 'docs/modules.md', pattern: prose('one \\*\\*([\\d ]+) kB\\*\\* chunk'), what: 'the bundle before code splitting' },
  { file: 'docs/modules.md', pattern: prose('\\| After \\| \\*\\*([\\d ]+) kB\\*\\*'), what: 'the bundle after it, measured then' },
  { file: 'docs/modules.md', pattern: prose('kB\\*\\* \\| \\*\\*([\\d ]+) kB\\*\\* \\|'), what: 'the same, gzipped' },
  { file: 'docs/modules.md', pattern: prose('and all \\*\\*(\\d+)\\*\\* `useQuery` call sites'), what: 'call sites woken by one write, before per-table versions' },
  { file: 'docs/modules.md', pattern: prose(': \\*\\*([\\d ]+) selector runs\\*\\*'), what: 'the measurement that opened finding 6' },
  { file: 'docs/modules.md', pattern: prose('now cost \\*\\*(\\d+) selector runs\\*\\*'), what: 'the same ten writes after step 9, measured then' },
  { file: 'docs/module-map.html', pattern: prose('<strong>(\\d+) lines</strong> — writing a notification'), what: 'notifications, before the write path handed its meaning back' },
  { file: 'docs/module-map.html', pattern: prose('<b>([\\d ]+) lines → 13 files</b>'), what: 'the one MCP file, before the split' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) tools, unchanged</b>'), what: 'the tool surface across that split, counted then' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) SQL'), what: 'raw statements in that file' },
  { file: 'docs/module-map.html', pattern: prose('<b>([\\d ]+) → 1 282 lines</b>'), what: 'repo.ts across finding 2' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+)-line switch gone</b>'), what: 'applyInvariants, removed' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) tests'), what: 'tests that pinned the order the branches ran in' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) knots fixed</b>'), what: 'import knots on the client, at finding 4' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) files in one folder</b>'), what: 'the components folder, before step 10' },
  { file: 'docs/module-map.html', pattern: prose('<b>([\\d ]+) kB → 819 kB</b>'), what: 'the bundle across code splitting' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) kB → 253 kB gzipped</b>'), what: 'the same, gzipped' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) selector runs per keystroke</b>'), what: 'the client store before per-table versions' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) call sites</b>'), what: 'call sites woken by one write, then' },
  { file: 'docs/module-map.html', pattern: prose('<b>([\\d ]+)</b> selector runs'), what: 'ten writes on a board, before step 9' },
  { file: 'docs/module-map.html', pattern: prose('now cost <b>(\\d+)</b> runs'), what: 'the same ten writes after it' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) distinct SELECTs</b>'), what: 'the read side, when finding 7 asked whether it needed a queries.ts' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) written twice</b>'), what: 'of those, the duplicated ones' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) real definition</b>'), what: 'of those, the ones that were a definition rather than a lookup' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) of the 5 exceptions</b><b>kernel/mail'), what: 'how many of the five the mail move accounted for' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) callers, 1 sends mail</b>'), what: 'callers of isEmailAddress when it moved into the kernel' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) of the 5 exceptions</b><b>modules/share'), what: 'how many the share move accounted for' },
  { file: 'docs/module-map.html', pattern: prose('<b>(\\d+) screens embed it</b>'), what: 'screens embedding the share sheet when it moved' },
];

const BOLD = {
  'CLAUDE.md': /\*\*(\d[\d ]*\d|\d)/dg,
  'docs/modules.md': /\*\*(\d[\d ]*\d|\d)/dg,
  'docs/module-map.html': /<(?:strong|b)>\s*(\d[\d ]*\d|\d)/dg,
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

/*
 * Every bolded number, matched against what claims it or records it.
 *
 * Positions rather than values, because the same number is often both — `0`
 * appears as a count that is checked and as a count that is history two
 * paragraphs apart, and comparing the digits would call both covered.
 */
/*
 * What `modules.mjs` writes is left out: those blocks are compared byte for
 * byte against the tree, which is a stronger check than a claim, and asking
 * for both would mean two files guarding the same number.
 */
const HANDWRITTEN = (text) => text
  .replace(/<!-- generated: \w+ -->[\s\S]*?<!-- end -->/g, '')
  .replace(/\/\* generated: \w+ \*\/[\s\S]*?\/\* end \*\//g, '')
  .replace(/<!-- generated by scripts\/modules\.mjs[\s\S]*?<!-- end generated -->/g, '');

const covered = new Map();
for (const { file, pattern } of [...FIGURES.flatMap((f) => f.claims), ...HISTORY]) {
  const text = HANDWRITTEN(edits.get(file) ?? read(file));
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  if (match?.indices?.[1]) (covered.get(file) ?? covered.set(file, new Set()).get(file)).add(match.indices[1][0]);
}
let uncovered = 0;
for (const [file, pattern] of Object.entries(BOLD)) {
  const text = HANDWRITTEN(edits.get(file) ?? read(file));
  for (const match of text.matchAll(pattern)) {
    const at = match.indices[1][0];
    if (covered.get(file)?.has(at)) continue;
    uncovered++;
    const line = text.slice(0, at).split('\n').length;
    const context = text.split('\n')[line - 1].trim().replace(/\s+/g, ' ').slice(0, 96);
    console.error(`  UNMARKED ${file}:${line}: **${match[1]}** is neither checked nor recorded as history — ${context}`);
  }
}
if (uncovered) {
  console.error(
    `\n${uncovered} bolded number(s) with nothing saying whether they are a measurement or a record. `
    + 'Add a claim above if the tree can answer for it, or a HISTORY entry if it is a record of what the tree said then.',
  );
}

if (fix && edits.size) {
  for (const [file, text] of edits) writeFileSync(join(ROOT, file), text);
  console.log(`\nRewrote ${edits.size} file(s).`);
  process.exit(0);
}

if (wrong) {
  console.error(`\n${wrong} figure(s) no longer match what they count. \`node scripts/figures.mjs --fix\` rewrites them.`);
}
if (wrong || uncovered) process.exit(1);

const files = new Set([...FIGURES.flatMap((f) => f.claims.map((c) => c.file)), ...HISTORY.map((h) => h.file)]);
console.log(
  `${checked} figures across ${files.size} files, all matching what they count`
  + `, and ${HISTORY.length} bolded numbers marked as records of what the tree said then.`,
);
