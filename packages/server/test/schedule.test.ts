/**
 * Dependency scheduling.
 *
 * One rule: a task may not start before everything blocking it has finished.
 * The cases below are the ones where a scheduler usually goes wrong — a chain,
 * a diamond, a task that is already late enough, a cycle, and a task with only
 * one of its two dates.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_WORKING_DAYS, addDays, addWorkingDays, daysBetween, isWorkingDay, moveTask,
  nextWorkingDay, packRows, reschedule, span, workingDaysBetween,
  type Dependency, type Scheduled,
} from '@kolibri/shared';

const task = (id: string, start: string | null, due: string | null): Scheduled => ({ id, start_date: start, due_date: due });
const dep = (from: string, to: string): Dependency => ({ from, to });

describe('a span', () => {
  it('fills in the end a task did not give', () => {
    assert.deepEqual(span(task('a', '2026-08-10', '2026-08-14')), { start: '2026-08-10', end: '2026-08-14' });
    assert.deepEqual(span(task('a', null, '2026-08-14')), { start: '2026-08-14', end: '2026-08-14' }, 'a due date alone is one day');
    assert.deepEqual(span(task('a', '2026-08-10', null)), { start: '2026-08-10', end: '2026-08-10' }, 'and so is a start alone');
    assert.equal(span(task('a', null, null)), null, 'a task with no dates is not on the chart at all');
  });

  it('reads a backwards pair the only way it can be meant', () => {
    assert.deepEqual(span(task('a', '2026-08-20', '2026-08-10')), { start: '2026-08-10', end: '2026-08-20' });
  });
});

describe('rescheduling', () => {
  it('pushes a successor to the day after its blocker ends', () => {
    const tasks = [task('a', '2026-08-10', '2026-08-14'), task('b', '2026-08-12', '2026-08-16')];
    const moves = reschedule(['a'], tasks, [dep('a', 'b')]);
    assert.deepEqual(moves, [{ id: 'b', start_date: '2026-08-15', due_date: '2026-08-19' }]);
    assert.equal(daysBetween('2026-08-12', '2026-08-16'), daysBetween('2026-08-15', '2026-08-19'), 'and keeps its length');
  });

  it('leaves a successor that is already late enough exactly where it is', () => {
    const tasks = [task('a', '2026-08-10', '2026-08-14'), task('b', '2026-09-01', '2026-09-03')];
    assert.deepEqual(reschedule(['a'], tasks, [dep('a', 'b')]), [], 'nothing to do is nothing written');
  });

  it('never pulls anything earlier, even when the blocker finishes early', () => {
    // The plan is somebody's decision. A chart that snaps work backwards the
    // moment a dependency lands early is arguing with whoever made it.
    const tasks = [task('a', '2026-08-01', '2026-08-02'), task('b', '2026-08-20', '2026-08-22')];
    assert.deepEqual(reschedule(['a'], tasks, [dep('a', 'b')]), []);
  });

  it('carries a shift down a whole chain', () => {
    const tasks = [
      task('a', '2026-08-10', '2026-08-14'),
      task('b', '2026-08-15', '2026-08-16'),
      task('c', '2026-08-17', '2026-08-18'),
    ];
    const deps = [dep('a', 'b'), dep('b', 'c')];
    // A moves three days later; everything downstream moves with it.
    const moves = moveTask('a', '2026-08-13', '2026-08-17', tasks, deps);
    assert.deepEqual(moves, [
      { id: 'a', start_date: '2026-08-13', due_date: '2026-08-17' },
      { id: 'b', start_date: '2026-08-18', due_date: '2026-08-19' },
      { id: 'c', start_date: '2026-08-20', due_date: '2026-08-21' },
    ]);
  });

  it('respects the later of two blockers, whichever order it hears about them', () => {
    const tasks = [
      task('a', '2026-08-10', '2026-08-11'),
      task('b', '2026-08-10', '2026-08-20'),
      task('c', '2026-08-12', '2026-08-13'),
    ];
    const moves = reschedule(['a', 'b'], tasks, [dep('a', 'c'), dep('b', 'c')]);
    assert.deepEqual(moves, [{ id: 'c', start_date: '2026-08-21', due_date: '2026-08-22' }], 'the longer blocker wins');
  });

  it('moves a task that has only a due date, and keeps it having only that', () => {
    const tasks = [task('a', '2026-08-10', '2026-08-14'), task('b', null, '2026-08-12')];
    assert.deepEqual(
      reschedule(['a'], tasks, [dep('a', 'b')]),
      [{ id: 'b', start_date: null, due_date: '2026-08-15' }],
      'a date it never had is not a date to invent',
    );
  });

  it('ignores a successor with no dates rather than inventing some', () => {
    const tasks = [task('a', '2026-08-10', '2026-08-14'), task('b', null, null)];
    assert.deepEqual(reschedule(['a'], tasks, [dep('a', 'b')]), []);
  });

  it('stops on a dependency cycle instead of running forever', () => {
    const tasks = [task('a', '2026-08-10', '2026-08-11'), task('b', '2026-08-10', '2026-08-11')];
    const moves = reschedule(['a'], tasks, [dep('a', 'b'), dep('b', 'a')]);
    // Both ends of a circle get pushed; the point is that this returns at all.
    assert.ok(moves.length >= 1);
    assert.ok(moves.every((move) => move.start_date && move.start_date >= '2026-08-10'));
  });
});

describe('packing overlapping work into rows', () => {
  it('gives everything running at once a row of its own, and reuses one that is free', () => {
    const { row, rows } = packRows([
      task('a', '2026-08-01', '2026-08-05'),
      task('b', '2026-08-03', '2026-08-08'),
      task('c', '2026-08-04', '2026-08-06'),
      task('d', '2026-08-20', '2026-08-22'),
    ]);
    assert.equal(rows, 3, 'three run at once at the busiest moment');
    assert.equal(row.get('a'), 0);
    assert.equal(row.get('b'), 1, 'it starts before a has finished');
    assert.equal(row.get('c'), 2);
    assert.equal(row.get('d'), 0, 'and the first row is free again by then');
  });

  it('is one row when nothing overlaps, and one row when there is nothing', () => {
    const spaced = packRows([task('a', '2026-08-01', '2026-08-02'), task('b', '2026-08-03', '2026-08-04')]);
    assert.equal(spaced.rows, 1);
    assert.equal(packRows([]).rows, 1, 'an empty lane still has a height');
  });

  it('ignores what has no dates instead of stacking it at day zero', () => {
    const { row, rows } = packRows([task('a', '2026-08-01', '2026-08-02'), task('b', null, null)]);
    assert.equal(rows, 1);
    assert.equal(row.has('b'), false);
  });
});

describe('day arithmetic', () => {
  it('crosses a month and a leap day without drifting', () => {
    assert.equal(addDays('2026-08-30', 3), '2026-09-02');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29', '2028 is a leap year');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1, 'and 2026 is not');
  });
});

/* 2026-08-10 is a Monday, which is what makes the dates below readable. */


