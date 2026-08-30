/**
 * Who is here, on this side of the wire.
 *
 * The mirror in `store.ts` holds rows: things that were written down and are
 * still true tomorrow. Presence is neither, so it never goes near IndexedDB —
 * it lives in a plain Map that starts empty on every load and is repopulated by
 * the server the moment the stream opens.
 *
 * The heartbeat only runs while the tab is actually visible. A backgrounded tab
 * on a phone can keep a connection nominally open for minutes after the person
 * has put the phone in a pocket, so "the socket is up" is a poor answer to "is
 * anyone there"; "the tab was visible in the last 45 seconds" is a good one.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { api } from '../../kernel/sync/api';

const BEAT_MS = 25_000;
/** While typing, refreshed no more often than this. */
const TYPING_MS = 3_000;

export interface Presence {
  online: boolean;
  /** The conversation they are typing in, if any. */
  typing: string | null;
}

const people = new Map<string, Presence>();
const listeners = new Set<() => void>();

/** Bumped on every change so `useSyncExternalStore` has something to compare. */
let version = 0;

const changed = (): void => {
  version += 1;
  for (const listener of listeners) listener();
};

export const subscribePresence = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const presenceVersion = (): number => version;

export const presenceOf = (userId: string): Presence | undefined => people.get(userId);

export const isOnline = (userId: string): boolean => people.get(userId)?.online === true;

/** Everybody typing in this conversation right now, excluding nobody. */
export function typistsIn(channelId: string): string[] {
  const out: string[] = [];
  for (const [userId, state] of people) if (state.typing === channelId) out.push(userId);
  return out;
}

/**
 * A `presence` event off the stream.
 *
 * The server sends the same shape for the opening snapshot and for a single
 * change, so there is one handler rather than two — but a snapshot is
 * authoritative about everyone, which is why it says so and clears first.
 */
export function applyPresence(update: { people: { userId: string; online: boolean; typing: string | null }[] }, replace = false): void {
  if (replace) people.clear();
  for (const person of update.people ?? []) {
    if (person.online) people.set(person.userId, { online: true, typing: person.typing ?? null });
    else people.delete(person.userId);
  }
  changed();
}

/** The stream dropped: nobody is known to be here until it says so again. */
export function clearPresence(): void {
  if (!people.size) return;
  people.clear();
  changed();
}

/* ------------------------------------------------------------- heartbeat */

let typing: string | null = null;
let sentTypingAt = 0;
let beating = false;
/**
 * Off until the stream says otherwise.
 *
 * The alternative is a heartbeat on the sign-in screen, which is a 401 every 25
 * seconds for as long as somebody leaves the tab open — noise in the log for a
 * dot nobody is looking at.
 */
let live = false;

/**
 * The stream is up, so there is a session to beat for.
 *
 * No beat here: opening the stream *is* the first one, counted on the server
 * side, so the dot lights up on connect rather than 25 seconds later.
 */
export function startBeating(): void {
  live = true;
}

/** The stream went away. Stop until it comes back. */
export function stopBeating(): void {
  live = false;
  typing = null;
}

async function beat(state?: string | null): Promise<void> {
  if (beating || !live) return;
  beating = true;
  try {
    await api.post('/api/presence', state === undefined ? {} : { typing: state });
  } catch {
    // A missed beat is forgiven by the server's 45-second window, and the next
    // one is 25 seconds away. Nothing here is worth an error to the user.
  } finally {
    beating = false;
  }
}

/**
 * Called from the composer on every keystroke — so it is throttled here rather
 * than at forty call sites, and a request only leaves when the answer changed
 * or the server is about to forget.
 */
export function setTyping(channelId: string | null): void {
  const now = Date.now();
  if (channelId === typing && (channelId === null || now - sentTypingAt < TYPING_MS)) return;
  typing = channelId;
  sentTypingAt = now;
  void beat(channelId);
}

const visible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible';

if (typeof window !== 'undefined') {
  setInterval(() => {
    if (visible() && navigator.onLine) void beat();
  }, BEAT_MS);
  document.addEventListener('visibilitychange', () => {
    if (visible()) void beat();
    // Leaving mid-sentence should not leave a "…is typing" hanging over the
    // conversation for everybody else.
    else if (typing) setTyping(null);
  });
}

/* ----------------------------------------------------------------- hooks */

/** Whether this person is here. Re-renders when that changes, and not otherwise. */
export function useOnline(userId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribePresence,
    () => (userId ? people.get(userId)?.online === true : false),
    () => false,
  );
}

/**
 * Everybody known to be here, for a list that wants to sort by it.
 *
 * A joined string for the same reason `useTypists` uses one: the snapshot is
 * compared by identity, and a fresh Set on every read is an endless render.
 */
export function useOnlineIds(): Set<string> {
  const joined = useSyncExternalStore(
    subscribePresence,
    () => [...people.keys()].sort().join(','),
    () => '',
  );
  return useMemo(() => new Set(joined ? joined.split(',') : []), [joined]);
}

/**
 * Who is typing in this conversation, other than you.
 *
 * The snapshot is a string rather than an array because
 * `useSyncExternalStore` compares by identity, and a fresh array every read is
 * an infinite render loop. Joining and splitting a handful of ids is cheaper
 * than the memoisation that would otherwise be required here.
 */
export function useTypists(channelId: string | null | undefined, exclude?: string): string[] {
  const joined = useSyncExternalStore(
    subscribePresence,
    () => (channelId ? typistsIn(channelId).filter((id) => id !== exclude).sort().join(',') : ''),
    () => '',
  );
  return joined ? joined.split(',') : [];
}
