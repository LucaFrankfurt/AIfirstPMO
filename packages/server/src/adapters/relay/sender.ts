/**
 * What the relay asks of Apple's service and of Google's, in one shape.
 *
 * Three outcomes and no more, because those are the three things the relay does
 * something different about: it was delivered, the token is over and the server
 * that sent it should forget it, or it did not work this time.
 */
import type { Words } from './words.ts';

export type Outcome = 'sent' | 'gone' | 'failed';

export interface Sender {
  send(token: string, words: Words): Promise<Outcome>;
  /** Let go of open connections, so a process can end. */
  close?(): void;
}

/** A token as it may appear in a log line: enough to correlate, not enough to use. */
export const shortToken = (token: string): string => `${token.slice(0, 8)}…`;

export const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');
