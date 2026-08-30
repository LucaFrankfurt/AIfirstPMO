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
 * It lives in the kernel rather than beside the SMTP client because four
 * different things ask this question and only one of them is sending mail:
 * signing up, inviting somebody to a workspace, checking `KOLIBRI_MAIL_FROM`,
 * and addressing an envelope. An account is named by an address whether or not
 * this instance can send to one, so the shape is not the relay's to own — and
 * while it was the relay's, the kernel imported an adapter to ask.
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
 *
 * Everything after that is deliberately loose, and there is a scar behind that
 * word. The first version of this required the domain to contain a dot, which
 * looks obviously right and is obviously wrong: a bare host is a legal domain
 * in RFC 5321, `KOLIBRI_MAIL_FROM` defaults to **`kolibri@localhost`**, and the
 * docker-compose overlay relays to `mailpit`. So the check that was added to
 * keep carriage returns out of an SMTP conversation instead refused this
 * project's own default sender, and the deployment job went red on a stack
 * that was working perfectly.
 *
 * The lesson is the shape of the rule, not the missing case. This decides one
 * thing — *can this string be written into a line-oriented protocol without
 * becoming a second line* — and it must not drift into deciding what somebody's
 * address is allowed to look like. An address this refuses is a message that
 * never leaves; an address the relay refuses is an error the relay explains.
 */
export function isEmailAddress(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  if (!raw || raw.length > 254) return false;
  if (CONTROL.test(raw)) return false;

  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return false;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);

  // The characters that mean something to a header or an envelope, and so
  // cannot simply be part of a name.
  if (local.length > 64 || /[\s<>,;:"\\]/.test(local)) return false;
  if (/[\s<>,;:"\\@]/.test(domain)) return false;

  // Labels rather than a pattern with a dot in it: `localhost` is one label,
  // `example.co.uk` is three, and both are addresses people really have. What
  // is refused is a label that is empty (`a@b..com`, `a@.com`) or that starts
  // or ends with a hyphen — neither of which any relay would resolve.
  return domain.split('.').every((label) =>
    label.length > 0 && !label.startsWith('-') && !label.endsWith('-'));
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
