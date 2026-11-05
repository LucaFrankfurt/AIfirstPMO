/**
 * In-process pub/sub feeding the Server-Sent-Events stream.
 *
 * The payload is deliberately tiny: clients get "something changed up to seq N"
 * and pull the delta through the normal sync endpoint. That keeps one code path
 * for realtime and for catching up after being offline.
 */

export interface BusEvent {
  workspaceId: string;
  seq: number;
  /** Client id that caused the change, so the origin can ignore its own echo. */
  origin?: string;
  kind?: string;
  /** For a row in no workspace: the people it reaches, on whichever workspace their stream is open. */
  users?: readonly string[];
}

type Listener = (event: BusEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const personal = (userId: string): string => `user:${userId}`;

function listen(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(key);
  };
}

export const subscribe = (workspaceId: string, listener: Listener): (() => void) => listen(workspaceId, listener);

/** What is published to this person by name, wherever their stream is open. */
export const subscribeUser = (userId: string, listener: Listener): (() => void) => listen(personal(userId), listener);

const pending = new Map<string, BusEvent>();
let scheduled = false;

/** Coalesces bursts (a sync push writes many rows) into one notification per audience. */
export function publish(event: BusEvent): void {
  for (const key of event.users ? event.users.map(personal) : [event.workspaceId]) {
    const seen = pending.get(key);
    if (!seen) {
      pending.set(key, { workspaceId: event.workspaceId, seq: event.seq, origin: event.origin, kind: event.kind });
      continue;
    }
    seen.seq = Math.max(seen.seq, event.seq);
    // Mixed origins: nobody's echo filter may swallow somebody else's change.
    if (seen.origin !== event.origin) seen.origin = undefined;
  }
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, 40).unref?.();
  }
}

function flush(): void {
  scheduled = false;
  const due = [...pending];
  pending.clear();
  for (const [key, event] of due) {
    for (const listener of listeners.get(key) ?? []) {
      try {
        listener(event);
      } catch {
        /* a dead SSE connection must not break the others */
      }
    }
  }
}

export const subscriberCount = (workspaceId: string): number => listeners.get(workspaceId)?.size ?? 0;
