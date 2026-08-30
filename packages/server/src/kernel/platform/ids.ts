import { randomBytes, randomUUID } from 'node:crypto';

export const uid = (): string => randomUUID();

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** URL-safe random token, e.g. for invite codes and API keys. */
export function token(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * The secret in a share link.
 *
 * Longer than an invite code because it is the *only* thing standing between a
 * stranger and the content: 24 bytes of system randomness, base64url so it
 * survives being pasted into a chat window.
 */
export const shareToken = (): string => token(24);

export function shortCode(len = 8): string {
  const raw = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[raw[i] % ALPHABET.length];
  return out;
}

/** `My Team` -> `MYT`, used as project/team key default. */
export function keyFromName(name: string, len = 3): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  const raw = words.length > 1 ? words.map((w) => w[0]).join('') : words[0] ?? 'KOL';
  return raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, Math.max(len, 2)).toUpperCase() || 'KOL';
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}
