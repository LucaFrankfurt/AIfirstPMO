/**
 * The numbers at the top of *My work*.
 *
 * Only the arithmetic is here — the store lookups need a browser, and the part
 * that gets a boundary wrong is this one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstName, greetingKey, plusDays, summarise, type Countable } from '../src/modules/work/overview.ts';

const open = (due: string | null): Countable => ({ due_date: due, completed_at: null, done: false });
const done = (at: number): Countable => ({ due_date: null, completed_at: at, done: true });

const DAY = '2026-03-10';
const NOW = Date.UTC(2026, 2, 10, 12);
const DAY_MS = 86_400_000;

describe('a day, shifted', () => {
  it('walks forward without leaving the calendar', () => {
    assert.equal(plusDays('2026-03-10', 7), '2026-03-17');
  });

  it('crosses a month, a year and a leap day', () => {
    assert.equal(plusDays('2026-01-28', 7), '2026-02-04');
    assert.equal(plusDays('2026-12-30', 7), '2027-01-06');
    assert.equal(plusDays('2028-02-26', 7), '2028-03-04');
  });
});

describe('where you stand', () => {
  it('counts what is open, what is soon and what has no date', () => {
    const standing = summarise([open('2026-03-12'), open(null), open('2026-06-01')], DAY, NOW);
    assert.deepEqual(standing, { open: 3, soon: 1, unscheduled: 1, done: 0 });
  });

  it('counts overdue work as open and leaves it out of the next seven days', () => {
    // It has a card of its own below. Rolling a month-old task into "coming up"
    // would let it hide inside a number that reads like a plan.
    const standing = summarise([open('2026-02-01'), open(DAY)], DAY, NOW);
    assert.equal(standing.open, 2);
    assert.equal(standing.soon, 1);
    assert.equal(standing.unscheduled, 0);
  });

  it('includes both ends of the horizon and nothing past it', () => {
    assert.equal(summarise([open(DAY)], DAY, NOW).soon, 1);
    assert.equal(summarise([open('2026-03-17')], DAY, NOW).soon, 1);
    assert.equal(summarise([open('2026-03-18')], DAY, NOW).soon, 0);
  });

  it('does not count a finished task as open, whatever its due date says', () => {
    const finished: Countable = { due_date: DAY, completed_at: NOW, done: true };
    assert.deepEqual(summarise([finished], DAY, NOW), { open: 0, soon: 0, unscheduled: 0, done: 1 });
  });

  it('forgets work finished before the horizon', () => {
    assert.equal(summarise([done(NOW - 6 * DAY_MS)], DAY, NOW).done, 1);
    assert.equal(summarise([done(NOW - 8 * DAY_MS)], DAY, NOW).done, 0);
  });

  it('says nothing rather than NaN when there is nothing', () => {
    assert.deepEqual(summarise([], DAY, NOW), { open: 0, soon: 0, unscheduled: 0, done: 0 });
  });

  it('does not credit a finished task that never recorded when', () => {
    // Completed before the column existed. It is finished, but it is not news.
    assert.equal(summarise([{ due_date: null, completed_at: null, done: true }], DAY, NOW).done, 0);
  });
});

describe('a greeting for the hour', () => {
  it('covers the whole clock without a gap or an overlap', () => {
    const seen = new Set<string>();
    for (let hour = 0; hour < 24; hour += 1) seen.add(greetingKey(hour));
    assert.deepEqual([...seen].sort(), [
      'overview.greetAfternoon', 'overview.greetEvening',
      'overview.greetMorning', 'overview.greetNight',
    ]);
  });

  it('changes at the hours a person would expect', () => {
    assert.equal(greetingKey(4), 'overview.greetNight');
    assert.equal(greetingKey(5), 'overview.greetMorning');
    assert.equal(greetingKey(11), 'overview.greetMorning');
    assert.equal(greetingKey(12), 'overview.greetAfternoon');
    assert.equal(greetingKey(17), 'overview.greetAfternoon');
    assert.equal(greetingKey(18), 'overview.greetEvening');
    assert.equal(greetingKey(23), 'overview.greetEvening');
  });
});

describe('what to call somebody', () => {
  it('takes the first word', () => {
    assert.equal(firstName('Luca Khaghani'), 'Luca');
    assert.equal(firstName('Luca'), 'Luca');
  });

  it('is not thrown by the whitespace people actually type', () => {
    assert.equal(firstName('  Luca   Khaghani '), 'Luca');
  });

  it('gives nothing back for nothing, so the greeting is left out', () => {
    for (const value of ['', '   ', null, undefined]) assert.equal(firstName(value), '');
  });
});
