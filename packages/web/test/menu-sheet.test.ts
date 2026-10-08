/**
 * The two things about a menu-as-sheet that nothing else would notice.
 *
 * Both are about a rule in a stylesheet, which is why they are here: a class
 * name is a string, the compiler has nothing to say about either, and the
 * browser checks would stay green through both regressions.
 *
 * **One**: the sheet is moved by a rule on the *wrapper*, not on the menu.
 * Radix wraps a menu in a popper element carrying a `transform`, and a
 * transform makes an element the containing block for `position: fixed` inside
 * it — so fixing the menu fixes it to the wrapper, which is where it already
 * was. The rule has to reach the wrapper through `:has()`. Delete that one
 * selector and `check:css` still passes (the class is defined two rules
 * below), `typecheck` still passes, and the menu quietly goes back to hanging
 * off its button, somewhere in the middle of a phone screen — small enough
 * that `check:menus` may well find it inside the window and say nothing.
 *
 * **Two**: the width at which this happens is written once, in `narrow.ts`.
 * The class is only ever put on the element while `useNarrow()` says the
 * window is narrow, so the stylesheet needs no media query of its own — and
 * must not grow one, because a second copy of that number in a language that
 * cannot read the first is exactly the drift `CLAUDE.md` means by "one number,
 * one source".
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { SHEET_BELOW, SHEET_QUERY } from '../src/kernel/design-system/narrow.ts';

const here = new URL('.', import.meta.url).pathname;
const css = readFileSync(join(here, '../src/styles/app.css'), 'utf8');

/** The rule that moves the sheet, from its selector to its closing brace. */
const wrapperRule = css.slice(
  css.indexOf('[data-radix-popper-content-wrapper]'),
  css.indexOf('}', css.indexOf('[data-radix-popper-content-wrapper]')) + 1,
);

describe('a menu rendered as a sheet', () => {
  it('is moved by a rule on the popper wrapper, not on the menu', () => {
    assert.ok(
      css.includes('[data-radix-popper-content-wrapper]:has(> .menu-sheet)'),
      'the wrapper rule is gone — a sheet moved by `position: fixed` on itself does not move, '
      + 'because the wrapper it sits in carries a transform and is therefore its containing block',
    );
  });

  /**
   * The transform is the whole reason the rule exists. Keeping the rule but
   * dropping this one declaration leaves the sheet pinned wherever the popper
   * had already put it, which on a phone is halfway down the screen.
   */
  it('undoes the transform the popper put on that wrapper', () => {
    assert.match(wrapperRule, /transform:\s*none/);
    assert.match(wrapperRule, /position:\s*fixed/);
    // Bottom edge, full width: `inset: auto 0 0 0`.
    assert.match(wrapperRule, /inset:\s*auto 0 0 0/);
  });

  it('states the width in one language only', () => {
    assert.equal(SHEET_QUERY, `(max-width: ${SHEET_BELOW})`);
    const sheetRules = css.slice(css.indexOf('[data-radix-popper-content-wrapper]'));
    assert.ok(
      !sheetRules.includes(SHEET_BELOW),
      `the stylesheet now states ${SHEET_BELOW} as well — the class is only ever applied while `
      + '`useNarrow()` says so, so a media query here is a second copy of a number that cannot check the first',
    );
  });

  /** The class has to exist for `check:css` to be about anything. */
  it('defines the class the menu asks for', () => {
    assert.ok(css.includes('.menu-sheet {'));
  });
});
