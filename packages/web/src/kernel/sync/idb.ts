/**
 * A very small IndexedDB wrapper — the offline mirror of the workspace.
 *
 * One object store per entity plus `outbox` (mutations waiting to be pushed)
 * and `meta` (sync cursor, cached session, ui preferences).
 *
 * One database per person and workspace, so a switch or a second tab clears nothing.
 */
import { ENTITY_NAMES, type EntityName } from '@kolibri/shared';

/** The device's own database; it also holds the mirror from before the split. */
export const DEVICE = 'kolibri';
export const META = 'meta';
export const OUTBOX = 'outbox';

const STORES = [...ENTITY_NAMES, META, OUTBOX];

export const mirrorName = (userId: string, workspaceId: string): string => `${DEVICE}:${userId}:${workspaceId}`;

/** The mirror every call without an explicit database goes to; the device's own until a workspace opens. */
let current = DEVICE;

export function selectMirror(name: string): void {
  current = name;
}

export const currentMirror = (): string => current;

const handles = new Map<string, Promise<IDBDatabase>>();

/** Open at a given version, creating whatever stores are not there yet. */
function openAt(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: store === META ? 'key' : 'id' });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
}

/**
 * Open the database, and make sure every entity has a store.
 *
 * There used to be a hand-maintained `DB_VERSION` here with a comment telling
 * whoever added an entity to bump it. Chat was added and it was not bumped, and
 * the failure that produced is worth describing because it is not the one you
 * would guess: a browser that had opened the database before never runs
 * `onupgradeneeded` again, so the three chat stores simply did not exist. Every
 * write to them threw, which meant a pull could apply its changes to memory and
 * then fail to save them — so the sync cursor was never written, so the next
 * pull started from zero, so the server answered with a snapshot and the
 * `reset` that comes with one, which empties the in-memory tables. The channel
 * somebody had just made disappeared off the screen, and came back only when
 * the *next* snapshot happened to be taken after their device had pushed it.
 * One forgotten number, and the visible symptom was a chat that vanished.
 *
 * So the number is gone. The store list is the schema, this asks the database
 * whether it has those stores, and it upgrades if it does not — which is the
 * same question the comment was asking a person to remember to ask.
 */
function open(name: string): Promise<IDBDatabase> {
  const known = handles.get(name);
  if (known) return known;
  const forget = () => {
    if (handles.get(name) === opening) handles.delete(name);
  };
  const opening = (async () => {
    // No version: whatever this browser has, or a new database at 1 with the lot.
    let db = await openAt(name);
    if (!STORES.every((store) => db.objectStoreNames.contains(store))) {
      const next = db.version + 1;
      db.close();
      db = await openAt(name, next);
    }
    // Another tab may upgrade later — for a new entity, or because it is running
    // a newer build. Holding an old connection open blocks that upgrade for
    // ever, so step aside and reopen on the next call.
    db.onversionchange = () => {
      db.close();
      forget();
    };
    return db;
  })();
  // A failed open must not be remembered, or the app never recovers from a
  // transient one.
  opening.catch(forget);
  handles.set(name, opening);
  return opening;
}

const wrap = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export async function readAll<T = any>(store: string, name = current): Promise<T[]> {
  const db = await open(name);
  return wrap(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function put(store: string, value: unknown, name = current): Promise<void> {
  const db = await open(name);
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(commit(tx));
}

export async function putMany(entries: { store: string; values: unknown[] }[], name = current): Promise<void> {
  const stores = entries.map((e) => e.store).filter((s, i, arr) => arr.indexOf(s) === i);
  if (!stores.length) return;
  const db = await open(name);
  const tx = db.transaction(stores, 'readwrite');
  for (const entry of entries) {
    const objectStore = tx.objectStore(entry.store);
    for (const value of entry.values) objectStore.put(value);
  }
  await done(commit(tx));
}

export async function remove(store: string, key: string, name = current): Promise<void> {
  const db = await open(name);
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(commit(tx));
}

export async function removeMany(store: string, keys: string[], name = current): Promise<void> {
  if (!keys.length) return;
  const db = await open(name);
  const tx = db.transaction(store, 'readwrite');
  for (const key of keys) tx.objectStore(store).delete(key);
  await done(commit(tx));
}

export async function clear(stores: readonly string[], name = current): Promise<void> {
  const db = await open(name);
  const tx = db.transaction([...stores], 'readwrite');
  for (const store of stores) tx.objectStore(store).clear();
  await done(commit(tx));
}

export async function getMeta<T = any>(key: string, name = current): Promise<T | undefined> {
  const db = await open(name);
  const row = await wrap(db.transaction(META, 'readonly').objectStore(META).get(key) as IDBRequest<{ value: T }>);
  return row?.value;
}

export const setMeta = (key: string, value: unknown, name = current): Promise<void> => put(META, { key, value }, name);

/** Every mirror this person has on the device, whichever workspace it is for. */
export async function mirrorsOf(userId: string): Promise<string[]> {
  const prefix = mirrorName(userId, '');
  const known = await (indexedDB.databases?.() ?? Promise.resolve([])).catch(() => []);
  const names = new Set(known.map((db) => db.name ?? '').filter((name) => name.startsWith(prefix)));
  if (current.startsWith(prefix)) names.add(current);
  return [...names];
}

export async function erase(name: string): Promise<void> {
  const opened = handles.get(name);
  handles.delete(name);
  if (opened) (await opened.catch(() => null))?.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    // Another tab closes its connection on `versionchange`; the delete completes then.
    request.onblocked = () => resolve();
  });
}

/** Commit now rather than after the success round trip, which a page left a moment later never sees. */
const commit = (tx: IDBTransaction): IDBTransaction => {
  tx.commit?.();
  return tx;
};

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export const storeFor = (entity: EntityName): string => entity;

/** Storage is best-effort: a private-mode browser may refuse it entirely. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
