/**
 * The regressions a design system can introduce silently.
 *
 * These read the source rather than run it, which is unusual and deliberate.
 * Both rules below are invisible at runtime — nothing throws, nothing logs, the
 * screen looks right — and both were real: the port replaced a few hundred
 * `<button class="btn">` with `<Button>`, and `Button` defaults to
 * `type="button"` the way every React design system does. That default is
 * correct: a bare `<button>` inside a form submitting it is a footgun. But at
 * the one call site where the form's submit button was converted and nobody
 * added `type="submit"` back, *Create project* became a button that does
 * nothing at all. No error, no request, no clue.
 *
 * A browser test would catch that one form. This catches the next one.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { twMerge } from 'tailwind-merge';

const SRC = new URL('../src', import.meta.url).pathname;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/**
 * The index just past the `>` that closes the JSX tag opening at `start`.
 *
 * A regex cannot do this: `onChange={(event) => …}` contains a `>` that is not
 * the end of anything, and so does `size={a > b ? 1 : 2}`. Braces and quotes
 * are tracked so the scan stops at the right one.
 */
function endOfTag(text: string, start: number): number {
  let quote: string | null = null;
  let brace = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && brace === 0) {
      quote = c;
    } else if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '>' && brace === 0) return i + 1;
  }
  return text.length;
}

