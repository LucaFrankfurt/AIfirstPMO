/**
 * The rules the catalogue's nine tables live by.
 *
 * Shaped like `budgets.ts` and for the same reasons — a write path that knew
 * what a price kind was would be a write path that knows about selling — and
 * with one rule the budget does not need: a package may not contain itself.
 *
 * Everything here that can be a *correction* is one, applied through `forced`
 * so the client learns what was changed. These writes arrive in sync batches
 * from devices that have been away, and a price with a `kind` somebody's old
 * build spelled differently should not take twenty other rows down with it.
 * The one thing that is a refusal instead is the cycle, because there is no
 * correction for it that is not a guess at what somebody meant.
 */

import {
  COST_BASIS, COST_CATEGORIES, COST_RECURRENCES, type EntityName, PRICE_KINDS,
  PRODUCT_KINDS, PRODUCT_STATUS, PROMOTION_KINDS, PROMOTION_STATUS, RENEWALS,
} from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { HttpError } from '../../../kernel/platform/http.ts';
import { type EntityRule, writeEntity, type WriteOpts } from '../../../kernel/write-path/repo.ts';

/** The nine tables the catalogue is made of. */
const PRODUCT_ENTITIES = new Set<EntityName>([
  'product', 'productGroup', 'productPrice', 'productCost', 'productContributor',
  'productCapability', 'productPart', 'promotion', 'productScenario',
]);

/** The rows that hang off one product and die with it. */
const PRODUCT_CHILDREN = [
  ['productPrice', 'product_prices'],
  ['productCost', 'product_costs'],
  ['productContributor', 'product_contributors'],
  ['productPart', 'product_parts'],
] as const;

/** Basis points, and nothing anywhere stores a proportion any other way. */
const FULL_BPS = 10_000;

