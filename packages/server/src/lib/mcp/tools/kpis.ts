/**
 * Numbers somebody has undertaken to watch, and what they have to reach.
 */
import { coversProject, dueOn, formatMeasure, type KpiTarget, MEASURE_CADENCES, MEASURE_DIRECTIONS, MEASURE_HEALTH, MEASURE_UNITS, orderKey, parseMeasure } from '@kolibri/shared';
import { all, type Row } from '../../../db/index.ts';
import { read, serialize, writeEntity } from '../../repo.ts';
import { uid } from '../../ids.ts';
import { asKpi, findKpi, findProject, isoDay, kpiContext, kpiReport, McpError, requireFeature, requireWrite, resolveScope, scopeOf, str, type ToolDef, visibleKpis, workspaceOf, writeOpts } from '../kit.ts';

export const kpiTools: ToolDef[] = [
  {
    name: 'list_kpis',
    title: 'List KPIs',
    description:
      'Every KPI in the workspace with where it stands, worst first. `health` is the answer: '
      + '"on_track" means it is past the straight line from its baseline to its target, not that '
      + 'it is near the target. The three that are not judgements matter more than they look — '
      + '"no_data" is nothing measured, "no_target" is nothing promised, and "stale" is a reading '
      + 'too old to stand for today. None of those is a KPI doing well, and a report that treats '
      + 'them as green is the thing this feature exists to prevent.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only KPIs covering this project, by key, id or name' },
        health: { type: 'string', enum: [...MEASURE_HEALTH], description: 'Only KPIs in this state' },
        as_of: { type: 'string', description: 'YYYY-MM-DD; answers as it stood then' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'kpi');
      const asOf = isoDay(args.as_of, 'as_of') ?? undefined;

      let rows = visibleKpis(workspaceId, ctx).filter((row) => !Number(row.archived));
      if (args.project) {
        const project = findProject(String(args.project), workspaceId, ctx);
        rows = rows.filter((row) => coversProject(scopeOf(row), String(project.id)));
      }
      const context = kpiContext(rows, workspaceId);
      const reports = rows.map((row) => kpiReport(row, workspaceId, asOf, context).summary);
      const wanted = args.health ? String(args.health) : null;
      const filtered = wanted ? reports.filter((row) => row.health === wanted) : reports;

      const rank = (health: string) => MEASURE_HEALTH.indexOf(health as never);
      return {
        kpis: filtered.sort((a, b) => rank(a.health) - rank(b.health) || String(a.name).localeCompare(String(b.name))),
        counts: MEASURE_HEALTH.reduce((out: Record<string, number>, health: string) => {
          const count = reports.filter((row) => row.health === health).length;
          if (count) out[health] = count;
          return out;
        }, {}),
      };
    },
  },
  {
    name: 'kpi_status',
    title: 'One KPI in full',
    description:
      'One KPI with its readings, its targets and where it stands. `achieved_pct` is how far it '
      + 'has come from its baseline toward the target and `expected_pct` is where a straight line '
      + 'says it should be by now — comparing those two is the judgement, and both are returned so '
      + 'the reasoning can be quoted rather than asserted. A target due by a milestone takes the '
      + "milestone's date, so a slipped release moves the deadline here too.",
    schema: {
      type: 'object',
      required: ['kpi'],
      properties: {
        kpi: { type: 'string', description: 'KPI id or name' },
        as_of: { type: 'string', description: 'YYYY-MM-DD; answers as it stood then' },
        limit: { type: 'number', description: 'How many readings to return, newest first. Default 20' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'kpi');
      const row = findKpi(String(args.kpi), workspaceId, ctx);
      const asOf = isoDay(args.as_of, 'as_of') ?? undefined;
      const report = kpiReport(row, workspaceId, asOf);
      const limit = Math.max(1, Math.min(500, Math.round(Number(args.limit) || 20)));

      const moduleNames = new Map(all<Row>(
        `SELECT id, name FROM modules WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId,
      ).map((entry) => [String(entry.id), String(entry.name)]));

      return {
        ...report.summary,
        unit: row.unit,
        unit_label: row.unit_label ?? null,
        description: row.description ?? null,
        readings: [...report.readings]
          .sort((a, b) => (a.measured_on < b.measured_on ? 1 : -1))
          .slice(0, limit)
          .map((entry) => ({
            id: entry.id,
            measured_on: entry.measured_on,
            value: entry.value,
            value_text: formatMeasure(entry.value, report.kpi, 'en'),
            source: entry.source ?? null,
            note: entry.note ?? null,
          })),
        targets: report.targets.map((entry) => ({
          id: entry.id,
          value: entry.value,
          value_text: formatMeasure(entry.value, report.kpi, 'en'),
          /* Where the date came from, not only what it is: a reader needs to
             know whether this moves when the milestone does. */
          due: dueOn(entry, report.modules),
          milestone: entry.module_id ? moduleNames.get(entry.module_id) ?? null : null,
          note: entry.note ?? null,
        })),
      };
    },
  },
  {
    name: 'create_kpi',
    title: 'Define a KPI',
    description:
      'Define a number to watch. `decimals` fixes the scale for every value on it — 2 for a '
      + 'percentage read to a hundredth — and cannot be usefully changed afterwards without '
      + 'restating every reading, so it is worth getting right. `cadence` is how often somebody '
      + 'has undertaken to measure it, and is what lets a reading be reported as stale rather '
      + 'than quoted as current. Scoped like a budget: one project, several, or the workspace.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        unit: { type: 'string', enum: [...MEASURE_UNITS], description: 'Defaults to number' },
        unit_label: { type: 'string', description: 'The word after the figure, for unit "number"' },
        decimals: { type: 'number', description: '0 to 4. Defaults to 0' },
        direction: { type: 'string', enum: [...MEASURE_DIRECTIONS], description: 'Which way is better. Defaults to up' },
        baseline: { type: 'string', description: 'Where it stood before anybody started, e.g. "90.0"' },
        cadence: { type: 'string', enum: [...MEASURE_CADENCES], description: 'Defaults to monthly' },
        project: { type: 'string', description: 'The project that owns it' },
        projects: { type: 'array', items: { type: 'string' }, description: 'The projects it covers' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'kpi');
      const decimals = Math.max(0, Math.min(4, Math.round(Number(args.decimals) || 0)));
      const scope = resolveScope(args, workspaceId, ctx);
      const baseline = args.baseline === undefined || args.baseline === null || args.baseline === ''
        ? null
        : parseMeasure(String(args.baseline), decimals);
      if (args.baseline !== undefined && args.baseline !== null && args.baseline !== '' && baseline === null) {
        throw new McpError(`baseline is not a number I can read: "${args.baseline}"`);
      }

      const { row } = writeEntity('kpi', uid(), {
        workspace_id: workspaceId,
        ...scope,
        name: String(args.name).trim(),
        description: str(args.description) ?? null,
        unit: args.unit ?? 'number',
        unit_label: str(args.unit_label) ?? null,
        decimals,
        direction: args.direction ?? 'up',
        baseline,
        cadence: args.cadence ?? 'monthly',
        sort_order: orderKey(),
      }, writeOpts(workspaceId, ctx));

      return { id: row.id, name: row.name, unit: row.unit, decimals: row.decimals, direction: row.direction, cadence: row.cadence };
    },
  },
  {
    name: 'record_measurement',
    title: 'Record a measurement',
    description:
      'Record what a KPI reads today, or on a given day. `source` is where the number came from '
      + 'and is worth filling in: a measurement nobody can trace back is a number somebody will '
      + 'argue with and nobody can defend. Recording a second reading for a day already measured '
      + 'is allowed and the later one stands — a correction is a normal thing.',
    schema: {
      type: 'object',
      required: ['kpi', 'value'],
      properties: {
        kpi: { type: 'string', description: 'KPI id or name' },
        value: { type: 'string', description: 'e.g. "99.95". Read at the KPI\'s own scale' },
        measured_on: { type: 'string', description: 'YYYY-MM-DD; defaults to today' },
        source: { type: 'string', description: 'Where the number came from' },
        note: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'kpi');
      const kpiRow = findKpi(String(args.kpi), workspaceId, ctx);
      const decimals = Number(kpiRow.decimals) || 0;
      const value = parseMeasure(String(args.value), decimals);
      if (value === null) throw new McpError(`value is not a number I can read: "${args.value}"`);

      const { row } = writeEntity('kpiReading', uid(), {
        workspace_id: workspaceId,
        kpi_id: kpiRow.id,
        measured_on: isoDay(args.measured_on, 'measured_on') ?? new Date().toISOString().slice(0, 10),
        value,
        source: str(args.source) ?? null,
        note: str(args.note) ?? null,
      }, writeOpts(workspaceId, ctx));

      const after = kpiReport(kpiRow, workspaceId);
      return {
        id: row.id,
        kpi: kpiRow.name,
        measured_on: row.measured_on,
        value_text: formatMeasure(Number(row.value), asKpi(kpiRow), 'en'),
        /* What it did to the verdict, which is the reason somebody recorded it. */
        health: after.summary.health,
        achieved_pct: after.summary.achieved_pct,
        expected_pct: after.summary.expected_pct,
      };
    },
  },
  {
    name: 'set_kpi_target',
    title: 'Set what a KPI has to reach',
    description:
      'Add a target. Several are normal and are a ladder rather than a replacement — "85% by '
      + 'June, 90% by December" is two targets, and the one in force is the earliest still '
      + 'ahead. Give `milestone` instead of `due_on` to hang it on a milestone, and it will move '
      + 'when that milestone moves: the promise was "by the time we ship", not "by 30 June".',
    schema: {
      type: 'object',
      required: ['kpi', 'value'],
      properties: {
        kpi: { type: 'string', description: 'KPI id or name' },
        value: { type: 'string', description: 'e.g. "99.9"' },
        due_on: { type: 'string', description: 'YYYY-MM-DD' },
        milestone: { type: 'string', description: 'Module id or name; its date wins over due_on' },
        note: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'kpi');
      const kpiRow = findKpi(String(args.kpi), workspaceId, ctx);
      const decimals = Number(kpiRow.decimals) || 0;
      const value = parseMeasure(String(args.value), decimals);
      if (value === null) throw new McpError(`value is not a number I can read: "${args.value}"`);

      let module: Row | null = null;
      if (args.milestone) {
        const wanted = String(args.milestone).trim().toLowerCase();
        module = all<Row>(`SELECT * FROM modules WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
          .find((row) => row.id === args.milestone || String(row.name).toLowerCase() === wanted) ?? null;
        if (!module) throw new McpError(`No milestone "${args.milestone}" in this workspace`);
      }

      const { row } = writeEntity('kpiTarget', uid(), {
        workspace_id: workspaceId,
        kpi_id: kpiRow.id,
        module_id: module?.id ?? null,
        due_on: isoDay(args.due_on, 'due_on') ?? null,
        value,
        note: str(args.note) ?? null,
        sort_order: orderKey(),
      }, writeOpts(workspaceId, ctx));

      const modules = module
        ? [{ id: String(module.id), target_date: (module.target_date as string | null) ?? null }]
        : [];
      const due = dueOn(serialize('kpiTarget', row) as unknown as KpiTarget, modules);
      return {
        id: row.id,
        kpi: kpiRow.name,
        value_text: formatMeasure(value, asKpi(kpiRow), 'en'),
        due,
        milestone: module ? module.name : null,
        /* Said plainly, because it is the difference between the two ways of
           setting a target and it is invisible in the stored row. */
        moves_with_milestone: !!module,
      };
    },
  },
];
