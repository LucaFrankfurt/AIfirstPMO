// The reporter's state machine, without a DOM: the capture is injected.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FeedbackReporterController } from '../src/adapters/capture/reporter.ts';
import type { CaptureResult } from '../src/adapters/capture/capture.ts';

function deferred() {
  let resolve!: (r: CaptureResult | null) => void;
  const promise = new Promise<CaptureResult | null>((r) => (resolve = r));
  return { promise, resolve };
}

const shot = (): CaptureResult => ({
  blob: new Blob([new Uint8Array(3)], { type: 'image/webp' }),
  width: 3,
  height: 1,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('FeedbackReporterController', () => {
  it('opens IMMEDIATELY with the capture running, then resolves into the preview', async () => {
    const d = deferred();
    const c = new FeedbackReporterController({ capture: () => d.promise });

    c.open();
    // The dialog does not wait for a render that takes seconds.
    assert.deepEqual(c.getSnapshot(), { open: true, capture: { status: 'capturing' } });

    const result = shot();
    d.resolve(result);
    await flush();
    assert.deepEqual(c.getSnapshot(), { open: true, capture: { status: 'ready', ...result } });
  });

  it('reports a failed capture as such — the report can still go without one', async () => {
    const c = new FeedbackReporterController({ capture: async () => null });
    c.open();
    await flush();
    assert.deepEqual(c.getSnapshot().capture, { status: 'failed' });
  });

  it('treats a capture that throws like one that failed', async () => {
    const c = new FeedbackReporterController({ capture: () => Promise.reject(new Error('boom')) });
    c.open();
    await flush();
    assert.deepEqual(c.getSnapshot().capture, { status: 'failed' });
  });

  it('discards a capture that lands after close() — no stale frame in the next report', async () => {
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    const c = new FeedbackReporterController({ capture: () => queue.shift()!.promise });

    c.open();
    c.close();
    c.open(); // a NEW report, with its own capture
    first.resolve(shot()); // the orphan finishes late
    await flush();
    assert.deepEqual(c.getSnapshot().capture, { status: 'capturing' });

    second.resolve(null);
    await flush();
    assert.deepEqual(c.getSnapshot().capture, { status: 'failed' });
  });

  it('ignores open() while already open — no second capture', () => {
    let captures = 0;
    const c = new FeedbackReporterController({ capture: async () => (captures++, null) });
    c.open();
    c.open();
    assert.equal(captures, 1);
  });

  it('lets a submit that outruns the renderer wait for it', async () => {
    const d = deferred();
    const c = new FeedbackReporterController({ capture: () => d.promise });
    c.open();
    const waiting = c.waitForCapture();
    const result = shot();
    d.resolve(result);
    assert.equal(await waiting, result);
  });

  it('has nothing to wait for once closed', async () => {
    const c = new FeedbackReporterController({ capture: async () => shot() });
    c.open();
    c.close();
    assert.equal(await c.waitForCapture(), null);
    assert.deepEqual(c.getSnapshot(), { open: false, capture: { status: 'idle' } });
  });

  it('keeps the snapshot identity stable until something changes, and notifies on change', async () => {
    const c = new FeedbackReporterController({ capture: async () => null });
    const seen: unknown[] = [];
    const unsubscribe = c.subscribe(() => seen.push(c.getSnapshot()));
    const before = c.getSnapshot();
    assert.equal(c.getSnapshot(), before); // what useSyncExternalStore requires

    c.open();
    await flush();
    assert.equal(seen.length, 2); // capturing, then failed
    unsubscribe();
    c.close();
    assert.equal(seen.length, 2);
  });
});
