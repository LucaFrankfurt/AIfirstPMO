/**
 * The colour on a due date — and whether anything can see it.
 *
 * `dueClass` had two faults at once, which is why neither showed. It decided
 * from a bare date, so a task finished in January stayed red for ever; and it
 * returned `.due-overdue`, a hand-written rule that the chip's own `text-soft`
 * utility beat every time. A wrong answer, painted in a colour nobody rendered.
 *
 * Both halves are pinned here. What it decides comes from `dueTone` in
 * `@kolibri/shared`, tested next to the rest of the risk rules on the server
 * side; what is left for this file is the half that only exists in the browser:
 * that the class it returns survives `cn` alongside the chip's own.
 *
 * The chip's classes are read out of `chip.tsx` rather than copied, so a change
 * to its default tone lands here rather than rotting quietly.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { cn } from '../src/kernel/design-system/cn.ts';
import { dueClass, today } from '../src/kernel/design-system/format.ts';

const SRC = join(import.meta.dirname, '..', 'src');

/** The classes a plain `<Chip>` carries — the ones a due colour has to beat. */
function chipDefaultTone(): string {
  const source = readFileSync(join(SRC, 'kernel/design-system/ui/chip.tsx'), 'utf8');
  const match = source.match(/default:\s*'([^']+)'/);
  assert.ok(match, 'chip.tsx no longer has a default tone — this test is looking at the wrong thing');
  return match[1];
}

const yesterday = (): string => {
  const at = new Date(`${today()}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
};

describe('what a due date is coloured', () => {
  it('is nothing at all for work that is finished', () => {
    assert.equal(dueClass(yesterday(), 'completed'), '');
    assert.equal(dueClass(yesterday(), 'cancelled'), '');
  });

  it('is nothing for a date still ahead, or no date', () => {
    assert.equal(dueClass('2099-01-01', 'started'), '');
    assert.equal(dueClass(null, 'started'), '');
    assert.equal(dueClass(undefined, undefined), '');
  });

  it('is danger when the day has passed and the work has not', () => {
    assert.equal(dueClass(yesterday(), 'started'), 'text-danger');
  });

  it('is warning on the day itself', () => {
    assert.equal(dueClass(today(), 'unstarted'), 'text-warn');
  });
});

describe('and whether the chip lets it through', () => {
  const tone = chipDefaultTone();

  it('starts from a chip that does set a colour of its own', () => {
    assert.match(tone, /\btext-\S+/, 'the premise of this test is that the chip sets one');
  });

  it('drops the chip colour when the date is late', () => {
    const classes = cn(tone, dueClass(yesterday(), 'started')).split(' ');
    assert.ok(classes.includes('text-danger'), classes.join(' '));
    assert.ok(!classes.includes('text-soft'), `the chip's colour survived: ${classes.join(' ')}`);
  });

  it('leaves the chip alone when there is nothing to say', () => {
    const classes = cn(tone, dueClass('2099-01-01', 'started')).split(' ');
    assert.ok(classes.includes('text-soft'), classes.join(' '));
  });
});
