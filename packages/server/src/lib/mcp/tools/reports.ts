/**
 * The six questions a lead asks on a Monday, each answered with a reason rather than a list.
 */
import { isDoneGroup, riskOf } from '@kolibri/shared';
import { all, get, type Row } from '../../../db/index.ts';
import { visibleProjectIds } from '../../repo.ts';
import { assigneeNames, brief, findProject, holes, McpError, namesOf, perProject, reportScope, safeList, str, taskView, type ToolDef, windowDays, workspaceOf } from '../kit.ts';

export const reportTools: ToolDef[] = [
  {
    name: 'project_status',
    title: 'Project status report',
    description: 'A digest for standups and reports: counts by state group and priority, overdue items, recent activity and the active cycle.',
    readOnly: true,
    schema: { type: 'object', required: ['project'], properties: { project: { type: 'string' }, workspace_id: { type: 'string' } } },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      const project = findProject(String(args.project), workspaceId, ctx);
      const byGroup = all<Row>(
        `SELECT s.group_key, count(*) AS count FROM tasks t JOIN states s ON s.id = t.state_id
          WHERE t.project_id = ? AND t.deleted_at IS NULL AND t.archived = 0 GROUP BY s.group_key`,
        project.id,
      );
      const byPriority = all<Row>(
        `SELECT priority, count(*) AS count FROM tasks
          WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 GROUP BY priority`,
        project.id,
      );
      return {
        project: { id: project.id, key: project.key, name: project.name, status: project.status, target_date: project.target_date },
        by_state_group: Object.fromEntries(byGroup.map((r) => [r.group_key, Number(r.count)])),
        by_priority: Object.fromEntries(byPriority.map((r) => [r.priority, Number(r.count)])),
        overdue: all<Row>(
          `SELECT t.* FROM tasks t JOIN states s ON s.id = t.state_id
            WHERE t.project_id = ? AND t.deleted_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < date('now')
              AND s.group_key NOT IN ('completed','cancelled') ORDER BY t.due_date LIMIT 25`,
          project.id,
        ).map(taskView),
        unassigned: Number(get<Row>(
          `SELECT count(*) c FROM tasks WHERE project_id = ? AND deleted_at IS NULL AND archived = 0 AND assignees = '[]'`,
          project.id,
        )?.c ?? 0),
        active_cycle: get<Row>(
          `SELECT id, name, start_date, end_date FROM cycles
            WHERE project_id = ? AND deleted_at IS NULL AND start_date <= date('now') AND end_date >= date('now') LIMIT 1`,
          project.id,
        ) ?? null,
        recent_activity: all<Row>(
          `SELECT a.verb, a.field, a.new_value, a.created_at, u.name AS actor FROM activities a
            LEFT JOIN users u ON u.id = a.actor_id
            WHERE a.project_id = ? ORDER BY a.created_at DESC LIMIT 20`,
          project.id,
        ),
      };
    },
  },
  {
    name: 'changes_since',
    title: 'What changed',
    description:
      'Everything that happened in a window — the last seven days unless told otherwise — grouped by person, by kind of change, and by task. The answer to "what did we get done last week".',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How far back to look. Default 7, clamped to 1–365.' },
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { workspaceId, projectIds, project, keyOf } = reportScope(args, ctx);
      const days = windowDays(args.days, 7);
      const since = Date.now() - days * 86_400_000;
      const empty = {
        window_days: days,
        since: new Date(since).toISOString(),
        scope: project ? 'project' : 'workspace',
        project: project?.key ?? null,
        projects: Object.values(keyOf).sort(),
      };
      if (!projectIds.length) {
        return { ...empty, total: 0, by_person: {}, by_kind: {}, by_project: {}, completed: [], created: [], busiest_tasks: [] };
      }

      /* Activity with no project is workspace-level — a page outside any
         project, most often — and belongs in a workspace-wide answer and not
         in a project's. */
      const scope = project
        ? { clause: `a.project_id IN (${holes(projectIds.length)})`, params: projectIds }
        : { clause: `(a.project_id IN (${holes(projectIds.length)}) OR a.project_id IS NULL)`, params: projectIds };

      const rows = all<Row>(
        `SELECT a.verb, a.field, a.actor_id, a.task_id, a.created_at
           FROM activities a
          WHERE a.workspace_id = ? AND a.created_at >= ? AND ${scope.clause}
          ORDER BY a.created_at DESC
          LIMIT 5000`,
        workspaceId, since, ...scope.params,
      );

      const tally = (key: (r: Row) => string) => {
        const out: Record<string, number> = {};
        for (const row of rows) {
          const k = key(row);
          if (k) out[k] = (out[k] ?? 0) + 1;
        }
        return out;
      };
      const names = namesOf(rows.map((r) => String(r.actor_id ?? '')));
      const byPerson: Record<string, number> = {};
      for (const [id, count] of Object.entries(tally((r) => String(r.actor_id ?? '')))) {
        byPerson[names[id] ?? 'somebody who has since been removed'] = count;
      }

      // The tasks that moved most — where an assistant should look first.
      const touches = tally((r) => String(r.task_id ?? ''));
      const busiest = Object.entries(touches)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, count]) => {
          const task = get<Row>(`SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL`, id);
          return task ? { ...brief(task, names, keyOf), changes: count } : null;
        })
        .filter(Boolean);

      /* Finished and filed come from the tasks themselves rather than from the
         activity log: a task completed offline syncs with the timestamp of the
         moment it was completed, and counting log rows would date it to when
         the connection came back. */
      const inScope = `project_id IN (${holes(projectIds.length)})`;
      const completed = all<Row>(
        `SELECT * FROM tasks WHERE ${inScope} AND deleted_at IS NULL
           AND completed_at IS NOT NULL AND completed_at >= ?
         ORDER BY completed_at DESC LIMIT 50`,
        ...projectIds, since,
      );
      const created = all<Row>(
        `SELECT * FROM tasks WHERE ${inScope} AND deleted_at IS NULL AND created_at >= ?
         ORDER BY created_at DESC LIMIT 50`,
        ...projectIds, since,
      );
      const taskNames = assigneeNames([...completed, ...created]);
      return {
        ...empty,
        total: rows.length,
        truncated: rows.length === 5000,
        by_person: byPerson,
        by_kind: tally((r) => (r.field ? `${r.verb}:${r.field}` : String(r.verb))),
        by_project: {
          completed: perProject(completed, keyOf, (r) => String(r.project_id)),
          created: perProject(created, keyOf, (r) => String(r.project_id)),
        },
        completed: completed.map((row) => brief(row, taskNames, keyOf)),
        created: created.map((row) => brief(row, taskNames, keyOf)),
        busiest_tasks: busiest,
      };
    },
  },

  {
    name: 'deadlines_at_risk',
    title: 'Deadlines at risk',
    description:
      'Dated work that is unlikely to land, each with the reason: already overdue, waiting on an unfinished blocker, due soon and not started, or due soon with nobody on it. Sorted worst first.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How far ahead to look. Default 14, clamped to 1–365.' },
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { projectIds, project, keyOf } = reportScope(args, ctx);
      const days = windowDays(args.days, 14);
      const head = {
        horizon_days: days,
        scope: project ? 'project' : 'workspace',
        project: project?.key ?? null,
        projects: Object.values(keyOf).sort(),
      };
      if (!projectIds.length) return { ...head, counts: {}, by_project: {}, at_risk: [] };

      /* Open, dated, and either already past or inside the horizon. `archived`
         is excluded because an archived task is one somebody has decided about;
         its date is a record, not a promise. */
      const rows = all<Row>(
        `SELECT t.*, s.name AS state_name, s.group_key
           FROM tasks t JOIN states s ON s.id = t.state_id
          WHERE t.project_id IN (${holes(projectIds.length)})
            AND t.deleted_at IS NULL AND t.archived = 0
            AND s.group_key NOT IN ('completed', 'cancelled')
            AND t.due_date IS NOT NULL
            AND t.due_date <= date('now', '+' || ? || ' days')
          ORDER BY t.due_date`,
        ...projectIds, days,
      );
      if (!rows.length) return { ...head, counts: {}, by_project: {}, at_risk: [] };

      /* Unfinished blockers, in one query rather than one per task. A `blocks`
         row is stored in one direction only — `task_id` blocks
         `related_task_id` — so the waiting task is the *related* one. */
      const ids = rows.map((r) => String(r.id));
      const blockers = all<Row>(
        `SELECT r.related_task_id AS waiting, b.identifier, b.title, s.name AS state_name
           FROM task_relations r
           JOIN tasks b ON b.id = r.task_id
           JOIN states s ON s.id = b.state_id
          WHERE r.kind = 'blocks' AND r.deleted_at IS NULL
            AND b.deleted_at IS NULL AND s.group_key NOT IN ('completed', 'cancelled')
            AND r.related_task_id IN (${holes(ids.length)})`,
        ...ids,
      );
      const blocking = new Map<string, { identifier: string; title: string; state: string }[]>();
      for (const row of blockers) {
        const list = blocking.get(String(row.waiting)) ?? [];
        list.push({ identifier: String(row.identifier), title: String(row.title), state: String(row.state_name) });
        blocking.set(String(row.waiting), list);
      }

      const today = new Date().toISOString().slice(0, 10);
      const names = assigneeNames(rows);
      /* The reasons and the weighting are `riskOf` in `@kolibri/shared`, so the
         answer here and the one the interface paints on a due date come from
         one rule. The query above has already excluded finished and archived
         work; `riskOf` excludes it again, because a predicate that trusts its
         caller to have filtered is a predicate with two definitions. */
      const at_risk = rows.map((row) => {
        const blocked = blocking.get(String(row.id)) ?? [];
        const risk = riskOf({
          due_date: String(row.due_date),
          group_key: String(row.group_key),
          assignees: safeList(row.assignees),
          blockedBy: blocked.length,
          archived: !!Number(row.archived ?? 0),
        }, today);

        return {
          ...brief(row, names, keyOf),
          project_id: String(row.project_id),
          days_until_due: risk.daysUntilDue,
          reasons: risk.reasons,
          blocked_by: blocked,
          severity: risk.severity,
        };
      })
        .filter((t) => t.reasons.length)
        .sort((a, b) => b.severity - a.severity);

      const counts: Record<string, number> = {};
      for (const task of at_risk) for (const reason of task.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
      return {
        ...head,
        counts,
        by_project: perProject(at_risk, keyOf, (t) => t.project_id),
        // `project_id` was carried only to group by; the key is what a caller
        // reads, and it is already on every row.
        at_risk: at_risk.map(({ project_id, ...rest }) => rest),
      };
    },
  },

  {
    name: 'workload',
    title: 'Who is carrying what',
    description:
      'Open work per person: how many tasks, how many overdue, how much is due this week, and the points they add up to. Unassigned work is counted separately rather than hidden.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { workspaceId, projectIds, project, keyOf } = reportScope(args, ctx);
      const head = {
        scope: project ? 'project' : 'workspace',
        project: project?.key ?? null,
        projects: Object.values(keyOf).sort(),
      };
      if (!projectIds.length) return { ...head, people: [], unassigned: null, by_project: {} };

      const rows = all<Row>(
        `SELECT t.*, s.name AS state_name FROM tasks t JOIN states s ON s.id = t.state_id
          WHERE t.project_id IN (${holes(projectIds.length)})
            AND t.deleted_at IS NULL AND t.archived = 0
            AND s.group_key NOT IN ('completed', 'cancelled')`,
        ...projectIds,
      );

      const today = new Date().toISOString().slice(0, 10);
      const weekEnd = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const names = assigneeNames(rows);
      const blank = () => ({
        open: 0, overdue: 0, due_this_week: 0, unestimated: 0, points: 0,
        // Which projects this person's open work is spread across. Somebody
        // with eight tasks in one project and somebody with eight across five
        // are carrying different weeks, and the count alone says they are not.
        by_project: {} as Record<string, number>,
        most_urgent: null as any,
      });
      const buckets = new Map<string, ReturnType<typeof blank>>();
      const unassigned = blank();

      for (const row of rows) {
        const due = row.due_date ? String(row.due_date) : null;
        const assignees = safeList(row.assignees);
        // A task with two people on it counts for both, the way the app's own
        // per-person chart does. The totals therefore exceed the task count,
        // which is the honest answer to "how much is on you".
        for (const target of assignees.length ? assignees.map((id) => {
          if (!buckets.has(id)) buckets.set(id, blank());
          return buckets.get(id)!;
        }) : [unassigned]) {
          target.open += 1;
          const key = keyOf[String(row.project_id)];
          if (key) target.by_project[key] = (target.by_project[key] ?? 0) + 1;
          if (due && due < today) target.overdue += 1;
          if (due && due >= today && due <= weekEnd) target.due_this_week += 1;
          if (row.estimate == null) target.unestimated += 1;
          else target.points += Number(row.estimate);
          const current = target.most_urgent;
          if (due && (!current?.due_date || due < current.due_date)) target.most_urgent = brief(row, names, keyOf);
        }
      }

      const people = namesOf([...buckets.keys()]);
      const members = new Set(
        all<Row>(`SELECT user_id FROM workspace_members WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
          .map((r) => String(r.user_id)),
      );
      return {
        ...head,
        by_project: perProject(rows, keyOf, (r) => String(r.project_id)),
        people: [...buckets.entries()]
          .map(([id, stats]) => ({
            user_id: id,
            name: people[id] ?? id,
            // Work still assigned to somebody who has left the workspace is
            // work nobody is doing, and it looks assigned on every board.
            still_a_member: members.has(id),
            ...stats,
          }))
          .sort((a, b) => b.open - a.open),
        unassigned,
      };
    },
  },

  {
    name: 'blocked_tasks',
    title: 'What is waiting on what',
    description:
      'Open work held up by an unfinished blocker, and — separately — links whose blocker is already finished, which are the ones nobody remembers to remove.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { projectIds, project, keyOf } = reportScope(args, ctx);
      const head = {
        scope: project ? 'project' : 'workspace',
        project: project?.key ?? null,
        projects: Object.values(keyOf).sort(),
      };
      if (!projectIds.length) return { ...head, by_project: {}, blocked: [], stale_links: [] };

      /* Both sides in one query. `w` is the task that waits — a `blocks` row
         reads `task_id` blocks `related_task_id` — and the join to the blocker
         is deliberately not filtered by project: work is routinely held up by
         a task in another project, and dropping those would report the waiting
         task as unblocked. */
      const rows = all<Row>(
        `SELECT w.id AS waiting_id, w.identifier AS waiting, w.title AS waiting_title,
                w.due_date, w.priority, w.assignees, w.estimate, w.state_id, w.project_id,
                ws.name AS waiting_state,
                b.identifier AS blocker, b.title AS blocker_title, b.due_date AS blocker_due,
                b.project_id AS blocker_project, bs.name AS blocker_state, bs.group_key AS blocker_group, r.lag
           FROM task_relations r
           JOIN tasks w ON w.id = r.related_task_id
           JOIN tasks b ON b.id = r.task_id
           JOIN states ws ON ws.id = w.state_id
           JOIN states bs ON bs.id = b.state_id
          WHERE r.kind = 'blocks' AND r.deleted_at IS NULL
            AND w.deleted_at IS NULL AND b.deleted_at IS NULL AND w.archived = 0
            AND ws.group_key NOT IN ('completed', 'cancelled')
            AND w.project_id IN (${holes(projectIds.length)})
          ORDER BY w.due_date IS NULL, w.due_date`,
        ...projectIds,
      );

      const names = assigneeNames(rows);
      const blocked = new Map<string, any>();
      const stale: any[] = [];
      for (const row of rows) {
        const link = {
          identifier: String(row.blocker),
          title: String(row.blocker_title),
          state: String(row.blocker_state),
          due_date: row.blocker_due ?? null,
          lag_days: Number(row.lag ?? 0),
          /* Named even when it is a project this token cannot otherwise read.
             Work is routinely held up by a task in another project, and a
             blocker reported as belonging to nothing is a blocker nobody can
             go and ask about — the identifier is already visible either way,
             because it is what the waiting task points at. */
          project: keyOf[String(row.blocker_project ?? '')] ?? null,
          in_another_project: String(row.blocker_project) !== String(row.project_id),
        };
        const done = isDoneGroup(String(row.blocker_group ?? ''));
        if (done) {
          stale.push({ waiting: String(row.waiting), blocker: link });
          continue;
        }
        const entry = blocked.get(String(row.waiting_id)) ?? {
          ...brief(
            { ...row, id: row.waiting_id, identifier: row.waiting, title: row.waiting_title, state_name: row.waiting_state },
            names, keyOf,
          ),
          project_id: String(row.project_id),
          blocked_by: [] as typeof link[],
        };
        entry.blocked_by.push(link);
        blocked.set(String(row.waiting_id), entry);
      }

      const waiting = [...blocked.values()];
      return {
        ...head,
        by_project: perProject(waiting, keyOf, (t) => t.project_id),
        blocked: waiting.map(({ project_id, ...rest }) => rest),
        // Not an error, and not something to fix automatically — somebody may
        // be about to reopen the blocker. It is a list worth reading.
        stale_links: stale,
      };
    },
  },

  {
    name: 'stale_tasks',
    title: 'Work that has stopped moving',
    description:
      'Tasks sitting in an in-progress state that nothing has touched for a while. The usual causes are work that finished without being marked and work that quietly stopped.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How quiet counts as stale. Default 14, clamped to 1–365.' },
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { projectIds, project, keyOf } = reportScope(args, ctx);
      const days = windowDays(args.days, 14);
      const head = {
        quiet_for_days: days,
        scope: project ? 'project' : 'workspace',
        project: project?.key ?? null,
        projects: Object.values(keyOf).sort(),
      };
      if (!projectIds.length) return { ...head, by_project: {}, stale: [] };

      const cutoff = Date.now() - days * 86_400_000;
      const rows = all<Row>(
        `SELECT t.*, s.name AS state_name FROM tasks t JOIN states s ON s.id = t.state_id
          WHERE t.project_id IN (${holes(projectIds.length)})
            AND t.deleted_at IS NULL AND t.archived = 0
            AND s.group_key = 'started'
            AND t.updated_at < ?
          ORDER BY t.updated_at
          LIMIT 100`,
        ...projectIds, cutoff,
      );
      const now = Date.now();
      const names = assigneeNames(rows);
      return {
        ...head,
        by_project: perProject(rows, keyOf, (r) => String(r.project_id)),
        stale: rows.map((row) => ({
          ...brief(row, names, keyOf),
          // `updated_at` is when the change was *made*, not when it synced, so
          // this stays true for work done on a device that was offline.
          silent_days: Math.floor((now - Number(row.updated_at)) / 86_400_000),
        })),
      };
    },
  },

  {
    name: 'cycle_review',
    title: 'How a cycle went',
    description:
      'What a cycle held, what got finished, what did not, and what was added after it started. Given a project it reviews that project\'s cycle; without one it reviews every cycle running across the workspace and totals them. Retro material rather than a progress bar.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Key or name. Omitted, every project with a cycle running.' },
        cycle: { type: 'string', description: 'Cycle name or id. Default the one running now. A name matches across projects.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { workspaceId, projectIds, project, keyOf } = reportScope(args, ctx);
      const ref = str(args.cycle);
      const head = {
        scope: project ? 'project' : 'workspace',
        project: project?.key ?? null,
        projects: Object.values(keyOf).sort(),
      };
      if (!projectIds.length) return { ...head, cycles: [], totals: null };

      /* Which cycles a review covers, in the three shapes a cycle comes in:
         one project's own, one a named set of projects runs together, and one
         the whole workspace shares. The last two belong in a project's review
         as much as in the workspace's, because that project's work is in them.

         `coversProject` says the same thing in TypeScript for the client. This
         is the half SQLite has to answer, so a workspace with a long history
         does not send every cycle it has ever run to be filtered in memory. */
      const inScope = `(
        (json_array_length(projects) = 0 AND (project_id IS NULL OR project_id IN (${holes(projectIds.length)})))
        OR EXISTS (SELECT 1 FROM json_each(projects) WHERE json_each.value IN (${holes(projectIds.length)}))
      )`;
      const cycles = ref
        ? all<Row>(
            `SELECT * FROM cycles WHERE workspace_id = ? AND ${inScope} AND deleted_at IS NULL
               AND (id = ? OR lower(name) = lower(?))
             ORDER BY start_date`,
            workspaceId, ...projectIds, ...projectIds, ref, ref,
          )
        : all<Row>(
            `SELECT * FROM cycles WHERE workspace_id = ? AND ${inScope} AND deleted_at IS NULL
               AND start_date <= date('now') AND end_date >= date('now')
             ORDER BY start_date`,
            workspaceId, ...projectIds, ...projectIds,
          );

      if (!cycles.length) {
        /* A project asked for by name that has no cycle is an error, because
           the caller named something specific and got nothing. A workspace
           with no cycle running anywhere is an ordinary Tuesday, and answering
           with an empty list is the truthful reply. */
        if (project) {
          throw new McpError(
            ref ? `No cycle called "${ref}" in ${project.key}` : `No cycle is running in ${project.key} right now`,
          );
        }
        return { ...head, cycles: [], totals: { cycles: 0, tasks: 0, completed: 0, cancelled: 0, carried: 0, points_planned: 0, points_completed: 0, unestimated: 0 } };
      }

      const today = new Date().toISOString().slice(0, 10);
      const points = (list: Row[]) => list.reduce((sum, r) => sum + (r.estimate == null ? 0 : Number(r.estimate)), 0);

      /* The keys of the projects a *cycle covers*, which is a wider question
         than the projects in scope: asked about WEB, "who else is in this
         fortnight" is worth an answer, and `keyOf` only knows WEB.

         Resolved against everything this token can see, and a covered project
         it cannot see is left out rather than reported as a bare id — an id is
         no use to the caller and disclosing one is the same leak the rest of
         these tools take care not to make. */
      const coverIds = [...visibleProjectIds(ctx.auth.userId, workspaceId)];
      const coverKeyOf: Record<string, string> = coverIds.length
        ? Object.fromEntries(
            all<Row>(`SELECT id, key FROM projects WHERE id IN (${holes(coverIds.length)})`, ...coverIds)
              .map((r) => [String(r.id), String(r.key)]),
          )
        : {};

      const reviews = cycles.map((cycle) => {
        /* Narrowed to the projects in scope even for a workspace cycle. Asked
           about WEB, "how did the shared fortnight go" means WEB's half of it;
           asked about the workspace it means all of it. The same query answers
           both because the scope is already resolved. */
        const rows = all<Row>(
          `SELECT t.*, s.name AS state_name, s.group_key FROM tasks t JOIN states s ON s.id = t.state_id
            WHERE t.cycle_id = ? AND t.deleted_at IS NULL
              AND t.project_id IN (${holes(projectIds.length)})`,
          cycle.id, ...projectIds,
        );
        const done = rows.filter((r) => r.group_key === 'completed');
        const cancelled = rows.filter((r) => r.group_key === 'cancelled');
        const open = rows.filter((r) => r.group_key !== 'completed' && r.group_key !== 'cancelled');
        const names = assigneeNames(rows);

        /* Scope added after the window opened. A cycle that grew mid-flight is
           the single most useful thing a retro can be handed, and it is
           invisible on a burn-down — which is why the app draws a burn-*up*. */
        const startedAt = Date.parse(`${String(cycle.start_date)}T00:00:00Z`);
        const addedLate = rows.filter((r) => Number(r.created_at) > startedAt);

        const listed = safeList(cycle.projects);
        return {
          project: cycle.project_id ? keyOf[String(cycle.project_id)] ?? null : null,
          cycle_scope: cycle.project_id ? 'project' : (listed.length ? 'projects' : 'workspace'),
          // The projects it is *for*, which is not the same as the ones that
          // put work in it — a project can be in a cycle and contribute
          // nothing, and that is worth being able to see.
          cycle_projects: listed.map((id) => coverKeyOf[id]).filter(Boolean).sort(),
          // Which projects actually put work in it. For a workspace cycle this
          // is the answer to "who is in this fortnight", which its own row
          // cannot say.
          projects_involved: [...new Set(rows.map((r) => keyOf[String(r.project_id)]).filter(Boolean))].sort(),
          cycle: { id: cycle.id, name: cycle.name, start_date: cycle.start_date, end_date: cycle.end_date },
          finished: cycle.end_date ? String(cycle.end_date) < today : false,
          totals: {
            tasks: rows.length,
            completed: done.length,
            cancelled: cancelled.length,
            carried: open.length,
            points_planned: points(rows),
            points_completed: points(done),
            unestimated: rows.filter((r) => r.estimate == null).length,
          },
          completed: done.map((row) => brief(row, names, keyOf)),
          // What has to go somewhere before the cycle closes.
          carried_over: open.map((row) => brief(row, names, keyOf)),
          cancelled: cancelled.map((row) => brief(row, names, keyOf)),
          added_after_start: addedLate.map((row) => ({
            ...brief(row, names, keyOf),
            added_on: new Date(Number(row.created_at)).toISOString().slice(0, 10),
          })),
        };
      });

      const sum = (pick: (t: (typeof reviews)[number]['totals']) => number) =>
        reviews.reduce((total, review) => total + pick(review.totals), 0);

      return {
        ...head,
        totals: {
          cycles: reviews.length,
          tasks: sum((t) => t.tasks),
          completed: sum((t) => t.completed),
          cancelled: sum((t) => t.cancelled),
          carried: sum((t) => t.carried),
          points_planned: sum((t) => t.points_planned),
          points_completed: sum((t) => t.points_completed),
          unestimated: sum((t) => t.unestimated),
        },
        cycles: reviews,
      };
    },
  },
  {
    name: 'prepare_meeting',
    title: 'Prepare a weekly meeting',
    description:
      'One agenda from all six reports, in the order a meeting runs: what shipped, what is at risk, what is blocked, what has stalled, how the cycles are going, and who is carrying what. Workspace-wide unless given a project.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Key or name. Omitted, the whole workspace.' },
        days: { type: 'number', description: 'How far back "since last time" reaches. Defaults to 7 — a week, because that is the meeting this is for.' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const { workspaceId, project, keyOf } = reportScope(args, ctx);
      const days = windowDays(args.days, 7);
      const scope = { project: args.project, workspace_id: workspaceId };
      /* The other reports' own `run`, by name — they are the six above this
         one in this file. Calling them rather than repeating their queries is
         the whole point: a report that changes changes here too, and a number
         in the agenda is the same number the tool gives. */
      const report = (name: string, extra: Record<string, unknown> = {}): any =>
        reportTools.find((tool) => tool.name === name)!.run({ ...scope, ...extra }, ctx);

      const changed = report('changes_since', { days });
      const risk = report('deadlines_at_risk');
      const blocked = report('blocked_tasks');
      const stalled = report('stale_tasks', { days });
      const load = report('workload');
      /* `cycle_review` refuses a project with no cycle running, because there
         the caller named something specific and got nothing. Here nobody named
         a cycle — the agenda asked for whatever is running — so no cycle is an
         ordinary week and an empty section is the honest answer, not an error
         that takes the other five sections down with it. */
      let cycles: any = { cycles: [], totals: null };
      try {
        cycles = report('cycle_review');
      } catch {
        cycles = { cycles: [], totals: null, note: 'No cycle is running in this scope right now.' };
      }

      return {
        scope: project ? 'project' : 'workspace',
        project: project?.key ?? null,
        projects: Object.values(keyOf).sort(),
        window_days: days,
        /* Read first and often read alone. Somebody skimming on the way to the
           room wants the four numbers that decide whether this is a short
           meeting, not six objects to count for themselves. */
        headline: {
          finished: Number(changed?.completed?.length ?? 0),
          filed: Number(changed?.created?.length ?? 0),
          at_risk: Number(risk?.at_risk?.length ?? 0),
          blocked: Number(blocked?.blocked?.length ?? 0),
          stalled: Number(stalled?.stale?.length ?? 0),
          // `workload.unassigned` is a bucket, not a count — `.open` is the
          // number. `Number()` on the object gave NaN, which JSON writes as
          // null, so the agenda reported "unassigned: null" and read as none.
          unassigned: Number(load?.unassigned?.open ?? 0),
          cycles_running: Number(cycles?.cycles?.length ?? 0),
        },
        agenda: [
          { heading: `What moved in the last ${days} days`, report: 'changes_since', detail: changed },
          { heading: 'Cycles in flight', report: 'cycle_review', detail: cycles },
          { heading: 'Deadlines at risk', report: 'deadlines_at_risk', detail: risk },
          { heading: 'Waiting on something', report: 'blocked_tasks', detail: blocked },
          { heading: 'Stopped moving', report: 'stale_tasks', detail: stalled },
          { heading: 'Who is carrying what', report: 'workload', detail: load },
        ],
      };
    },
  },
  /* ------------------------------------------------------- page templates
     Pages could be marked as templates since they were written, and nothing
     over MCP could see it: `list_pages` returned them mixed in with real pages
     and did not say which was which, so an assistant asked to "write up the
     notes from the template" could neither find one nor use it. */
];
