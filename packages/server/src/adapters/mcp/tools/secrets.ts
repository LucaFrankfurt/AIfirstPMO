/**
 * The one thing an assistant may know about the vault: that a credential
 * exists, who it is for, and whether it has gone stale.
 *
 * `docs/secrets.md` said "no MCP surface, not even a list of names" and meant
 * it — the reasoning was that an assistant which can name your secrets is a
 * transcript which names your secrets, and that relaxing it later is easy
 * while un-leaking is impossible. This is the deliberate relaxation, and it is
 * worth being precise about what changed and what did not.
 *
 * **What is here.** Labels: a name, a kind, who it is for, when it was last
 * rotated and whether that is overdue. That answers the question a vault is
 * actually for — *which of our credentials has nobody touched since the
 * contractor left* — and it is a question no screen can answer for somebody
 * who is not looking at the screen.
 *
 * **What is not, and will not be without a decision of its own.**
 *
 * - **No value.** Not through a tool, not through an argument, not by
 *   accident: the query below does not select the column. The seal is a second
 *   line of defence and this is the first.
 * - **No mask either.** `maskSecret` shows the last four characters, which is
 *   how every provider's console lets you tell four keys apart — and four
 *   characters of a credential in a model transcript is four characters of a
 *   credential in a model transcript. The REST listing does not carry it
 *   either; only the two write routes echo it, to the person who just typed
 *   the value.
 * - **No writing.** Rotating a credential from a chat window is a thing that
 *   should require the screen it is kept on.
 *
 * **The visibility rule is `canSeeSecret`, unchanged.** A private secret is
 * listed to its author and to nobody else, exactly as over REST, and a token
 * is its owner's. There was a case for narrowing that further here — a private
 * credential is the one class whose *name* is most telling — but two different
 * answers to "who may see this" is how a rule rots, and the person asking is
 * the person who marked it private.
 */

import { daysUntilRotation, rotation, SECRET_ACCESS, SECRET_KINDS, type WorkspaceRole } from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { hasRole } from '../../../kernel/identity/auth.ts';
import { canSeeSecret } from '../../../modules/secrets/rules/secrets.ts';
import { openEnvironmentSql } from '../../../modules/secrets/rules/environments.ts';
import { findProject, McpError, namesOf, projectNames, str, type McpCtx, type ToolDef, workspaceOf } from '../kit.ts';

/**
 * A guest is refused rather than shown an empty vault.
 *
 * The same sentence the collection route uses, and for the same reason: a
 * guest is *in* the workspace, so "there is nothing here" would read as a fact
 * about the workspace rather than as a boundary. The role is the person's, not
 * the token's — a guest who mints themselves a token has not stopped being a
 * guest.
 */
function requireVault(ctx: McpCtx, workspaceId: string): WorkspaceRole {
  const role = ctx.auth.memberships.get(workspaceId);
  if (!role || !hasRole(role, 'member')) {
    throw new McpError('The vault is for members of the workspace', -32000);
  }
  return role;
}

/**
 * An environment by name, refused rather than ignored when there is no such
 * thing.
 *
 * A filter that silently matches nothing is the worst of the three possible
 * answers: `list_secrets --environment prod` in a workspace whose environment
 * is called `production` would report an empty vault, and an assistant would
 * repeat that as a fact.
 */
function findEnvironment(ref: string, workspaceId: string): Row {
  const row = get<Row>(
    `SELECT * FROM environments WHERE workspace_id = ? AND (id = ? OR name = ?) AND deleted_at IS NULL`,
    workspaceId, ref, ref.toLowerCase(),
  );
  if (!row) throw new McpError(`No environment in this workspace is called "${ref}"`);
  return row;
}

/**
 * Overdue first, then due, then everything else by name.
 *
 * The order is the answer. A vault sorted by when each row was written is a
 * list; sorted by what is late, the first line is the reply to the question
 * that made somebody ask.
 */
const URGENCY: Record<string, number> = { overdue: 0, due: 1, fresh: 2, unset: 3 };