describe('working days', () => {
  const week = DEFAULT_WORKING_DAYS;

  it('knows a Saturday from a Monday', () => {
    assert.equal(isWorkingDay('2026-08-10', week), true, 'Monday');
    assert.equal(isWorkingDay('2026-08-15', week), false, 'Saturday');
    assert.equal(isWorkingDay('2026-08-16', week), false, 'Sunday');
  });

  it('steps over the weekend rather than into it', () => {
    assert.equal(nextWorkingDay('2026-08-15', week), '2026-08-17', 'Saturday waits for Monday');
    assert.equal(nextWorkingDay('2026-08-13', week), '2026-08-13', 'a working day is already one');
    assert.equal(addWorkingDays('2026-08-14', 1, week), '2026-08-17', 'the day after Friday is Monday');
    assert.equal(addWorkingDays('2026-08-10', 5, week), '2026-08-17', 'five working days on from Monday');
  });

  it('counts a working week as five days and a fortnight as ten', () => {
    assert.equal(workingDaysBetween('2026-08-10', '2026-08-14', week), 5);
    assert.equal(workingDaysBetween('2026-08-10', '2026-08-21', week), 10);
    assert.equal(workingDaysBetween('2026-08-15', '2026-08-16', week), 0, 'a weekend on its own is no working days');
  });

  it('is every day when nobody has said otherwise, so old plans are unchanged', () => {
    const tasks = [task('a', '2026-08-13', '2026-08-14'), task('b', '2026-08-13', '2026-08-14')];
    assert.deepEqual(
      reschedule(['a'], tasks, [dep('a', 'b')]),
      [{ id: 'b', start_date: '2026-08-15', due_date: '2026-08-16' }],
      'a Saturday start, because no calendar was given',
    );
  });

  it('lands a pushed task on a working day and keeps its length in working days', () => {
    // `b` is three working days long and its blocker ends on a Friday.
    const tasks = [task('a', '2026-08-10', '2026-08-14'), task('b', '2026-08-11', '2026-08-13')];
    const moves = reschedule(['a'], tasks, [dep('a', 'b')], { workingDays: week });
    assert.deepEqual(moves, [{ id: 'b', start_date: '2026-08-17', due_date: '2026-08-19' }]);
    assert.equal(
      workingDaysBetween('2026-08-17', '2026-08-19', week), 3,
      'three days of work stays three days of work rather than stretching over the weekend',
    );
  });

  it('takes a calendar per task, because two projects can disagree about Saturday', () => {
    const tasks = [task('a', '2026-08-10', '2026-08-14'), task('b', '2026-08-11', '2026-08-11')];
    const moves = reschedule(['a'], tasks, [dep('a', 'b')], {
      // `b` belongs to a team that works Saturdays.
      workingDays: (id) => (id === 'b' ? [1, 2, 3, 4, 5, 6] : week),
    });
    assert.deepEqual(moves, [{ id: 'b', start_date: '2026-08-15', due_date: '2026-08-15' }]);
  });
});

