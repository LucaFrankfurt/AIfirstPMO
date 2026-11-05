// Reading and validating an incoming report — the server half of the wire protocol
// whose browser half is `@kolibri-day/feedback/browser` (buildFeedbackForm).
//
// THE ONE RULE THIS FILE ENFORCES: identity is not part of the input. The wire shape
// is a kind, a message, a screenshot and a bag of browser facts — and that is ALL a
// client is allowed to say. A client that posts `role: "ADMIN"` is not rejected; the
// field is simply never read, which is the only version of this that cannot rot (a
// rejection list has to be kept in sync with the schema; a shape that has no such
// field does not). The app attaches the reporter from its own session, after this.
//
// Framework-agnostic: takes a standard `Request`, so it works in a Next.js route
// handler, Hono, Remix, a Cloudflare worker or plain Node 18+.
import type { FeedbackClientContext } from './types.ts';
import { SCREENSHOT_MIME_TYPES } from './files.ts';
import { en, type FeedbackMessages } from './messages.ts';

export interface FeedbackLimits {
  /** Free text cap. Generous — a good bug report is long — but not unbounded. */
  maxMessageLength: number;
  /**
   * Hard ceiling on an accepted screenshot. The browser capture targets ~1 MB and a
   * typical UI screenshot is far below that, so anything approaching this is either
   * a pathological page or a hand-crafted request.
   */
  maxScreenshotBytes: number;
  /** Room for the text fields on top of the screenshot, for the whole-body pre-check. */
  maxBodyOverheadBytes: number;
  /** Client-context keys are capped in count and size — it is an untrusted free-form blob. */
  maxContextKeys: number;
  maxContextKeyLength: number;
  maxContextValueLength: number;
  /** The serialized client-context field; anything longer is dropped, not parsed. */
  maxContextJsonLength: number;
}

export const DEFAULT_LIMITS: Readonly<FeedbackLimits> = Object.freeze({
  maxMessageLength: 5_000,
  maxScreenshotBytes: 3 * 1024 * 1024,
  maxBodyOverheadBytes: 256 * 1024,
  maxContextKeys: 40,
  maxContextKeyLength: 64,
  maxContextValueLength: 2_000,
  maxContextJsonLength: 20_000,
});

export interface FeedbackScreenshotInput {
  bytes: Uint8Array;
  contentType: string;
}

/** The wire shape — deliberately the COMPLETE set of things a client may say. */
export interface FeedbackInput {
  kind: string;
  message: string;
  clientContext: unknown;
  screenshot?: FeedbackScreenshotInput | null;
}

export interface ParsedFeedbackInput<K extends string = string> {
  kind: K;
  message: string;
  clientContext: FeedbackClientContext;
  screenshot: FeedbackScreenshotInput | null;
}

/**
 * A report the server will not accept, with the HTTP status to answer it with and a
 * message worded for the reporter.
 */
export class FeedbackInputError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = 'FeedbackInputError';
    this.status = status;
  }
}

interface InputOptions {
  limits?: Partial<FeedbackLimits>;
  /** Language of the error messages. Default: German. */
  messages?: FeedbackMessages;
}

function limitsOf(options: InputOptions): FeedbackLimits {
  return { ...DEFAULT_LIMITS, ...options.limits };
}

/**
 * Normalize the untrusted client-context blob.
 *
 * Permissive about WHICH keys arrive (the browser facts worth capturing will change,
 * and a strict allowlist would silently drop new ones) but strict about SIZE and
 * DEPTH: scalars only, bounded key count, bounded string length. An unbounded nested
 * object here would be a free write-amplification primitive into whatever stores it.
 */
export function sanitizeClientContext(raw: unknown, limits: Partial<FeedbackLimits> = {}): FeedbackClientContext {
  const l = { ...DEFAULT_LIMITS, ...limits };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: FeedbackClientContext = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= l.maxContextKeys) break;
    if (key.length > l.maxContextKeyLength) continue;
    if (typeof value === 'string') {
      out[key] = value.slice(0, l.maxContextValueLength);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else {
      continue; // objects/arrays/functions — not a browser fact worth carrying
    }
    count++;
  }
  return out;
}

export interface ParseOptions<K extends string> extends InputOptions {
  /** The kinds this app accepts. Anything else is refused rather than defaulted. */
  kinds: readonly K[];
}

