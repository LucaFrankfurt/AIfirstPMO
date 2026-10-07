/**
 * Which rung a page stands on.
 *
 * Four functions, and all of them exist because the names belong to the
 * workspace and nothing downstream may read one. What is pinned here is the
 * part that *is* fixed: a page with no status is a draft, a new page starts on
 * the first draft rather than the first rung, and a status somebody deleted
 * does not leave a page in limbo.
 *
 * The last two are the ones that would be easy to get subtly wrong and hard to
 * notice: a workspace that puts "Final" at the top of its list — because that
 * is how they read one — would otherwise have every new page announce itself
 * as finished.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultStatus, kindOf, ladder, statusOf, type PageStatus } from '@kolibri/shared';

const rung = (id: string, kind: 'draft' | 'review' | 'final', sort_order: string): PageStatus =>
  ({ id, workspace_id: 'w1', name: id, kind, color: '#000', sort_order } as PageStatus);

const DRAFT = rung('draft', 'draft', 'a');
const REVIEW = rung('review', 'review', 'b');
const FINAL = rung('final', 'final', 'c');
const LADDER = [FINAL, DRAFT, REVIEW];

describe('reading a workspace ladder', () => {
  it('puts the rungs in the order the workspace chose', () => {
    assert.deepEqual(ladder(LADDER).map((one) => one.id), ['draft', 'review', 'final']);
  });

  it('starts a new page on the first draft, not on the first rung', () => {
    assert.equal(defaultStatus(LADDER)?.id, 'draft');
    // Even when the workspace has put something else at the top of its list.
    assert.equal(defaultStatus([rung('signed', 'final', 'a'), rung('wip', 'draft', 'b')])?.id, 'wip');
  });

  it('falls back to the first rung when no draft is left', () => {
    assert.equal(defaultStatus([REVIEW, FINAL])?.id, 'review');
  });

  it('has nothing to say about an empty ladder, rather than inventing one', () => {
    assert.equal(defaultStatus([]), undefined);
    assert.equal(statusOf({ status_id: null }, []), undefined);
  });
});

describe('the rung a page stands on', () => {
  it('is the one it points at', () => {
    assert.equal(statusOf({ status_id: 'review' }, LADDER)?.id, 'review');
    assert.equal(kindOf({ status_id: 'review' }, LADDER), 'review');
  });

  /** Every page written before the ladder existed. */
  it('is the draft when it points at nothing', () => {
    assert.equal(statusOf({ status_id: null }, LADDER)?.id, 'draft');
    assert.equal(kindOf({ status_id: null }, LADDER), 'draft');
  });

  /**
   * And when it points at a rung somebody deleted — which is what lets the
   * settings screen delete one without walking the whole wiki.
   */
  it('is the draft when the rung is gone', () => {
    assert.equal(statusOf({ status_id: 'retired' }, LADDER)?.id, 'draft');
    assert.equal(kindOf({ status_id: 'retired' }, LADDER), 'draft');
  });

  it('calls a page with no ladder at all a draft', () => {
    assert.equal(kindOf({ status_id: null }, []), 'draft');
  });
});
