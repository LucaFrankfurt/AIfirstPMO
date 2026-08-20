/**
 * Classes the source uses that the stylesheet does not define.
 *
 * This exists because of a bug that nothing else could have caught. The port to
 * Tailwind deleted `.field`, `.check-row` and the command palette's list styles
 * in the commit that introduced the components meant to replace them — but the
 * seventy-odd call sites still said `class="field"`. Nothing threw. No request
 * failed. TypeScript was happy, every test passed, and every form in the app
 * quietly lost its spacing while the command palette turned into a paragraph of
 * run-together text.
 *
 * A class name is a string, so the compiler cannot help. What can help is the
 * stylesheet the browser actually loads: if a class appears in a `className`
 * and in no rule anywhere, either it is dead or something is unstyled.
 *
 * Run it against a built app:
 *   node scripts/unstyled.mjs                  # reads packages/web/dist
 *   node scripts/unstyled.mjs http://host:port # reads what a server is serving
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'packages/web/src');
const DIST = join(ROOT, 'packages/web/dist/assets');

/**
 * Classes that are markers rather than styles: a test looks for them, or a
 * component reads them, and nothing is supposed to paint them.
 *
 * Every entry needs a reason. "It was already failing" is not one — that is how
 * a check like this becomes a list of everything.
 */
const MARKERS = new Set([
  'sheet',        // the handle tests and screen rules use to find a dialog
  'gx-device',    // passed to <Frame> in the guide's diagrams, which styles itself
  'gx-inbox',
  'gx-mail',
  'gx-planbar',
  'lines',        // marks which chart a .chart-plot is, for the SVG inside it
  'menu',         // the palette borrows the name; the Radix menu carries the styles
  // Table columns name themselves so a column-visibility setting can address
  // them. The widths come from `.narrow` and from the table, not from these.
  'type', 'state', 'assignees', 'priority', 'due_date', 'estimate', 'labels', 'updated_at',
  'auto-recipient',
]);

/** Every class the stylesheet defines, including inside compound selectors. */
function defined(css) {
  const out = new Set();
  // `\.` escapes matter: Tailwind writes `.text-\[12px\]` for `text-[12px]`.
  for (const match of css.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) {
    out.add(match[1].replace(/\\(.)/g, '$1'));
  }
  return out;
}

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Comments out, so prose about a class is not mistaken for a use of it.
 *
 * Only block comments, and only `//` at the start of a line: a bare `//` rule
 * would eat the `//` in every URL in the file.
 */
const decomment = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  .replace(/^\s*\/\/.*$/gm, '');

/** Only literal class names — an interpolated one is not knowable from here. */
function used() {
  const out = new Map();
  for (const path of sources(SRC)) {
    const text = decomment(readFileSync(path, 'utf8'));
    for (const match of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
      const line = text.slice(0, match.index).split('\n').length;
      for (const token of raw.split(/\s+/)) {
        if (token) out.set(token, out.get(token) ?? `${path.slice(SRC.length + 1)}:${line}`);
      }
    }
  }
  return out;
}

const target = process.argv[2];
let css = '';
if (target) {
  const index = await (await fetch(target)).text();
  for (const match of index.matchAll(/href="([^"]+\.css)"/g)) {
    css += await (await fetch(new URL(match[1], target))).text();
  }
  if (!css) throw new Error(`no stylesheet linked from ${target}`);
} else {
  const files = readdirSync(DIST).filter((name) => name.endsWith('.css'));
  if (!files.length) throw new Error('nothing built — run `npm run build` first');
  css = files.map((name) => readFileSync(join(DIST, name), 'utf8')).join('\n');
}

const rules = defined(css);
const orphans = [...used()].filter(([token]) => !rules.has(token) && !MARKERS.has(token));

if (!orphans.length) {
  console.log(`OK — every class the source uses is defined (${rules.size} in the stylesheet).`);
  process.exit(0);
}
console.log(`${orphans.length} class name(s) used but defined nowhere:\n`);
for (const [token, where] of orphans.sort()) console.log(`  ${token.padEnd(30)} ${where}`);
console.log('\nEither the rule was deleted, or the class is dead and should go.');
process.exit(1);
