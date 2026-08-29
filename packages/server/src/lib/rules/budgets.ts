/**
 * The rules a budget's four tables live by.
 *
 * All of this was inside `repo.ts`, which is how a write path ends up knowing
 * what a cost category is. It is registered against the entities it speaks for
 * instead — see `repo.onEntity` for why appending rules is not a reordering,
 * and `lib/wiring.ts` for where they are hung on.
 */

import { type Allocation, BUDGET_STATUS, COST_CATEGORIES, COST_CONFIDENCE, COST_KINDS, COST_RECURRENCES, type EntityName, normaliseAllocations, projectScope, SPEND_STAGES } from '@kolibri/shared';
import { all, get, type Row } from '../../db/index.ts';
import { type EntityRule, writeEntity, type WriteOpts } from '../repo.ts';

/** The four tables a budget is made of. */
const BUDGET_ENTITIES = new Set<EntityName>(['budget', 'budgetLine', 'budgetActual', 'budgetScenario']);

/**
 * Money and the shapes it comes in.
 *
 * Everything here is a *correction* rather than a refusal, applied through
 * `forced` so the client learns what was changed. That is deliberate: these
 * writes arrive in sync batches from devices that have been away, and a budget
 * line with a category somebody's old build spelled differently should not
 * take twenty other rows down with it.
 */
function applyBudgetInvariants(entity: EntityName, values: Record<string, unknown>, forced: Record<string, unknown>): void {
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };
  /** Snap to one of a fixed list, or to its default. See the enums in `types.ts`. */
  const oneOf = <T extends string>(field: string, allowed: readonly T[], fallback: T): void => {
    if (values[field] === undefined) return;
    const value = String(values[field] ?? '');
    if (!(allowed as readonly string[]).includes(value)) settle(field, fallback);
  };
  /**
   * An amount is a whole number of minor units.
   *
   * A client that sends `12.5` means twelve and a half cents, which is not a
   * thing; rounding it is the only reading that keeps the column addable. A
   * value that is not a number at all becomes zero rather than `NaN`, which
   * SQLite would store as NULL and every later `SUM` would silently skip.
   */
  const whole = (field: string): void => {
    if (values[field] === undefined) return;
    const value = Math.round(Number(values[field]));
    if (!Number.isFinite(value)) settle(field, 0);
    else if (value !== values[field]) settle(field, value);
  };
  /** Shares that add up to the whole, or an empty list. See `normaliseAllocations`. */
  const splits = (field: string): void => {
    if (values[field] === undefined) return;
    let parsed: unknown = values[field];
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = []; } }
    const clean = normaliseAllocations(Array.isArray(parsed) ? parsed as Allocation[] : []);
    const encoded = JSON.stringify(clean);
    if (encoded !== values[field]) settle(field, encoded);
  };

  if (entity === 'budget') {
    // The fourth combination — an owner *and* a list — is never stored, so no
    // reader downstream has to decide which of two fields wins.
    if (values.project_id !== undefined || values.projects !== undefined) {
      let listed: unknown = values.projects;
      if (typeof listed === 'string') { try { listed = JSON.parse(listed); } catch { listed = []; } }
      const scope = projectScope({
        project: (values.project_id as string | null) ?? null,
        projects: Array.isArray(listed) ? listed.filter((row): row is string => typeof row === 'string') : [],
      });
      if (values.project_id !== scope.project_id) settle('project_id', scope.project_id);
      const encoded = JSON.stringify(scope.projects);
      if (values.projects !== encoded) settle('projects', encoded);
    }
    oneOf('status', BUDGET_STATUS, 'draft');
    whole('approved');
    // ISO 4217 is three letters, upper case. A currency this server has never
    // heard of is still stored — new ones exist — but `eur` and `EUR` are one
    // currency and storing both would be storing a split in every total.
    if (typeof values.currency === 'string') {
      const code = values.currency.trim().toUpperCase();
      settle('currency', /^[A-Z]{3}$/.test(code) ? code : 'EUR');
    }
  }

  if (entity === 'budgetLine') {
    oneOf('category', COST_CATEGORIES, 'other');
    oneOf('kind', COST_KINDS, 'opex');
    oneOf('recurrence', COST_RECURRENCES, 'once');
    oneOf('confidence', COST_CONFIDENCE, 'likely');
    whole('amount');
    splits('allocations');
  }

  if (entity === 'budgetActual') {
    oneOf('category', COST_CATEGORIES, 'other');
    oneOf('stage', SPEND_STAGES, 'paid');
    whole('amount');
    splits('allocations');
    // A day, or today. A malformed date would sort into the wrong month and
    // then quietly vanish from every report that filters on the period.
    if (values.spent_on !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(values.spent_on ?? ''))) {
      settle('spent_on', new Date().toISOString().slice(0, 10));
    }
  }
}

