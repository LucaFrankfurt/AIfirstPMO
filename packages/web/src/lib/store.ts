/**
 * The client-side cache.
 *
 * Every screen reads from these maps, never from the network directly — that is
 * what makes the app instant and what makes offline behave exactly like online.
 * The sync engine is the only thing that writes to them.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { ENTITY_NAMES, type ChangeSet, type EntityMap, type EntityName } from '@kolibri/shared';

type Tables = { [K in EntityName]: Map<string, any> };

export const tables: Tables = Object.fromEntries(ENTITY_NAMES.map((name) => [name, new Map()])) as Tables;

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getVersion = () => version;

/** Re-renders whenever anything in the cache changes. */
export const useVersion = (): number => useSyncExternalStore(subscribe, getVersion, getVersion);

/** Memoised view over the cache; recomputed on every store change. */
export function useQuery<T>(select: () => T, deps: unknown[] = []): T {
  const v = useVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compute = useCallback(select, deps);
  return computeMemo(compute, v, deps);
}

const memo = new WeakMap<() => unknown, { version: number; deps: unknown[]; value: unknown }>();

function computeMemo<T>(compute: () => T, v: number, deps: unknown[]): T {
  const cached = memo.get(compute);
  if (cached && cached.version === v && sameDeps(cached.deps, deps)) return cached.value as T;
  const value = compute();
  memo.set(compute, { version: v, deps, value });
  return value;
}

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/* ------------------------------------------------------------------ access */

export function list<K extends EntityName>(entity: K, predicate?: (row: EntityMap[K]) => boolean): EntityMap[K][] {
  const out: EntityMap[K][] = [];
  for (const row of tables[entity].values()) {
    if (row.deleted_at) continue;
    if (predicate && !predicate(row)) continue;
    out.push(row);
  }
  return out;
}

export function byId<K extends EntityName>(entity: K, id: string | null | undefined): EntityMap[K] | undefined {
  if (!id) return undefined;
  const row = tables[entity].get(id);
  return row && !row.deleted_at ? row : undefined;
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
    for (const row of rows) {
      const existing = table.get(row.id);
      table.set(row.id, existing ? { ...existing, ...row } : row);
      touched = true;
    }
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
    if (table?.delete(purge.row_id)) touched = true;
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

/** Merge one row locally (optimistic update). */
export function patchLocal(entity: EntityName, id: string, patch: Record<string, unknown>): Record<string, any> {
  const table = tables[entity];
  const existing = table.get(id) ?? { id };
  const next = { ...existing, ...patch, updated_at: Date.now() };
  table.set(id, next);
  emit();
  return next;
}

export function hydrate(entity: EntityName, rows: any[]): void {
  const table = tables[entity];
  for (const row of rows) table.set(row.id, row);
}

export function reset(): void {
  for (const entity of ENTITY_NAMES) tables[entity].clear();
  emit();
}

export const notifyStore = emit;
