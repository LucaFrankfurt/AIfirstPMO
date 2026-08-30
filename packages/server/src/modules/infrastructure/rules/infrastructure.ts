/**
 * The rules the register lives by: vendors, components and moves.
 *
 * Nothing here cascades a *deletion*, and that is the point — a vendor leaving
 * the list does not switch off the servers. What it does is detach, so no row
 * is left pointing at something that is not there.
 */

import { COMPONENT_KINDS, COST_RECURRENCES, type EntityName, ENVIRONMENTS, LIFECYCLES, MOVE_STATUS, VENDOR_KINDS } from '@kolibri/shared';
import { all, type Row } from '../../../kernel/platform/db/index.ts';
import { type EntityRule, parseIds, wouldLoop, writeEntity, type WriteOpts } from '../../../kernel/write-path/repo.ts';

/**
 * The register's own shapes: enums that have to be one of a list, money that
 * has to be a whole number, dates that have to sort.
 *
 * Corrections rather than refusals, for the reason the budget and rate
 * invariants give — these arrive in batches from devices that have been away,
 * and one unknown enum should not take twenty good rows down with it.
 */
function applyLandscapeInvariants(
  entity: EntityName,
  values: Record<string, unknown>,
  forced: Record<string, unknown>,
): void {
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };
  const oneOf = <T extends string>(field: string, allowed: readonly T[], fallback: T): void => {
    if (values[field] === undefined) return;
    if (!(allowed as readonly string[]).includes(String(values[field] ?? ''))) settle(field, fallback);
  };
  /** A date, or nothing. A malformed one sorts unpredictably and lands in the
      wrong landscape rather than in none, which is the worse of the two. */
  const day = (field: string): void => {
    if (values[field] === undefined || values[field] === null || values[field] === '') return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(values[field]))) settle(field, null);
  };
  /** A list of ids, from whatever arrived. */
  const ids = (field: string): void => {
    if (values[field] === undefined) return;
    let parsed: unknown = values[field];
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = []; } }
    const clean = Array.isArray(parsed)
      ? [...new Set(parsed.filter((row): row is string => typeof row === 'string' && !!row))]
      : [];
    const encoded = JSON.stringify(clean);
    if (encoded !== values[field]) settle(field, encoded);
  };

  if (entity === 'vendor') {
    oneOf('kind', VENDOR_KINDS, 'other');
    day('contract_start');
    day('contract_end');
    if (values.notice_days !== undefined) {
      const days = Math.round(Number(values.notice_days));
      // Clamped rather than refused: a negative notice period is a typo, and a
      // five-year one is a typo that would put the reminder in the past.
      if (!Number.isFinite(days) || days < 0) settle('notice_days', 0);
      else if (days > 1095) settle('notice_days', 1095);
      else if (days !== values.notice_days) settle('notice_days', days);
    }
  }

  if (entity === 'component') {
    oneOf('kind', COMPONENT_KINDS, 'other');
    oneOf('environment', ENVIRONMENTS, 'production');
    oneOf('status', LIFECYCLES, 'live');
    oneOf('recurrence', COST_RECURRENCES, 'monthly');
    ids('projects');
    day('live_from');
    day('live_until');
    if (values.amount !== undefined) {
      const amount = Math.round(Number(values.amount));
      if (!Number.isFinite(amount) || amount < 0) settle('amount', 0);
      else if (amount !== values.amount) settle('amount', amount);
    }
    if (typeof values.currency === 'string') {
      const code = values.currency.trim().toUpperCase();
      settle('currency', /^[A-Z]{3}$/.test(code) ? code : 'EUR');
    }
    /*
     * A component that leaves before it arrives is in no landscape at all, on
     * any day, and nothing on any screen would say why. The end date is dropped
     * rather than the start: somebody who typed one date correctly typed the
     * start, because that is the one they knew first.
     */
    const from = (values.live_from ?? undefined) as string | undefined;
    const until = (values.live_until ?? undefined) as string | undefined;
    if (from && until && until < from) settle('live_until', null);
  }

  if (entity === 'move') {
    oneOf('status', MOVE_STATUS, 'proposed');
    ids('leaving');
    ids('arriving');
    day('target_date');
  }
}

/** A vendor that is gone leaves its components running, and unattached. */
function detachFromVendor(vendor: Row, opts: WriteOpts): void {
  for (const row of all<Row>(`SELECT id FROM components WHERE vendor_id = ? AND deleted_at IS NULL`, vendor.id)) {
    writeEntity('component', String(row.id), { vendor_id: null }, { ...opts, op: undefined, system: true, silent: true });
  }
}

/**
 * A component that is gone leaves its children at the top of the tree, and its
 * name out of the moves that named it.
 *
 * The second half is the less obvious one. `moveProgress` reads the register
 * rather than the move's own status, and an id it cannot resolve counts as
 * *not done* — so a move naming a deleted component would sit at 90% forever
 * with nothing on the screen able to explain the missing tenth. Taking the id
 * out is the smaller surprise of the two.
 */
function detachComponent(component: Row, opts: WriteOpts): void {
  for (const row of all<Row>(`SELECT id FROM components WHERE parent_id = ? AND deleted_at IS NULL`, component.id)) {
    writeEntity('component', String(row.id), { parent_id: null }, { ...opts, op: undefined, system: true, silent: true });
  }
  const id = String(component.id);
  for (const move of all<Row>(`SELECT * FROM moves WHERE deleted_at IS NULL`)) {
    const leaving = parseIds(move.leaving);
    const arriving = parseIds(move.arriving);
    if (!leaving.includes(id) && !arriving.includes(id)) continue;
    writeEntity('move', String(move.id), {
      leaving: JSON.stringify(leaving.filter((row) => row !== id)),
      arriving: JSON.stringify(arriving.filter((row) => row !== id)),
    }, { ...opts, op: undefined, system: true, silent: true });
  }
}



export const landscapeRules = {
  entities: ['vendor', 'component', 'move'],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'component' && !values.name) setForced('name', 'Untitled component');
    if (entity === 'vendor' && !values.name) setForced('name', 'Untitled vendor');
    if (entity === 'move' && !values.name) setForced('name', 'Untitled move');
  },
  invariants(entity, id, values, existing, forced) {
    if (entity === 'vendor' || entity === 'component' || entity === 'move') {
      applyLandscapeInvariants(entity, values, forced);
    }
    /*
     * A component cannot sit under itself, at any remove.
     *
     * The same rule a project and a sub-task already follow, and reachable the
     * same way: two people can each make a legal move that is a loop together.
     * Refused through `forced` rather than thrown, because this write may be one
     * row of a sync batch from a device that has been away.
     */
    if (entity === 'component' && values.parent_id !== undefined && existing) {
      const wanted = values.parent_id as string | null;
      if (wanted === existing.id || wouldLoop('components', String(existing.id), wanted)) {
        values.parent_id = existing.parent_id ?? null;
        forced.parent_id = values.parent_id;
      }
    }
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'vendor' && row.deleted_at && !before?.deleted_at) detachFromVendor(row, opts);
    if (entity === 'component' && row.deleted_at && !before?.deleted_at) detachComponent(row, opts);
  },
} satisfies EntityRule;
