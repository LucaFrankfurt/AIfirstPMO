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
 *   - two dark palettes that disagree: the one the OS asks for and the one a
 *     pinned theme asks for are written out twice in `app.css`;
 *   - a type step the stylesheet declares and `cn.ts` does not list, or the other
 *     way round. `tailwind-merge` cannot read the stylesheet, and a step it has
 *     not been told about is a colour to it: `cn('text-label', 'text-muted')`
 *     comes back as `text-muted`, and the size is gone with no error anywhere.
 *
 * And in `app.css`, the rules written by hand, it refuses:
 *
 *   - a font size that is not a step — `var(--text-…)` — or relative to one
 *     (`em`, `%`, `inherit`);
 *   - a radius that is not a step, `0`, `50%` or `999px` (a circle, a pill);
 *   - an elevation that is not one of the two shadows. A box-shadow with no blur
 *     is not an elevation — it is a ring, a focus outline, a drop line drawn
 *     without moving the layout — and those are geometry, so they pass.
 *
 * That half was missing while it said it was "the part of the port still to
 * come", and in the meantime the stylesheet held 26 font sizes and 26 radii:
 * 12px written 34 times beside a 12.5px step, 6px corners beside an 8px one.
 *
 * What it does not look at: `packages/feedback`, which ships compiled into
 * other people's apps and has none of these tokens to use.
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
 * Rules in `app.css` that are off the scale on purpose: `{ selectors | prefix,
 * property?, why }`. `prefix` covers every rule whose selector starts with it;
 * `property` narrows the entry to one of `font-size`, `radius`, `shadow`. As
 * above, an entry that excuses nothing fails the check.
 */
const CSS_EXCEPTIONS = [
  {
    prefix: '.gx-',
    why: "the guide's diagrams draw the app in miniature — a task card at two thirds of its size, "
      + 'an avatar the size of a letter. Their sizes are a drawing\'s proportions, not the type scale.',
  },
  {
    selectors: ['.emoji-trigger', '.emoji-cell', '.reaction-pick'],
    property: 'font-size',
    why: 'an emoji in a picker is sized as an icon is, to the cell it fills, not as text',
  },
  {
    selectors: ['.tabbar a'],
    property: 'font-size',
    why: 'five labels and the add button share a 340px phone; at the caption step, measured in German, '
      + '"Aufgaben" and "Posteingang" ran into each other with no gap between them',
  },
  {
    selectors: ['.canvas-board-name'],
    property: 'font-size',
    why: 'counter-scaled against the canvas zoom (`--inverse`), so it stays one size on screen',
  },
];

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

/**
 * The custom properties a block of declarations sets, in order of appearance.
 *
 * Comments out first: the dark blocks carry a note about status colours, and
 * a `--danger` mentioned in prose is not a declaration.
 */
function declarations(body) {
  const out = new Map();
  for (const [, name, value] of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(name, value.replace(/\s+/g, ' ').trim());
  }
  return out;
}

/**
 * The dark palette, as the OS asks for it and as a pinned theme asks for it.
 *
 * Two blocks because CSS has no way to say "this, under a media query or
 * under an attribute" once: `light-dark()` would, and needs iOS 17.5. So the
 * same twenty-odd values are written twice, and the day one of them is changed
 * in one place only, dark mode looks different depending on whether somebody
 * pinned it — on the machines of exactly the people who care about it most.
 */
function darkBlocks(css) {
  const media = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='light'\]\) \{([^}]*)\}/);
  const pinned = css.match(/:root\[data-theme='dark'\] \{([^}]*)\}/);
  return media && pinned ? [declarations(media[1]), declarations(pinned[1])] : null;
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

/*
 * The stylesheet's own rules. Comments blanked with their newlines kept, so a
 * note quoting `font-size: 12px` is not one, and a line number is still a line.
 */
const cssText = readFileSync(CSS, 'utf8');
const masked = cssText.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
const unusedCss = new Set(CSS_EXCEPTIONS);
const RADIUS_OK = (part) => part === '0' || part === '50%' || part === '999px'
  || (/^var\(--radius(?:-([a-z0-9]+))?\)$/.test(part) && theme.radius.has(part.match(/^var\(--radius(?:-([a-z0-9]+))?\)$/)[1] ?? ''));
