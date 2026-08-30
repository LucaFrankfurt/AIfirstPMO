/**
 * Asking a model something, without knowing whose model it is.
 *
 * Three companies answer the same question three different ways, and the
 * difference between them is four things: the URL, the header the key goes in,
 * where the prompt sits in the request, and where the answer sits in the
 * reply. Everything else — what to ask, how to read the answer, who is allowed
 * to ask, what it costs — is written once, above this line, and does not care.
 *
 * This is `lib/delivery.ts` again, one floor up. That file learned the lesson
 * this one inherits: a failure carries whether it is worth trying again rather
 * than having it read back out of the message later.
 */
import { env } from '../../kernel/platform/env.ts';

export interface AiRequest {
  /** The standing instructions. Identical on every call, so it caches well. */
  system: string;
  /** The task, as text. Everything that differs between two calls is here. */
  user: string;
  /** A ceiling, not a target. A review that hits it was going wrong anyway. */
  maxTokens: number;
}

/** Answers with the model's text, or throws `AiError`. */
export type Reviewer = (request: AiRequest) => Promise<string>;

/**
 * A model that did not answer, and whether asking again could help.
 *
 * `permanent` is the same idea as `DeliveryError.permanent` and is classified
 * the same way — in HTTP's terms, where 4xx is a request that will never work
 * and 5xx is a bad moment. Nothing retries here, because a person is waiting;
 * what it decides is whether the sentence they read says "try again" or
 * "somebody has to fix the configuration".
 */
export class AiError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'AiError';
    this.permanent = permanent;
  }
}

/**
 * Which failures are worth trying again, in HTTP's terms.
 *
 * 401 and 403 are the key; 400 is the request; 404 is usually a model name
 * that does not exist. None of those improve on a second attempt. 429 is the
 * provider asking for a moment and 5xx is the provider having one.
 */
export const permanentStatus = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 429;

/**
 * The body of a failed response, short enough to show a person.
 *
 * Providers put the useful sentence in different places and some return HTML,
 * so this takes the first 300 characters of whatever came back rather than
 * trying to find a field that might not be there.
 */
export async function detailOf(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  return body.trim().slice(0, 300);
}

/** One fetch, one timeout, one classification of not-getting-there. */
export async function askProvider(
  url: string,
  init: RequestInit,
  who: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(env.ai.timeoutMs) });
  } catch (error) {
    // A timeout, a refused connection, DNS. Nothing about the request is known
    // to be wrong, so this is a bad moment rather than a bad question.
    const why = error instanceof Error && error.name === 'TimeoutError'
      ? `did not answer within ${Math.round(env.ai.timeoutMs / 1000)}s`
      : `could not be reached: ${error instanceof Error ? error.message : String(error)}`;
    throw new AiError(`${who} ${why}`, false);
  }
}
