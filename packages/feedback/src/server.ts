// @kolibri-day/feedback/server — what runs next to the app's own session and storage:
// resolving the configured target, reading and validating an incoming report, and
// delivering a stored report with the right retry semantics.
export {
  resolveFeedbackTarget,
  describeFeedbackTarget,
  type ResolvedFeedbackTarget,
  type ResolveOptions,
} from './wiring.ts';
export {
  readFeedbackForm,
  parseFeedbackInput,
  sanitizeClientContext,
  FeedbackInputError,
  DEFAULT_LIMITS,
  type FeedbackLimits,
  type FeedbackInput,
  type FeedbackScreenshotInput,
  type ParsedFeedbackInput,
  type ParseOptions,
} from './kernel/feedback/input.ts';
export {
  dispatchFeedback,
  MAX_ERROR_LENGTH,
  type FeedbackStore,
  type StoredFeedback,
  type StoredFeedbackStatus,
  type FeedbackSubmittedUpdate,
  type FeedbackFailureUpdate,
  type DispatchResult,
  type DispatchOptions,
  type DispatchLogger,
} from './kernel/feedback/dispatch.ts';
export type { Env } from './adapters/kolibri/env.ts';
