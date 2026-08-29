/**
 * The rules a KPI, its targets and its readings live by.
 *
 * It listens to `module` as well as its own three tables, because a milestone
 * being deleted leaves the promises made against it standing — that cascade is
 * a fact about targets rather than about milestones, so it belongs here rather
 * than in the write path or in planning.
 */

import { type EntityName, MEASURE_CADENCES, MEASURE_DIRECTIONS, MEASURE_UNITS, projectScope } from '@kolibri/shared';
import { all, get, type Row } from '../../db/index.ts';
import { type EntityRule, writeEntity, type WriteOpts } from '../repo.ts';

/** The three tables a KPI is made of. */
const KPI_ENTITIES = new Set<EntityName>(['kpi', 'kpiTarget', 'kpiReading']);

/**
 * A measurement is a number, a scale and a day.
 *
 * Corrections rather than refusals, as the budget invariants are and for the
 * same reason. The one worth naming is `decimals`: it is clamped to 0–4 and
 * only ever whole, because it is the exponent every value on the KPI is scaled
 * by — a fractional or wild one would not make a figure slightly wrong, it
 * would move the decimal point on every reading and target at once.
 */
function applyKpiInvariants(
  entity: EntityName,
  values: Record<string, unknown>,
  forced: Record<string, unknown>,
): void {
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };
  const oneOf = (field: string, allowed: readonly string[], fallback: string) => {
    if (values[field] === undefined) return;
    const given = String(values[field] ?? '');
    if (!allowed.includes(given)) settle(field, fallback);
  };
  /**
   * A whole number, or zero.
   *
   * `null` is coerced rather than skipped, which is the whole point: `value` is
   * `NOT NULL`, so letting a null through does not store a slightly wrong
   * figure — it throws inside the write and takes the entire sync batch it
   * arrived in down with it. The budget's `whole` has always done this; this one
   * did not, and a client sending `{value: null}` got a 500 instead of a zero.
   * Nullable columns are handled at their own call site.
   */
  const whole = (field: string) => {
    if (values[field] === undefined) return;
    const number = Math.round(Number(values[field]));
    settle(field, Number.isFinite(number) ? number : 0);
  };
  const day = (field: string) => {
    if (values[field] === undefined) return;
    const given = String(values[field] ?? '');
    if (given && !/^\d{4}-\d{2}-\d{2}$/.test(given)) settle(field, new Date().toISOString().slice(0, 10));
  };

  if (entity === 'kpi') {
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
    oneOf('unit', MEASURE_UNITS, 'number');
    oneOf('direction', MEASURE_DIRECTIONS, 'up');
    oneOf('cadence', MEASURE_CADENCES, 'monthly');
    if (values.decimals !== undefined) {
      const given = Math.round(Number(values.decimals));
      settle('decimals', Number.isFinite(given) ? Math.max(0, Math.min(4, given)) : 0);
    }
    // The one nullable number here, and null means something: nobody has said
    // where it started, and progress runs from the first reading instead.
    if (values.baseline !== undefined && values.baseline !== null) whole('baseline');
  }

  if (entity === 'kpiTarget') {
    whole('value');
    day('due_on');
  }

  if (entity === 'kpiReading') {
    whole('value');
    // Not optional here, unlike a target's: a reading with no day cannot be
    // placed on the line, and the state that says "we do not know when" is a
    // reading nobody entered.
    if (values.measured_on !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(values.measured_on ?? ''))) {
      settle('measured_on', new Date().toISOString().slice(0, 10));
    }
  }
}

/**
 * A line, an actual or a scenario belongs to whichever budget it names.
 *
 * Not to the workspace the write arrived in — those are the same thing today,
 * and `guardReferences` already refuses a budget in another workspace, but the
 * child rows are read by joining on `budget_id` and a row whose two answers
 * disagree is a row that appears in one query and not the next.
 */
/** A target and a reading live where their KPI lives, whatever the client said. */
function followKpiWorkspace(values: Record<string, unknown>, existing: Row | undefined): void {
  const kpiId = (values.kpi_id ?? existing?.kpi_id) as string | undefined;
  if (!kpiId) return;
  const kpi = get<Row>(`SELECT workspace_id FROM kpis WHERE id = ?`, kpiId);
  if (kpi) values.workspace_id = kpi.workspace_id;
}

function tombstoneKpiChildren(kpi: Row, opts: WriteOpts): void {
  for (const [entity, table] of [['kpiTarget', 'kpi_targets'], ['kpiReading', 'kpi_readings']] as const) {
    for (const row of all<Row>(`SELECT id FROM ${table} WHERE kpi_id = ? AND deleted_at IS NULL`, kpi.id)) {
      writeEntity(entity, String(row.id), {}, { ...opts, op: 'delete', system: true, silent: true });
    }
  }
}

/**
 * A milestone that is gone leaves the targets due by it standing, undated.
 *
 * The same rule the estate follows and the opposite of the cascade above, for a
 * reason worth stating: cancelling a milestone does not cancel the promise. "We
 * want 90% uptime" survives the release it was hung on, and deleting the target
 * with the module would quietly retire a commitment nobody decided to drop. The
 * target keeps whatever date was typed on it and otherwise becomes undated,
 * which every screen already reports as its own state.
 *
 * Note the options: `op: undefined` so this is an edit rather than a delete.
 * Passing `opts` through unchanged once deleted the invoices filed against a
 * budget line, which is how that lesson was learned.
 */
function detachTargetsOf(module: Row, opts: WriteOpts): void {
  for (const row of all<Row>(`SELECT id FROM kpi_targets WHERE module_id = ? AND deleted_at IS NULL`, module.id)) {
    writeEntity('kpiTarget', String(row.id), { module_id: null }, { ...opts, op: undefined, system: true, silent: true });
  }
}



export const kpiRules = {
  entities: [...KPI_ENTITIES, 'module'],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'kpi') {
      // Same reason a budget gets one: a number nobody owns is a number nobody is
      // asked about when it goes red.
      if (!values.owner_id) setForced('owner_id', opts.actorId);
      if (!values.name) setForced('name', 'Untitled KPI');
    }
    if (entity === 'kpiReading' && !values.measured_on) {
      setForced('measured_on', new Date().toISOString().slice(0, 10));
    }
  },
  invariants(entity, id, values, existing, forced) {
    applyKpiInvariants(entity, values, forced);
    if (entity === 'kpiTarget' || entity === 'kpiReading') followKpiWorkspace(values, existing);
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'kpi' && row.deleted_at && !before?.deleted_at) tombstoneKpiChildren(row, opts);
    if (entity === 'module' && row.deleted_at && !before?.deleted_at) detachTargetsOf(row, opts);
  },
} satisfies EntityRule;
