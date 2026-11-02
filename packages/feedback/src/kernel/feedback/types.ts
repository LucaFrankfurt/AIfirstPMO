// The feedback-target seam — the one contract the capture/UI side and the delivery
// side both depend on, and the reason a different issue tracker can replace the
// configured one without either of them changing.
//
// Consumers depend ONLY on this interface and the normalized report shape below,
// never on a concrete HTTP client. `KolibriFeedbackTarget` is the real
// implementation; `FakeFeedbackTarget` drives tests and local development. A future
// Linear/Jira target slots in next to it and nothing on the capture side is touched.
//
// Deliberately NOT on this interface: update/comment/close/list. Feedback is
// one-directional (the app posts, humans work the ticket in the tracker's own UI), so
// declaring round-trip methods would be inventing a contract no caller needs.

/**
 * Whether the configured target is run by the same organisation as the app, or by
 * someone else.
 *
 * This is the ONE property of a target that deliberately leaks upward into the UI,
 * and it earns that: it drives the PRIVACY POSTURE, not the transport. A screenshot
 * of an application view contains whatever data that view shows, so what the
 * reporter is told before they attach it — and whether attaching is the default at
 * all — depends on where those bytes are about to land.
 *
 * Self-hosted means the same data controller, no new processor, no third-country
 * transfer: an internal data flow, not a disclosure. A third-party target is a
 * genuinely different question (GDPR Art. 28 processor agreement), and putting the
 * distinction in the TYPE is what forces whoever adds such a target to answer it
 * rather than inherit an answer that was never about them.
 */
export type TrustBoundary = 'self_hosted' | 'third_party';

/**
 * What a target IS, independent of whether its credentials are present — the
 * safe-to-serialize view a web tier hands to the browser so the privacy notice can
 * name where the screenshot is going. Three strings, none of them secret.
 */
export interface FeedbackTargetDescriptor {
  /** Stable id, persisted on the report ("kolibri"). */
  name: string;
  /** Display name for the notice ("Kolibri"). */
  label: string;
  trustBoundary: TrustBoundary;
}

/** A file to attach to the created item. In practice: one screenshot, sometimes none. */
export interface FeedbackAttachment {
  filename: string; // "screenshot.webp"
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Who filed the report — resolved SERVER-SIDE from the app's own session, never from
 * the request body. The client posts a message, a kind, a screenshot and a bag of
 * browser facts; who it claims to be is not among the things it gets to say.
 */
export interface FeedbackReporter {
  id: string;
  name: string;
  /** Optional role, shown next to the name ("Max Mustermann (ADMIN)"). */
  role?: string | null;
}

/** A scalar fact in one of the report's context tables. `null`/`undefined` render as "—". */
export type FeedbackFactValue = string | number | boolean | null | undefined;

/**
 * Further SERVER-DERIVED facts for the trusted context table, as `[label, value]`
 * pairs in display order (tenant, active workspace, feature flags …). A tuple list
 * rather than a record so the order is exactly what the app wrote — a record would
 * silently hoist integer-like labels to the front.
 *
 * A `null` value still renders its row: "no active workspace" is information, and an
 * omitted row reads as a forgotten field.
 */
export type FeedbackServerContext = ReadonlyArray<readonly [label: string, value: FeedbackFactValue]>;

/**
 * Browser facts as REPORTED BY THE CLIENT. Every consumer must present these as
 * client-reported rather than mixing them in with the server-derived context: a
 * debugging artifact that blurs verified and self-reported facts is how people end up
 * chasing ghosts. Loosely typed on purpose — a target formats whatever it is given and
 * never depends on a particular key.
 */
export interface FeedbackClientContext {
  url?: string;
  title?: string;
  viewport?: string; // "1440x900"
  screen?: string;
  devicePixelRatio?: number;
  userAgent?: string;
  language?: string;
  timezone?: string;
  online?: boolean;
  connection?: string | null; // navigator.connection.effectiveType
  clientTime?: string; // ISO, from the CLIENT clock — skew explains a class of date bugs
  [key: string]: unknown;
}

/** A link from the ticket back to the report in the reporting app. */
export interface FeedbackBacklink {
  url: string;
  /** Link text; defaults to the messages' `report.openReport`. */
  label?: string;
}

/** The normalized report — the ONLY thing a FeedbackTarget consumes. */
export interface FeedbackReport<K extends string = string> {
  /**
   * The app's own report id. Backlink, support reference — and for Kolibri the TASK
   * id, which is what makes delivery idempotent. Must be a UUID for that target.
   */
  id: string;
  kind: K;
  message: string;
  reporter: FeedbackReporter;
  serverContext?: FeedbackServerContext;
  client: FeedbackClientContext;
  attachments: FeedbackAttachment[];
  /** When the app received the report (server clock). */
  createdAt: Date;
  backlink?: FeedbackBacklink | null;
}

/** What the target created. `externalUrl` is the human backlink, when the target has one. */
export interface FeedbackSubmission {
  externalId: string;
  externalUrl: string | null;
  /** May be FEWER than the report's attachments — a partial upload is a real outcome. */
  attachmentsUploaded: number;
}

/**
 * A target failure, classified.
 *
 * `permanent` is what stops a retry policy burning its whole attempt budget on a
 * misconfigured project id, and equally what stops a transient 502 being written off
 * as a dead report. The rule: a 4xx that no amount of retrying will fix (auth,
 * not-found, unprocessable) is permanent; 5xx, network and timeout are not.
 *
 * `externalId` is set when the failure happened AFTER the item was created (i.e. the
 * attachment upload failed). A durable caller persists it so the retry resumes the
 * upload instead of creating a second ticket.
 */
export class FeedbackTargetError extends Error {
  readonly permanent: boolean;
  readonly status?: number;
  readonly externalId?: string;
  readonly externalUrl?: string | null;

  constructor(message: string, permanent: boolean, status?: number, externalId?: string, externalUrl?: string | null) {
    super(message);
    this.name = 'FeedbackTargetError';
    this.permanent = permanent;
    this.status = status;
    this.externalId = externalId;
    this.externalUrl = externalUrl;
  }
}

/**
 * Resume hint for a retry: the item ALREADY EXISTS at the target with this id.
 *
 * Part of the interface rather than one target's detail, because it is inherent to any
 * target that creates an item and attaches files in separate calls (Kolibri, Jira and
 * Linear all do) — the window between those calls is exactly where a retry can
 * duplicate a ticket. A target whose create is idempotent, as Kolibri's is, needs it
 * only as a hint; one that creates atomically ignores it entirely.
 */
export interface FeedbackResume {
  externalId: string;
}

export interface FeedbackTarget extends FeedbackTargetDescriptor {
  /**
   * Create the item and attach the report's files.
   *
   * Contract: throws FeedbackTargetError on failure — it does NOT retry internally.
   * Retry belongs to the caller's durable queue, which is where the backoff, the
   * attempt budget and the operator visibility live. A target that retried on its own
   * would be a second, invisible retry policy layered under the real one.
   *
   * When `resume` is given the item must NOT be created again — only the remaining
   * work (the attachment upload) is retried.
   */
  submit(report: FeedbackReport, resume?: FeedbackResume): Promise<FeedbackSubmission>;
}

/** The descriptor of a live target — what crosses to the browser. */
export function describeTarget(target: FeedbackTargetDescriptor): FeedbackTargetDescriptor {
  return { name: target.name, label: target.label, trustBoundary: target.trustBoundary };
}

/** Injected so HTTP targets are unit-testable without a network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
