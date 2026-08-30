/**
 * One definition of what "at risk" means, checked where it lives.
 *
 * There used to be two. The MCP report worked it out from SQL rows; the
 * interface worked out something narrower from a bare date. Neither knew about
 * the other, and they disagreed in a way somebody could see: a task shipped in
 * January stayed painted red, because a date was all the interface looked at.
 *
 * The rule is pure and takes the day as an argument, so it can be checked
 * without a clock, a database or a browser — which is the point of it being in
 * `shared` rather than in either caller.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canBeLate, daysUntil, dueTone, isDoneGroup, riskOf } from '@kolibri/shared';

const TODAY = '2026-03-10';
const open = (over: Partial<Parameters<typeof riskOf>[0]> = {}) => ({
  due_date: '2026-03-20', group_key: 'started', assignees: ['ada'], ...over,
});

describe('days between two calendar days', () => {
  it('counts whole days, negative once the day has passed', () => {
    assert.equal(daysUntil('2026-03-20', TODAY), 10);
    assert.equal(daysUntil('2026-03-10', TODAY), 0);
    assert.equal(daysUntil('2026-03-01', TODAY), -9);
  });

  it('does not drift across a daylight-saving boundary', () => {
    // Europe puts the clocks forward on 29 March 2026. Parsed as local
    // midnight, the days either side of it are 23 hours apart and round to
    // nothing; parsed as UTC, as they are, a day is a day.
    assert.equal(daysUntil('2026-03-30', '2026-03-28'), 2);
    assert.equal(daysUntil('2026-10-26', '2026-10-24'), 2);
  });
});

describe('what counts as finished', () => {
  it('is completed and cancelled, and nothing else', () => {
    assert.equal(isDoneGroup('completed'), true);
    assert.equal(isDoneGroup('cancelled'), true);
    for (const group of ['backlog', 'unstarted', 'started', null, undefined, '']) {
      assert.equal(isDoneGroup(group), false, `${group} is not finished`);
    }
  });

  it('leaves finished, undated and archived work out of the reckoning', () => {
    assert.equal(canBeLate(open()), true);
    assert.equal(canBeLate(open({ due_date: null })), false, 'no date, no promise');
    assert.equal(canBeLate(open({ group_key: 'completed' })), false);
    assert.equal(canBeLate(open({ group_key: 'cancelled' })), false);
    assert.equal(canBeLate(open({ archived: true })), false, 'a record rather than a promise');
  });
});

describe('why dated work is in trouble', () => {
  it('says nothing about work that is dated, open, owned and unblocked', () => {
    assert.deepEqual(riskOf(open(), TODAY).reasons, []);
  });

  it('reports every reason rather than the first one found', () => {
    const risk = riskOf(open({
      due_date: '2026-03-01', group_key: 'unstarted', assignees: [], blockedBy: 2,
    }), TODAY);
    // `not_started` is deliberately absent: it is about work that has not begun
    // and is *still due*, which is a different conversation from work that is
    // already late.
    assert.deepEqual(risk.reasons.sort(), ['blocked', 'overdue', 'unassigned']);
  });

  it('calls unstarted work due soon "not started", but only while it is still due', () => {
    assert.ok(riskOf(open({ group_key: 'backlog' }), TODAY).reasons.includes('not_started'));
    assert.ok(!riskOf(open({ due_date: '2026-03-01', group_key: 'backlog' }), TODAY).reasons.includes('not_started'));
  });

  it('sorts worse things first, and being late outweighs everything else', () => {
    const late = riskOf(open({ due_date: '2026-03-05' }), TODAY).severity;
    const everythingButLate = riskOf(open({ group_key: 'backlog', assignees: [], blockedBy: 1 }), TODAY).severity;
    assert.ok(late > everythingButLate, `${late} should outrank ${everythingButLate}`);
  });

  it('says nothing at all about work that cannot be late', () => {
    const finished = riskOf(open({ due_date: '2026-01-01', group_key: 'completed', assignees: [] }), TODAY);
    assert.deepEqual(finished.reasons, []);
    assert.equal(finished.severity, 0);
  });
});

describe('what a due date is coloured', () => {
  it('is red once the day has passed and amber on the day', () => {
    assert.equal(dueTone('2026-03-01', 'started', TODAY), 'overdue');
    assert.equal(dueTone('2026-03-10', 'started', TODAY), 'today');
    assert.equal(dueTone('2026-03-20', 'started', TODAY), null);
  });

  it('is nothing at all once the work is finished', () => {
    // The bug this file exists for: a task shipped in January, still painted.
    assert.equal(dueTone('2026-01-15', 'completed', TODAY), null);
    assert.equal(dueTone('2026-01-15', 'cancelled', TODAY), null);
    assert.equal(dueTone('2026-03-10', 'completed', TODAY), null);
  });

  it('is nothing when there is no date', () => {
    assert.equal(dueTone(null, 'started', TODAY), null);
    assert.equal(dueTone(undefined, 'started', TODAY), null);
  });
});
