// The reporter's state machine — open/close and the screenshot that runs alongside —
// without any UI framework. `@kolibri-day/feedback/react` binds it to React; a Vue or
// vanilla app subscribes to it directly.
//
// THE DIALOG OPENS IMMEDIATELY; THE CAPTURE RESOLVES INTO ITS PREVIEW. This sequencing
// is the third iteration, and the constraint it finally gets right is about PIXELS,
// not order. v1 opened the dialog before capturing — the form was in every screenshot.
// v2 held the dialog until the capture finished — correct pixels, but on a real page a
// DOM render takes seconds (measured ~4.5s for modern-screenshot and ~1.7s for
// html2canvas at ~2000 elements), and a button that does nothing for seconds reads as
// broken. No renderer choice fixes that; the render cost has to come OFF the
// click-to-dialog path.
//
// So: the capture starts at open(), the dialog opens in the same tick, and the dialog
// stays out of the shot because its panel AND its backdrop carry REDACT_ATTRIBUTE.
// The preview shows "capturing…" until the frame lands; a submit that outruns it
// awaits waitForCapture().
//
// Known minor artifact, accepted: a modal that locks page scroll removes the
// scrollbar, so on classic-scrollbar systems the capture can sit ~15px off from what
// was on screen. A shifted-by-a-scrollbar screenshot is a fair trade for an instant
// dialog.
import { captureViewport, type CaptureOptions, type CaptureResult } from './capture.ts';

export type CaptureState =
  | { status: 'idle' }
  | { status: 'capturing' }
  | { status: 'failed' }
  | ({ status: 'ready' } & CaptureResult);

export interface FeedbackReporterSnapshot {
  open: boolean;
  capture: CaptureState;
}

export interface FeedbackReporterOptions {
  /** Replace the capture (tests, or an app with its own renderer). Default: captureViewport(captureOptions). */
  capture?: () => Promise<CaptureResult | null>;
  captureOptions?: CaptureOptions;
}

const IDLE: FeedbackReporterSnapshot = Object.freeze({
  open: false,
  capture: Object.freeze({ status: 'idle' as const }),
});

export class FeedbackReporterController {
  private snapshot: FeedbackReporterSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  /** The in-flight capture, for a submit that arrives before it resolves. */
  private pending: Promise<CaptureResult | null> | null = null;
  /** Generation stamp, so a capture orphaned by close() can never write stale state. */
  private generation = 0;
  private readonly capture: () => Promise<CaptureResult | null>;

  constructor(options: FeedbackReporterOptions = {}) {
    this.capture = options.capture ?? (() => captureViewport(options.captureOptions));
  }

  /** The current state. The same object until something changes — safe for useSyncExternalStore. */
  getSnapshot = (): FeedbackReporterSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: FeedbackReporterSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  /** Start the capture and open, in the same tick. A no-op while already open. */
  open = (): void => {
    if (this.snapshot.open) return;
    const generation = ++this.generation;
    // A capture that throws (it should not — captureViewport returns null on failure)
    // still settles as "no screenshot" rather than an unhandled rejection.
    const pending = this.capture().catch(() => null);
    this.pending = pending;
    this.set({ open: true, capture: { status: 'capturing' } });
    void pending.then((result) => {
      if (this.generation !== generation) return; // closed meanwhile — stale frame
      this.set({ open: true, capture: result ? { status: 'ready', ...result } : { status: 'failed' } });
    });
  };

  /**
   * Close and forget. The render itself cannot be aborted, but its result is
   * discarded — no reason to hold an image for a report that was cancelled.
   */
  close = (): void => {
    this.generation++;
    this.pending = null;
    this.set(IDLE);
  };

  /** The settled capture — immediately when done, or after an in-flight one finishes. */
  waitForCapture = async (): Promise<CaptureResult | null> => {
    return this.pending ? await this.pending : null;
  };
}
