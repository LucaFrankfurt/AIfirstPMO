/**
 * What has to be true of a secret's *label*, whoever wrote it.
 *
 * The value is not here at all — it never travels through the write path,
 * because it is not one of the entity's `fields`. It arrives at one route,
 * gets sealed, and is written with a statement of its own. What is left for
 * this file is the small set of things that must hold about the row around it,
 * and they are the ones a client could otherwise get wrong quietly.
 *
 * The `access` invariant is the load-bearing one. `project` on a secret that
 * belongs to no project reads as "the project it is in", and there is none — so
 * `canSeeSecret` would fall through to allowing it, and a credential meant for
 * one team would sit in front of the whole workspace. Pages have the same
 * shape and answer it in the interface with a toast; a credential is not a
 * thing to answer in the interface only, because MCP, the API and an import all
 * reach the same column.
 */

import { SECRET_ACCESS, SECRET_KINDS, type SecretAccess, type SecretKind } from '@kolibri/shared';
import type { Row } from '../../../kernel/platform/db/index.ts';
import { canSeeProject, type EntityRule } from '../../../kernel/write-path/repo.ts';

const KINDS = new Set<string>(SECRET_KINDS);
const ACCESS = new Set<string>(SECRET_ACCESS);

export const secretRules = {
  entities: ['secret'],
  defaults(entity, id, values, opts, setForced) {
    if (entity !== 'secret') return;
    if (!values.created_by) setForced('created_by', opts.actorId);
  },
  invariants(entity, id, values, existing, forced) {
    if (entity !== 'secret') return;

    if (values.kind !== undefined) {
      // Folded rather than refused, the same way a page's format is: an unknown
      // kind is a label problem, and a secret nobody can save is a secret
      // somebody keeps in a chat message instead.
      const kind: SecretKind = KINDS.has(String(values.kind)) ? (String(values.kind) as SecretKind) : 'password';
      values.kind = kind;
      forced.kind = kind;
    }

    if (values.access !== undefined) {
      let access: SecretAccess = ACCESS.has(String(values.access)) ? (String(values.access) as SecretAccess) : 'workspace';
      // The one that is not a fold but a correction. Whichever half of the pair
      // is being written, the answer is read from both — a write that clears
      // `project_id` on a `project` secret is the same mistake from the other
      // side, and this is the only place that sees both at once.
      const project = values.project_id !== undefined ? values.project_id : existing?.project_id;
      if (access === 'project' && !project) access = 'private';
      values.access = access;
      forced.access = access;
    } else if (values.project_id !== undefined && !values.project_id && existing?.access === 'project') {
      values.access = 'private';
      forced.access = 'private';
    }

    if (values.rotate_after_days !== undefined) {
      const days = Math.trunc(Number(values.rotate_after_days ?? 0));
      // Clamped rather than refused, and clamped at ten years because a cadence
      // longer than that is the same statement as no cadence at all.
      const clean = Number.isFinite(days) ? Math.min(Math.max(days, 0), 3650) : 0;
      values.rotate_after_days = clean;
      forced.rotate_after_days = clean;
    }
  },
} satisfies EntityRule;

/**
 * Whether this person may read this secret.
 *
 * The same two-part rule a page follows, and written out here rather than
 * imported from the page module because a capability may not lean on another
 * capability — but it is the same rule, and it is meant to stay the same rule.
 *
 * The difference from a page is what `private` means when the answer is no. A
 * private page an admin cannot read is a mild surprise; a private *credential*
 * an admin cannot read is the entire promise of the word, so there is no
 * override here and there is not going to be one. An owner who needs a
 * colleague's key asks the colleague.
 */
export function canSeeSecret(secret: Row, userId: string): boolean {
  if (secret.project_id && !canSeeProject(userId, String(secret.project_id))) return false;
  return secret.access !== 'private' || secret.created_by === userId;
}