describe('lag on a link', () => {
  it('holds the successor back by that many working days', () => {
    const tasks = [task('a', '2026-08-10', '2026-08-11'), task('b', '2026-08-11', '2026-08-11')];
    assert.deepEqual(
      reschedule(['a'], tasks, [{ from: 'a', to: 'b', lag: 2 }], { workingDays: DEFAULT_WORKING_DAYS }),
      [{ id: 'b', start_date: '2026-08-14', due_date: '2026-08-14' }],
      'Tuesday plus one plus two working days is Friday',
    );
  });

  it('counts the wait in working days too, so a weekend is not the wait', () => {
    // `a` ends on a Thursday; one day on is Friday, two more is Tuesday.
    const tasks = [task('a', '2026-08-10', '2026-08-13'), task('b', '2026-08-14', '2026-08-14')];
    assert.deepEqual(
      reschedule(['a'], tasks, [{ from: 'a', to: 'b', lag: 2 }], { workingDays: DEFAULT_WORKING_DAYS }),
      [{ id: 'b', start_date: '2026-08-18', due_date: '2026-08-18' }],
    );
  });

  it('refuses a lead time, because that is the one thing the rule forbids', () => {
    const tasks = [task('a', '2026-08-10', '2026-08-14'), task('b', '2026-08-11', '2026-08-11')];
    assert.deepEqual(
      reschedule(['a'], tasks, [{ from: 'a', to: 'b', lag: -3 }]),
      [{ id: 'b', start_date: '2026-08-15', due_date: '2026-08-15' }],
      'a negative wait is read as none — never as permission to start early',
    );
  });
});
