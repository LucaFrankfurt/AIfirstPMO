/**
 * What a ballot adds up to, without a server anywhere near it.
 *
 * `tallyOf` is the one function the browser draws the bars with and the one the
 * MCP tools answer from, so a disagreement between the two would be a
 * disagreement about who won. The cases here are the three that a second
 * implementation would get wrong: the share is of the people who voted rather
 * than of the ticks, a tie is a list rather than a winner, and a secret ballot
 * is counted from the server's own counters because the rows are not there to
 * count.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  afterPicking, chosenBy, closedBecause, isOpen, tallyOf, voteId,
  type Decision, type DecisionOption, type DecisionVote,
} from '@kolibri/shared';

const base = { created_at: 1, updated_at: 1, deleted_at: null, seq: 1 };

const decision = (over: Partial<Decision> = {}): Decision => ({
  ...base,
  id: 'd1',
  workspace_id: 'w',
  project_id: null,
  task_id: null,
  question: 'Which one?',
  description: null,
  mode: 'single',
  visibility: 'open',
  status: 'open',
  closes_at: null,
  created_by: 'ada',
  announced_at: null,
  voters: 0,
  sort_order: 'V',
  ...over,
});

const option = (id: string, tally = 0): DecisionOption => ({
  ...base, id, workspace_id: 'w', decision_id: 'd1', label: id, description: null, tally, sort_order: id,
});

const vote = (optionId: string, voterId: string): DecisionVote => ({
  ...base,
  id: voteId('d1', optionId, voterId),
  workspace_id: 'w',
  decision_id: 'd1',
  option_id: optionId,
  voter_id: voterId,
});

describe('an open ballot is counted from the rows', () => {
  const options = [option('a'), option('b')];

  it('counts one vote each and knows which is mine', () => {
    const result = tallyOf(decision(), options, [vote('a', 'ada'), vote('b', 'lin')], 'ada');
    assert.equal(result.counted, 'rows');
    assert.equal(result.voters, 2);
    assert.deepEqual(result.options.map((row) => row.votes), [1, 1]);
    assert.deepEqual(result.options.map((row) => row.mine), [true, false]);
    assert.equal(result.voted, true);
  });

  /*
   * The figure people argue about. Three of four voters ticked both options in
   * a multiple-choice vote: six ticks, four voters, and "75% want a" is the
   * sentence somebody can act on. Dividing by the ticks would report 50% for
   * an option three quarters of the room asked for.
   */
  it('takes the share of the voters, not of the ticks', () => {
    const votes = [
      vote('a', 'ada'), vote('b', 'ada'),
      vote('a', 'lin'), vote('b', 'lin'),
      vote('a', 'max'),
      vote('b', 'sam'),
    ];
    const result = tallyOf(decision({ mode: 'multiple' }), options, votes, null);
    assert.equal(result.voters, 4);
    assert.deepEqual(result.options.map((row) => Math.round(row.share * 100)), [75, 75]);
  });

  it('reports a tie as both options rather than picking one', () => {
    const result = tallyOf(decision(), options, [vote('a', 'ada'), vote('b', 'lin')], null);
    assert.deepEqual(result.leading.map((row) => row.option.id), ['a', 'b']);
  });

  it('leads with nobody while nobody has voted', () => {
    const result = tallyOf(decision(), options, [], null);
    assert.deepEqual(result.leading, []);
    assert.deepEqual(result.options.map((row) => row.share), [0, 0]);
  });

  it('ignores a withdrawn vote and one cast on another decision', () => {
    const withdrawn = { ...vote('a', 'ada'), deleted_at: 2 };
    const elsewhere = { ...vote('a', 'lin'), decision_id: 'd2' };
    const result = tallyOf(decision(), options, [withdrawn, elsewhere, vote('b', 'max')], null);
    assert.equal(result.voters, 1);
    assert.deepEqual(result.options.map((row) => row.votes), [0, 1]);
  });
});

describe('a secret ballot is counted from the counters', () => {
  /*
   * The device holding this has one vote row — its own — because the sync
   * filter sent it nothing else. Counting rows would report a turnout of one
   * and a leader with a single vote, which is why `visibility` and not a flag
   * decides where the figures come from.
   */
  it('reads the stored tally and still knows its own choice', () => {
    const secret = decision({ visibility: 'anonymous', voters: 7 });
    const result = tallyOf(secret, [option('a', 5), option('b', 2)], [vote('a', 'ada')], 'ada');
    assert.equal(result.counted, 'server');
    assert.equal(result.voters, 7);
    assert.deepEqual(result.options.map((row) => row.votes), [5, 2]);
    assert.deepEqual(result.options.map((row) => row.mine), [true, false]);
    assert.deepEqual(result.leading.map((row) => row.option.id), ['a']);
  });

  it('does not let a negative counter produce a negative share', () => {
    const secret = decision({ visibility: 'anonymous', voters: -3 });
    const result = tallyOf(secret, [option('a', -1)], [], null);
    assert.equal(result.voters, 0);
    assert.deepEqual(result.options.map((row) => row.votes), [0]);
    assert.deepEqual(result.options.map((row) => row.share), [0]);
  });
});

describe('what a click leaves you holding', () => {
  it('replaces the held option in a single-choice vote', () => {
    assert.deepEqual(afterPicking({ mode: 'single' }, ['a'], 'b'), ['b']);
  });

  it('adds to it when several may be held', () => {
    assert.deepEqual(afterPicking({ mode: 'multiple' }, ['a'], 'b'), ['a', 'b']);
  });

  it('withdraws the one already held, in either mode', () => {
    assert.deepEqual(afterPicking({ mode: 'single' }, ['a'], 'a'), []);
    assert.deepEqual(afterPicking({ mode: 'multiple' }, ['a', 'b'], 'a'), ['b']);
  });

  it('reads back what somebody holds, in ballot order', () => {
    const options = [option('a'), option('b'), option('c')];
    const votes = [vote('c', 'ada'), vote('a', 'ada'), vote('b', 'lin')];
    assert.deepEqual(chosenBy(options, votes, 'ada'), ['a', 'c']);
    assert.deepEqual(chosenBy(options, votes, null), []);
  });
});

describe('closed is decided on reading, not by a clock', () => {
  const now = 1_000_000;

  it('is open until the deadline and closed after it', () => {
    assert.equal(isOpen(decision({ closes_at: now + 1 }), now), true);
    assert.equal(isOpen(decision({ closes_at: now }), now), false);
    assert.equal(isOpen(decision({ closes_at: null }), now), true);
  });

  it('says why, because "closed" and "nobody closed it" are different facts', () => {
    assert.equal(closedBecause(decision({ closes_at: null }), now), 'open');
    assert.equal(closedBecause(decision({ closes_at: now - 1 }), now), 'expired');
    assert.equal(closedBecause(decision({ status: 'closed' }), now), 'closed');
  });

  /* Somebody closing it by hand outranks a deadline that has not arrived. */
  it('reports a hand-closed vote as closed even before its deadline', () => {
    assert.equal(closedBecause(decision({ status: 'closed', closes_at: now + 5000 }), now), 'closed');
  });
});

describe('the id of a vote', () => {
  it('is derived, so the same vote from two devices is one row', () => {
    assert.equal(voteId('d1', 'a', 'ada'), voteId('d1', 'a', 'ada'));
    assert.notEqual(voteId('d1', 'a', 'ada'), voteId('d1', 'a', 'lin'));
    assert.notEqual(voteId('d1', 'a', 'ada'), voteId('d1', 'b', 'ada'));
  });
});
