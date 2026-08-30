/**
 * Who is here, and who is typing.
 *
 * This is the one thing in the app that is **not** a row. Everything else is
 * written down, synced and still true after a tunnel; presence is true for the
 * next few seconds and then it is not. Putting it in the database would mean a
 * write per keystroke, a tombstone per person who closed a tab, and a sync
 * cursor that moves constantly for information nobody will ever want to read
 * back. So it lives in memory, it is lost on restart, and that is correct.
 *
 * `docs/chat.md` said this should be its own transport rather than a widening
 * of the sync stream. It shares the connection — one socket per client rather
 * than two — but nothing else: presence carries no `seq`, never touches the
 * cursor, and is delivered under its own event name, so catching up after a
 * tunnel and hearing about a change live remain the single code path that rule
 * was protecting.
 *
 * Two clocks, deliberately different:
 *
 * - **Online** expires after 45 seconds. Clients beat every 25, so one missed
 *   beat is forgiven and a closed laptop drops off within a minute.
 * - **Typing** expires after 8. It is refreshed every 3 seconds while somebody
 *   is actually typing, and a stale "still typing…" under an empty composer is
 *   worse than no indicator at all.
 */
import { all, type Row } from '../../kernel/platform/db/index.ts';

const ONLINE_MS = 45_000;
const TYPING_MS = 8_000;

interface Seen {
  at: number;
  /** The conversation they are typing in, if any. */
  typing?: string;
  typingAt: number;
}

/** userId -> what we last heard. Instance-wide, filtered per viewer on the way out. */
const seen = new Map<string, Seen>();

export interface PresenceEvent {
  userId: string;
  online: boolean;
  typing: string | null;
}

type Listener = (event: PresenceEvent) => void;
const listeners = new Set<Listener>();

export function subscribePresence(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const announce = (event: PresenceEvent): void => {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* a dead connection must not take the others with it */
    }
  }
};

const stateOf = (entry: Seen, now: number): PresenceEvent['typing'] =>
  (entry.typing && now - entry.typingAt < TYPING_MS ? entry.typing : null);

/**
 * A heartbeat, and optionally what they are typing in.
 *
 * Only announced when something actually changed — a beat that says the same
 * thing as the last one is the common case, and forwarding it to every open
 * connection every 25 seconds per person is how a small feature becomes the
 * reason the server is busy.
 */
export function touch(userId: string, typing?: string | null): void {
  const now = Date.now();
  const before = seen.get(userId);
  const wasOnline = !!before && now - before.at < ONLINE_MS;
  const wasTyping = before ? stateOf(before, now) : null;

  const entry: Seen = {
    at: now,
    typing: typing === undefined ? before?.typing : (typing ?? undefined),
    typingAt: typing === undefined ? (before?.typingAt ?? 0) : (typing ? now : 0),
  };
  seen.set(userId, entry);

  const isTyping = stateOf(entry, now);
  if (!wasOnline || wasTyping !== isTyping) announce({ userId, online: true, typing: isTyping });
}

/**
 * Somebody signed out.
 *
 * Deliberately not called when a tab closes: a person with two tabs open would
 * blink offline and back on every time they closed one. Closing the last tab
 * just stops the heartbeat, and they fade within the minute.
 */
export function leave(userId: string): void {
  if (!seen.delete(userId)) return;
  announce({ userId, online: false, typing: null });
}

/** Everybody currently here, as a viewer is allowed to see them. */
export function snapshot(visible: Set<string>): PresenceEvent[] {
  const now = Date.now();
  const out: PresenceEvent[] = [];
  for (const [userId, entry] of seen) {
    if (now - entry.at >= ONLINE_MS || !visible.has(userId)) continue;
    out.push({ userId, online: true, typing: stateOf(entry, now) });
  }
  return out;
}

/**
 * Whom this person may be told about.
 *
 * The same rule the sync filter applies to a `user` row: somebody in a
 * workspace with them, or somebody they are in a direct conversation with.
 * Presence must not be a way to learn that an account exists.
 */
export function visiblePeople(userId: string): Set<string> {
  const rows = all<Row>(
    `SELECT DISTINCT other.user_id AS id
       FROM workspace_members mine
       JOIN workspace_members other ON other.workspace_id = mine.workspace_id AND other.deleted_at IS NULL
      WHERE mine.user_id = ? AND mine.deleted_at IS NULL
      UNION
     SELECT json_each.value AS id
       FROM channels c, json_each(c.members)
      WHERE c.kind = 'direct' AND c.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM json_each(c.members) AS mine WHERE mine.value = ?)`,
    userId, userId,
  );
  return new Set(rows.map((row) => String(row.id)));
}

/**
 * Drop whoever stopped beating, and say so.
 *
 * A departure has to be announced or a name sits lit up on everybody else's
 * screen until they reload. Typing that expires is announced the same way,
 * which is why the sweep looks at both.
 */
const sweep = (): void => {
  const now = Date.now();
  for (const [userId, entry] of seen) {
    if (now - entry.at >= ONLINE_MS) {
      seen.delete(userId);
      announce({ userId, online: false, typing: null });
    } else if (entry.typing && now - entry.typingAt >= TYPING_MS) {
      entry.typing = undefined;
      announce({ userId, online: true, typing: null });
    }
  }
};

const timer = setInterval(sweep, 5_000);
timer.unref?.();

/** For the tests, which cannot wait 45 seconds to see somebody leave. */
export const presenceInternals = { seen, sweep, ONLINE_MS, TYPING_MS };

/** Whether this person is currently counted as here — used by the tests. */
export const isOnline = (userId: string): boolean => {
  const entry = seen.get(userId);
  return !!entry && Date.now() - entry.at < ONLINE_MS;
};

export const forget = (): void => seen.clear();

export const online = (): number => {
  const now = Date.now();
  let count = 0;
  for (const entry of seen.values()) if (now - entry.at < ONLINE_MS) count += 1;
  return count;
};
