/**
 * Fractional indexing for drag & drop ordering.
 *
 * A key is read as a base-62 fraction (`"V"` means `0.V`), so there is always
 * room for another item between any two neighbours. Two clients reordering the
 * same list while offline produce different keys instead of fighting over
 * integer positions — each ends its keys in its own digits, see `setOrderTail` —
 * and a merge never has to renumber the list.
 *
 * Internally a number is a digit array: index 0 is the integer part, the rest
 * are fraction digits.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const HALF = DIGITS[BASE >> 1];

const digit = (s: string, i: number) => DIGITS.indexOf(s[i]);

/** Drop trailing zeros — they do not change the value and only cost bytes. */
const normalize = (s: string) => {
  let end = s.length;
  while (end > 0 && s[end - 1] === DIGITS[0]) end--;
  return s.slice(0, end);
};

let tail = '';

/** Digits every key this process mints ends in; a device sets its own so two offline devices never mint the same key. */
export function setOrderTail(value: string): void {
  tail = normalize([...value].filter((ch) => DIGITS.includes(ch)).join(''));
}

/**
 * A key strictly between `before` and `after`.
 * Pass `null` for "start of list" / "end of list" respectively.
 */
export function orderKey(before?: string | null, after?: string | null): string {
  const lo = normalize(before ?? '');
  const hi = normalize(after ?? '');
  if (lo && lo === hi) return orderKey(lo, lo + DIGITS[1]); // two keys collided: just after them, not behind the list
  if (lo && hi && lo > hi) return orderKey(lo, null); // caller gave us garbage: append instead

  let prefix = '';
  for (let i = 0; i < 64; i++) {
    const a = i < lo.length ? digit(lo, i) : 0;
    const b = i < hi.length ? digit(hi, i) : BASE;
    if (b - a >= 2) return prefix + DIGITS[(a + b) >> 1] + tail;
    // Neighbouring digits: keep this position and split one level deeper.
    prefix += DIGITS[a];
  }
  return prefix + HALF + tail;
}

/** Evenly spread keys for a freshly created list. */
export function orderKeys(count: number): string[] {
  if (count <= 0) return [];
  if (count < BASE - 1) {
    return Array.from({ length: count }, (_, i) => DIGITS[Math.floor(((i + 1) * BASE) / (count + 1))]);
  }
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    prev = orderKey(prev, null);
    out.push(prev);
  }
  return out;
}

export const compareOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
