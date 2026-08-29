/**
 * Vendors, what runs where, and the moves between one landscape and the next.
 */
import { annualCost, type Budget, compareLandscapes, type Component, COMPONENT_KINDS, COST_RECURRENCES, costOfLandscape, ENVIRONMENTS, formatMoney, landscapeOn, LIFECYCLES, livenessOn, type Move, MOVE_STATUS, moveProgress, noticeBy, noticeDue, orderKey, type Vendor } from '@kolibri/shared';
import { all, type Row } from '../../../db/index.ts';
import { canSeeProject, read, serialize, writeEntity } from '../../repo.ts';
import { uid } from '../../ids.ts';
import { brief, componentsOf, componentView, costView, ensureVendor, findBudget, findComponent, findProject, findVendor, isoDay, lastComponentOrder, McpError, moneyList, requireFeature, requireMoney, requireWrite, str, type ToolDef, vendorsOf, workspaceOf, writeOpts } from '../kit.ts';

export const infrastructureTools: ToolDef[] = [
  {
    name: 'list_components',
    title: 'List the estate',
    description:
      'Servers, instances, SaaS subscriptions and the rest, with what each costs and whether it '
      + 'is running on a given day. Nesting is reported through `parent`, so an instance says '
      + 'which machine it is on.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        on: { type: 'string', description: 'YYYY-MM-DD; only what is running that day' },
        kind: { type: 'string', enum: [...COMPONENT_KINDS] },
        environment: { type: 'string', enum: [...ENVIRONMENTS] },
        status: { type: 'string', enum: [...LIFECYCLES] },
        vendor: { type: 'string', description: 'Vendor name' },
        project: { type: 'string', description: 'Components a project depends on' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'infrastructure');
      const vendors = vendorsOf(workspaceId);
      const vendorId = args.vendor ? String(findVendor(String(args.vendor), workspaceId).id) : null;
      const projectId = args.project ? String(findProject(String(args.project), workspaceId, ctx).id) : null;
      const on = isoDay(args.on, 'on') ?? undefined;

      let rows = componentsOf(workspaceId);
      if (on) rows = landscapeOn(rows, on);
      if (args.kind) rows = rows.filter((row) => row.kind === args.kind);
      if (args.environment) rows = rows.filter((row) => row.environment === args.environment);
      if (args.status) rows = rows.filter((row) => row.status === args.status);
      if (vendorId) rows = rows.filter((row) => row.vendor_id === vendorId);
      if (projectId) rows = rows.filter((row) => (row.projects ?? []).includes(projectId));

      return {
        components: rows.map((row) => componentView(row, vendors, on)),
        total: rows.length,
        ...costView(costOfLandscape(rows)),
      };
    },
  },
  {
    name: 'landscape',
    title: 'Current against future',
    description:
      'What the estate looks like on one day against another: what is gone by then, what has '
      + 'arrived, what is untouched, and what the difference costs a year. Leave `to` out to '
      + 'describe today alone. Components somebody planned without a date are in neither answer '
      + 'and are listed separately — they are in no landscape at all until they have a date.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD; defaults to today' },
        to: { type: 'string', description: 'YYYY-MM-DD; the future to compare against' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'infrastructure');
      const vendors = vendorsOf(workspaceId);
      const components = componentsOf(workspaceId);
      const from = isoDay(args.from, 'from') ?? new Date().toISOString().slice(0, 10);
      const to = isoDay(args.to, 'to') ?? from;
      const diff = compareLandscapes(components, from, to);
      const brief = (rows: Component[]) => rows.map((row) => componentView(row, vendors, to));

      return {
        from,
        to,
        now: { ...costView(diff.costFrom), components: diff.costFrom.components },
        then: { ...costView(diff.costTo), components: diff.costTo.components },
        /* The number the meeting turns on. Negative is cheaper, and it is the
           yearly figure rather than a monthly one because a year is exact:
           dividing a yearly contract into twelve does not come back to itself. */
        annual_delta: moneyList(diff.annualDelta),
        leaving: brief(diff.leaving),
        arriving: brief(diff.arriving),
        staying: diff.staying.length,
        undated: brief(diff.undated),
      };
    },
  },
  {
    name: 'record_component',
    title: 'Record something in the estate',
    description:
      'Add a server, an instance, a subscription. `parent` puts it on a machine or in an '
      + 'account. `live_from` and `live_until` are what decide which landscape it appears in — '
      + 'a planned component without a `live_from` is in none of them, which is reported rather '
      + 'than hidden. `line` charges it to a budget line so the two figures can be reconciled.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: [...COMPONENT_KINDS] },
        environment: { type: 'string', enum: [...ENVIRONMENTS] },
        status: { type: 'string', enum: [...LIFECYCLES] },
        vendor: { type: 'string', description: 'Vendor name; created if it is new' },
        parent: { type: 'string', description: 'Component id or name this runs on' },
        live_from: { type: 'string', description: 'YYYY-MM-DD' },
        live_until: { type: 'string', description: 'YYYY-MM-DD' },
        amount: { type: 'string', description: 'Per occurrence, e.g. "1200"' },
        recurrence: { type: 'string', enum: [...COST_RECURRENCES] },
        currency: { type: 'string' },
        location: { type: 'string', description: 'Region, data centre, rack' },
        reference: { type: 'string', description: 'Hostname, account, ARN' },
        budget: { type: 'string', description: 'Budget holding the line below' },
        line: { type: 'string', description: 'Plan line this is charged to' },
        projects: { type: 'array', items: { type: 'string' }, description: 'Projects that depend on it' },
        note: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'infrastructure');

      const parent = args.parent ? findComponent(String(args.parent), workspaceId) : null;
      // A vendor named but not known is made rather than refused: an assistant
      // writing down an estate should not have to create the supplier first,
      // and a register with the name spelled once is better than one with a
      // component nobody could file.
      const vendorId = args.vendor ? String(ensureVendor(String(args.vendor), workspaceId, ctx).id) : null;

      let lineId: string | null = null;
      if (args.line) {
        requireFeature(workspaceId, 'budget');
        const budget = args.budget ? findBudget(String(args.budget), workspaceId, ctx) : null;
        const wanted = String(args.line).toLowerCase();
        const line = all<Row>(
          budget
            ? `SELECT * FROM budget_lines WHERE budget_id = ? AND deleted_at IS NULL`
            : `SELECT * FROM budget_lines WHERE workspace_id = ? AND deleted_at IS NULL`,
          budget ? budget.id : workspaceId,
        ).find((row) => row.id === args.line || String(row.name).toLowerCase() === wanted);
        if (!line) throw new McpError(`No budget line called "${args.line}"`);
        lineId = String(line.id);
      }

      const { row } = writeEntity('component', uid(), {
        workspace_id: workspaceId,
        vendor_id: vendorId,
        parent_id: parent?.id ?? null,
        name: String(args.name).trim(),
        kind: args.kind ?? 'server',
        environment: args.environment ?? 'production',
        status: args.status ?? 'live',
        live_from: isoDay(args.live_from, 'live_from'),
        live_until: isoDay(args.live_until, 'live_until'),
        location: str(args.location) ?? null,
        reference: str(args.reference) ?? null,
        amount: args.amount === undefined ? 0 : requireMoney(args.amount, 'amount'),
        recurrence: args.recurrence ?? 'monthly',
        currency: String(args.currency ?? 'EUR').trim().toUpperCase(),
        line_id: lineId,
        projects: JSON.stringify(Array.isArray(args.projects)
          ? args.projects.map((ref: string) => String(findProject(String(ref), workspaceId, ctx).id))
          : []),
        note: str(args.note) ?? null,
        sort_order: orderKey(lastComponentOrder(workspaceId), null),
      }, writeOpts(workspaceId, ctx));

      const stored = serialize('component', row) as unknown as Component;
      const yearly = annualCost(stored);
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        parent: parent?.name ?? null,
        annual_cost: yearly === null ? null : formatMoney(yearly, stored.currency, 'en'),
        // Said back rather than left to be discovered: a planned component with
        // no start date appears in no landscape, and the caller has just made
        // one if they left the date out.
        in_a_landscape: livenessOn(stored, new Date().toISOString().slice(0, 10)) !== 'undated',
      };
    },
  },
  {
    name: 'plan_move',
    title: 'Document a move',
    description:
      'Write down a step from one landscape to the next: what it retires and what it brings in. '
      + 'Progress is read back from the register rather than from the status, so a move claimed '
      + 'done while a server is still running is reported as disagreeing.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: [...MOVE_STATUS] },
        leaving: { type: 'array', items: { type: 'string' }, description: 'Components it retires' },
        arriving: { type: 'array', items: { type: 'string' }, description: 'Components it brings in' },
        target_date: { type: 'string', description: 'YYYY-MM-DD' },
        project: { type: 'string', description: 'Project doing the work' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'infrastructure');
      const refs = (list: unknown): string[] => (Array.isArray(list) ? list : [])
        .map((ref: string) => String(findComponent(String(ref), workspaceId).id));

      const { row } = writeEntity('move', uid(), {
        workspace_id: workspaceId,
        name: String(args.name).trim(),
        description: str(args.description) ?? null,
        status: args.status ?? 'proposed',
        leaving: JSON.stringify(refs(args.leaving)),
        arriving: JSON.stringify(refs(args.arriving)),
        target_date: isoDay(args.target_date, 'target_date'),
        project_id: args.project ? String(findProject(String(args.project), workspaceId, ctx).id) : null,
        sort_order: 'V',
      }, writeOpts(workspaceId, ctx));

      const stored = serialize('move', row) as unknown as Move;
      const progress = moveProgress(stored, componentsOf(workspaceId), new Date().toISOString().slice(0, 10));
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        retiring: progress.retiring,
        bringing_in: progress.arriving,
        done_share: progress.done,
      };
    },
  },
  {
    name: 'list_moves',
    title: 'The way to the future landscape',
    description:
      'Every documented step, with how far the register says each has actually got — which is '
      + 'not the same as its status. A move marked done with something it named still running '
      + 'comes back flagged.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...MOVE_STATUS] },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'infrastructure');
      const components = componentsOf(workspaceId);
      const byId = new Map(components.map((row) => [row.id, row.name]));
      const day = new Date().toISOString().slice(0, 10);

      const rows = all<Row>(
        `SELECT * FROM moves WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY target_date`,
        workspaceId,
      )
        .map((row) => serialize('move', row) as unknown as Move)
        .filter((row) => (args.status ? row.status === args.status : true))
        .filter((row) => canSeeProject(ctx.auth.userId, row.project_id));

      return {
        moves: rows.map((move) => {
          const progress = moveProgress(move, components, day);
          return {
            id: move.id,
            name: move.name,
            status: move.status,
            target_date: move.target_date,
            leaving: move.leaving.map((id) => byId.get(id) ?? id),
            arriving: move.arriving.map((id) => byId.get(id) ?? id),
            done_share: progress.done === null ? null : Math.round(progress.done * 100) / 100,
            /* The register against the claim. Worth returning even when false,
               so a caller can say "and all of them agree" rather than having to
               infer it from an absence. */
            disagrees_with_the_register: progress.disagrees,
          };
        }),
        total: rows.length,
      };
    },
  },
  {
    name: 'list_vendors',
    title: 'List vendors',
    description:
      'Who you buy from, what each supplies, and when the contract has to be given notice on — '
      + 'which is the end date minus the notice period, and the date a renewal actually surprises '
      + 'somebody.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        notice_within_days: { type: 'number', description: 'Only contracts due for notice this soon' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'infrastructure');
      const day = new Date().toISOString().slice(0, 10);
      const components = componentsOf(workspaceId);
      const vendors = vendorsOf(workspaceId).filter((row) => !row.archived);

      const soon = Number(args.notice_within_days) > 0
        ? new Set(noticeDue(vendors, day, Number(args.notice_within_days)).map((row) => row.vendor.id))
        : null;

      const rows = vendors.filter((vendor) => (soon ? soon.has(vendor.id) : true));
      return {
        vendors: rows.map((vendor) => {
          const theirs = components.filter((component) => component.vendor_id === vendor.id);
          return {
            id: vendor.id,
            name: vendor.name,
            kind: vendor.kind,
            components: theirs.length,
            ...costView(costOfLandscape(landscapeOn(theirs, day))),
            contract_end: vendor.contract_end,
            notice_by: noticeBy(vendor),
          };
        }),
        total: rows.length,
      };
    },
  },

  /* ------------------------------------------------------------- reports --
   *
   * Six read-only questions that were answerable before only by pulling the
   * backlog and doing the arithmetic in the model. Each is one query the
   * database is better at, and each returns a *reason* rather than a bare
   * list — "overdue" is a fact anybody can compute, "due Thursday, still in
   * Backlog, nobody on it" is the sentence somebody acts on.
   */

];
