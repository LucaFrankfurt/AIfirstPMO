/**
 * What a transport is, and what it means when one fails.
 *
 * Mail leaves this server two ways — an SMTP relay, or Scaleway's HTTP API —
 * and everything upstream of here (the queue, the batching, the backoff, the
 * suppression list) is written once and does not care which.
 */

/** The one shape a transport has to deliver. */
export interface Deliverable {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

/** Returns the Message-ID it delivered under. */
export type Transport = (mail: Deliverable) => Promise<string>;

/**
 * A failed delivery, and whether trying again could ever help.
 *
 * `permanent` is carried rather than inferred, and that is the whole point of
 * this class. The queue used to decide by reading a 5xx out of the error text,
 * which is right for SMTP — 5xx is "never, for this address", 4xx is "not just
 * now" — and exactly backwards for HTTP, where 4xx is a request that will never
 * be accepted and 5xx is the provider having a bad minute.
 *
 * Left to the regex, an hour of Scaleway returning HTTP 500 would have been
 * read as a hard bounce per message and every recipient it touched would have
 * been added to the suppression list — an outage at one provider quietly
 * turning into a mailing list that no longer has anybody on it. Suppression is
 * not something you undo by retrying; somebody has to notice and clear it.
 *
 * So each transport says what it means, in its own protocol's terms, and the
 * queue believes it.
 */
export class DeliveryError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'DeliveryError';
    this.permanent = permanent;
  }
}

/**
 * Whether a failure should stop this address being written to again.
 *
 * A transport that says so is believed. Anything else — a socket error, a
 * timeout, something thrown from a library — falls back to reading an SMTP
 * status out of the text, which is what this has always done and is still the
 * right guess for a failure that came off a socket.
 */
export const isPermanentFailure = (error: unknown): boolean => {
  if (error instanceof DeliveryError) return error.permanent;
  return /\b5\d\d\b/.test(error instanceof Error ? error.message : String(error));
};
