'use client';

// React bindings for the reporter: one dialog, any number of triggers.
//
// The indirection through context is the design. Every entry point — a floating
// button, a menu item, a keyboard shortcut, a future shake-to-report — calls
// `openFeedback()` and knows nothing else; the dialog reads the state. A second copy of
// the surface would be a second copy of the rules.
//
// Two contexts, on purpose: triggers subscribe only to the stable `openFeedback`, so
// a capture finishing re-renders the dialog and not every button in the app.
//
// The markup is the app's. This package ships no dialog, because the one thing every
// app already has is its own dialog component — and a second one, styled differently,
// would be the odd one out. Remember the two attributes that keep it out of its own
// screenshot: REDACT_ATTRIBUTE on the dialog panel AND on its backdrop.
import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  FeedbackReporterController,
  type FeedbackReporterOptions,
  type FeedbackReporterSnapshot,
} from '../capture/reporter.ts';
import type { CaptureResult } from '../capture/capture.ts';

export interface FeedbackActions {
  /** Start the capture and open the dialog. A no-op while it is already open. */
  openFeedback: () => void;
}

export interface FeedbackReporterState extends FeedbackReporterSnapshot {
  openFeedback: () => void;
  close: () => void;
  /** The settled capture — for a submit that outruns the renderer. */
  waitForCapture: () => Promise<CaptureResult | null>;
}

const ActionsContext = createContext<FeedbackActions | null>(null);
const ControllerContext = createContext<FeedbackReporterController | null>(null);

export interface FeedbackReporterProviderProps extends FeedbackReporterOptions {
  children?: ReactNode;
}

export function FeedbackReporterProvider({ children, capture, captureOptions }: FeedbackReporterProviderProps) {
  // Created once per provider. The options are read at creation; changing them later
  // would mean a different reporter, which no app has needed.
  const [controller] = useState(() => new FeedbackReporterController({ capture, captureOptions }));
  const actions = useMemo<FeedbackActions>(() => ({ openFeedback: controller.open }), [controller]);
  return (
    <ControllerContext.Provider value={controller}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </ControllerContext.Provider>
  );
}

const noop: FeedbackActions = { openFeedback: () => {} };

/**
 * For triggers. Safe to call from anywhere; a no-op outside the provider, so a
 * component also rendered on a page without a reporter (a public page with nobody to
 * attribute a report to) does not crash.
 */
export function useFeedback(): FeedbackActions {
  return useContext(ActionsContext) ?? noop;
}

/** For the dialog: the full state plus the actions. Must be inside FeedbackReporterProvider. */
export function useFeedbackReporter(): FeedbackReporterState {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error('useFeedbackReporter must be used inside <FeedbackReporterProvider>');
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return useMemo(
    () => ({
      ...snapshot,
      openFeedback: controller.open,
      close: controller.close,
      waitForCapture: controller.waitForCapture,
    }),
    [snapshot, controller],
  );
}
