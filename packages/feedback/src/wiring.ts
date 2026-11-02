// Which FeedbackTarget is configured — the ONE place that knows. Adding a target
// means a case here and a block of env vars; nothing on the capture, UI or delivery
// side changes.
//
//   FEEDBACK_TARGET=kolibri  + KOLIBRI_API_URL / _TOKEN / _WORKSPACE_ID / _PROJECT_ID
//   FEEDBACK_TARGET=fake     in-memory, for development
//   (unset)                  the fake in development; in PRODUCTION a target that fails
//                            every report loudly — never a silent fake
import type { FeedbackTarget, FeedbackTargetDescriptor, FetchLike } from './kernel/feedback/types.ts';
import { FakeFeedbackTarget, UnconfiguredFeedbackTarget } from './kernel/feedback/fake-target.ts';
import { KolibriFeedbackTarget, KOLIBRI_TARGET } from './adapters/kolibri/target.ts';
import { kolibriConfigFromEnv, type Env } from './adapters/kolibri/env.ts';
import { en, type FeedbackMessages } from './kernel/feedback/messages.ts';

export interface ResolvedFeedbackTarget {
  target: FeedbackTarget;
  /** Set when the target is a placeholder — log it once at boot. */
  warning: string | null;
}

export interface ResolveOptions {
  /** Language of the configuration warnings, the ticket body and the target errors. Default: German. */
  messages?: FeedbackMessages;
  /** Display labels for the app's own kinds, used in ticket titles. */
  kindLabels?: Readonly<Record<string, string>>;
  /** Per-request timeout for HTTP targets. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: FetchLike;
}

const KNOWN_TARGETS = ['kolibri', 'fake'] as const;

function processEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

/**
 * Build the configured target.
 *
 * NEVER THROWS. A misconfiguration produces an UnconfiguredFeedbackTarget plus a
 * warning, not an exception: failing a worker's boot over a feedback variable would
 * take every other job in that process down with it. The failure still surfaces — at
 * boot as the warning, and per report as a permanent failure naming the problem.
 */
export function resolveFeedbackTarget(env: Env = processEnv(), options: ResolveOptions = {}): ResolvedFeedbackTarget {
  const messages = options.messages ?? en;
  const choice = (env.FEEDBACK_TARGET ?? '').trim().toLowerCase();
  const isProduction = env.NODE_ENV === 'production';
  const unconfigured = (reason: string): ResolvedFeedbackTarget => ({
    target: new UnconfiguredFeedbackTarget(reason, messages.targets.unconfigured),
    warning: reason,
  });

  if (choice === '' || choice === 'fake') {
    // Unset in production is NOT treated as "use the fake". A silently-swallowing
    // target in production is the one outcome worse than a loud failure: people go on
    // filing reports that reach nobody.
    if (choice === '' && isProduction) return unconfigured(messages.config.targetUnset);
    return {
      target: new FakeFeedbackTarget({ label: messages.targets.fake }),
      warning: isProduction ? messages.config.fakeInProduction : null,
    };
  }

  if (choice === 'kolibri') {
    const read = kolibriConfigFromEnv(env, messages);
    if (!read.ok) return unconfigured(read.reason);
    return {
      target: new KolibriFeedbackTarget(
        { ...read.config, messages, kindLabels: options.kindLabels, timeoutMs: options.timeoutMs },
        options.fetch,
      ),
      // A configured Kolibri target is only as good as its preflight — the token's
      // write scope over the upload route cannot be assumed (see the README).
      warning: null,
    };
  }

  return unconfigured(messages.config.unknownTarget(choice, KNOWN_TARGETS));
}

/**
 * Where would a screenshot land? — answered WITHOUT credentials.
 *
 * A web tier legitimately holds no tracker token: it only needs FEEDBACK_TARGET so the
 * reporter's notice can name the destination. Resolving from that alone would yield
 * the unconfigured placeholder and a notice like "is stored in your self-hosted no
 * target system" — broken, and a false statement about where data goes. So a known
 * choice is described from its static descriptor; only an unset or unknown choice
 * falls through to the resolver, which is where "no target" is the honest answer.
 */
export function describeFeedbackTarget(
  env: Env = processEnv(),
  options: Pick<ResolveOptions, 'messages'> = {},
): FeedbackTargetDescriptor {
  const messages = options.messages ?? en;
  const choice = (env.FEEDBACK_TARGET ?? '').trim().toLowerCase();
  if (choice === KOLIBRI_TARGET.name) return { ...KOLIBRI_TARGET };
  if (choice === 'fake') return { name: 'fake', label: messages.targets.fake, trustBoundary: 'self_hosted' };

  const { target } = resolveFeedbackTarget(env, { messages });
  return { name: target.name, label: target.label, trustBoundary: target.trustBoundary };
}
