/**
 * The offline-first sync engine.
 *
 * Reads always come from IndexedDB via the store; writes go to the store, to
 * IndexedDB and into an outbox, and are pushed when the network allows. The
 * server merges per field with last-writer-wins, so a phone that was offline
 * for a day merges cleanly instead of clobbering the team's work.
 */
import { Clock, ENTITY_NAMES, type ChangeSet, type EntityName, type Mutation, type PullResponse, type PushResponse } from '@kolibri/shared';
import { api, ApiError } from './api';
import * as idb from './idb';
import { applyChanges, hydrate, notifyStore, reset, tables } from './store';

export type SyncState = 'starting' | 'synced' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncedAt: number | null;
  message?: string;
}

const listeners = new Set<(status: SyncStatus) => void>();
let status: SyncStatus = { state: 'starting', pending: 0, lastSyncedAt: null };

export function subscribeSync(listener: (status: SyncStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const listener of listeners) listener(status);
}

export const getStatus = (): SyncStatus => status;

/* ------------------------------------------------------------------ engine */

const CLIENT_KEY = 'kolibri.client-id';

let clientId = localStorage.getItem(CLIENT_KEY) ?? '';
if (!clientId) {
  clientId = crypto.randomUUID().slice(0, 8);
  localStorage.setItem(CLIENT_KEY, clientId);
}

export const clock = new Clock(clientId);

let workspaceId = '';
let cursor = 0;
let outbox: Mutation[] = [];
let stream: EventSource | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pulling: Promise<void> | null = null;
let retryDelay = 1000;

export function currentWorkspace(): string {
  return workspaceId;
}

/** Load the cached workspace from disk, then catch up with the server. */
export async function start(id: string): Promise<void> {
  if (workspaceId === id) return;
  stop();
  workspaceId = id;
  setStatus({ state: 'starting' });

  const cached = await idb.getMeta<{ workspaceId: string; cursor: number }>('sync');
  if (cached?.workspaceId === id) {
    cursor = cached.cursor;
    await Promise.all(ENTITY_NAMES.map(async (entity) => hydrate(entity, await idb.readAll(entity))));
    notifyStore();
  } else {
    cursor = 0;
    reset();
    await idb.clearAll();
  }

  outbox = await idb.readAll<Mutation>(idb.OUTBOX);
  setStatus({ pending: outbox.length });

  await flush();
  await pull();
  connect();
  void idb.requestPersistence();
}

export function stop(): void {
  stream?.close();
  stream = null;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

export async function signOutLocal(): Promise<void> {
  stop();
  workspaceId = '';
  cursor = 0;
  outbox = [];
  reset();
  await idb.clearAll();
}

/* -------------------------------------------------------------------- pull */

export function pull(): Promise<void> {
  if (pulling) return pulling;
  pulling = (async () => {
    if (!workspaceId) return;
    setStatus({ state: 'syncing' });
    try {
      let more = true;
      while (more) {
        const response = await api.get<PullResponse>(`/api/sync/pull?workspace=${workspaceId}&since=${cursor}`);
        if (response.reset && cursor === 0) {
          reset();
          await idb.clearAll();
        }
        applyChanges(response.changes);
        await persist(response.changes);
        const before = cursor;
        cursor = response.cursor;
        await idb.setMeta('sync', { workspaceId, cursor });
        // A truncated page returns a cursor below the server head; keep going.
        more = response.cursor > before && countRows(response.changes) > 0 && hadFullPage(response.changes);
      }
      retryDelay = 1000;
      setStatus({ state: outbox.length ? 'syncing' : 'synced', lastSyncedAt: Date.now(), message: undefined });
    } catch (err) {
      handleError(err);
    } finally {
      pulling = null;
    }
  })();
  return pulling;
}

const countRows = (changes: ChangeSet): number =>
  Object.values(changes).reduce((sum, rows) => sum + (rows?.length ?? 0), 0);

const hadFullPage = (changes: ChangeSet): boolean =>
  Object.values(changes).some((rows) => (rows?.length ?? 0) >= 2000);

async function persist(changes: ChangeSet): Promise<void> {
  const entries = Object.entries(changes)
    .filter(([, rows]) => rows?.length)
    .map(([entity, rows]) => ({ store: entity, values: rows as unknown[] }));
  if (entries.length) await idb.putMany(entries);
}

/* -------------------------------------------------------------------- push */

/** Queue a local change: store first, network whenever it comes back. */
export function enqueue(entity: EntityName, entityId: string, patch: Record<string, unknown>, op: 'upsert' | 'delete' = 'upsert'): void {
  const mutation: Mutation = {
    id: crypto.randomUUID(),
    entity,
    entityId,
    op,
    patch,
    hlc: clock.now(),
  };
  outbox.push(mutation);
  setStatus({ pending: outbox.length, state: 'syncing' });
  void idb.put(idb.OUTBOX, mutation);
  scheduleFlush();
}

function scheduleFlush(delay = 250): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), delay);
}

