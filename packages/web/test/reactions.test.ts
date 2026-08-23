/**
 * The reaction set, which two surfaces now share.
 *
 * Comments and chat each carried their own copy of this and neither was
 * checked. They are one function now, so the interesting case — the emoji that
 * has to *disappear* when the last person takes it back, rather than stay as an
 * empty list — is worth pinning down before a third surface inherits it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextReactions, REACTIONS } from '../src/lib/reactions.ts';

const ADA = 'user-ada';
const LIN = 'user-lin';

describe('reactions', () => {
  it('adds somebody who has not reacted yet', () => {
    assert.deepEqual(nextReactions({}, '👍', ADA), { '👍': [ADA] });
  });

  it('starts from nothing at all', () => {
    // A row that has never been reacted to stores null, not an empty object.
    assert.deepEqual(nextReactions(null, '🎉', ADA), { '🎉': [ADA] });
    assert.deepEqual(nextReactions(undefined, '🎉', ADA), { '🎉': [ADA] });
  });

  it('joins somebody already there rather than replacing them', () => {
    assert.deepEqual(nextReactions({ '👍': [LIN] }, '👍', ADA), { '👍': [LIN, ADA] });
  });

  it('takes one person back out and leaves the others', () => {
    assert.deepEqual(nextReactions({ '👍': [LIN, ADA] }, '👍', ADA), { '👍': [LIN] });
  });

  it('deletes the emoji when the last person takes it back', () => {
    const next = nextReactions({ '👍': [ADA] }, '👍', ADA);
    assert.deepEqual(next, {});
    // Not merely empty — absent. Kept as [] it is invisible in the row and
    // permanent in the row's JSON.
    assert.equal('👍' in next, false);
  });

  it('leaves the other emoji alone when one is emptied', () => {
    assert.deepEqual(nextReactions({ '👍': [ADA], '🎉': [LIN] }, '👍', ADA), { '🎉': [LIN] });
  });

  it('does not mutate what it was given', () => {
    const before = { '👍': [ADA] };
    nextReactions(before, '👍', LIN);
    assert.deepEqual(before, { '👍': [ADA] }, 'the caller still holds the old set');
  });

  it('round-trips: react, un-react, and the set is back where it started', () => {
    const start = { '👀': [LIN] };
    const there = nextReactions(start, '👀', ADA);
    assert.deepEqual(nextReactions(there, '👀', ADA), start);
  });

  it('offers six, which is the row the picker draws', () => {
    assert.equal(REACTIONS.length, 6);
    assert.equal(new Set(REACTIONS).size, 6, 'no duplicates — each is one button');
  });
});
