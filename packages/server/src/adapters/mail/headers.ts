/**
 * What a mail header may contain.
 *
 * The address these two used to sit beside is a kernel format now — signing up
 * and inviting somebody ask the same question, and neither is sending mail. A
 * header is not like that: `Reply-To:` and its folding rules exist because a
 * message is being built, so this stays with the transports that build one.
 *
 * Both are here for one reason, which is the reason the address check gives at
 * more length: a header is a line, and a value with a carriage return in it is
 * not a long value but a second header.
 */

/** A header value that cannot start a header of its own. */
export const headerSafe = (value: string): string =>
  String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');

/** A header *name*: letters, digits and hyphens, which is all RFC 5322 allows. */
export const isHeaderName = (name: string): boolean => /^[A-Za-z0-9-]+$/.test(name);
