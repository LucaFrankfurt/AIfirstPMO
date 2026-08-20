/**
 * What a workspace has switched on.
 *
 * Stored as JSON inside `workspaces.settings` rather than as a column each,
 * because a switch is not data anybody queries: it is read when a session
 * loads and never joined against. A malformed value reads as "nothing switched
 * on", which is the safe direction for this to fail in — a feature that
 * appears because a JSON parse went wrong is worse than one that stays hidden.
 */
import type { WorkspaceFeatures } from '@kolibri/shared';
import { get, type Row } from '../db/index.ts';

export function featuresOf(workspace: Row | undefined): WorkspaceFeatures {
  try {
    const parsed = JSON.parse(String(workspace?.settings ?? '{}')) as { features?: WorkspaceFeatures };
    return parsed.features ?? {};
  } catch {
    return {};
  }
}

export const hasFeature = (workspaceId: string, name: keyof WorkspaceFeatures): boolean =>
  !!featuresOf(get<Row>(`SELECT settings FROM workspaces WHERE id = ?`, workspaceId))[name];
