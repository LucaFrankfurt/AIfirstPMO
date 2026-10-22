/**
 * One attachment, one spelling of where it hangs.
 *
 * A file used to hang off a task, a page or a comment, and each was a column of
 * its own. Everything else it can hang off now — a decision, a project, a
 * budget, a KPI, a cycle, a module, a product, a component — goes in a
 * `subject_kind` / `subject_id` pair instead, because the alternative was a
 * fourth, fifth and sixth named column and a fresh copy of the visibility rule
 * beside each of them.
 *
 * That leaves a hazard worth a suite: two legal spellings of the same link. A
 * row with `subject_kind: 'task'` and a row with `task_id` would be the same
 * attachment and would not compare equal — the task's own Files section reads
 * `task_id`, the project export's three `EXISTS` read `task_id`, and
 * `storeFile`'s de-duplication reads both. So exactly two functions know which
 * kinds have a column: `attachmentLink` writes it and `attachmentSubject` reads
 * it back, and `soleLink` is what the write path uses to reduce whatever a
 * write names to that one link before it reaches the database.
 *
 * Tested from this side because `uploadLink` — the one place the column name
 * and the query parameter deliberately differ — is the client's, and because
 * the round trip is the property that matters rather than either half.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTACHMENT_SUBJECTS, GENERIC_SUBJECTS, attachmentLink, attachmentSubject, isAttachmentSubject, soleLink,
} from '@kolibri/shared';
import { uploadLink } from '../src/kernel/files/link.ts';

describe('the link a subject is written as', () => {
  it('round-trips every kind, whichever spelling it uses', () => {
    // The property, over the whole list rather than over three examples: what
    // `attachmentLink` writes is what `attachmentSubject` reads back. A kind
    // added to the list with no column and no pair would fail here.
    for (const kind of ATTACHMENT_SUBJECTS) {
      const subject = attachmentSubject(attachmentLink(kind, 'abc'));
      assert.deepEqual(subject, { kind, id: 'abc' }, `${kind} did not survive the round trip`);
    }
  });

  it('gives the three with a column of their own exactly that column', () => {
    assert.deepEqual(attachmentLink('task', 't1'), { task_id: 't1' });
    assert.deepEqual(attachmentLink('page', 'p1'), { page_id: 'p1' });
    assert.deepEqual(attachmentLink('comment', 'c1'), { comment_id: 'c1' });
  });

  it('gives everything else the generic pair', () => {
    for (const kind of GENERIC_SUBJECTS) {
      assert.deepEqual(attachmentLink(kind, 'x'), { subject_kind: kind, subject_id: 'x' });
    }
    // And the two sets together are the whole list, with nothing in both.
    assert.equal(GENERIC_SUBJECTS.length + 3, ATTACHMENT_SUBJECTS.length);
  });

  it('prefers the named column when a row somehow carries both', () => {
    /*
     * Not a shape the write path leaves behind — `soleLink` clears the pair —
     * but a row written by an older build, an import or a hand-edited database
     * can carry it, and a `PATCH` names it on the way in. One answer is
     * required, and the named column is the one the rest of the application
     * already reads.
     */
    const subject = attachmentSubject({ task_id: 't1', subject_kind: 'decision', subject_id: 'd1' });
    assert.deepEqual(subject, { kind: 'task', id: 't1' });
  });
});

