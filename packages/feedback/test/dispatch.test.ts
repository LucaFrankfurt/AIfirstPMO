// dispatchFeedback against an in-memory store and the scriptable fake target.
//
// The cases that decide whether a report survives a bad day: a target that is down,
// a token that is wrong, an upload that failed after the ticket already existed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matches } from './helpers.ts';
import {
  dispatchFeedback,
  type FeedbackStore,
  type StoredFeedback,
  type FeedbackFailureUpdate,
} from '../src/kernel/feedback/dispatch.ts';
import { FakeFeedbackTarget, UnconfiguredFeedbackTarget } from '../src/kernel/feedback/fake-target.ts';
import { FeedbackTargetError, type FeedbackReport } from '../src/kernel/feedback/types.ts';

interface Row extends StoredFeedback {
  screenshotStored: boolean;
  lastError: string | null;
  targetName: string | null;
  externalUrl: string | null;
}

/** The smallest store that behaves like a real one — including dropping the bytes on success. */
function memoryStore() {
  const rows = new Map<string, Row>();
  const store: FeedbackStore = {
    async load(id) {
      const row = rows.get(id);
      return row ? { report: row.report, status: row.status, externalId: row.externalId } : null;
    },
    async markSubmitted(id, update) {
      const row = rows.get(id)!;
      Object.assign(row, {
        status: 'submitted',
        targetName: update.targetName,
        externalId: update.externalId,
        externalUrl: update.externalUrl,
        lastError: null,
        screenshotStored: false,
      });
    },
    async recordFailure(id, update: FeedbackFailureUpdate) {
      const row = rows.get(id)!;
      row.lastError = update.message;
      row.targetName = update.targetName;
      if (update.externalId) {
        row.externalId = update.externalId;
        row.externalUrl = update.externalUrl ?? null;
      }
      if (update.permanent) row.status = 'failed';
    },
  };
  return { store, rows };
}

const quiet = { log: () => {}, error: () => {} };

function seed(rows: Map<string, Row>, over: Partial<Row> = {}): string {
  const id = `rep-${rows.size + 1}`;
  const report: FeedbackReport = {
    id,
    kind: 'BUG',
    message: 'Speichern geht nicht',
    reporter: { id: 'u-1', name: 'Rita Rep' },
    client: {},
    attachments: [{ filename: 'screenshot.webp', contentType: 'image/webp', bytes: new Uint8Array([1, 2]) }],
    createdAt: new Date(),
  };
  rows.set(id, {
    report,
    status: 'pending',
    externalId: null,
    screenshotStored: true,
    lastError: null,
    targetName: null,
    externalUrl: null,
    ...over,
  });
  return id;
}

