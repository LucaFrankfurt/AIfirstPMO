/**
 * Time-based one-time passwords (RFC 6238), written out.
 *
 * Six digits from an HMAC of the current 30-second step. It is thirty lines of
 * arithmetic and one dependency-free implementation is easier to audit than a
 * package — which matters more here than anywhere else in the codebase.
 *
 * The two details that are easy to get wrong and that the tests pin down: the
 * dynamic-truncation offset comes from the *last* byte of the digest, and
 * verification accepts the neighbouring steps, because a phone's clock and a
 * server's clock are never exactly the same.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
/** How many steps either side are accepted: ±30 seconds of clock drift. */
const DRIFT = 1;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A shared secret, base32 as every authenticator app expects it. */
export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one 30-second step. */
export function codeFor(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(step))));

  const digest = createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation: the low nibble of the *last* byte picks where to read.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const currentCode = (secret: string, now = Date.now()): string =>
  codeFor(secret, Math.floor(now / 1000 / STEP_SECONDS));

/**
 * Whether a typed code is right, allowing for clock drift.
 *
 * Compared in constant time. The comparison is short and the secret is not in
 * it, so the leak would be small — but a timing-safe compare is one call, and
 * "small leak" is not a thing to write on purpose in an authentication path.
 */
export function verifyCode(secret: string, code: string, now = Date.now()): boolean {
  const typed = String(code ?? '').replace(/\D/g, '');
  if (typed.length !== DIGITS) return false;

  const step = Math.floor(now / 1000 / STEP_SECONDS);
  let ok = false;
  for (let offset = -DRIFT; offset <= DRIFT; offset++) {
    const expected = Buffer.from(codeFor(secret, step + offset));
    const given = Buffer.from(typed);
    // No early exit: every candidate is compared, so the time taken does not
    // say which step matched.
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The issuer appears twice on purpose — in the label and as a parameter —
 * because different apps read different one.
 */
export function otpauthUri(secret: string, account: string, issuer = 'Kolibri'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

/**
 * One-time recovery codes, for the phone that fell in a river.
 *
 * Stored hashed like any other credential; shown once when they are made.
 */
export const generateRecoveryCodes = (count = 8): string[] =>
  Array.from({ length: count }, () => randomBytes(5).toString('hex').replace(/(.{4})(.{6})/, '$1-$2'));