function applyProductInvariants(entity: EntityName, values: Record<string, unknown>, forced: Record<string, unknown>): void {
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };

  /** Snap to one of a fixed list, or to its default. See the enums in `types.ts`. */
  const oneOf = <T extends string>(field: string, allowed: readonly T[], fallback: T): void => {
    if (values[field] === undefined) return;
    const value = String(values[field] ?? '');
    if (!(allowed as readonly string[]).includes(value)) settle(field, fallback);
  };
  /**
   * A whole number, clamped.
   *
   * The same reasoning `whole` in `budgets.ts` gives — a value that is not a
   * number at all becomes the floor rather than `NaN`, which SQLite stores as
   * NULL and every later `SUM` silently skips — plus a ceiling, because these
   * are counts and proportions rather than money: a churn of 40 000 basis
   * points is four hundred per cent a month, and there is no reading of that.
   */
  const bounded = (field: string, min: number, max: number, fallback: number): void => {
    if (values[field] === undefined) return;
    if (values[field] === null && min <= 0) return;
    const value = Math.round(Number(values[field]));
    if (!Number.isFinite(value)) settle(field, fallback);
    else if (value < min || value > max) settle(field, Math.min(Math.max(value, min), max));
    else if (value !== values[field]) settle(field, value);
  };
  /** An amount is a whole number of minor units. Negative is allowed: a credit is real. */
  const money = (field: string): void => {
    if (values[field] === undefined) return;
    const value = Math.round(Number(values[field]));
    if (!Number.isFinite(value)) settle(field, 0);
    else if (value !== values[field]) settle(field, value);
  };
  /** A JSON array of ids, from whatever arrived. Anything else is an empty list. */
  const ids = (field: string): void => {
    if (values[field] === undefined) return;
    let parsed: unknown = values[field];
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = []; } }
    const clean = Array.isArray(parsed) ? [...new Set(parsed.filter((row): row is string => typeof row === 'string'))] : [];
    const encoded = JSON.stringify(clean);
    if (encoded !== values[field]) settle(field, encoded);
  };
  /** ISO 4217: three letters, upper case, or the default. As `budgets.ts` does it. */
  const currency = (field: string): void => {
    if (typeof values[field] !== 'string') return;
    const code = (values[field] as string).trim().toUpperCase();
    settle(field, /^[A-Z]{3}$/.test(code) ? code : 'EUR');
  };

  if (entity === 'product') {
    oneOf('kind', PRODUCT_KINDS, 'single');
    oneOf('status', PRODUCT_STATUS, 'draft');
    oneOf('billing', COST_RECURRENCES, 'once');
    oneOf('renewal', RENEWALS, 'none');
    currency('currency');
    money('acquisition_cost');
    bounded('scope_amount', 0, 1_000_000, 0);
    // Null is "no ceiling" and has to survive; zero would read as a product
    // that can sell nothing, which is not what an empty field means.
    if (values.capacity !== undefined && values.capacity !== null) bounded('capacity', 1, 1_000_000, 1);
    bounded('term_months', 0, 600, 0);
    bounded('churn_bps', 0, FULL_BPS, 0);
    ids('capabilities');
  }

  if (entity === 'productPrice') {
    oneOf('kind', PRICE_KINDS, 'list');
    oneOf('recurrence', COST_RECURRENCES, 'once');
    money('amount');
    bounded('min_quantity', 1, 1_000_000, 1);
    // A window that runs backwards is a window nothing falls inside, so a price
    // entered the wrong way round would simply never apply and never say why.
    if (typeof values.valid_from === 'string' && typeof values.valid_to === 'string'
      && values.valid_from > values.valid_to) {
      const from = values.valid_from;
      settle('valid_from', values.valid_to);
      settle('valid_to', from);
    }
  }

  if (entity === 'productCost') {
    oneOf('category', COST_CATEGORIES, 'other');
    oneOf('basis', COST_BASIS, 'unit');
    money('amount');
  }

  if (entity === 'productContributor') {
    oneOf('fee_basis', COST_BASIS, 'delivery');
    money('fee');
  }

  if (entity === 'productPart') bounded('quantity', 1, 1_000_000, 1);

  if (entity === 'promotion') {
    oneOf('kind', PROMOTION_KINDS, 'percent');
    oneOf('status', PROMOTION_STATUS, 'draft');
    currency('currency');
    money('spend');
    bounded('uplift_bps', -FULL_BPS, 100 * FULL_BPS, 0);
    ids('products');
    ids('groups');
    /*
     * A percentage is basis points and cannot exceed the whole; an amount and a
     * price are money and can be anything a currency can. Clamping all three
     * would turn "€45 000 for the year" into 100%, which is how a campaign
     * quietly becomes free.
     */
    if (values.kind === 'percent') bounded('value', 0, FULL_BPS, 0);
    else money('value');
    if (typeof values.starts_on === 'string' && typeof values.ends_on === 'string'
      && values.starts_on > values.ends_on) {
      const from = values.starts_on;
      settle('starts_on', values.ends_on);
      settle('ends_on', from);
    }
  }

  if (entity === 'productScenario' && values.assumptions !== undefined) {
    /*
     * Stored as it arrived once it is an object at all, rather than settled
     * here against `DEFAULT_ASSUMPTIONS`. `assumptionsOf` clamps every field on
     * the way *out*, on both sides, so writing the settled shape in would mean
     * two places that decide what a missing `months` is — and the one that runs
     * on a three-week-old client would be the older of the two.
     */
    let parsed: unknown = values.assumptions;
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = {}; } }
    const clean = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const encoded = JSON.stringify(clean);
    if (encoded !== values.assumptions) settle('assumptions', encoded);
  }
}

/** A child follows its product's workspace, the way a budget line follows its budget's. */
function followProductWorkspace(values: Record<string, unknown>, existing: Row | undefined): void {
  const productId = (values.product_id ?? existing?.product_id) as string | undefined;
  if (!productId) return;
  const product = get<Row>(`SELECT workspace_id FROM products WHERE id = ?`, productId);
  if (product) values.workspace_id = product.workspace_id;
}

/**
 * A package may not contain itself, at any depth.
 *
 * The one rule here that refuses rather than corrects, because every correction
 * available is a guess: dropping the part silently loses what somebody meant,
 * and keeping it means `bundleValue` walks a ring until the stack gives out —
 * on the server, inside the write transaction, on a row a client will retry.
 *
 * Walks upward from the proposed container rather than downward from the part,
 * which is the cheaper half: a package has a handful of parents and may have
 * many descendants. Depth is capped as well as visited-tracked, because the
 * only thing worse than a cycle here is a cycle this loop does not detect.
 */
