/**
 * `cn` and the type steps.
 *
 * The steps are names this project chose — `text-label`, `text-body` — and
 * `tailwind-merge` only recognises a font size it was told about. Untold, it
 * reads `text-label` as a colour, and the merge that exists to resolve two
 * colours then deletes the size from every element that also has one. Nothing
 * throws and nothing logs; the text just comes out at the inherited 14px.
 *
 * `check:tokens` keeps `TYPE_STEPS` equal to what `app.css` declares. This keeps
 * `cn` doing the right thing with whatever `TYPE_STEPS` holds.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cn, TYPE_STEPS } from '../src/kernel/design-system/cn.ts';

describe('cn and the type steps', () => {
  for (const step of TYPE_STEPS) {
    it(`keeps text-${step} beside a colour`, () => {
      assert.equal(cn(`text-${step}`, 'text-muted'), `text-${step} text-muted`);
    });

    it(`lets a later size replace text-${step}`, () => {
      const other = step === 'body' ? 'caption' : 'body';
      assert.equal(cn(`text-${step}`, `text-${other}`), `text-${other}`);
    });
  }

  it('treats a variant as its own slot, the way the field primitive relies on', () => {
    // `Input` ships `text-input sm:text-body`; the task title passes both of its own.
    assert.equal(cn('text-input sm:text-body', 'text-headline sm:text-headline'), 'text-headline sm:text-headline');
    assert.equal(cn('text-input sm:text-body', 'mb-2.5'), 'text-input sm:text-body mb-2.5');
  });

  it('still merges the radius and shadow steps it knows by their own names', () => {
    assert.equal(cn('rounded', 'rounded-sm'), 'rounded-sm');
    assert.equal(cn('rounded-lg', 'rounded-full'), 'rounded-full');
    assert.equal(cn('shadow', 'shadow-sm'), 'shadow-sm');
  });
});