function followBudgetWorkspace(values: Record<string, unknown>, existing: Row | undefined): void {
  const budgetId = (values.budget_id ?? existing?.budget_id) as string | undefined;
  if (!budgetId) return;
  const budget = get<Row>(`SELECT workspace_id FROM budgets WHERE id = ?`, budgetId);
  if (budget) values.workspace_id = budget.workspace_id;
}

/**
 * A budget that is gone takes its lines, its actuals and its scenarios with it.
 *
 * Tombstones rather than a `DELETE`, for the reason `tombstoneValuesOf` gives:
 * every other device holds those rows and only a tombstone tells them. Without
 * this, deleting a budget left its lines on every client — invisible, because
 * nothing renders a line whose budget has gone, and permanently, because
 * nothing would ever mention them again.
 */
function tombstoneBudgetChildren(budget: Row, opts: WriteOpts): void {
  for (const [entity, table] of [
    ['budgetLine', 'budget_lines'],
    ['budgetActual', 'budget_actuals'],
    ['budgetScenario', 'budget_scenarios'],
  ] as const) {
    for (const row of all<Row>(`SELECT id FROM ${table} WHERE budget_id = ? AND deleted_at IS NULL`, budget.id)) {
      writeEntity(entity, String(row.id), {}, { ...opts, op: 'delete', system: true, silent: true });
    }
  }
}

/**
 * A plan line that is gone leaves its actuals behind, unattached.
 *
 * The opposite of the rule above, on purpose. An invoice does not stop having
 * been paid because somebody tidied up the plan it was filed under, and
 * deleting real money because a forecast row was deleted would be the worst
 * kind of cascade. The actual becomes unplanned spend — which is exactly what
 * it now is, and which the reports already have a column for.
 */
function detachActualsOf(line: Row, opts: WriteOpts): void {
  for (const row of all<Row>(`SELECT id FROM budget_actuals WHERE line_id = ? AND deleted_at IS NULL`, line.id)) {
    // `op: undefined`, and it is the whole of this function working. The
    // `opts` this is handed are the *line's* delete options, so spreading them
    // unchanged carries `op: 'delete'` onto every invoice — which deleted the
    // money along with the plan, quietly, and is exactly what this is here to
    // prevent.
    writeEntity('budgetActual', String(row.id), { line_id: null }, { ...opts, op: undefined, system: true, silent: true });
  }
}



export const budgetRules = {
  entities: [...BUDGET_ENTITIES],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'budget') {
      // Whoever made it owns it until somebody says otherwise. A budget with no
      // owner is a budget nobody is asked about when it goes red.
      if (!values.owner_id) setForced('owner_id', opts.actorId);
      if (!values.name) setForced('name', 'Untitled budget');
    }
    if (entity === 'budgetActual') {
      if (!opts.system || !values.recorded_by) setForced('recorded_by', opts.actorId);
      if (!values.spent_on) setForced('spent_on', new Date().toISOString().slice(0, 10));
    }
  },
  invariants(entity, id, values, existing, forced) {
    applyBudgetInvariants(entity, values, forced);
    if (entity === 'budgetLine' || entity === 'budgetActual' || entity === 'budgetScenario') {
      followBudgetWorkspace(values, existing);
    }
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'budget' && row.deleted_at && !before?.deleted_at) tombstoneBudgetChildren(row, opts);
    if (entity === 'budgetLine' && row.deleted_at && !before?.deleted_at) detachActualsOf(row, opts);
  },
} satisfies EntityRule;
