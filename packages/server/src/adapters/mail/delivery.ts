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
  /**
   * Files carried with the message. One sender uses these — the nightly backup,
   * see `backup.ts` — and it sends directly rather than through the queue,
   * because a queued attachment would sit in a table in the very database the
   * next night's backup copies.
   */
  attachments?: Attachment[];
}

export interface Attachment {
  /** Letters, digits, dots and dashes; anything else is replaced on the way out. */
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * A filename and a content type that are safe in a header.
 *
 * Both end up inside a quoted MIME parameter, and a quote or a line break in
 * either would end the parameter and start whatever came next. The names this
 * server attaches are its own, so narrowing them costs nothing.
 */
export const safeFilename = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'attachment';
export const safeContentType = (type: string): string =>
  (/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(type) ? type : 'application/octet-stream');

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
  /**
   * Whose problem it is: the address the message was for, or this server's
   * way of sending.
   *
   * `permanent` alone was read as "this address is dead", which is right for
   * `RCPT TO` answering 550 and wrong for everything that fails before the
   * recipient is even named — a rejected password, a From address the relay
   * will not relay for, a Scaleway key without the email permission. Those are
   * final for the message and say nothing about the person it was for, and
   * reading them as a bounce put every recipient on the suppression list one
   * message at a time, the admin's own address first. See `suppressesRecipient`.
   */
  readonly about: 'recipient' | 'sender';

  constructor(message: string, permanent: boolean, about: 'recipient' | 'sender' = 'recipient') {
    super(message);
    this.name = 'DeliveryError';
    this.permanent = permanent;
    this.about = about;
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

/**
 * Whether a failure should put the *address* on the suppression list.
 *
 * Only a permanent failure that is about the recipient. A permanent failure
 * that is about the sender stops this message — retrying a wrong password every
 * few minutes tells nobody anything — and leaves the person it was for alone,
 * so the next message reaches them once the configuration is fixed.
 */
export const suppressesRecipient = (error: unknown): boolean =>
  (error instanceof DeliveryError ? error.permanent && error.about === 'recipient' : isPermanentFailure(error));
