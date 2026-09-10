/**
 * A fractional index compared as a word.
 *
 * `sort_order` is a base-62 fraction — `orderKey` writes `V`, then `k`, then
 * `s` — and it is only meaningful compared byte for byte. `String.localeCompare`
 * sorts letters first and case second, so it reads `k` before `V`: every list
 * keyed that way comes back with its first item last.
 *
 * This check exists because that has now been wrong twice, in code written
 * years apart and found only by somebody looking at a screen. A ballot read its
 * first option last, and worse: the form that appends an option asks the sorted
 * list for its highest key, kept being handed the lowest, and gave five options
 * two distinct keys between them. The vault listed `development, production,
 * shared, staging` because a workspace is seeded with `C O b n` — production
 * buried in the middle of a list it is meant to head.
 *
 * Both are fixed and both have a test, and a test only covers the call site it
 * names. This covers the ones nobody has written yet.
 *
 *   node scripts/ordering.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PACKAGES = join(ROOT, 'packages');

/**
 * The comparisons a fractional index is allowed to be on the left of.
 *
 * `compareOrder` is the one in `@kolibri/shared` that does it byte for byte;
 * the other two are the named comparators built on it. A fourth belongs here
 * only if it is built on `compareOrder` as well — this list is not a way past
 * the rule, it is the list of things that already obey it.
 */
const ALLOWED = ['compareOrder', 'byOrder', 'byBallotOrder', 'byEnvironmentOrder'];

/**
 * A column that holds a fractional index rather than a word.
 *
 * `sort_order` is the registry's name for it everywhere. `order` on its own is
 * deliberately not here: `order_by` is a saved view's column *name*, which is a
 * word and compares like one.
 */
const KEYS = ['sort_order'];

/** Every TypeScript source under `packages/`, skipping what is not ours. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'ios' || entry === 'android') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * A `localeCompare` whose receiver mentions a fractional index.
 *
 * Deliberately a regex over one line rather than a parse. What it is looking
 * for is short and always written the same way — `a.sort_order.localeCompare(…)`
 * or `(a.sort_order ?? '').localeCompare(…)` — and a TypeScript parse to catch
 * a shape nobody writes would be a dependency this repository does not have.
 * The cost of the regex is that a comparison split over two lines is missed;
 * the cost of missing one is a list in the wrong order, which is what the two
 * tests already catch for the call sites that exist.
 */
const OFFENDING = new RegExp(`[^\\n]*\\b(?:${KEYS.join('|')})\\b[^\\n]*\\.localeCompare\\s*\\(`);

const findings = [];
for (const file of sources(PACKAGES)) {
  const relative = file.slice(PACKAGES.length + 1);
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    // A comment naming the mistake is how it stays documented; only code counts.
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
    if (!OFFENDING.test(code)) return;
    if (ALLOWED.some((name) => code.includes(name))) return;
    findings.push([`${relative}:${index + 1}`, line.trim()]);
  });
}

if (!findings.length) {
  console.log(`OK — no fractional index is compared as a word (${ALLOWED.length} comparators allowed).`);
  process.exit(0);
}

console.log(`${findings.length} place(s) compare a fractional index with localeCompare:\n`);
for (const [where, line] of findings) console.log(`  ${where}\n    ${line.slice(0, 110)}`);
console.log(`\nA \`sort_order\` is a base-62 fraction: locale collation reads \`k\` before \`V\`.`);
console.log(`Use \`compareOrder\` from @kolibri/shared, or one of ${ALLOWED.slice(1).join(', ')}.`);
process.exit(1);