function refuseCycle(values: Record<string, unknown>, existing: Row | undefined): void {
  const container = (values.product_id ?? existing?.product_id) as string | undefined;
  const part = (values.part_id ?? existing?.part_id) as string | undefined;
  if (!container || !part) return;
  if (container === part) throw new HttpError(422, 'A package cannot contain itself');

  const seen = new Set<string>([container]);
  let frontier = [container];
  for (let depth = 0; depth < 32 && frontier.length; depth++) {
    const placeholders = frontier.map(() => '?').join(',');
    const parents = all<Row>(
      `SELECT product_id FROM product_parts WHERE part_id IN (${placeholders}) AND deleted_at IS NULL`,
      ...frontier,
    ).map((row) => String(row.product_id));
    if (parents.includes(part)) throw new HttpError(422, 'That would put a package inside itself');
    frontier = parents.filter((id) => !seen.has(id));
    for (const id of frontier) seen.add(id);
  }
}

/**
 * A product that is gone takes its prices, costs, people and parts with it.
 *
 * Tombstones rather than a `DELETE`, for the reason `tombstoneBudgetChildren`
 * gives: every other device holds those rows and only a tombstone tells them.
 *
 * It also takes the *memberships* — the rows where it is somebody else's part —
 * which the budget has no equivalent of. Leaving those behind would give every
 * package containing it a part that resolves to nothing: no price, no
 * capabilities, and a list value quietly short by whatever it was worth.
 */
function tombstoneProductChildren(product: Row, opts: WriteOpts): void {
  for (const [entity, table] of PRODUCT_CHILDREN) {
    for (const row of all<Row>(`SELECT id FROM ${table} WHERE product_id = ? AND deleted_at IS NULL`, product.id)) {
      writeEntity(entity, String(row.id), {}, { ...opts, op: 'delete', system: true, silent: true });
    }
  }
  for (const row of all<Row>(`SELECT id FROM product_parts WHERE part_id = ? AND deleted_at IS NULL`, product.id)) {
    writeEntity('productPart', String(row.id), {}, { ...opts, op: 'delete', system: true, silent: true });
  }
}

/**
 * A group that is gone leaves its products behind, ungrouped.
 *
 * The opposite of the rule above, on purpose, and the same call `detachActualsOf`
 * makes about a budget line's invoices: a product does not stop being sold
 * because somebody tidied up the families, and deleting a line of business
 * because its folder went would be the worst kind of cascade. They become
 * ungrouped — which is what they now are, and which the catalogue already has a
 * row for.
 */
function detachProductsOf(group: Row, opts: WriteOpts): void {
  for (const row of all<Row>(`SELECT id FROM products WHERE group_id = ? AND deleted_at IS NULL`, group.id)) {
    // `op: undefined`, and it is the whole of this function working — see the
    // same line in `budgets.ts` for what spreading the delete instead cost.
    writeEntity('product', String(row.id), { group_id: null }, { ...opts, op: undefined, system: true, silent: true });
  }
}

export const productRules = {
  entities: [...PRODUCT_ENTITIES],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'product') {
      // Whoever made it owns it until somebody says otherwise. A product with
      // no owner is a product nobody is asked about when the margin goes red.
      if (!values.owner_id) setForced('owner_id', opts.actorId);
      if (!values.name) setForced('name', 'Untitled product');
    }
    if (entity === 'productGroup' && !values.name) setForced('name', 'Untitled group');
    if (entity === 'productCapability' && !values.name) setForced('name', 'Untitled capability');
    if (entity === 'promotion') {
      if (!values.owner_id) setForced('owner_id', opts.actorId);
      if (!values.name) setForced('name', 'Untitled promotion');
    }
    if (entity === 'productScenario' && !values.name) setForced('name', 'Untitled scenario');
  },
  invariants(entity, id, values, existing, forced) {
    applyProductInvariants(entity, values, forced);
    if (entity !== 'product' && entity !== 'productGroup' && entity !== 'productCapability'
      && entity !== 'promotion' && entity !== 'productScenario') {
      followProductWorkspace(values, existing);
    }
  },
  guards(entity, id, values, existing) {
    if (entity === 'productPart') refuseCycle(values, existing);
  },
  effects(entity, row, before, changed, opts) {
    if (entity === 'product' && row.deleted_at && !before?.deleted_at) tombstoneProductChildren(row, opts);
    if (entity === 'productGroup' && row.deleted_at && !before?.deleted_at) detachProductsOf(row, opts);
  },
} satisfies EntityRule;
