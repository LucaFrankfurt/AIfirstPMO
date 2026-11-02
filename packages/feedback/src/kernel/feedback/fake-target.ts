// In-memory FeedbackTarget — the default in development, so a fresh checkout has a
// working feedback button without anyone provisioning a tracker token first.
//
// It also has to be able to FAIL on demand: most of what is worth testing about
// delivery is the failure handling (transient vs permanent, resume-after-partial),
// and none of that is reachable against a target that always succeeds.
import type { FeedbackTarget, FeedbackReport, FeedbackResume, FeedbackSubmission, TrustBoundary } from './types.ts';
import { FeedbackTargetError } from './types.ts';
import { en } from './messages.ts';

export interface FakeSubmission {
  report: FeedbackReport;
  resume: FeedbackResume | undefined;
  externalId: string;
}

export interface FakeFeedbackTargetOptions {
  /** Origin used for the fake backlinks. */
  webUrl?: string;
  label?: string;
}

export class FakeFeedbackTarget implements FeedbackTarget {
  readonly name = 'fake';
  readonly label: string;
  /** Nothing leaves the process, so it is trivially inside the trust boundary. */
  readonly trustBoundary: TrustBoundary = 'self_hosted';

  /** Every submit() call, in order — including the ones that then threw. */
  readonly submissions: FakeSubmission[] = [];
  /** Calls that actually created a new item (i.e. were not resumes). Duplicate-ticket detector. */
  readonly creates: string[] = [];

  private seq = 0;
  private failures: FeedbackTargetError[] = [];
  private readonly webUrl: string;

  constructor(options: FakeFeedbackTargetOptions = {}) {
    this.webUrl = options.webUrl ?? 'https://fake.invalid';
    this.label = options.label ?? en.targets.fake;
  }

  /** Queue a failure for the NEXT submit() call (repeat to script a sequence). */
  failNext(error: FeedbackTargetError): this {
    this.failures.push(error);
    return this;
  }

  /** Convenience: the two classifications, scripted. */
  failNextTransient(message = 'target unreachable'): this {
    return this.failNext(new FeedbackTargetError(message, false));
  }
  failNextPermanent(message = 'target rejected the report'): this {
    return this.failNext(new FeedbackTargetError(message, true, 422));
  }
  /**
   * Script the partial failure that resumability exists for: the item was created,
   * the attachment upload then failed. The error carries the id, exactly as a real
   * target does, so a durable caller can persist it and resume.
   */
  failNextAfterCreate(message = 'attachment upload failed'): this {
    const id = `fake_${++this.seq}`;
    this.creates.push(id);
    return this.failNext(new FeedbackTargetError(message, false, 502, id, `${this.webUrl}/tasks/${id}`));
  }

  async submit(report: FeedbackReport, resume?: FeedbackResume): Promise<FeedbackSubmission> {
    const scripted = this.failures.shift();
    if (scripted) {
      this.submissions.push({ report, resume, externalId: scripted.externalId ?? '' });
      throw scripted;
    }

    const externalId = resume?.externalId ?? `fake_${++this.seq}`;
    if (!resume) this.creates.push(externalId);
    this.submissions.push({ report, resume, externalId });
    return {
      externalId,
      externalUrl: `${this.webUrl}/tasks/${externalId}`,
      attachmentsUploaded: report.attachments.length,
    };
  }
}

/**
 * A target that always fails permanently with a configuration message.
 *
 * This is what an unconfigured production deployment gets, and the choice is
 * deliberate: reports are still PERSISTED and the failure is LOUD (a failed report
 * naming the missing variables). The alternative — silently discarding reports, or
 * refusing the button — would mean people file feedback into nothing and conclude the
 * team ignored them.
 *
 * It is also why a missing variable does not throw at process BOOT: that would take
 * every other job in the same worker down over a feedback misconfiguration.
 */
export class UnconfiguredFeedbackTarget implements FeedbackTarget {
  readonly name = 'unconfigured';
  readonly trustBoundary: TrustBoundary = 'self_hosted';
  readonly label: string;
  private readonly reason: string;

  constructor(reason: string, label: string = en.targets.unconfigured) {
    this.reason = reason;
    this.label = label;
  }

  async submit(_report?: FeedbackReport, _resume?: FeedbackResume): Promise<FeedbackSubmission> {
    throw new FeedbackTargetError(this.reason, true);
  }
}
