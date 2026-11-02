'use client';

// @kolibri-day/feedback/react — the reporter's state for React (18+), without markup.
export {
  FeedbackReporterProvider,
  useFeedback,
  useFeedbackReporter,
  type FeedbackActions,
  type FeedbackReporterState,
  type FeedbackReporterProviderProps,
} from './adapters/react/reporter.tsx';
export type { CaptureState } from './adapters/capture/reporter.ts';
export type { CaptureResult } from './adapters/capture/capture.ts';
