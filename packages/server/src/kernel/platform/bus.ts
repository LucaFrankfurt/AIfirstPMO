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
}

type Listener = (event: BusEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribe(workspaceId: string, listener: Listener): () => void {
  let set = listeners.get(workspaceId);
  if (!set) {
    set = new Set();
    listeners.set(workspaceId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(workspaceId);
  };
}

let pending: BusEvent | null = null;
let scheduled = false;

/** Coalesces bursts (a sync push writes many rows) into one notification. */
export function publish(event: BusEvent): void {
  if (pending && pending.workspaceId === event.workspaceId) {
    pending.seq = Math.max(pending.seq, event.seq);
  } else {
    flush();
    pending = { ...event };
  }
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, 40).unref?.();
  }
}

function flush(): void {
  scheduled = false;
  const event = pending;
  pending = null;
  if (!event) return;
  for (const listener of listeners.get(event.workspaceId) ?? []) {
    try {
      listener(event);
    } catch {
      /* a dead SSE connection must not break the others */
    }
  }
}

export const subscriberCount = (workspaceId: string): number => listeners.get(workspaceId)?.size ?? 0;