describe('a row that names nothing this build can resolve', () => {
  it('reads as loose when it names nothing at all', () => {
    // An avatar, a workspace logo, an image pasted into a chat message. `null`
    // here is what makes those stay readable by the workspace.
    assert.equal(attachmentSubject({}), null);
    assert.equal(attachmentSubject({ task_id: null, page_id: null, comment_id: null }), null);
  });

  it('reads as nothing for a kind it does not know, rather than guessing', () => {
    /*
     * A `subject_kind` from a newer version, or from a client making it up.
     * `null` rather than `{kind: 'wombat'}`, because every caller then has one
     * fewer case to get wrong — and the callers that must refuse rather than
     * shrug (`canSeeFile`, `visibleRow`, MCP's `findAttachment`) tell the two
     * apart by looking at the raw columns, which is why the id is not simply
     * dropped on the floor.
     */
    assert.equal(attachmentSubject({ subject_kind: 'wombat', subject_id: 'x' }), null);
    assert.equal(attachmentSubject({ subject_kind: 'decision', subject_id: null }), null);
  });

  it('knows which names are subjects', () => {
    assert.ok(isAttachmentSubject('decision'));
    assert.ok(!isAttachmentSubject('workspace'));
    assert.ok(!isAttachmentSubject(undefined));
    assert.ok(!isAttachmentSubject(null));
  });
});

describe('reducing a row to one link', () => {
  it('moves a generic task onto task_id and clears the pair', () => {
    assert.deepEqual(
      soleLink({ subject_kind: 'task', subject_id: 't1' }),
      { task_id: 't1', subject_kind: null, subject_id: null },
    );
  });

  it('says nothing about a row that already names exactly one thing', () => {
    assert.equal(soleLink({ task_id: 't1' }), null);
    assert.equal(soleLink({ subject_kind: 'decision', subject_id: 'd1' }), null);
    assert.equal(soleLink({}), null);
  });

  it('clears the loser when a row would end up with two links', () => {
    /*
     * The case a `PATCH` produces: `{subject_kind: 'decision', subject_id: …}`
     * on a row that still has its `task_id` is a caller who said where to put
     * the file and not where to take it from. The named column wins, which is
     * what `attachmentSubject` answers for such a row — so the stored row ends
     * up saying what every reader reads.
     */
    assert.deepEqual(
      soleLink({ task_id: 't1', subject_kind: 'decision', subject_id: 'd1' }),
      { subject_kind: null, subject_id: null },
    );
  });

  it('lets a file move when the write says where to take it from', () => {
    assert.equal(soleLink({ task_id: null, subject_kind: 'decision', subject_id: 'd1' }), null);
  });

  it('would clear an unknown kind, which is why the guard refuses it first', () => {
    /*
     * Not an endorsement — a row nothing can resolve must not quietly become a
     * loose file. Guards run before invariants, so `guardAttachmentWrite` has
     * already refused the name by the time this would see it; the case is here
     * so that the ordering is written down somewhere that fails if it changes.
     */
    assert.deepEqual(
      soleLink({ subject_kind: 'wombat', subject_id: 'x' }),
      { subject_kind: null, subject_id: null },
    );
  });
});

describe('the query the upload endpoint takes', () => {
  it('sends the three named kinds as their own parameter', () => {
    assert.deepEqual(uploadLink({ kind: 'task', id: 't1' }), { task_id: 't1' });
    assert.deepEqual(uploadLink({ kind: 'page', id: 'p1' }), { page_id: 'p1' });
  });

  it('renames subject_kind to subject, which is the one place the two differ', () => {
    /*
     * `subject_kind` is the column and `subject` is the parameter, because
     * `?subject=decision&subject_id=…` reads as a sentence and
     * `?subject_kind=…` reads as a schema. One line in `uploadLink` knows that,
     * and this case is what keeps it from being two.
     */
    assert.deepEqual(uploadLink({ kind: 'decision', id: 'd1' }), { subject: 'decision', subject_id: 'd1' });
    assert.deepEqual(uploadLink({ kind: 'budget', id: 'b1' }), { subject: 'budget', subject_id: 'b1' });
  });

  it('answers nothing for an upload that hangs on nothing', () => {
    // An avatar goes up with no link at all, and `undefined` is what keeps the
    // query string empty rather than carrying `subject=undefined`.
    assert.equal(uploadLink(null), undefined);
    assert.equal(uploadLink(undefined), undefined);
  });
});
