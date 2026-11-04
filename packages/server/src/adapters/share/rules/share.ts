/** A share publishes to strangers, so it may only point at what its maker may read — on every write path. */

import type { Row } from '../../../kernel/platform/db/index.ts';
import { forbidden } from '../../../kernel/platform/http.ts';
import {
  canSeePage, canSeeProject, isWorkspaceAdmin, type EntityRule,
} from '../../../kernel/write-path/repo.ts';

/** The value a write leaves behind, whether it named the field or not. */
const after = (values: Record<string, unknown>, existing: Row | undefined, field: string): unknown =>
  (values[field] !== undefined ? values[field] : existing?.[field]) ?? null;

export const shareRules = {
  entities: ['share'],

  guards(entity, id, values, existing, opts) {
    // Revoking a link never publishes anything.
    if (opts.op === 'delete') return;
    const kind = String(after(values, existing, 'kind') ?? '');
    const projectId = after(values, existing, 'project_id');
    if (projectId && !canSeeProject(opts.actorId, String(projectId))) throw forbidden('That project is private');
    if (kind === 'tasks' || kind === 'intake') {
      const workspaceId = String(existing?.workspace_id ?? opts.workspaceId);
      if (kind === 'tasks' && !projectId && !isWorkspaceAdmin(workspaceId, opts.actorId)) {
        throw forbidden('Only an administrator may share the tasks of every project');
      }
      return;
    }
    // Every other kind renders as a page.
    if (!canSeePage(opts.actorId, String(after(values, existing, 'page_id') ?? ''))) {
      throw forbidden('That page is private');
    }
  },

  invariants(entity, id, values, existing, forced, opts) {
    if (opts.system) return;
    // The renderer reads with its maker's eyes, so the maker is not a client's to claim.
    const maker = existing ? existing.created_by ?? null : opts.actorId;
    if (values.created_by !== undefined && values.created_by !== maker) {
      values.created_by = maker;
      forced.created_by = maker;
    }
  },
} satisfies EntityRule;