const FONT_OK = (value) => /^(?:inherit|initial|unset|smaller|larger)$/.test(value) || /^-?[\d.]+(?:em|%)$/.test(value)
  || (/^var\(--text-([a-z0-9]+)\)$/.test(value) && theme.text.has(value.match(/^var\(--text-([a-z0-9]+)\)$/)[1]));
/** The shadows in a box-shadow list, split on the commas between them rather than inside a colour. */
const shadowsOf = (value) => {
  const out = []; let depth = 0; let from = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) { out.push(value.slice(from, i).trim()); from = i + 1; }
  }
  return [...out, value.slice(from).trim()];
};
/** A shadow that lifts something: anything with a blur. A ring or an inset line has none. */
const lifts = (shadow) => {
  if (shadow === 'none' || /^var\(--shadow(?:-[a-z0-9]+)?\)$/.test(shadow)) return false;
  const lengths = shadow.replace(/\b(?:rgb|hsl|oklch|color-mix|var)\([^)]*\)+/g, ' ').match(/-?[\d.]+(?:px)?(?![\w%])/g) ?? [];
  return lengths.length >= 3 && parseFloat(lengths[2]) !== 0;
};
for (const rule of masked.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
  const selector = rule[1].trim().replace(/\s+/g, ' ');
  if (selector.startsWith('@')) continue; // `@theme` and the token blocks declare variables, not properties
  const bodyAt = rule.index + rule[1].length + 1;
  for (const decl of rule[2].matchAll(/(?<![\w-])(font-size|border(?:-[a-z]+)*-radius|box-shadow)\s*:\s*([^;]+);/g)) {
    const [, prop, raw] = decl;
    const value = raw.trim();
    const kind = prop === 'font-size' ? 'font-size' : prop === 'box-shadow' ? 'shadow' : 'radius';
    const bad = kind === 'font-size' ? !FONT_OK(value)
      : kind === 'radius' ? !value.split(/\s+/).every(RADIUS_OK)
        : shadowsOf(value).some(lifts);
    if (!bad) continue;
    const excused = CSS_EXCEPTIONS.find((entry) => (!entry.property || entry.property === kind)
      && (entry.prefix ? selector.startsWith(entry.prefix) : entry.selectors.includes(selector)));
    if (excused) { unusedCss.delete(excused); continue; }
    const line = masked.slice(0, bodyAt + decl.index).split('\n').length;
    const use = kind === 'font-size' ? `a step: ${[...theme.text.keys()].map((name) => `var(--text-${name})`).join(', ')}`
      : kind === 'radius' ? `${[...theme.radius].map((name) => `var(--radius${name ? `-${name}` : ''})`).join(', ')}, 0, 50% or 999px`
        : 'var(--shadow) or var(--shadow-sm) — or no blur, if it is a ring rather than an elevation';
    findings.push({ where: `styles/app.css:${line}`, token: `${selector} { ${prop}: ${value} }`, use });
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
for (const entry of unusedCss) problems.push(`the stylesheet exception for ${entry.prefix ?? entry.selectors.join(', ')} excuses nothing any more — delete it.`);

const dark = darkBlocks(readFileSync(CSS, 'utf8'));
if (!dark) {
  problems.push('app.css no longer has both dark blocks where this looks for them — the media query and [data-theme=\'dark\'].');
} else {
  const [media, pinned] = dark;
  for (const name of new Set([...media.keys(), ...pinned.keys()])) {
    if (media.get(name) !== pinned.get(name)) {
      problems.push(`${name} is ${media.get(name) ?? 'missing'} when the OS asks for dark and ${pinned.get(name) ?? 'missing'} when dark is pinned — the two dark blocks in app.css must agree.`);
    }
  }
}

if (!findings.length && !problems.length) {
  console.log(`OK — every size, radius and shadow is a step, in the source and in app.css (${theme.text.size} type steps, ${theme.radius.size} radii, ${theme.shadow.size} shadows; ${EXCEPTIONS.length} exceptions in the source and ${CSS_EXCEPTIONS.length} in the stylesheet, all named), and both dark blocks set the same ${dark[0].size} values.`);
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
