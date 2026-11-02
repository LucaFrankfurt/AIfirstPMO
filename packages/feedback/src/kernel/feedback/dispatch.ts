// Delivering a STORED report to the configured target — the half of the design that
// makes feedback honest about failure.
//
// The recommended shape is durable: the app confirms a report as soon as it is
// stored, and delivery runs later from a job queue that provides backoff, an attempt
// budget and an operator-visible failed state. A synchronous submit in the request
// path would lose the report outright whenever the tracker is down — which is
// precisely when people are filing bug reports.
//
// The package owns the RULES; the app owns storage and the queue, behind the small
// FeedbackStore interface below. Three rules worth reading before changing anything:
//
// 1. THE EXTERNAL ID IS PERSISTED BEFORE THE ATTACHMENT UPLOAD IS RETRIED. Creating
//    the item and uploading the screenshot are separate calls at most trackers; a
//    failure between them must resume the upload, never create a second ticket. The
//    target reports a post-create failure by carrying the id on the error, and it is
//    recorded immediately.
//
// 2. PERMANENT FAILURES DO NOT RETRY. A bad token or a missing project fails
//    identically on every attempt, and the delay only postpones the failed report
//    someone needs to see. Transient failures are rethrown into the queue's backoff.
//
// 3. THE SCREENSHOT IS DELETED ON SUCCESS. Once the target holds the bytes, a second
//    copy in the app's database is pure added exposure — markSubmitted must drop it
//    (keeping only metadata such as type and size, if the app wants to show that one
//    was attached).
import { FeedbackTargetError, type FeedbackReport, type FeedbackSubmission, type FeedbackTarget } from './types.ts';

export type StoredFeedbackStatus = 'pending' | 'submitted' | 'failed';

export interface StoredFeedback {
  report: FeedbackReport;
  status: StoredFeedbackStatus;
  /** Set when an earlier attempt created the item at the target but did not finish. */
  externalId: string | null;
}

export interface FeedbackSubmittedUpdate {
  targetName: string;
  externalId: string;
  externalUrl: string | null;
  submittedAt: Date;
}

export interface FeedbackFailureUpdate {
  targetName: string;
  /** The error message, truncated — safe to show an operator (targets never put credentials in it). */
  message: string;
  /** Mark the report failed for good; no attempt will ever succeed. */
  permanent: boolean;
  /** The item exists at the target — persist it so the next attempt resumes instead of re-creating. */
  externalId?: string;
  externalUrl?: string | null;
}

/** Where the app keeps its reports. Implement it over your own database. */
export interface FeedbackStore {
  load(id: string): Promise<StoredFeedback | null>;
  /** Record delivery — AND drop the stored screenshot bytes (rule 3). Clears any recorded error. */
  markSubmitted(id: string, update: FeedbackSubmittedUpdate): Promise<void>;
  /** Record a failed attempt (rule 1 and 2). */
  recordFailure(id: string, update: FeedbackFailureUpdate): Promise<void>;
}

export type DispatchResult =
  | { outcome: 'submitted'; submission: FeedbackSubmission }
  | { outcome: 'missing' }
  | { outcome: 'already_submitted' }
  | { outcome: 'failed_permanently'; message: string };

export interface DispatchLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface DispatchOptions {
  store: FeedbackStore;
  target: FeedbackTarget;
  logger?: DispatchLogger;
}

const defaultLogger: DispatchLogger = {
  log: (m) => console.log(`[feedback] ${m}`),
  error: (m) => console.error(`[feedback] ${m}`),
};

/** Longest error message recorded on a report. */
export const MAX_ERROR_LENGTH = 1_000;

/**
 * Deliver one stored report.
 *
 * Resolves on success, on nothing-to-do, and on a PERMANENT failure (recorded — the
 * failed report IS the alarm, and rethrowing would only burn the retry budget).
 * Throws on a TRANSIENT failure, after recording it, so the caller's queue backs off
 * and tries again. Any error that is not a FeedbackTargetError (a bug, a database
 * hiccup) counts as transient: it is not known to be hopeless.
 */
export async function dispatchFeedback(id: string, options: DispatchOptions): Promise<DispatchResult> {
  const { store, target } = options;
  const logger = options.logger ?? defaultLogger;

  const stored = await store.load(id);
  // Gone, or already delivered: complete rather than throw. A job that can never
  // succeed must not retry to exhaustion and then sit failed with nothing for an
  // operator to act on.
  if (!stored) {
    logger.log(`report ${id} no longer exists — skipping`);
    return { outcome: 'missing' };
  }
  if (stored.status === 'submitted') {
    logger.log(`report ${id} already submitted (${stored.externalId ?? '?'}) — skipping`);
    return { outcome: 'already_submitted' };
  }

  try {
    // Resume when the item already exists (create succeeded, upload didn't).
    const resume = stored.externalId ? { externalId: stored.externalId } : undefined;
    const submission = await target.submit(stored.report, resume);
    await store.markSubmitted(id, {
      targetName: target.name,
      externalId: submission.externalId,
      externalUrl: submission.externalUrl,
      submittedAt: new Date(),
    });
    logger.log(`report ${id} -> ${target.name} ${submission.externalId}`);
    return { outcome: 'submitted', submission };
  } catch (e) {
    const err = e instanceof FeedbackTargetError ? e : null;
    const message = (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_LENGTH);
    const permanent = err?.permanent ?? false;

    await store.recordFailure(id, {
      targetName: target.name,
      message,
      permanent,
      // Written the moment it is known — rule 1. Without it, the next attempt creates
      // a duplicate ticket at any target whose create is not idempotent.
      ...(err?.externalId ? { externalId: err.externalId, externalUrl: err.externalUrl ?? null } : {}),
    });

    if (permanent) {
      logger.error(`report ${id} permanently failed: ${message}`);
      return { outcome: 'failed_permanently', message };
    }
    throw e;
  }
}