const files = sources(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/** `<form …>…</form>`, one entry per form, with the line it starts on. */
function forms(): { file: string; line: number; body: string }[] {
  const out: { file: string; line: number; body: string }[] = [];
  for (const { path, text } of files) {
    for (const match of text.matchAll(/<form\b/g)) {
      const close = text.indexOf('</form>', match.index!);
      if (close < 0) continue;
      out.push({
        file: path.slice(SRC.length + 1),
        line: text.slice(0, match.index).split('\n').length,
        body: text.slice(match.index!, close),
      });
    }
  }
  return out;
}

describe('every form', () => {
  const all = forms();

  it('is found at all — a scanner that matches nothing passes everything', () => {
    assert.ok(all.length >= 5, `only found ${all.length} forms, which means the scan is broken`);
  });

  it('has a button that actually submits it', () => {
    const broken: string[] = [];
    for (const form of all) {
      if (!form.body.includes('onSubmit')) continue;
      let submits = false;
      for (const match of form.body.matchAll(/<(Button|button)\b/g)) {
        const tag = form.body.slice(match.index!, endOfTag(form.body, match.index!));
        if (/type=(?:"submit"|\{['"]submit['"]\})/.test(tag)) submits = true;
        // A plain `<button>` with no type is a submit button by HTML's own
        // rules. `<Button>` is not, and that is the whole trap.
        else if (match[1] === 'button' && !/type=/.test(tag)) submits = true;
      }
      if (!submits) broken.push(`${form.file}:${form.line}`);
    }
    assert.deepEqual(broken, [], `form(s) with no way to submit: ${broken.join(', ')}`);
  });
});

/**
 * A label pointing at nothing is a label that does not focus its field, does
 * not enlarge its hit target, and reads as unlabelled to a screen reader. The
 * port moved a lot of `<input>`s into `<Input>`; an `id` left behind on the way
 * is silent.
 */
describe('every label', () => {
  it('points at a control that exists in the same file', () => {
    const orphans: string[] = [];
    for (const { path, text } of files) {
      const ids = new Set([...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
      for (const match of text.matchAll(/htmlFor="([^"]+)"/g)) {
        if (!ids.has(match[1])) {
          orphans.push(`${path.slice(SRC.length + 1)}:${text.slice(0, match.index).split('\n').length} → "${match[1]}"`);
        }
      }
    }
    assert.deepEqual(orphans, [], `label(s) pointing at nothing: ${orphans.join(', ')}`);
  });
});

/**
 * Two utilities in one string that mean opposite things.
 *
 * `class="flex items-center gap-2 gap-1.5"` is not a style — it is a coin
 * toss. Both classes exist, both apply, and which one wins depends on the
 * order Tailwind happened to emit them in, which depends on what else the app
 * uses. The port's codemod prefixed a lot of elements with a layout triple and
 * left whatever was already there behind it, so eighty-three strings ended up
 * in this state and a good number of them rendered at the wrong gap.
 *
 * `cn()` — which is `twMerge` — resolves exactly this, last one wins. So the
 * check is: does merging the string change it? If it does, the string is
 * asking for two things at once and only one of them is happening.
 */
describe('every className literal', () => {
  it('does not contain a utility that another one in the same string overrides', () => {
    const conflicts: string[] = [];
    for (const { path, text } of files) {
      for (const match of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const raw = match[1] ?? match[2] ?? '';
        // An interpolated string is assembled at runtime; nothing here can say
        // what it will contain, and those call sites go through `cn()` anyway.
        if (raw.includes('${')) continue;
        const tokens = raw.split(/\s+/).filter(Boolean);
        const merged = twMerge(tokens.join(' ')).split(/\s+/).filter(Boolean);
        if (merged.length === tokens.length) continue;
        const lost = tokens.filter((token) => !merged.includes(token));
        const line = text.slice(0, match.index).split('\n').length;
        conflicts.push(`${path.slice(SRC.length + 1)}:${line} loses ${lost.join(', ')}`);
      }
    }
    assert.deepEqual(conflicts, [], `self-conflicting class string(s):\n  ${conflicts.join('\n  ')}`);
  });
});

/**
 * An icon and a tooltip is not a name.
 *
 * `title` is a hint for a mouse pointer. It is announced inconsistently, it is
 * skipped entirely by some screen readers, and on a touchscreen it never
 * appears at all — so a button whose only text is an icon and whose only words
 * are in a `title` reads as "button" and is, on a phone, a small grey square
 * nobody can identify. This was most of what the first accessibility pass over
 * this app found, and the reason the *tool* is not always intuitive is the same
 * reason: a picture with no word next to it is a guess.
 *
 * `Button` and `MenuButton` derive the name from `title` when there is nothing
 * else, so the components are covered. This catches the raw `<button>` that
 * does not go through them — the layout switcher was exactly that.
 */
describe('every icon-only control', () => {
  /** Text a screen reader would read out of the tag's own children. */
  const speaks = (body: string): boolean =>
    // Words between the tags, ignoring JSX elements and expressions. `{t('x')}`
    // counts: a translated string is text, whatever it renders to.
    /(^|>)[^<>{}]*[A-Za-z0-9][^<>{}]*(<|$)/.test(body) || /\{t\(/.test(body) || /\{[a-z]\w*\.(name|title|label)\b/.test(body);

  it('has a name that is not only a title attribute', () => {
    const mute: string[] = [];
    for (const { path, text } of files) {
      for (const match of text.matchAll(/<button\b/g)) {
        const end = endOfTag(text, match.index!);
        const tag = text.slice(match.index!, end);
        if (!/\btitle=/.test(tag)) continue;
        if (/\baria-label(?:ledby)?=/.test(tag)) continue;
        const close = text.indexOf('</button>', end);
        const body = close < 0 ? '' : text.slice(end, close);
        if (speaks(body)) continue;
        mute.push(`${path.slice(SRC.length + 1)}:${text.slice(0, match.index).split('\n').length}`);
      }
    }
    assert.deepEqual(mute, [], `button(s) named only by a tooltip: ${mute.join(', ')}`);
  });
});

/**
 * A tab strip scrolls sideways when its labels do not fit, and a scrolled strip
 * can hold the tab you are on off the end of itself — on a phone, `?tab=…` for
 * anything but the first tab opened with no underline visible anywhere. The fix
 * is `useTabStrip`, which is easy to leave off the next strip somebody adds:
 * nothing throws, and at a desktop width where everything fits, nothing looks
 * wrong either.
 */
describe('every tab strip', () => {
  const strips = files.flatMap(({ path, text }) =>
    [...text.matchAll(/<div\b[^>]*className=(?:"tabs[^"]*"|\{[^}]*'tabs[^']*'[^}]*\})[^>]*>/g)].map((match) => ({
      file: path.slice(SRC.length + 1),
      line: text.slice(0, match.index).split('\n').length,
      tag: match[0],
      imports: text.includes('useTabStrip'),
    })));

  it('is found at all — a scanner that matches nothing passes everything', () => {
    assert.ok(strips.length >= 5, `only found ${strips.length} tab strips, which means the scan is broken`);
  });

  it('keeps the active tab in view', () => {
    const adrift = strips.filter((s) => !/\bref=\{/.test(s.tag) || !s.imports).map((s) => `${s.file}:${s.line}`);
    assert.deepEqual(adrift, [], `tab strip(s) with no useTabStrip: ${adrift.join(', ')}`);
  });
});

/**
 * Two fields side by side were being written as `flex items-center`, which
 * centres each one against the tallest of them. One of a pair almost always
 * carries a line of help text underneath, so its partner's label came to rest
 * half a field lower — visible on every screen at every width, and invisible to
 * everything that is not an eye. Four call sites had already found it and
 * pinned `alignItems: 'flex-start'` back on inline, which is the tell: a rule
 * being undone by hand at most of the places that use it.
 *
 * `.field-row` is that row, and it also stacks when there is no room for two
 * columns. Both halves matter — the inline override fixed the alignment and
 * left a 390px phone with two 178px columns.
 */
describe('fields side by side', () => {
  const rows = files.flatMap(({ path, text }) => {
    const lines = text.split('\n');
    return lines.flatMap((line, i) =>
      /className="[^"]*\bitems-center\b[^"]*"/.test(line) && /className="field[ "]/.test(lines[i + 1] ?? '')
        ? [`${path.slice(SRC.length + 1)}:${i + 1}`]
        : []);
  });

  it('is a .field-row, not a centred flex line', () => {
    assert.deepEqual(rows, [], `field(s) centred against a taller neighbour: ${rows.join(', ')}`);
  });

  it('never has its alignment undone inline', () => {
    const patched = files.flatMap(({ path, text }) =>
      [...text.matchAll(/alignItems:\s*'flex-start'/g)].map((m) => `${path.slice(SRC.length + 1)}:${text.slice(0, m.index).split('\n').length}`));
    assert.deepEqual(patched, [], `inline alignment patch(es) — use .field-row: ${patched.join(', ')}`);
  });
});