export const secretTools: ToolDef[] = [
  {
    name: 'list_secrets',
    title: 'List secrets',
    description:
      'The vault as labels: what credentials exist, who each is for, and which are overdue for rotation. '
      + 'Values are never returned — not by this tool and not by any other — and there is no tool that reveals one. '
      + 'Overdue first. A private secret appears only to the person who kept it.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: "A project's key or name, for the credentials kept under it." },
        kind: { type: 'string', enum: [...SECRET_KINDS] },
        access: { type: 'string', enum: [...SECRET_ACCESS], description: 'Who a secret is for.' },
        environment: {
          type: 'string',
          description:
            'One environment by name. Not enumerated here because a workspace names its own — every answer '
            + 'carries `by_environment`, which is the list of what exists.',
        },
        rotation: {
          type: 'string',
          enum: ['overdue', 'due', 'stale', 'fresh', 'unset'],
          description: '`stale` is overdue and due together — the two worth acting on.',
        },
        include_archived: { type: 'boolean' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const role = requireVault(ctx, workspaceId);
      const project = args.project ? findProject(String(args.project), workspaceId, ctx) : null;
      const environment = str(args.environment) ? findEnvironment(String(args.environment), workspaceId) : null;

      /*
       * The column list is the point of this query. `value` is not in it, so
       * the sealed bytes are not read out of SQLite at all — whatever the view
       * below does or a later edit to it forgets. `serialize` would keep the
       * value out too, and it would also carry every future field of the
       * entity out with it; for this one row an allowlist is the failure mode
       * to want.
       */
      const rows = all<Row>(
        `SELECT id, name, description, kind, access, project_id, created_by, environment_id,
                rotated_at, rotate_after_days, last_used_at, archived, created_at
           FROM secrets
          WHERE workspace_id = ? AND deleted_at IS NULL
            ${project ? 'AND project_id = ?' : ''}
            ${environment ? 'AND environment_id = ?' : ''}
            ${args.include_archived === true ? '' : 'AND archived = 0'}
            ${str(args.kind) ? 'AND kind = ?' : ''}
            ${str(args.access) ? 'AND access = ?' : ''}
            AND (access <> 'private' OR created_by = ?)
            ${openEnvironmentSql('secrets')}
          LIMIT 500`,
        workspaceId,
        ...(project ? [project.id] : []),
        ...(environment ? [environment.id] : []),
        ...(str(args.kind) ? [String(args.kind)] : []),
        ...(str(args.access) ? [String(args.access)] : []),
        ctx.auth.userId,
        ctx.auth.userId,
      )
        // The private clause and the environment floor are both in SQL; the
        // project one cannot be, and `canSeeSecret` is the function every door
        // asks rather than a second spelling of the same three rules.
        .filter((row) => canSeeSecret(row, ctx.auth.userId, role));

      const wanted = str(args.rotation);
      const names = namesOf(rows.map((row) => String(row.created_by ?? '')));
      const projects = projectNames(workspaceId);
      /* Every environment the reader may open, not only the ones in use, so an
         empty `production` is legible as empty rather than as absent — and so
         the caller learns the words this workspace uses without a tool of its
         own to ask. */
      const environments = Object.fromEntries(all<Row>(
        `SELECT id, name FROM environments WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId,
      ).map((row) => [String(row.id), String(row.name)]));
      const view = rows
        .map((row) => {
          const stands = rotation(row);
          return {
            id: row.id,
            name: row.name,
            description: row.description || null,
            kind: row.kind,
            access: row.access,
            project: row.project_id ? projects[String(row.project_id)] ?? null : null,
            /* Null is not a wildcard: a secret with no environment is the same
               everywhere, and one asked for in `production` that exists only in
               `development` is not found. There is no fallback — see
               docs/secrets.md for why that is the safe way round. */
            environment: row.environment_id ? environments[String(row.environment_id)] ?? null : null,
            kept_by: names[String(row.created_by ?? '')] ?? null,
            rotation: stands,
            rotate_after_days: Number(row.rotate_after_days ?? 0) || null,
            /* Days rather than only a date, because "in 4 days" is the answer
               and a timestamp is arithmetic somebody has to do. Negative once
               it is past; null when the secret has no cadence at all. */
            days_until_rotation: daysUntilRotation(row),
            last_rotated: iso(row.rotated_at ?? row.created_at),
            last_used: iso(row.last_used_at),
            archived: !!row.archived,
          };
        })
        .filter((one) => !wanted
          || (wanted === 'stale' ? one.rotation === 'overdue' || one.rotation === 'due' : one.rotation === wanted))
        .sort((a, b) => (URGENCY[a.rotation] ?? 9) - (URGENCY[b.rotation] ?? 9)
          || String(a.name).localeCompare(String(b.name)));

      const byEnvironment: Record<string, number> = { none: 0 };
      for (const name of Object.values(environments)) byEnvironment[name] = 0;
      for (const one of view) byEnvironment[one.environment ?? 'none'] += 1;

      return {
        total: view.length,
        overdue: view.filter((one) => one.rotation === 'overdue').length,
        due: view.filter((one) => one.rotation === 'due').length,
        by_environment: byEnvironment,
        secrets: view,
      };
    },
  },
];

/** A date a model can read. The millisecond it was is not the question here. */
const iso = (at: unknown): string | null => (Number(at) ? new Date(Number(at)).toISOString() : null);
