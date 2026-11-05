// The Kolibri FeedbackTarget.
//
// Transport is a plain fetch(), not a client library: two HTTP calls with a static
// auth header do not justify a dependency.
//
// Every claim below about Kolibri's behaviour was verified against the live API and
// its source, not inferred from the OpenAPI document — the write-up is
// docs/setaside-feedback-api.md in this repository, and the § references point into
// it. openapi.json describes the generated CRUD routes but says "read the handler" for
// exactly the two routes this file depends on.
//
// TWO CALLS:
//     POST {base}/api/workspaces/{ws}/tasks              -> the task (JSON)
//     POST {base}/api/workspaces/{ws}/files?task_id={id}  -> the screenshot (RAW body)
//
// THE CREATE IS AN UPSERT, AND THAT IS THE WHOLE TRICK (§G25). Kolibri lets the client
// choose the row id, and a create against an id that already exists updates it rather
// than inserting a second row — same task, same number, same created_at. So the
// report's own id is sent as the task id, and the create becomes idempotent for free:
// a retry can never produce a duplicate ticket.
//
// AND SO IS THE UPLOAD. Kolibri matches uploads on (workspace, checksum, target) among
// living rows, so re-sending identical bytes to the same task returns the row that is
// already there instead of a second one. Both calls are safe to repeat.
//
// DESCRIPTIONS ARE MARKDOWN, AND ARE NOT ESCAPED HERE: Kolibri's renderer escapes
// everything before generating markup (§B8). See format.ts.
import type {
  FeedbackTarget,
  FeedbackReport,
  FeedbackResume,
  FeedbackSubmission,
  FeedbackTargetDescriptor,
  FetchLike,
} from '../../kernel/feedback/types.ts';
import { FeedbackTargetError } from '../../kernel/feedback/types.ts';
import { buildTitle, buildDescriptionMarkdown, type FormatOptions } from '../../kernel/feedback/format.ts';
import { en, type FeedbackMessages } from '../../kernel/feedback/messages.ts';

/**
 * What a Kolibri target is, before it has credentials — so a web tier that holds no
 * token can still tell the reporter where the screenshot goes.
 *
 * Self-hosted by the team that runs the app: same controller, no processor, no
 * third-country transfer. It settles the EXTERNAL question only. The internal one —
 * who inside the company can open a screenshot — is answered by the feedback
 * project's membership, and only on a Kolibri that scopes attachments by the project
 * of the task they hang off. On an older instance attachments were visible to the
 * whole workspace, which is why a MINIMUM KOLIBRI VERSION is part of the setup, not
 * just a private project (see the README).
 */
export const KOLIBRI_TARGET: FeedbackTargetDescriptor = Object.freeze({
  name: 'kolibri',
  label: 'Kolibri',
  trustBoundary: 'self_hosted',
});

export interface KolibriConfig {
  /**
   * Kolibri's origin — e.g. https://kolibri.example.com. NOT an /api path. Kolibri
   * serves its API and its web app from the same origin, so the task backlink is built
   * from this too.
   */
  apiUrl: string;
  /** API token ("kol_…"), sent as `Authorization: Bearer …`. Needs the `write` scope. */
  token: string;
  /** Workspace UUID. A slug is refused with 403 (§A2). */
  workspaceId: string;
  /** UUID of the (private) feedback project. A project key is refused with 400 (§A3). */
  projectId: string;
  /** Per-request timeout. fetch() has none by default. */
  timeoutMs?: number;
  /** Language of the ticket body and of the error messages. Default: German. */
  messages?: FeedbackMessages;
  /** Display labels for the app's kinds in the title. */
  kindLabels?: FormatOptions['kindLabels'];
  /** Keep the reported URL's query string and fragment in the ticket. Default: false. */
  fullUrl?: FormatOptions['fullUrl'];
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Kolibri addresses workspaces and projects by UUID and refuses anything else — a
 * slug with 403, a project key with 400 (§A2/§A3). Checking the shape up front turns
 * a per-report round-trip that reads as "Kolibri rejected us" into "this setting is
 * wrong".
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this status worth retrying?
 *
 * 4xx means we sent something Kolibri will reject identically next time — a bad token,
 * a project that doesn't exist, a body it won't process. Retrying burns the attempt
 * budget and delays the failed report an operator needs to see. 429 and 408 are the
 * exceptions inside 4xx: both explicitly mean "later".
 *
 * 5xx is transient. Kolibri used to answer a NOT NULL violation with 500, so a
 * permanently-malformed write could masquerade as an outage; current instances answer
 * those with 400, so a 5xx is what it claims to be.
 */
export function isPermanentStatus(status: number): boolean {
  if (status === 429 || status === 408) return false;
  return status >= 400 && status < 500;
}

/** Truncated response body for the error message. Never contains the token — that only ever travels in a header. */
async function errorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 500);
}

