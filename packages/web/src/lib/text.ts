/** `Platform team` -> `PLT`; used as the default key for teams and projects. */
export function keyFromName(name: string, length = 3): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  const raw = words.length > 1 ? words.map((word) => word[0]).join('') : words[0] ?? 'TEAM';
  return raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, Math.max(length, 2)).toUpperCase() || 'TEAM';
}
