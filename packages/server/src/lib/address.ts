/**
 * What counts as an email address here.
 *
 * One shape, in one place, because an address is not only something to match a
 * user row on: it is written into an SMTP conversation as `RCPT TO:<…>` and
 * into a message as a `To:` header, and both of those are line-oriented
 * protocols where a carriage return ends the command and starts the next one.
 * An address with a newline in it is not a badly-typed address, it is an
 * instruction to the mail relay.
 *
 * The regex this replaces was `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, which reads as
 * though it forbids whitespace and does — except that JavaScript's `$` without
 * the `m` flag also matches immediately before a final newline. `a@b.c\n`
 * passed it. The fix is not a cleverer regex; it is refusing control
 * characters explicitly and anchoring on the string's actual end.
 *
 * Deliberately permissive about everything else. RFC 5321 allows addresses
 * that look wrong, people have them, and an address this cannot post to is the
 * relay's answer to give — not a form's.
 */

/** Anything that can end a line, start a header, or confuse a parser. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Is this something we are willing to hand to a mail relay?
 *
 * `\r` and `\n` first and separately from the shape, so the reason a rejection
 * happens is never in doubt.
 */
export function isEmailAddress(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  if (raw.length > 254) return false;
  if (CONTROL.test(raw)) return false;
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return false;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (/[\s<>,;"\\]/.test(local) || local.length > 64) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) return false;
  return true;
}

/**
 * The same question, asked where the answer must be no argument.
 *
 * Called at the SMTP boundary rather than only at the form, because an address
 * can reach the queue from a form, from an identity provider's claims, from a
 * restored backup, or from an admin's environment variable — and only one of
 * those is a form.
 */
export function assertEmailAddress(raw: string, what: string): string {
  if (!isEmailAddress(raw)) throw new Error(`${what} is not a usable email address`);
  return raw;
}

/** A header value that cannot start a header of its own. */
export const headerSafe = (value: string): string =>
  String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');

/** A header *name*: letters, digits and hyphens, which is all RFC 5322 allows. */
export const isHeaderName = (name: string): boolean => /^[A-Za-z0-9-]+$/.test(name);
