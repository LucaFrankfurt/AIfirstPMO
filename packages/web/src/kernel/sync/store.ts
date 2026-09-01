/**
 * The client-side cache.
 *
 * Every screen reads from these maps, never from the network directly — that is
 * what makes the app instant and what makes offline behave exactly like online.
 * The sync engine is the only thing that writes to them.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { ENTITY_NAMES, crdt, entityDef, type ChangeSet, type EntityMap, type EntityName } from '@kolibri/shared';

type Tables = { [K in EntityName]: Map<string, any> };

export const tables: Tables = Object.fromEntries(ENTITY_NAMES.map((name) => [name, new Map()])) as Tables;

/**
 * A counter per table, not one for the whole cache.
 *
 * There was one, and it meant every selector on screen re-ran on every write:
 * typing a task title made the board re-scan the labels, the states, the
 * cycles, the vendors and everything else, and hand each of its callers a
 * freshly allocated array — which then invalidated every `useMemo` downstream
 * that was keyed on it. The counters are per table so a selector can be told
 * apart from a write it does not read.
 */
const versions: Record<EntityName, number> = Object.fromEntries(
  ENTITY_NAMES.map((name) => [name, 0]),
) as Record<EntityName, number>;

/** Bumped by any write at all — what the subscription below re-renders on. */
let revision = 0;

const listeners = new Set<() => void>();

/** Record that a table changed. Notify separately, once, per batch of writes. */
function bump(entity: EntityName): void {
  versions[entity] += 1;
  revision += 1;
}

