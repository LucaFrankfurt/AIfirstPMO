/**
 * What an hour costs, what it is charged at, and what that comes to.
 */
import { formatMoney, RATE_KINDS, rollUp, type TimeEntry, totalsOf, utilisation } from '@kolibri/shared';
import { read, writeEntity } from '../../repo.ts';
import { uid } from '../../ids.ts';
import { entriesIn, findMember, findProject, hours, isoDay, money, moneyList, namesOf, projectNames, ratesOf, requireAdmin, requireFeature, requireMoney, requireWrite, str, type ToolDef, workspaceOf, writeOpts } from '../kit.ts';

export const rateTools: ToolDef[] = [
  {
    name: 'list_rates',
    title: 'List hourly rates',
    description:
      'Every rate in the workspace, newest first, with who and where each applies to. Rates are '
      + 'dated and never edited in place, so this is also the history: two rows with two start '
      + 'dates is why March and April cost different amounts. Owners and admins only.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...RATE_KINDS], description: 'cost or billable' },
        user: { type: 'string', description: 'Person id, email or name' },
        project: { type: 'string', description: 'Project key or name' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'time');
      requireAdmin(ctx, workspaceId);
      const userId = args.user ? String(findMember(String(args.user), workspaceId).id) : null;
      const projectId = args.project ? String(findProject(String(args.project), workspaceId, ctx).id) : null;
      const names = namesOf(ratesOf(workspaceId).map((rate) => rate.user_id ?? '').filter(Boolean));
      const projects = projectNames(workspaceId);

      const rows = ratesOf(workspaceId)
        .filter((rate) => (args.kind ? rate.kind === args.kind : true))
        .filter((rate) => (userId ? rate.user_id === userId : true))
        .filter((rate) => (projectId ? rate.project_id === projectId : true))
        .sort((a, b) => (a.starts_on < b.starts_on ? 1 : -1));

      return {
        rates: rows.map((rate) => ({
          id: rate.id,
          kind: rate.kind,
          // "Anybody" and "everywhere" rather than null: a rate that applies to
          // the whole workspace is the most important row in the list and
          // reads as missing data when it comes back as two nulls.
          who: rate.user_id ? names[rate.user_id] ?? rate.user_id : 'anybody',
          where: rate.project_id ? projects[rate.project_id] ?? rate.project_id : 'everywhere',
          amount: rate.amount,
          amount_text: `${formatMoney(rate.amount, rate.currency, 'en')}/h`,
          currency: rate.currency,
          starts_on: rate.starts_on,
          note: rate.note,
        })),
        total: rows.length,
      };
    },
  },
  {
    name: 'set_rate',
    title: 'Set an hourly rate',
    description:
      'Record what an hour is worth from a date. This never edits an existing rate — it adds one '
      + 'that takes effect on `starts_on`, so what last quarter cost stays what last quarter cost. '
      + 'Leave `user` out for a workspace default and `project` out for everywhere; the most '
      + 'specific rate wins. Owners and admins only.',
    schema: {
      type: 'object',
      required: ['amount'],
      properties: {
        amount: { type: 'string', description: 'Per hour, e.g. "95" or "95,00"' },
        kind: { type: 'string', enum: [...RATE_KINDS], description: 'Defaults to cost' },
        user: { type: 'string', description: 'Person id, email or name. Omit for anybody' },
        project: { type: 'string', description: 'Project key or name. Omit for everywhere' },
        currency: { type: 'string', description: 'ISO 4217; defaults to EUR' },
        starts_on: { type: 'string', description: 'YYYY-MM-DD; defaults to today' },
        note: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'time');
      requireAdmin(ctx, workspaceId);

      const { row } = writeEntity('rate', uid(), {
        workspace_id: workspaceId,
        user_id: args.user ? String(findMember(String(args.user), workspaceId).id) : null,
        project_id: args.project ? String(findProject(String(args.project), workspaceId, ctx).id) : null,
        kind: args.kind ?? 'cost',
        amount: requireMoney(args.amount, 'amount'),
        currency: String(args.currency ?? 'EUR').trim().toUpperCase(),
        starts_on: isoDay(args.starts_on, 'starts_on') ?? new Date().toISOString().slice(0, 10),
        note: str(args.note) ?? null,
      }, writeOpts(workspaceId, ctx));

      return {
        id: row.id,
        kind: row.kind,
        amount_text: `${formatMoney(Number(row.amount), String(row.currency), 'en')}/h`,
        starts_on: row.starts_on,
        applies_to: {
          who: args.user ? String(args.user) : 'anybody',
          where: args.project ? String(args.project) : 'everywhere',
        },
      };
    },
  },
  {
    name: 'time_cost',
    title: 'What logged time cost',
    description:
      'Cost, revenue and margin over logged time, broken down by project and by person. Every '
      + 'hour is costed at the rate in force on the day it was worked, so raising a rate does not '
      + 'restate the past. Hours no rate covers are reported as `unrated` rather than as free. '
      + 'Owners and admins only.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        project: { type: 'string', description: 'Project key or name' },
        user: { type: 'string', description: 'Person id, email or name' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'time');
      requireAdmin(ctx, workspaceId);
      const rates = ratesOf(workspaceId);
      const entries = entriesIn(workspaceId, ctx, args);
      const totals = totalsOf(entries, rates);
      const projects = projectNames(workspaceId);
      const people = namesOf([...new Set(entries.map((entry) => entry.user_id))]);

      /** The same roll-up over one slice, so every row is computed one way. */
      const slice = (of: 'project' | 'user') => {
        const groups = new Map<string, TimeEntry[]>();
        for (const entry of entries) {
          const key = String((of === 'project' ? entry.project_id : entry.user_id) ?? '');
          const rows = groups.get(key) ?? [];
          rows.push(entry);
          groups.set(key, rows);
        }
        return [...groups].map(([key, rows]) => {
          const totalsHere = totalsOf(rows, rates);
          return {
            [of]: key
              ? (of === 'project' ? projects[key] ?? key : people[key] ?? key)
              : (of === 'project' ? 'no project' : 'unknown'),
            hours: hours(totalsHere.minutes),
            billable_hours: hours(totalsHere.billableMinutes),
            unrated_hours: hours(totalsHere.unratedMinutes),
            cost: moneyList(totalsHere.cost),
            revenue: moneyList(totalsHere.revenue),
          };
        }).sort((a, b) => b.hours - a.hours);
      };

      return {
        window: { from: args.from ?? null, to: args.to ?? null },
        hours: hours(totals.minutes),
        billable_hours: hours(totals.billableMinutes),
        /* The figure that keeps the rest honest. Hours nothing costed are not
           free hours, and a total that quietly counted them at zero would be
           lower than the truth by exactly the amount nobody noticed. */
        unrated_hours: hours(totals.unratedMinutes),
        billable_share: totals.billableShare === null ? null : Math.round(totals.billableShare * 100) / 100,
        cost: moneyList(totals.cost),
        revenue: moneyList(totals.revenue),
        margin: moneyList(totals.margin),
        by_project: slice('project'),
        by_person: slice('user'),
      };
    },
  },
  {
    name: 'utilisation',
    title: 'Billable share',
    description:
      'How much of the time logged was billable, per person or per project. `target_hours` gives '
      + 'the second ratio people mean by utilisation — billable over available — and is a number '
      + 'the caller supplies, because Kolibri holds no contracted hours and would otherwise be '
      + 'inventing one. Owners and admins only.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        by: { type: 'string', enum: ['user', 'project'], description: 'Defaults to user' },
        target_hours: { type: 'number', description: 'Hours available per person over the window' },
        project: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'time');
      requireAdmin(ctx, workspaceId);
      const by = args.by === 'project' ? 'project' : 'user';
      const entries = entriesIn(workspaceId, ctx, args);
      const target = Number(args.target_hours) > 0 ? Number(args.target_hours) * 60 : undefined;
      const names = by === 'project' ? projectNames(workspaceId) : namesOf([...new Set(entries.map((e) => e.user_id))]);

      return {
        by,
        window: { from: args.from ?? null, to: args.to ?? null },
        target_hours: args.target_hours ?? null,
        rows: utilisation({ entries, by, targetMinutes: target }).map((row) => ({
          [by]: row.key ? names[row.key] ?? row.key : (by === 'project' ? 'no project' : 'unknown'),
          hours: hours(row.minutes),
          billable_hours: hours(row.billableMinutes),
          billable_share: row.share === null ? null : Math.round(row.share * 100) / 100,
          against_target: row.againstTarget === null ? null : Math.round(row.againstTarget * 100) / 100,
        })),
      };
    },
  },

  /* ------------------------------------------------------------- budgets --
   *
   * Six tools over the money: read what a budget is doing, plan a cost, record
   * one that has happened, and ask what a project costs. Every figure comes
   * out of `rollUp` in `@kolibri/shared` — the same function the dashboard
   * draws — so an assistant and a person looking at the screen cannot be told
   * two different numbers.
   *
   * Amounts are accepted as text (`"12.500,00"`, `"€12,500"`, `"12500"`) and
   * returned both ways: `amount` in minor units for arithmetic, and
   * `amount_text` already formatted, because a model that has to divide by a
   * hundred to quote a figure will eventually forget to.
   */
];