export class KolibriFeedbackTarget implements FeedbackTarget {
  readonly name = KOLIBRI_TARGET.name;
  readonly label = KOLIBRI_TARGET.label;
  readonly trustBoundary = KOLIBRI_TARGET.trustBoundary;

  private readonly config: KolibriConfig;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly messages: FeedbackMessages;

  constructor(config: KolibriConfig, fetchFn: FetchLike = (input, init) => fetch(input, init)) {
    this.config = config;
    this.fetchFn = fetchFn;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.messages = config.messages ?? en;
  }

  /** Base with any trailing slash removed, so path joins never double up. */
  private get base(): string {
    return this.config.apiUrl.replace(/\/+$/, '');
  }

  /** The human backlink. `/t/{id}` accepts the row id or the identifier; the id is stable across a project-key rename (§F24). */
  taskUrl(taskId: string): string {
    return `${this.base}/t/${taskId}`;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.base}${path}`;
    try {
      return await this.fetchFn(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.config.token}`, ...((init.headers as Record<string, string>) ?? {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Network-level: DNS, TLS, connection refused, or our own timeout. No response
      // to classify, and all of them are worth another attempt later.
      throw new FeedbackTargetError(
        this.messages.kolibri.unreachable(path, e instanceof Error ? e.message : String(e)),
        false,
      );
    }
  }

  /**
   * POST /api/workspaces/{ws}/tasks — idempotent on the report's own id.
   *
   * `state_id` is deliberately absent: Kolibri fills in the project's default state
   * (§A1), and naming one here would mean the app owning a workflow decision that
   * belongs to whoever configures the board.
   */
  private async createTask(report: FeedbackReport): Promise<void> {
    const format: FormatOptions = { messages: this.messages, kindLabels: this.config.kindLabels, fullUrl: this.config.fullUrl };
    const res = await this.request(`/api/workspaces/${this.config.workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: report.id,
        project_id: this.config.projectId,
        title: buildTitle(report, format),
        description: buildDescriptionMarkdown(report, format),
      }),
    });

    if (!res.ok) {
      const body = await errorBody(res);
      throw new FeedbackTargetError(
        this.messages.kolibri.createRejected(res.status, body),
        isPermanentStatus(res.status),
        res.status,
      );
    }
  }

  /**
   * POST /api/workspaces/{ws}/files?task_id={id} — the body IS the file.
   *
   * Not multipart and not base64 (§C11): Kolibri takes the raw bytes with the name in
   * `x-filename` and the type in `content-type`, and creates the attachment row itself
   * because `?task_id=` is present. That is why there is no third call.
   *
   * Repeating this call is safe — Kolibri matches identical bytes against what already
   * hangs on the task and hands back the existing row.
   */
  private async uploadAttachments(taskId: string, report: FeedbackReport): Promise<number> {
    if (report.attachments.length === 0) return 0;

    let uploaded = 0;

    for (const att of report.attachments) {
      // Copy into a fresh ArrayBuffer before sending. Two reasons, and the second is
      // the one that bites: a Uint8Array read out of a database driver may be a view
      // onto a larger pooled Node Buffer, so sending the view risks sending its
      // neighbours; and `Uint8Array<ArrayBufferLike>` is not a `BodyInit`, because the
      // buffer behind it could be shared. The copy settles both.
      const body = new ArrayBuffer(att.bytes.byteLength);
      new Uint8Array(body).set(att.bytes);

      const res = await this.request(
        `/api/workspaces/${this.config.workspaceId}/files?task_id=${encodeURIComponent(taskId)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': att.contentType,
            // Kolibri decodes this and strips path separators itself; encoding is what
            // keeps a non-ASCII or spaced filename from breaking the header.
            'x-filename': encodeURIComponent(att.filename),
          },
          body,
        },
      );

      if (!res.ok) {
        const detail = await errorBody(res);
        throw new FeedbackTargetError(
          this.messages.kolibri.uploadRejected(res.status, detail),
          isPermanentStatus(res.status),
          res.status,
          // The task EXISTS. Carrying the id lets a durable caller persist it, which is
          // belt-and-braces here rather than load-bearing: the id is the report's own,
          // so a retry would find the task even without this.
          taskId,
          this.taskUrl(taskId),
        );
      }
      uploaded += 1;
    }

    return uploaded;
  }

  /**
   * Create the task, then upload attachments.
   *
   * `resume` is accepted for the interface's sake but carries no information this
   * target needs: the task id is the report id, so it is known before the first call
   * and identical on every attempt. Re-running the create on a resume is deliberate —
   * it is an upsert, it costs one request, and it repairs a task whose description
   * failed to write the first time.
   */
  async submit(report: FeedbackReport, _resume?: FeedbackResume): Promise<FeedbackSubmission> {
    await this.createTask(report);
    const attachmentsUploaded = await this.uploadAttachments(report.id, report);
    return { externalId: report.id, externalUrl: this.taskUrl(report.id), attachmentsUploaded };
  }
}
