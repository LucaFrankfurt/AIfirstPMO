/**
 * The scales, kept as scales.
 *
 * `docs/design.md` described five type sizes and three radii for as long as the
 * Tailwind port has been running, and the code agreed with it nowhere. A table
 * in a document is a wish: the source held 594 arbitrary `text-[…px]`, the most
 * common of them (`text-[12px]`, 262 times) a size the table does not list, and
 * 81 `rounded-[var(--radius…)]` written by hand because `rounded` itself had
 * quietly stopped meaning `--radius` (see the note above `@theme static` in
 * `app.css`). Nobody chose any of that. It is what happens when the scale lives
 * in prose and the escape hatch is one bracket away.
 *
 * So the scale is now the theme — `@theme static` declares the steps and clears
 * Tailwind's own — and this is what keeps the source on it. In the web client's
 * TypeScript it refuses:
 *
 *   - an arbitrary font size, radius or shadow: `text-[12px]`, `rounded-[9px]`,
 *     `shadow-[…]`;
 *   - one of Tailwind's own steps the theme does not declare: `text-sm`,
 *     `rounded-xl`, `shadow-lg`. These no longer generate CSS at all, so
 *     `check:css` reports them too — this one says what to use instead;
 *   - a font size or radius written as a number in a style object, which is the
 *     same thing with different punctuation;
 *   - a type step the stylesheet declares and `cn.ts` does not list, or the other
 *     way round. `tailwind-merge` cannot read the stylesheet, and a step it has
 *     not been told about is a colour to it: `cn('text-label', 'text-muted')`
 *     comes back as `text-muted`, and the size is gone with no error anywhere.
 *
 * What it does not look at: `app.css` itself, whose hand-written rules are the
 * part of the port still to come (`design.md` lists what stays there and why),
 * and `packages/feedback`, which ships compiled into other people's apps and has
 * none of these tokens to use.
 *
 *   node scripts/tokens.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'packages/web/src');
const CSS = join(SRC, 'styles/app.css');
const CN = join(SRC, 'kernel/design-system/cn.ts');

/**
 * A value that is off the scale on purpose: `{ file, token, why }`.
 *
 * `file` is relative to `packages/web/src`, `token` is the text as it appears.
 * Every entry says why the scale cannot hold it, and an entry that no longer
 * matches anything fails the check, so the list cannot outlive its reasons.
 * Empty, and the aim is to keep it so: a value the scale is missing is a step
 * to add to `@theme static`, with its reason beside it.
 */
const EXCEPTIONS = [];

/**
 * Tailwind's own steps for the three scales. `@theme static` clears them with
 * `--*: initial`, so the ones it does not declare again generate nothing.
 */
const TAILWIND = {
  text: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'],
  radius: ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'],
  shadow: ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'],
};

/** What the stylesheet's `@theme` blocks declare, with the value of each type step. */
function declared(css) {
  const out = { text: new Map(), radius: new Set(), shadow: new Set() };
  for (const block of css.matchAll(/@theme\b[^{]*\{([^}]*)\}/g)) {
    const body = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, name, value] of body.matchAll(/--text-([a-z0-9]+)\s*:\s*([^;]+);/g)) out.text.set(name, value.trim());
    for (const [, name] of body.matchAll(/--radius(?:-([a-z0-9]+))?\s*:/g)) out.radius.add(name ?? '');
    for (const [, name] of body.matchAll(/--shadow(?:-([a-z0-9]+))?\s*:/g)) out.shadow.add(name ?? '');
  }
  return out;
}

/** The names `cn.ts` hands `tailwind-merge` as font sizes. */
function merged(source) {
  const list = source.match(/TYPE_STEPS\s*=\s*\[([^\]]*)\]/);
  if (!list) return null;
  return new Set([...list[1].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]));
}

function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * Comments blanked, newlines kept, so prose about `text-[12px]` — this file's
 * own docblock, the note in `cn.ts` — is not a use of it, and line numbers
 * still point at the right line.
 *
 * A block comment counts only where one can start: at the beginning of a line
 * or straight after the `{` of a JSX comment. A bare `/*` would also match the
 * one inside `accept="image/*"` and blank everything up to the next comment's
 * end, hiding real code rather than prose.
 */