export async function flush(): Promise<void> {
  if (!workspaceId || !outbox.length) return;
  if (!navigator.onLine) {
    setStatus({ state: 'offline' });
    return;
  }
  const batch = outbox.slice(0, 200);
  try {
    const response = await api.post<PushResponse>('/api/sync/push', { workspaceId, clientId, mutations: batch });
    const accepted = new Set([...response.accepted, ...response.rejected.map((r) => r.id)]);
    outbox = outbox.filter((m) => !accepted.has(m.id));
    await idb.removeMany(idb.OUTBOX, [...accepted]);

    if (response.rejected.length) {
      console.warn('[sync] server rejected mutations', response.rejected);
      setStatus({ message: response.rejected[0].reason });
    }
    // The server may have decided values for us (task identifiers, defaults).
    applyChanges(response.patched);
    await persist(response.patched);

    setStatus({ pending: outbox.length, state: outbox.length ? 'syncing' : 'synced', lastSyncedAt: Date.now() });
    retryDelay = 1000;
    if (outbox.length) scheduleFlush(0);
    else await pull();
  } catch (err) {
    handleError(err);
  }
}

function handleError(err: unknown): void {
  const offline = !navigator.onLine || (err instanceof ApiError && err.status === 0);
  if (offline) {
    setStatus({ state: 'offline', message: undefined });
  } else if (err instanceof ApiError && err.status === 401) {
    setStatus({ state: 'error', message: 'Session expired — please sign in again' });
    window.dispatchEvent(new CustomEvent('kolibri:signed-out'));
    return;
  } else {
    setStatus({ state: 'error', message: err instanceof Error ? err.message : 'Sync failed' });
  }
  retryDelay = Math.min(retryDelay * 2, 30_000);
  setTimeout(() => {
    if (navigator.onLine) void flush().then(() => pull());
  }, retryDelay);
}

/* --------------------------------------------------------------- realtime */

function connect(): void {
  stream?.close();
  if (!workspaceId) return;
  stream = new EventSource(`/api/sync/stream?workspace=${workspaceId}&client=${clientId}`, { withCredentials: true });
  stream.addEventListener('change', () => void pull());
  stream.addEventListener('error', () => {
    // EventSource reconnects on its own; a pull on recovery closes any gap.
    if (stream?.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
  });
  stream.addEventListener('open', () => void pull());
}

window.addEventListener('online', () => {
  setStatus({ state: 'syncing' });
  void flush().then(() => pull());
  connect();
});
window.addEventListener('offline', () => setStatus({ state: 'offline' }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && navigator.onLine) void pull();
});
setInterval(() => {
  if (navigator.onLine && workspaceId && document.visibilityState === 'visible') void pull();
}, 60_000);

/* --------------------------------------------------------------- mutations */

export const rows = tables;
