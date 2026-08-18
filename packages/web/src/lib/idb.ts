/**
 * A very small IndexedDB wrapper — the offline mirror of the workspace.
 *
 * One object store per entity plus `outbox` (mutations waiting to be pushed)
 * and `meta` (sync cursor, cached session, ui preferences).
 */
import { ENTITY_NAMES, type EntityName } from '@kolibri/shared';

const DB_NAME = 'kolibri';
/**
 * Bump this whenever an entity is added: a browser that has already opened the
 * database at the old version never runs `onupgradeneeded` again, so the new
 * store would simply not exist and every read of it would throw. The upgrade
 * itself only ever adds missing stores, so it is safe to run on any old copy.
 */
const DB_VERSION = 2;
export const META = 'meta';
export const OUTBOX = 'outbox';

const STORES = [...ENTITY_NAMES, META, OUTBOX];

let handle: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (handle) return handle;
  handle = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
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
  return handle;
}

const wrap = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export async function readAll<T = any>(store: string): Promise<T[]> {
  const db = await open();
  return wrap(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function put(store: string, value: unknown): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(tx);
}

export async function putMany(entries: { store: string; values: unknown[] }[]): Promise<void> {
  const stores = entries.map((e) => e.store).filter((s, i, arr) => arr.indexOf(s) === i);
  if (!stores.length) return;
  const db = await open();
  const tx = db.transaction(stores, 'readwrite');
  for (const entry of entries) {
    const objectStore = tx.objectStore(entry.store);
    for (const value of entry.values) objectStore.put(value);
  }
  await done(tx);
}

export async function remove(store: string, key: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function removeMany(store: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  for (const key of keys) tx.objectStore(store).delete(key);
  await done(tx);
}

export async function clearAll(): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORES, 'readwrite');
  for (const store of STORES) tx.objectStore(store).clear();
  await done(tx);
}

export async function getMeta<T = any>(key: string): Promise<T | undefined> {
  const db = await open();
  const row = await wrap(db.transaction(META, 'readonly').objectStore(META).get(key) as IDBRequest<{ value: T }>);
  return row?.value;
}

export const setMeta = (key: string, value: unknown): Promise<void> => put(META, { key, value });

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
