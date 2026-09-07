/**
 * What a kept secret is, and the two questions worth asking about one without
 * looking at it.
 *
 * Everything here is deliberately about the *label* rather than the value. The
 * value is sealed on the server and never reaches this package — see
 * `ENTITIES.secret.secret`, which keeps it out of every serialised row, and
 * `seal.ts`, which keeps it out of a copied database. What a client holds is a
 * name, a kind and two dates, and that is enough to draw a useful list: what
 * exists, who may read it, and which ones have gone stale.
 *
 * The staleness rule is the reason this file exists rather than being three
 * lines in a component. A credential that nobody has rotated in two years is
 * the actual risk in a shared vault — not the encryption, which is arithmetic,
 * but the shared database password from the contractor who left. Answering
 * "which of these is overdue" has to be one function, because the list, the
 * detail screen and the count on the nav all have to agree.
 */

/**
 * What a secret is, as a fixed list.
 *
 * A fixed list rather than free text for the reason `COST_CATEGORIES` is one:
 * the point of a kind is that two people filing the same thing pick the same
 * word, and a text box guarantees they will not. Short on purpose — this
 * decides an icon and a sort order, not behaviour.
 */
export const SECRET_KINDS = ['password', 'api_key', 'token', 'certificate', 'connection', 'note'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

/** Who a secret is for. The same three words a page's `access` uses. */
export const SECRET_ACCESS = ['workspace', 'project', 'private'] as const;
export type SecretAccess = (typeof SECRET_ACCESS)[number];

/**
 * How a secret stands against the rotation its owner asked for.
 *
 * `unset` is a state and not a failure: most secrets never get a cadence, and
 * painting them all amber would train people to ignore the colour. Only a
 * secret whose owner said "every 90 days" can be late.
 */
export type Rotation = 'unset' | 'fresh' | 'due' | 'overdue';

/** A week's grace before "due" becomes "overdue" — one working week to do it in. */
const GRACE_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;

/**
 * Where a secret sits in its own rotation cycle.
 *
 * Counted from `rotated_at` rather than from `created_at`, because a secret
 * that has been rotated once has a real last-changed date and the creation date
 * stops being the question. A secret with a cadence and no rotation at all is
 * measured from when it was written down, which is the honest reading of "this
 * value has been the same since then".
 */
export function rotation(
  secret: { rotated_at?: number | null; created_at?: number | null; rotate_after_days?: number | null },
  now = Date.now(),
): Rotation {
  const days = Number(secret.rotate_after_days ?? 0);
  if (!Number.isFinite(days) || days <= 0) return 'unset';
  const since = Number(secret.rotated_at ?? secret.created_at ?? 0);
  if (!since) return 'unset';
  const age = (now - since) / DAY;
  if (age < days) return 'fresh';
  return age < days + GRACE_DAYS ? 'due' : 'overdue';
}

/** How many days until it is due, negative once it is past. Null when it has no cadence. */
export function daysUntilRotation(
  secret: { rotated_at?: number | null; created_at?: number | null; rotate_after_days?: number | null },
  now = Date.now(),
): number | null {
  const days = Number(secret.rotate_after_days ?? 0);
  const since = Number(secret.rotated_at ?? secret.created_at ?? 0);
  if (!Number.isFinite(days) || days <= 0 || !since) return null;
  return Math.ceil((since + days * DAY - now) / DAY);
}

/**
 * Enough of a value to recognise it by, and not enough to use.
 *
 * Shown where a value is *not* being revealed — beside the name in a list, in a
 * confirmation, in the line that says what was rotated. Somebody who keeps four
 * keys for four environments needs to tell them apart without opening each one,
 * and the last four characters is how every provider's own console does it.
 *
 * The floor matters more than the shape: under twelve characters nothing is
 * shown at all, because four of the last characters of an eight-character
 * password is half the password.
 */
export function maskSecret(value: string): string {
  const text = String(value ?? '');
  if (text.length < 12) return '••••••••';
  return `••••${text.slice(-4)}`;
}

/**
 * A rough word for how hard a value would be to guess.
 *
 * Deliberately not a score out of a hundred and deliberately not advice. It is
 * shown once, while somebody is typing a value they have chosen themselves, and
 * says nothing at all about a value that was generated elsewhere — an API key
 * is whatever the provider made it, and telling somebody their Stripe key is
 * "weak" would be noise about a thing they cannot change.
 */
export type Strength = 'weak' | 'fair' | 'strong';

export function strength(value: string): Strength {
  const text = String(value ?? '');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((shape) => shape.test(text)).length;
  // Length carries most of it, which is the one thing about passwords that is
  // not folklore: a long passphrase of one class beats a short one of four.
  if (text.length >= 20 && classes >= 2) return 'strong';
  if (text.length >= 16 || (text.length >= 12 && classes >= 3)) return 'fair';
  return 'weak';
}