/** Validate + normalize the wire shape. Pure: no I/O, no session, no side effects. */
export function parseFeedbackInput<K extends string>(
  input: FeedbackInput,
  options: ParseOptions<K>,
): ParsedFeedbackInput<K> {
  const messages = options.messages ?? en;
  const limits = limitsOf(options);

  const message = (input.message ?? '').trim();
  if (message.length === 0) throw new FeedbackInputError(messages.input.messageRequired, 400);
  if (message.length > limits.maxMessageLength) {
    throw new FeedbackInputError(messages.input.messageTooLong(limits.maxMessageLength), 400);
  }
  // `includes` on the app's own list, not `in` on an object: "constructor" and
  // "toString" must not pass as kinds.
  if (typeof input.kind !== 'string' || !(options.kinds as readonly string[]).includes(input.kind)) {
    throw new FeedbackInputError(messages.input.unknownKind, 400);
  }

  let screenshot: FeedbackScreenshotInput | null = null;
  if (input.screenshot) {
    const { bytes, contentType } = input.screenshot;
    if (bytes.byteLength === 0) {
      // An empty part means capture failed client-side. Drop it and keep the report:
      // the reporter's text is the point, and failing the whole submission over a
      // screenshot would lose the one part that cannot be re-derived.
      screenshot = null;
    } else if (bytes.byteLength > limits.maxScreenshotBytes) {
      throw new FeedbackInputError(messages.input.screenshotTooLarge, 400);
    } else if (!(SCREENSHOT_MIME_TYPES as readonly string[]).includes(contentType)) {
      throw new FeedbackInputError(messages.input.unsupportedImage, 400);
    } else {
      screenshot = { bytes, contentType };
    }
  }

  return {
    kind: input.kind as K,
    message,
    clientContext: sanitizeClientContext(input.clientContext, limits),
    screenshot,
  };
}

/** The whole body, or null as soon as it passes `budget` bytes. */
async function readAtMost(request: Request, budget: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > budget) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Read the multipart body the browser half sends (fields `kind`, `message`,
 * `clientContext` as JSON, optional file `screenshot`) into the wire shape.
 *
 * Validation of the CONTENT is parseFeedbackInput's job; this only refuses what must
 * not be buffered at all, and tolerates what is merely decorative:
 * - the declared Content-Length is checked before anything is read into memory,
 *   and the body is read with a byte counter that stops at the same budget, so an
 *   absent or lying header cannot make it buffer more;
 * - a malformed or oversized client context becomes `{}` — it must never be the
 *   reason a report is lost.
 */
export async function readFeedbackForm(request: Request, options: InputOptions = {}): Promise<FeedbackInput> {
  const messages = options.messages ?? en;
  const limits = limitsOf(options);
  const budget = limits.maxScreenshotBytes + limits.maxBodyOverheadBytes;

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > budget) {
    throw new FeedbackInputError(messages.input.bodyTooLarge, 413);
  }

  let form: FormData;
  try {
    const body = await readAtMost(request, budget);
    if (!body) throw new FeedbackInputError(messages.input.bodyTooLarge, 413);
    const headers = { 'content-type': request.headers.get('content-type') ?? '' };
    form = await new Response(body, { headers }).formData();
  } catch (error) {
    if (error instanceof FeedbackInputError) throw error;
    throw new FeedbackInputError(messages.input.invalidRequest, 400);
  }

  let clientContext: unknown = {};
  const rawContext = form.get('clientContext');
  if (typeof rawContext === 'string' && rawContext.length > 0 && rawContext.length < limits.maxContextJsonLength) {
    try {
      clientContext = JSON.parse(rawContext);
    } catch {
      clientContext = {};
    }
  }

  const file = form.get('screenshot');
  let screenshot: FeedbackScreenshotInput | null = null;
  if (file && typeof file !== 'string') {
    if (file.size > limits.maxScreenshotBytes) throw new FeedbackInputError(messages.input.screenshotTooLarge, 413);
    screenshot = { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type };
  }

  const kind = form.get('kind');
  const message = form.get('message');
  return {
    kind: typeof kind === 'string' ? kind : '',
    message: typeof message === 'string' ? message : '',
    clientContext,
    screenshot,
  };
}
