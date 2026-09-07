/**
 * What has to be true of an environment, and of a secret that names one.
 *
 * Environments are here rather than in a module of their own because the vault
 * is their only caller today. They are not a secrets concept — the
 * infrastructure register has had the same four words on `components` since it
 * was written, and the honest end state is one set of rows both point at. That
 * is a migration with its own screens and its own import format, so it is not
 * this change; when it happens, this file moves down rather than growing a
 * second copy.
 *
 * Two refusals here carry the whole feature:
 *
 * **A collision is refused, not merged.** CAP-5 asks for a secret to be
 * identified by (scope, environment, key). Nothing enforced that before — two
 * rows could both be called `STRIPE_KEY` in production, and a CLI resolving a
 * name would have to pick one. Refused in the write path rather than by a
 * UNIQUE index, because the index cannot express "among rows nobody has
 * deleted" and would fail the migration on any database that already holds a
 * pair. Rows that already collide are left alone until somebody writes to one.
 *
 * **There is no fallback between environments.** A secret asked for in
 * `production` that exists only in `development` is not found. The other design
 * — inherit from a base, override per environment — reads as convenience and
 * fails as a development process holding the production Stripe key, because
 * the value that was right was the one nobody remembered to override. A
 * secret meant for every environment has no environment at all, which is a
 * different statement and is spelled differently.
 */

import { ENVIRONMENT_ROLES, type EnvironmentRole, type WorkspaceRole } from '@kolibri/shared';
import { get, type Row } from '../../../kernel/platform/db/index.ts';
import { badRequest, forbidden } from '../../../kernel/platform/http.ts';
import { hasRole } from '../../../kernel/identity/auth.ts';
import { type EntityRule, type WriteOpts } from '../../../kernel/write-path/repo.ts';

const ROLES = new Set<string>(ENVIRONMENT_ROLES);

/**
 * A name a machine can be handed.
 *
 * Folded rather than refused, the way a secret's `kind` is: an environment
 * nobody can save is an environment somebody keeps in their head. Spaces
 * become hyphens because `staging eu` on a command line is two arguments.
 */
export function environmentName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
}

