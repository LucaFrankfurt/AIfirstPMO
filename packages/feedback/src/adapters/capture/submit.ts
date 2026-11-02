// The browser half of the wire protocol whose server half is
// `@kolibri-day/feedback/server` (readFeedbackForm): one multipart POST with the fields
// `kind`, `message`, `clientContext` (JSON) and an optional `screenshot` file.
//
// Multipart rather than JSON + base64: the screenshot is the bulk of the request, and
// base64 would inflate it by a third for nothing. (In Next.js this also means a route
// handler, not a server action — server actions cap bodies at 1 MB by default.)
import type { FeedbackClientContext } from '../../kernel/feedback/types.ts';
import { screenshotFilename } from '../../kernel/feedback/files.ts';

export interface FeedbackSubmitInput {
  kind: string;
  message: string;
  clientContext?: FeedbackClientContext;
  /** The capture's blob, or null/undefined for a text-only report. */
  screenshot?: Blob | null;
}

/** Build the multipart body. Identity is deliberately not a field — the server takes it from the session. */
export function buildFeedbackForm(input: FeedbackSubmitInput): FormData {
  const form = new FormData();
  form.set('kind', input.kind);
  form.set('message', input.message);
  form.set('clientContext', JSON.stringify(input.clientContext ?? {}));
  if (input.screenshot) form.set('screenshot', input.screenshot, screenshotFilename(input.screenshot.type));
  return form;
}

export type FeedbackSubmitResult =
  | { ok: true; id: string | null }
  | {
      ok: false;
      status: number;
      /** The server's message for the reporter, when it sent one (`{ "error": "…" }`). */
      error: string | null;
    };

/**
 * POST the report. Resolves with the server's verdict; REJECTS only when the request
 * never got an answer (offline, DNS, CORS) — the caller words that case differently
 * ("network error, try again") from a refusal.
 *
 * Success means the server ACCEPTED the report — with the durable pipeline, that it is
 * stored, not that it reached the tracker. Word the confirmation accordingly.
 */
export async function submitFeedback(
  endpoint: string,
  input: FeedbackSubmitInput,
  options: { fetch?: typeof fetch } = {},
): Promise<FeedbackSubmitResult> {
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(endpoint, { method: 'POST', body: buildFeedbackForm(input) });
  const body = (await res.json().catch(() => null)) as { id?: unknown; error?: unknown } | null;
  if (!res.ok) {
    return { ok: false, status: res.status, error: typeof body?.error === 'string' ? body.error : null };
  }
  return { ok: true, id: typeof body?.id === 'string' ? body.id : null };
}
