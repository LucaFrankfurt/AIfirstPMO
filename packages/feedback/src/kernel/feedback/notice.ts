// The privacy notice shown next to the screenshot, and whether attaching is the
// default — both derived from the CONFIGURED TARGET rather than hardcoded.
//
// This is the payoff of `trustBoundary` on the target. A screenshot of an application
// view contains whatever that view shows, and the honest answer to "is that fine?"
// depends entirely on where the bytes land:
//
//   self-hosted  — same data controller, no processor, no third-country transfer.
//                  An internal data flow. Attaching stays the default because the
//                  screenshot is what makes a bug report actionable.
//   third-party  — a different company's systems. That is a disclosure and needs a
//                  GDPR Art. 28 processor agreement; the reporter must OPT IN rather
//                  than opt out, and the notice must name the change.
//
// Worth stating plainly, because the self-hosted case is not zero-risk: an app's own
// visibility rules are usually FINER-GRAINED than the tracker's. Everyone with access
// to the feedback project sees every screenshot in it, so a screenshot can widen the
// audience for data *within* the organisation even when it never leaves it. The
// mitigation is configuration, not code: a dedicated, access-restricted project.
import type { FeedbackTargetDescriptor } from './types.ts';
import { en, type FeedbackMessages } from './messages.ts';

/** Is the screenshot attached by default? Only inside our own trust boundary. */
export function screenshotDefaultOn(target: Pick<FeedbackTargetDescriptor, 'trustBoundary'>): boolean {
  return target.trustBoundary === 'self_hosted';
}

/**
 * The notice text. Names what the screenshot contains AND where it goes — a warning
 * that says only "a screenshot will be attached" tells the reporter nothing they
 * could act on.
 */
export function screenshotNotice(target: FeedbackTargetDescriptor, messages: FeedbackMessages = en): string {
  return target.trustBoundary === 'self_hosted'
    ? messages.notice.selfHosted(target.label)
    : messages.notice.thirdParty(target.label);
}