/** The caller's rank in this workspace, or nothing if they are not in it. */
const roleOf = (opts: WriteOpts): WorkspaceRole | undefined =>
  get<Row>(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL`,
    opts.workspaceId, opts.actorId,
  )?.role as WorkspaceRole | undefined;

/**
 * Whether this person may read what is kept in this environment.
 *
 * The second of the two axes, and it composes with `canSeeSecret` rather than
 * replacing it: `access` says who a secret is for, this says which rank may
 * open that environment at all, and a reader has to pass both. An admin-only
 * `production` therefore does not hand anybody somebody else's private secret,
 * and a private secret does not open production to its author.
 *
 * A secret with no environment is in none, and none has no floor.
 */
export function canOpenEnvironment(environmentId: unknown, role: WorkspaceRole | undefined): boolean {
  if (!environmentId) return true;
  const row = get<Row>(`SELECT min_role FROM environments WHERE id = ? AND deleted_at IS NULL`, environmentId);
  // An environment that has been deleted out from under a secret is not a
  // reason to hand the secret out. Refuse, and let somebody move it.
  if (!row) return false;
  return !!role && hasRole(role, String(row.min_role ?? 'member') as WorkspaceRole);
}

/**
 * The same floor, in SQL, for the two places that answer with a query.
 *
 * Written twice on purpose, exactly as the channel rule is: a sync pull and a
 * collection listing have to stay one statement so `limit` counts rows the
 * caller may actually have, and a guard has to be a function so it can refuse.
 * The pair is tested against each other rather than trusted to agree.
 *
 * The rank is read from `workspace_members` inside the clause rather than
 * passed in, so a caller cannot hand it the wrong role. `user` is the
 * placeholder to bind the reader to — the sync filter numbers its parameters
 * and everything else does not.
 */
export const openEnvironmentSql = (table = 'secrets', user = '?'): string => `
  AND (${table}.environment_id IS NULL OR EXISTS (
        SELECT 1 FROM environments e
         WHERE e.id = ${table}.environment_id AND e.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM workspace_members wm
                        WHERE wm.workspace_id = e.workspace_id AND wm.user_id = ${user}
                          AND wm.deleted_at IS NULL
                          AND (e.min_role = 'member'
                               OR (e.min_role = 'admin' AND wm.role IN ('admin', 'owner'))
                               OR (e.min_role = 'owner' AND wm.role = 'owner')))))`;

/** The value a write leaves behind, whether it named the field or not. */
const after = (values: Record<string, unknown>, existing: Row | undefined, field: string): unknown =>
  (values[field] !== undefined ? values[field] : existing?.[field]) ?? null;

/**
 * Which workspace this write lands in.
 *
 * Not `values.workspace_id`, which is never there: the write path strips that
 * field from anything a client sends, because a row's workspace is the scope
 * the request arrived in and not a claim the request may make. Asking `values`
 * for it returns null, and a uniqueness check scoped to null workspace matches
 * nothing and refuses nobody — which is how the first version of this file
 * passed its own typecheck while enforcing neither of its two rules.
 */
const workspaceOf = (existing: Row | undefined, opts: WriteOpts): unknown =>
  existing?.workspace_id ?? opts.workspaceId;

export const environmentRules = {
  entities: ['environment', 'secret'],

  invariants(entity, id, values, existing, forced, opts) {
    if (entity === 'environment') {
      if (values.name !== undefined) {
        const name = environmentName(values.name);
        values.name = name;
        forced.name = name;
      }
      if (values.min_role !== undefined) {
        const role: EnvironmentRole = ROLES.has(String(values.min_role))
          ? (String(values.min_role) as EnvironmentRole)
          : 'member';
        values.min_role = role;
        forced.min_role = role;
      }
      return;
    }
    if (entity !== 'secret' || values.environment_id === undefined || !values.environment_id) return;
    /*
     * An environment from another workspace is cleared rather than refused.
     * It is the shape of a copy-paste or of a stale client, not of somebody
     * trying something — and the refusals below are for the cases that are.
     */
    const environment = get<Row>(
      `SELECT workspace_id FROM environments WHERE id = ? AND deleted_at IS NULL`, values.environment_id,
    );
    if (!environment || String(environment.workspace_id) !== String(opts.workspaceId)) {
      values.environment_id = null;
      forced.environment_id = null;
    }
  },

  guards(entity, id, values, existing, opts) {
    const role = roleOf(opts);

    if (entity === 'environment') {
      /*
       * Configuration with an access floor on it, so it is an admin's to
       * write. The sharp case is not creation but `min_role`: lowering
       * `production` from `owner` to `member` opens every credential in it,
       * and a member who could do that has an admin's power spelled as an
       * ordinary row edit.
       */
      if (!role || !hasRole(role, 'admin')) {
        throw forbidden('Environments are set up by an administrator of the workspace');
      }
      const name = after(values, existing, 'name');
      if (name && (values.name !== undefined || !existing)) {
        const clash = get<Row>(
          `SELECT id FROM environments
            WHERE workspace_id = ? AND name = ? AND id <> ? AND deleted_at IS NULL`,
          workspaceOf(existing, opts), name, id,
        );
        if (clash) throw badRequest(`This workspace already has an environment called "${name}"`);
      }
      if (opts.op === 'delete') {
        const held = get<Row>(
          `SELECT count(*) AS n FROM secrets WHERE environment_id = ? AND deleted_at IS NULL`, id,
        );
        // Deleting it would leave its secrets in an environment that no longer
        // exists — unreadable by `canOpenEnvironment` and invisible in every
        // filter, which is a vault quietly losing rows rather than a warning.
        if (Number(held?.n ?? 0) > 0) {
          throw badRequest(
            `"${existing?.name}" still holds ${held!.n} secret(s). Move or delete them first.`,
          );
        }
      }
      return;
    }

    if (entity !== 'secret' || opts.op === 'delete') return;

    const environmentId = after(values, existing, 'environment_id');
    /*
     * Writing into an environment you may not open would make a credential you
     * cannot read afterwards — which is not a trap worth allowing, and is the
     * shape of somebody hiding one from themselves by accident.
     */
    if (values.environment_id !== undefined && environmentId && !canOpenEnvironment(environmentId, role)) {
      throw forbidden('That environment is not yours to write into');
    }

    const name = after(values, existing, 'name');
    if (!name) return;
    if (values.name === undefined && values.environment_id === undefined && values.project_id === undefined) return;
    const clash = get<Row>(
      `SELECT id FROM secrets
        WHERE workspace_id = ? AND name = ? AND id <> ? AND deleted_at IS NULL
          AND project_id IS ? AND environment_id IS ?`,
      workspaceOf(existing, opts), name, id,
      after(values, existing, 'project_id'), environmentId,
    );
    if (clash) {
      throw badRequest(
        `A secret called "${name}" already exists here. Names are unique per project and environment, `
        + 'so a machine asking for one gets an answer rather than a choice.',
      );
    }
  },
} satisfies EntityRule;
