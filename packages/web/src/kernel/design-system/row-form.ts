import { useState } from 'react';
import type { EntityName } from '@kolibri/shared';
import { update } from '../sync/mutations';

// A form turns null into '' on the way in and '' back into null on the way out.
const blank = (value: unknown): boolean =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

/** The fields of `patch` that differ from `opened`, the row as the form found it when it opened. */
export function changedFields(patch: Record<string, unknown>, opened: object): Record<string, unknown> {
  const before = opened as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (blank(value) && blank(before[field])) continue;
    if (JSON.stringify(value) !== JSON.stringify(before[field])) out[field] = value;
  }
  return out;
}

/** Saves an edit form: only what changed since it opened, so somebody else's edit to another field survives. */
export function useSaveChanges(entity: EntityName, row: { id: string } | null | undefined): (patch: Record<string, unknown>) => void {
  const [opened] = useState(row);
  return (patch) => {
    if (!opened) return;
    const changes = changedFields(patch, opened);
    // Even an empty write would resurrect a row deleted elsewhere meanwhile.
    if (Object.keys(changes).length) update(entity, opened.id, changes);
  };
}