function emit(): void {
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getRevision = () => revision;

/** Re-renders whenever anything in the cache changes. */
const useRevision = (): number => useSyncExternalStore(subscribe, getRevision, getRevision);

/* ----------------------------------------------------------- what was read */

/**
 * The tables the selector currently running has touched.
 *
 * Observed rather than declared, which is the whole point: a caller that had to
 * list the tables its selector reads would eventually list too few, and the
 * screen would quietly stop updating. `list` and `byId` are the only ways into
 * the cache, so recording them catches every read, including the ones a helper
 * three calls deep makes.
 */
let recording: Set<EntityName> | null = null;

const stampOf = (reads: Set<EntityName> | undefined): number => {
  if (!reads) return -1;
  let sum = 0;
  for (const entity of reads) sum += versions[entity];
  return sum;
};

interface Cached { deps: unknown[]; reads: Set<EntityName>; stamp: number; value: unknown }

const memo = new WeakMap<() => unknown, Cached>();

/**
 * A selector's value, recomputed only when one of the tables it read has moved.
 *
 * The identity of the result matters as much as the result: handing back the
 * same array means the `useMemo` that sorts it and the `React.memo` that
 * renders it both stand down too, which is most of the saving.
 *
 * Outside React this is usable directly, and then `select` has to be a stable
 * reference — the memo is keyed on it. `useQuery` gets that from `useCallback`.
 */
export function query<T>(select: () => T, deps: unknown[] = []): T {
  const cached = memo.get(select);
  if (cached && sameDeps(cached.deps, deps) && stampOf(cached.reads) === cached.stamp) return cached.value as T;

  const reads = new Set<EntityName>();
  const outer = recording;
  recording = reads;
  let value: T;
  try {
    value = select();
  } finally {
    // A nested selector's reads belong to the one around it as well, or the
    // outer memo would hold a set smaller than what it actually depends on.
    if (outer) for (const entity of reads) outer.add(entity);
    recording = outer;
  }
  memo.set(select, { deps, reads, stamp: stampOf(reads), value });
  return value;
}

/**
 * A memoised view over the cache.
 *
 * The component still re-renders on every write — 89 places read the cache
 * straight from a render body rather than through here, and they have nothing
 * else to tell them a row changed. What this stops is the *recomputation*: the
 * body re-runs, the selector does not, and it hands back the array it handed
 * back last time.
 */
export function useQuery<T>(select: () => T, deps: unknown[] = []): T {
  useRevision();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compute = useCallback(select, deps);
  return query(compute, deps);
}

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/* ------------------------------------------------------------------ access */

export function list<K extends EntityName>(entity: K, predicate?: (row: EntityMap[K]) => boolean): EntityMap[K][] {
  recording?.add(entity);
  const out: EntityMap[K][] = [];
  for (const row of tables[entity].values()) {
    if (row.deleted_at) continue;
    if (predicate && !predicate(row)) continue;
    out.push(row);
  }
  return out;
}

export function byId<K extends EntityName>(entity: K, id: string | null | undefined): EntityMap[K] | undefined {
  recording?.add(entity);
  if (!id) return undefined;
  const row = tables[entity].get(id);
  return row && !row.deleted_at ? row : undefined;
}

/**
 * Every row in a table, tombstones and archived rows included.
 *
 * `list` hides the deleted ones, which is right everywhere except the screen
 * whose subject they are. That screen used to reach into `tables` itself, and
 * a read that goes around `list` and `byId` is a read `query` cannot see — so
 * it would have kept its first answer for ever once the memo above arrived.
 */
export function listAll<K extends EntityName>(entity: K): EntityMap[K][] {
  recording?.add(entity);
  return [...tables[entity].values()];
}

export const useList = <K extends EntityName>(entity: K, predicate?: (row: EntityMap[K]) => boolean, deps: unknown[] = []) =>
  useQuery(() => list(entity, predicate), [entity, ...deps]);

export const useRow = <K extends EntityName>(entity: K, id: string | null | undefined) =>
  useQuery(() => byId(entity, id), [entity, id]);

/* ------------------------------------------------------------------ writes */

/** Apply a server changeset (pull result or push echo). */
export function applyChanges(changes: ChangeSet): void {
  let touched = false;
  for (const entity of ENTITY_NAMES) {
    const rows = (changes as Record<string, any[]>)[entity];
    if (!rows?.length) continue;
    const table = tables[entity];
    const merging = entityDef(entity)?.crdt;
    for (const row of rows) {
      const existing = table.get(row.id);
      // A merged field is combined rather than overwritten, here as well as on
      // the server: a device with an unsent edit must not lose it to the row
      // coming back from a pull, which is exactly when it would happen.
      if (existing && merging) for (const field of merging) row[field] = crdt.merge(existing[field], row[field]);
      table.set(row.id, existing ? { ...existing, ...row } : row);
    }
    bump(entity);
    touched = true;
  }
  if (applyPurges(changes)) touched = true;
  if (touched) emit();
}

/**
 * A purge is a tombstone that has itself been thrown away.
 *
 * The row it names is dropped outright rather than marked, because there is
 * nothing left to mark: the trash screen reads the tombstones, so leaving one
 * behind would keep offering to restore a thing the server no longer has.
 */
function applyPurges(changes: ChangeSet): boolean {
  const purges = (changes as Record<string, any[]>).purge;
  if (!purges?.length) return false;
  let touched = false;
  for (const purge of purges) {
    const table = (tables as Record<string, Map<string, any>>)[purge.entity];
    if (table?.delete(purge.row_id)) {
      bump(purge.entity as EntityName);
      touched = true;
    }
  }
  return touched;
}

/** The rows a changeset's purges named, so the same thing leaves IndexedDB. */
export function purgedRows(changes: ChangeSet): { store: string; keys: string[] }[] {
  const byStore = new Map<string, string[]>();
  for (const purge of ((changes as Record<string, any[]>).purge ?? [])) {
    const keys = byStore.get(purge.entity) ?? [];
    keys.push(purge.row_id);
    byStore.set(purge.entity, keys);
  }
  return [...byStore].map(([store, keys]) => ({ store, keys }));
}

/**
 * Forget a row this device invented and the server would not take.
 *
 * Not a delete: a delete is a tombstone that syncs, and there is nothing to
 * tell anybody about — the row never existed anywhere but here. It is dropped
 * from the table outright, and `sync.ts` drops it from IndexedDB in the same
 * breath.
 */
export function forgetLocal(entity: EntityName, id: string): void {
  if (tables[entity].delete(id)) bump(entity);
}

/** Merge one row locally (optimistic update). */
export function patchLocal(entity: EntityName, id: string, patch: Record<string, unknown>): Record<string, any> {
  const table = tables[entity];
  const existing = table.get(id) ?? { id };
  const next = { ...existing, ...patch, updated_at: Date.now() };
  table.set(id, next);
  bump(entity);
  emit();
  return next;
}

/**
 * Fill a table from IndexedDB at startup.
 *
 * Marks the table as changed but does not notify: this runs once per entity
 * across the whole cache, and forty-two rounds of re-rendering before the first
 * paint is worse than one. `sync.ts` calls `notifyStore` when it has finished.
 */
export function hydrate(entity: EntityName, rows: any[]): void {
  if (!rows.length) return;
  const table = tables[entity];
  for (const row of rows) table.set(row.id, row);
  bump(entity);
}

export function reset(): void {
  for (const entity of ENTITY_NAMES) {
    tables[entity].clear();
    bump(entity);
  }
  emit();
}

export const notifyStore = emit;