describe('dispatchFeedback', () => {
  it('submits, records the backlink, and drops the screenshot', async () => {
    const { store, rows } = memoryStore();
    const id = seed(rows);
    const target = new FakeFeedbackTarget();

    const result = await dispatchFeedback(id, { store, target, logger: quiet });

    matches(result, { outcome: 'submitted', submission: { externalId: 'fake_1' } });
    matches(rows.get(id), {
      status: 'submitted',
      targetName: 'fake',
      externalId: 'fake_1',
      lastError: null,
      screenshotStored: false,
    });
    assert.equal(target.submissions[0]!.report.attachments.length, 1);
  });

  describe('transient failure', () => {
    it("records the error, keeps the report pending, and rethrows for the queue's backoff", async () => {
      const { store, rows } = memoryStore();
      const id = seed(rows);
      const target = new FakeFeedbackTarget().failNextTransient('Kolibri nicht erreichbar');

      await assert.rejects(dispatchFeedback(id, { store, target, logger: quiet }), FeedbackTargetError);
      matches(rows.get(id), {
        status: 'pending',
        lastError: 'Kolibri nicht erreichbar',
        screenshotStored: true,
      });
    });

    it('succeeds on a later attempt and clears the recorded error', async () => {
      const { store, rows } = memoryStore();
      const id = seed(rows);
      const target = new FakeFeedbackTarget().failNextTransient();

      await dispatchFeedback(id, { store, target, logger: quiet }).catch(() => null);
      await dispatchFeedback(id, { store, target, logger: quiet });
      matches(rows.get(id), { status: 'submitted', lastError: null });
    });

    it('treats an error that is not a target error as transient — it is not known to be hopeless', async () => {
      const { store, rows } = memoryStore();
      const id = seed(rows);
      const target = new FakeFeedbackTarget().failNext(new TypeError('boom') as unknown as FeedbackTargetError);

      await assert.rejects(dispatchFeedback(id, { store, target, logger: quiet }), (error: Error) =>
        error.message.includes('boom'),
      );
      matches(rows.get(id), { status: 'pending', lastError: 'boom' });
    });
  });

  describe('permanent failure', () => {
    it('marks the report failed and resolves — no retry budget burned', async () => {
      const { store, rows } = memoryStore();
      const id = seed(rows);
      const target = new FakeFeedbackTarget().failNextPermanent('Token ungültig');
      assert.deepEqual(await dispatchFeedback(id, { store, target, logger: quiet }), {
        outcome: 'failed_permanently',
        message: 'Token ungültig',
      });
      matches(rows.get(id), { status: 'failed', lastError: 'Token ungültig', screenshotStored: true });
    });

    it('fails loudly when no target is configured', async () => {
      const { store, rows } = memoryStore();
      const id = seed(rows);
      await dispatchFeedback(id, {
        store,
        target: new UnconfiguredFeedbackTarget('FEEDBACK_TARGET fehlt'),
        logger: quiet,
      });
      matches(rows.get(id), {
        status: 'failed',
        lastError: 'FEEDBACK_TARGET fehlt',
        targetName: 'unconfigured',
      });
    });

    it('truncates a huge error message', async () => {
      const { store, rows } = memoryStore();
      const id = seed(rows);
      await dispatchFeedback(id, {
        store,
        target: new FakeFeedbackTarget().failNextPermanent('x'.repeat(5_000)),
        logger: quiet,
      });
      assert.equal(rows.get(id)?.lastError?.length, 1_000);
    });
  });

  describe('resumability — no duplicate tickets', () => {
    it('records the external id when the upload fails AFTER the ticket was created', async () => {
      const { store, rows } = memoryStore();
      const id = seed(rows);
      const target = new FakeFeedbackTarget().failNextAfterCreate();

      await dispatchFeedback(id, { store, target, logger: quiet }).catch(() => null);
      matches(rows.get(id), { status: 'pending', externalId: 'fake_1' });
      assert.ok(rows.get(id)?.externalUrl?.includes('/tasks/fake_1'));
    });

    it('resumes on the retry instead of creating a second ticket', async () => {
      const { store, rows } = memoryStore();
      const id = seed(rows);
      const target = new FakeFeedbackTarget().failNextAfterCreate();

      await dispatchFeedback(id, { store, target, logger: quiet }).catch(() => null);
      await dispatchFeedback(id, { store, target, logger: quiet });

      assert.equal(target.submissions.length, 2);
      assert.deepEqual(target.creates, ['fake_1']);
      assert.deepEqual(target.submissions[1]!.resume, { externalId: 'fake_1' });
      matches(rows.get(id), { status: 'submitted', externalId: 'fake_1' });
    });
  });

  describe('nothing to do', () => {
    it('completes when the report no longer exists', async () => {
      const { store } = memoryStore();
      const target = new FakeFeedbackTarget();
      assert.deepEqual(await dispatchFeedback('missing', { store, target, logger: quiet }), {
        outcome: 'missing',
      });
      assert.equal(target.submissions.length, 0);
    });

    it('completes when the report was already submitted', async () => {
      const { store, rows } = memoryStore();
      const id = seed(rows, { status: 'submitted', externalId: 'existing-1' });
      const target = new FakeFeedbackTarget();
      assert.deepEqual(await dispatchFeedback(id, { store, target, logger: quiet }), {
        outcome: 'already_submitted',
      });
      assert.equal(target.submissions.length, 0);
    });

    it('retries a report an operator re-queued after it FAILED', async () => {
      const { store, rows } = memoryStore();
      const id = seed(rows, { status: 'failed', lastError: 'Token ungültig' });
      await dispatchFeedback(id, { store, target: new FakeFeedbackTarget(), logger: quiet });
      matches(rows.get(id), { status: 'submitted', lastError: null });
    });
  });

  it('logs through the given logger', async () => {
    const { store, rows } = memoryStore();
    const id = seed(rows);
    const lines: string[] = [];
    await dispatchFeedback(id, {
      store,
      target: new FakeFeedbackTarget(),
      logger: { log: (m) => lines.push(m), error: (m) => lines.push(m) },
    });
    assert.deepEqual(lines, [`report ${id} -> fake fake_1`]);
  });
});