const decomment = (text) => text
  .replace(/(^|\{)(\s*)\/\*[\s\S]*?\*\//gm, (all, lead, space) => lead + space + all.slice(lead.length + space.length).replace(/[^\n]/g, ' '))
  .replace(/^\s*\/\/.*$/gm, (line) => ' '.repeat(line.length));

const theme = declared(readFileSync(CSS, 'utf8'));
const steps = [...theme.text].map(([name, value]) => `text-${name} ${value}`).join(' · ');
const radii = [...theme.radius].map((name) => (name ? `rounded-${name}` : 'rounded')).join(', ');
const shadows = [...theme.shadow].map((name) => (name ? `shadow-${name}` : 'shadow')).join(', ');

const variants = '(?:[\\w-]+:)*';
const start = '(?<![\\w-])';
const end = '(?![\\w-])';
const off = (all, kept) => all.filter((name) => !kept.has(name)).join('|');
const RULES = [
  {
    pattern: new RegExp(`${start}${variants}text-\\[(?:length:)?-?[\\d.]+(?:px|rem|em)\\]`, 'g'),
    use: `a step: ${steps}`,
  },
  {
    pattern: new RegExp(`${start}${variants}text-(?:${off(TAILWIND.text, theme.text)})${end}`, 'g'),
    use: `one of this theme's steps: ${steps}`,
  },
  {
    pattern: new RegExp(`${start}${variants}rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?-\\[[^\\]\\s]+\\]`, 'g'),
    use: `${radii} or rounded-full`,
  },
  {
    pattern: new RegExp(`${start}${variants}rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?-(?:${off(TAILWIND.radius, theme.radius)})${end}`, 'g'),
    use: `${radii} or rounded-full`,
  },
  {
    pattern: new RegExp(`${start}${variants}shadow-\\[[^\\]\\s]+\\]`, 'g'),
    use: shadows,
  },
  {
    pattern: new RegExp(`${start}${variants}shadow-(?:${off(TAILWIND.shadow, theme.shadow)})${end}`, 'g'),
    use: shadows,
  },
  {
    // A literal only: `fontSize: size * 0.45` is an avatar scaling its initials
    // to whatever size it was asked for, and `var(--…)` is a token.
    pattern: /\b(?:fontSize|borderRadius)\s*:\s*['"`]?-?\.?\d[^,}\n]*/g,
    use: 'the class for the step, not a number in a style object',
  },
];

const findings = [];
const unused = new Set(EXCEPTIONS);
for (const path of sources(SRC)) {
  const file = path.slice(SRC.length + 1);
  const text = decomment(readFileSync(path, 'utf8'));
  for (const { pattern, use } of RULES) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0].trim();
      const excused = EXCEPTIONS.find((entry) => entry.file === file && entry.token === token);
      if (excused) { unused.delete(excused); continue; }
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({ where: `${file}:${line}`, token, use });
    }
  }
}

const problems = [];
const known = merged(readFileSync(CN, 'utf8'));
if (!known) {
  problems.push('cn.ts no longer has a TYPE_STEPS list, so nothing tells tailwind-merge which text-* are sizes.');
} else {
  for (const name of theme.text.keys()) {
    if (!known.has(name)) problems.push(`text-${name} is declared in app.css and missing from TYPE_STEPS in cn.ts — cn() would treat it as a colour and drop it.`);
  }
  for (const name of known) {
    if (!theme.text.has(name)) problems.push(`text-${name} is in TYPE_STEPS in cn.ts and declared nowhere in app.css.`);
  }
}
for (const entry of unused) problems.push(`the exception for ${entry.token} in ${entry.file} matches nothing any more — delete it.`);

if (!findings.length && !problems.length) {
  console.log(`OK — every size, radius and shadow is a step (${theme.text.size} type steps, ${theme.radius.size} radii, ${theme.shadow.size} shadows; ${EXCEPTIONS.length} exceptions, all named).`);
  process.exit(0);
}

if (findings.length) {
  console.log(`${findings.length} value(s) off the scale:\n`);
  for (const { where, token, use } of findings) console.log(`  ${where}\n    ${token}  →  ${use}`);
  console.log('');
}
for (const problem of problems) console.log(`  ${problem}`);
console.log('\nThe scales are declared in `@theme static` in packages/web/src/styles/app.css.');
console.log('A value the scale is missing is a step to add there, with its reason — not a number at the call site.');
process.exit(1);
