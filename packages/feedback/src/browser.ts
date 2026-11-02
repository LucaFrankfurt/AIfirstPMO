// @kolibri-day/feedback/browser — viewport capture, browser facts, the reporter's
// state machine, and the client half of the wire protocol. Browser-only at call time;
// importing it on a server is harmless (nothing runs at module load).
export {
  captureViewport,
  encodeWithinBudget,
  fitWithin,
  isRequestedType,
  REDACT_ATTRIBUTE,
  MAX_EDGE_PX,
  TARGET_MAX_BYTES,
  HARD_MAX_BYTES,
  type CaptureOptions,
  type CaptureResult,
} from './adapters/capture/capture.ts';
export { collectClientContext } from './adapters/capture/client-context.ts';
export {
  FeedbackReporterController,
  type CaptureState,
  type FeedbackReporterSnapshot,
  type FeedbackReporterOptions,
} from './adapters/capture/reporter.ts';
export {
  buildFeedbackForm,
  submitFeedback,
  type FeedbackSubmitInput,
  type FeedbackSubmitResult,
} from './adapters/capture/submit.ts';
