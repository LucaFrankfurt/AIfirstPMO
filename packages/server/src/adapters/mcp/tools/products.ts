/**
 * What is sold, what it is worth, and what it would take to sell more of it.
 *
 * Nine tools and a deliberate asymmetry between them: every read answers with
 * the *derived* figures — margin, break-even, lifetime value — rather than with
 * the rows, because an assistant handed four price rows and eleven cost rows
 * will do the arithmetic itself and get a different answer from the screen.
 * The arithmetic lives in `@kolibri/shared` and both sides call it.
 */
import {
  assumptionsOf, bundleValue, COST_BASIS, COST_CATEGORIES, COST_RECURRENCES, DEFAULT_ASSUMPTIONS,
  formatMoney, orderKey, overlappingPrices, PRICE_KINDS, priceChangeRefusal, priceFor, priceHistory,
  PRODUCT_KINDS, PRODUCT_STATUS, PROMOTION_KINDS, PROMOTION_STATUS, promotionPhase, raisePrice, RENEWALS,
  retentionOf, simulate, unitCosts, type ProductAssumptions,
  type ProductContributor, type ProductCost, type ProductPart, type ProductPrice, type Promotion, type Product,
} from '@kolibri/shared';
import { all, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import {
  catalogueOf, findProduct, isoDay, lastChildOrder, McpError, money, productChildren, productsOf,
  productView, requireFeature, requireMoney, requireWrite, str, type ToolDef, workspaceOf, writeOpts,
} from '../kit.ts';

/** A whole number a caller typed, inside bounds, or a complaint naming the field. */
function whole(raw: unknown, field: string, min: number, max: number): number {
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed)) throw new McpError(`Cannot read "${raw}" as a number for ${field}`);
  if (parsed < min || parsed > max) throw new McpError(`${field} must be between ${min} and ${max}`);
  return parsed;
}

/**
 * A percentage a caller typed, as basis points.
 *
 * Every proportion crossing this boundary is a percentage and every one stored
 * is basis points, in one place, because the alternative is a tool that takes
 * `5` and a tool that takes `500` for the same 5% and no way for a reader of
 * the schema to tell which is which.
 */
const bps = (raw: unknown, field: string, min = -100, max = 10_000): number =>
  Math.round(whole(Number(raw) * 100, field, min * 100, max * 100));

/** The one place a catalogue answer decides which horizon it is speaking about. */
const horizon = (args: Record<string, any>) => ({
  months: args.months === undefined ? DEFAULT_ASSUMPTIONS.months : whole(args.months, 'months', 1, 120),
  deliveries: args.deliveries === undefined ? DEFAULT_ASSUMPTIONS.deliveries : whole(args.deliveries, 'deliveries', 0, 1000),
});

export const productTools: ToolDef[] = [
  {
    name: 'list_products',
    title: 'List products',
    description:
      'The catalogue with the figures it is read for: the price, what one unit costs, the margin, '
      + 'how much has to be sold to break even over the horizon, and what a customer is worth. '
      + 'Optionally narrowed to one group or one status.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Product group id or name' },
        status: { type: 'string', enum: [...PRODUCT_STATUS] },
        kind: { type: 'string', enum: [...PRODUCT_KINDS], description: 'single, or bundle for packages' },
        months: { type: 'number', description: 'Horizon the break-even is over. Defaults to 12' },
        deliveries: { type: 'number', description: 'Deliveries over that horizon. Defaults to 1' },
        include_archived: { type: 'boolean' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'products');
      const groups = all<Row>(`SELECT * FROM product_groups WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId);
      const wanted = str(args.group)?.toLowerCase();
      const group = wanted
        ? groups.find((row) => row.id === args.group || String(row.name).toLowerCase() === wanted)
        : null;
      if (wanted && !group) throw new McpError(`No product group "${args.group}" in this workspace`);

      const { entries } = catalogueOf(workspaceId, horizon(args));
      const shown = entries
        .filter((entry) => (args.include_archived ? true : !Number(entry.product.archived)))
        .filter((entry) => (args.status ? entry.product.status === args.status : true))
        .filter((entry) => (args.kind ? entry.product.kind === args.kind : true))
        .filter((entry) => (group ? entry.product.group_id === group.id : true));

      return {
        products: shown.map(productView),
        groups: groups.map((row) => ({ id: row.id, name: row.name, description: row.description })),
        total: shown.length,
      };
    },
  },
  {
    name: 'product_status',
    title: 'Product in full',
    description:
      'One product with everything behind the headline: every price, every cost by what it varies '
      + 'with, the external contributors and their fees, the capabilities, the parts if it is a '
      + 'package, the campaigns running against it, and the break-even and retention figures.',
    readOnly: true,
    schema: {
      type: 'object',
      required: ['product'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code' },
        months: { type: 'number', description: 'Horizon the break-even is over. Defaults to 12' },
        deliveries: { type: 'number', description: 'Deliveries over that horizon. Defaults to 1' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'products');
      const found = findProduct(String(args.product), workspaceId);
      const { entries, prices, today } = catalogueOf(workspaceId, horizon(args));
      const entry = entries.find((row) => row.product.id === found.id);
      if (!entry) throw new McpError(`No product "${args.product}" in this workspace`);
      const currency = entry.economics.currency;

      const capabilities = all<Row>(
        `SELECT * FROM product_capabilities WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId,
      );
      const parts = productChildren('productPart', String(found.id));
      const named = new Map(productsOf(workspaceId).map((row) => [String(row.id), String(row.name)]));

      const own = prices.get(String(found.id)) ?? [];
      /*
       * Which row `priceFor` would actually pick today, at quantity one. Said
       * on the price rather than left to the reader: a product with four prices
       * hands a model four amounts, and the one it quotes will otherwise be
       * whichever it saw first — which is the cheapest as often as not.
       */
      const applied = priceFor(own, { on: today });

      return {
        ...productView(entry),
        description: found.description,
        prices: own.map((price) => ({
          id: price.id,
          name: price.name,
          kind: price.kind,
          ...money(currency, { amount: price.amount }),
          min_quantity: price.min_quantity,
          recurrence: price.recurrence,
          valid: `${price.valid_from ?? '…'} → ${price.valid_to ?? '…'}`,
          applies_now: applied?.id === price.id,
        })),
        costs: productChildren('productCost', String(found.id)).map((cost) => ({
          id: cost.id,
          name: cost.name,
          category: cost.category,
          basis: cost.basis,
          ...money(currency, { amount: Number(cost.amount) }),
          vendor: cost.vendor,
        })),
        contributors: productChildren('productContributor', String(found.id)).map((person) => ({
          id: person.id,
          name: person.name,
          role: person.role,
          organisation: person.organisation,
          email: person.email,
          fee_basis: person.fee_basis,
          ...money(currency, { fee: Number(person.fee) }),
        })),
        price_history: priceHistory(own).map((change) => ({
          on: change.on,
          name: change.to.name || null,
          kind: change.to.kind,
          recurrence: change.to.recurrence,
          ...money(currency, { was: change.from.amount, now: change.to.amount, change: change.delta }),
          change_percent: change.deltaBps === null ? null : Math.round(change.deltaBps / 100),
        })),
        /* Two prices live at once for the same offer. Reported rather than
           resolved: which was meant is not ours to guess. */
        overlapping_prices: overlappingPrices(own).map(([a, b]) => [a.id, b.id]),
        capabilities: (entry.product.capabilities ?? [])
          .map((id) => capabilities.find((row) => row.id === id))
          .filter((row): row is Row => !!row)
          .map((row) => ({ id: row.id, name: row.name, description: row.description })),
        parts: parts.map((part) => ({
          id: part.id,
          product_id: part.part_id,
          name: named.get(String(part.part_id)) ?? null,
          quantity: part.quantity,
        })),
        /*
         * Only for a package, and null rather than an empty object for a single
         * product: a saving of nothing and a product that cannot have one read
         * the same in JSON and are not the same claim.
         */
        bundle: entry.product.kind !== 'bundle' ? null : ((): Record<string, unknown> => {
          const value = bundleValue({
            parts: parts as unknown as Parameters<typeof bundleValue>[0]['parts'],
            pricesOf: (id) => prices.get(id) ?? [],
            price: entry.economics.price,
            on: today,
          });
          return {
            ...money(currency, { list_value: value.listValue, saving: value.saving ?? 0 }),
            saving_percent: value.savingBps === null ? null : Math.round(value.savingBps / 100),
            unpriced_parts: value.unpriced,
          };
        })(),
      };
    },
  },
  {
    name: 'create_product',
    title: 'Create a product',
    description:
      'Add something the organisation sells. `scope_amount` and `scope_unit` are the Umfang — '
      + '"2 Tage", "12 Monate" — and `capacity` is how many units one delivery can take, which is '
      + 'what stops a simulation forecasting seats a room does not have. Use `kind: "bundle"` for '
      + 'a package and `add_product_part` to fill it.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        code: { type: 'string', description: 'Short handle, e.g. SEM-PM-2' },
        description: { type: 'string' },
        kind: { type: 'string', enum: [...PRODUCT_KINDS] },
        status: { type: 'string', enum: [...PRODUCT_STATUS] },
        group: { type: 'string', description: 'Product group id or name' },
        currency: { type: 'string', description: 'ISO 4217, e.g. EUR. Defaults to EUR' },
        unit_label: { type: 'string', description: 'What one sold unit is: Platz, Lizenz, Tag' },
        scope_amount: { type: 'number' },
        scope_unit: { type: 'string', description: 'Tage, Monate, Stunden' },
        capacity: { type: 'number', description: 'Units one delivery can take. Omit for no ceiling' },
        billing: { type: 'string', enum: [...COST_RECURRENCES], description: 'How `price` is charged. once is a sale, the rest a subscription. A product sold in several periods gets a `set_product_price` per period' },
        term_months: { type: 'number', description: 'Minimum commitment. 0 is none' },
        renewal: { type: 'string', enum: [...RENEWALS] },
        churn_percent: { type: 'number', description: 'Customers lost per month, e.g. 3.5' },
        acquisition_cost: { type: 'string', description: 'What winning one customer costs' },
        price: { type: 'string', description: 'The list price, if it is known. Adds a price row' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');

      const wanted = str(args.group)?.toLowerCase();
      const group = wanted
        ? all<Row>(`SELECT * FROM product_groups WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
          .find((row) => row.id === args.group || String(row.name).toLowerCase() === wanted)
        : null;
      if (wanted && !group) throw new McpError(`No product group "${args.group}" in this workspace`);

      /*
       * The period belongs to the price, not to the product — the same product
       * is sold monthly and yearly at once. Kept as an argument here because
       * this call also makes the first price, and that price needs one.
       */
      const billing = (COST_RECURRENCES as readonly string[]).includes(String(args.billing)) ? String(args.billing) : 'once';
      const { row } = writeEntity('product', uid(), {
        workspace_id: workspaceId,
        group_id: group ? group.id : null,
        name: String(args.name).trim(),
        code: str(args.code) ?? null,
        description: str(args.description) ?? null,
        kind: (PRODUCT_KINDS as readonly string[]).includes(String(args.kind)) ? args.kind : 'single',
        status: (PRODUCT_STATUS as readonly string[]).includes(String(args.status)) ? args.status : 'draft',
        currency: String(args.currency ?? 'EUR').trim().toUpperCase(),
        unit_label: str(args.unit_label) ?? null,
        scope_amount: args.scope_amount === undefined ? 0 : whole(args.scope_amount, 'scope_amount', 0, 1_000_000),
        scope_unit: str(args.scope_unit) ?? null,
        capacity: args.capacity === undefined ? null : whole(args.capacity, 'capacity', 1, 1_000_000),
        term_months: args.term_months === undefined ? 0 : whole(args.term_months, 'term_months', 0, 600),
        renewal: (RENEWALS as readonly string[]).includes(String(args.renewal)) ? args.renewal : 'none',
        churn_bps: args.churn_percent === undefined ? 0 : bps(args.churn_percent, 'churn_percent', 0, 100),
        acquisition_cost: args.acquisition_cost === undefined ? 0 : requireMoney(args.acquisition_cost, 'acquisition_cost'),
        capabilities: [],
        archived: 0,
      }, writeOpts(workspaceId, ctx));

      /*
       * The price is written as a row rather than as a column, because that is
       * where a price lives — see `ProductPrice`. Offered on create anyway,
       * because "add the product then add its price" is two round trips for the
       * thing everybody does first, and a product with no price at all reads as
       * unpriced in every answer until the second one lands.
       */
      if (args.price !== undefined) {
        writeEntity('productPrice', uid(), {
          workspace_id: workspaceId,
          product_id: row.id,
          name: 'List',
          kind: 'list',
          amount: requireMoney(args.price, 'price'),
          min_quantity: 1,
          recurrence: billing,
          sort_order: orderKey(null, null),
        }, writeOpts(workspaceId, ctx));
      }

      return { id: row.id, name: row.name, currency: row.currency, url: `${env.publicUrl}/products/${row.id}` };
    },
  },
  {
    name: 'set_product_price',
    title: 'Price a product',
    description:
      'Add a price to a product. A product may have several: the published one, a volume price '
      + 'that applies from `min_quantity` upward, a partner price, and an internal transfer price '
      + 'that never counts as revenue. Which one applies to an order is worked out from the '
      + 'quantity and the day, so they can all exist at once.',
    schema: {
      type: 'object',
      required: ['product', 'amount'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code' },
        amount: { type: 'string', description: 'Per unit, e.g. "1450" or "1.450,00"' },
        name: { type: 'string', description: 'What this price is called, e.g. "Frühbucher"' },
        kind: { type: 'string', enum: [...PRICE_KINDS] },
        min_quantity: { type: 'number', description: 'Smallest order it applies to. Defaults to 1' },
        recurrence: { type: 'string', enum: [...COST_RECURRENCES] },
        valid_from: { type: 'string', description: 'YYYY-MM-DD' },
        valid_to: { type: 'string', description: 'YYYY-MM-DD' },
        note: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const product = findProduct(String(args.product), workspaceId);

      const { row } = writeEntity('productPrice', uid(), {
        workspace_id: workspaceId,
        product_id: product.id,
        name: str(args.name) ?? '',
        kind: (PRICE_KINDS as readonly string[]).includes(String(args.kind)) ? args.kind : 'list',
        amount: requireMoney(args.amount, 'amount'),
        min_quantity: args.min_quantity === undefined ? 1 : whole(args.min_quantity, 'min_quantity', 1, 1_000_000),
        recurrence: (COST_RECURRENCES as readonly string[]).includes(String(args.recurrence))
          ? args.recurrence
          // A product no longer carries a period, so a price that does not name
          // one is a sale. Naming it is the ordinary case and the schema says so.
          : 'once',
        valid_from: isoDay(args.valid_from, 'valid_from'),
        valid_to: isoDay(args.valid_to, 'valid_to'),
        note: str(args.note) ?? null,
        sort_order: orderKey(lastChildOrder('product_prices', String(product.id)), null),
      }, writeOpts(workspaceId, ctx));

      return {
        id: row.id,
        product: product.name,
        ...money(String(product.currency), { amount: Number(row.amount) }),
        kind: row.kind,
        min_quantity: row.min_quantity,
      };
    },
  },
  {
    name: 'change_product_price',
    title: 'Change a price, keeping the old one as history',
    description:
      'Raise or cut a price from a given day. Two rows in one step: the current price stops the '
      + 'day before the new one starts, so the old amount stays readable as history and no two '
      + 'prices are ever live at once for the same offer. Use this rather than editing an amount '
      + 'in place — an edited price loses what it used to be, and a second `set_product_price` '
      + 'without closing the first leaves both applicable.',
    schema: {
      type: 'object',
      required: ['product', 'amount'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code' },
        amount: { type: 'string', description: 'The new amount, e.g. "59" or "1.450,00"' },
        from: { type: 'string', description: 'YYYY-MM-DD the new price starts. Defaults to today' },
        price: { type: 'string', description: 'Which price, by id or name. Defaults to the one that applies today' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const product = findProduct(String(args.product), workspaceId);
      const today = new Date().toISOString().slice(0, 10);
      const on = isoDay(args.from, 'from') ?? today;

      const prices = productChildren('productPrice', String(product.id)) as unknown as ProductPrice[];
      const wanted = str(args.price)?.toLowerCase();
      const current = wanted
        ? prices.find((row) => row.id === args.price || row.name.toLowerCase() === wanted)
        : priceFor(prices, { on: today });
      if (!current) {
        throw new McpError(wanted
          ? `No price "${args.price}" on ${product.name}`
          : `${product.name} has no price that applies today — use set_product_price to give it one`);
      }

      /* `raisePrice` throws on a day outside the old window; ask first so the
         answer names which end rather than arriving as an internal error. */
      const refusal = priceChangeRefusal(current, on);
      if (refusal === 'before-start') {
        throw new McpError(`"${current.name || product.name}" only starts on ${current.valid_from} — a change has to take effect after that`);
      }
      if (refusal === 'after-end') {
        throw new McpError(`"${current.name || product.name}" already ends on ${current.valid_to} — use set_product_price for a new one rather than changing a price that has stopped`);
      }

      const { closes, opens } = raisePrice(current, { amount: requireMoney(args.amount, 'amount'), on });
      writeEntity('productPrice', closes.id, { valid_to: closes.valid_to }, writeOpts(workspaceId, ctx));
      const { row } = writeEntity('productPrice', uid(), {
        ...opens,
        sort_order: orderKey(lastChildOrder('product_prices', String(product.id)), null),
      }, writeOpts(workspaceId, ctx));

      return {
        product: product.name,
        ...money(String(product.currency), { was: current.amount, now: Number(row.amount), change: Number(row.amount) - current.amount }),
        change_percent: current.amount === 0 ? null : Math.round(((Number(row.amount) - current.amount) * 100) / current.amount),
        old_price_ends: closes.valid_to,
        new_price_starts: on,
        new_price_id: row.id,
      };
    },
  },
  {
    name: 'add_product_cost',
    title: 'Cost a product',
    description:
      'Add a cost to a product. `basis` is the field a break-even is made of: `period` is incurred '
      + 'every month whatever is sold, `delivery` each time it is delivered whoever attends, and '
      + '`unit` per unit sold — only the last comes off the price. The category speaks the same '
      + 'vocabulary a budget line does, so the two can be read side by side.',
    schema: {
      type: 'object',
      required: ['product', 'name', 'amount'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code' },
        name: { type: 'string' },
        amount: { type: 'string', description: 'Per period, per delivery or per unit — see basis' },
        basis: { type: 'string', enum: [...COST_BASIS] },
        category: { type: 'string', enum: [...COST_CATEGORIES] },
        vendor: { type: 'string' },
        note: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const product = findProduct(String(args.product), workspaceId);

      const { row } = writeEntity('productCost', uid(), {
        workspace_id: workspaceId,
        product_id: product.id,
        name: String(args.name).trim(),
        category: (COST_CATEGORIES as readonly string[]).includes(String(args.category)) ? args.category : 'other',
        basis: (COST_BASIS as readonly string[]).includes(String(args.basis)) ? args.basis : 'unit',
        amount: requireMoney(args.amount, 'amount'),
        vendor: str(args.vendor) ?? null,
        note: str(args.note) ?? null,
        sort_order: orderKey(lastChildOrder('product_costs', String(product.id)), null),
      }, writeOpts(workspaceId, ctx));

      return {
        id: row.id,
        product: product.name,
        basis: row.basis,
        ...money(String(product.currency), { amount: Number(row.amount) }),
      };
    },
  },
  {
    name: 'add_product_contributor',
    title: 'Add an external contributor',
    description:
      'Record somebody outside the organisation who is part of the product — an external speaker, '
      + 'a trainer, a subcontracted specialist — with what they are paid and on what basis. Their '
      + 'fee counts as a cost of exactly that basis, so it lands in the margin and the break-even '
      + 'without being entered twice.',
    schema: {
      type: 'object',
      required: ['product', 'name'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code' },
        name: { type: 'string' },
        role: { type: 'string', description: 'Referent, Trainerin, Co-Autor' },
        organisation: { type: 'string' },
        email: { type: 'string' },
        fee: { type: 'string', description: 'What they are paid, per fee_basis' },
        fee_basis: { type: 'string', enum: [...COST_BASIS], description: 'Defaults to delivery' },
        note: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const product = findProduct(String(args.product), workspaceId);

      const { row } = writeEntity('productContributor', uid(), {
        workspace_id: workspaceId,
        product_id: product.id,
        name: String(args.name).trim(),
        role: str(args.role) ?? null,
        organisation: str(args.organisation) ?? null,
        email: str(args.email) ?? null,
        fee: args.fee === undefined ? 0 : requireMoney(args.fee, 'fee'),
        fee_basis: (COST_BASIS as readonly string[]).includes(String(args.fee_basis)) ? args.fee_basis : 'delivery',
        note: str(args.note) ?? null,
        sort_order: orderKey(lastChildOrder('product_contributors', String(product.id)), null),
      }, writeOpts(workspaceId, ctx));

      return {
        id: row.id,
        product: product.name,
        name: row.name,
        fee_basis: row.fee_basis,
        ...money(String(product.currency), { fee: Number(row.fee) }),
      };
    },
  },
  {
    name: 'add_product_part',
    title: 'Put a product in a package',
    description:
      'Add a product to a package. The package keeps its own price; what the parts are worth '
      + 'separately is computed, so the discount — or the premium — is visible rather than '
      + 'implied. A package cannot contain itself at any depth.',
    schema: {
      type: 'object',
      required: ['package', 'product'],
      properties: {
        package: { type: 'string', description: 'The package: product id, name or code' },
        product: { type: 'string', description: 'What goes in it' },
        quantity: { type: 'number', description: 'How many of it. Defaults to 1' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const container = findProduct(String(args.package), workspaceId);
      const part = findProduct(String(args.product), workspaceId);

      const { row } = writeEntity('productPart', uid(), {
        workspace_id: workspaceId,
        product_id: container.id,
        part_id: part.id,
        quantity: args.quantity === undefined ? 1 : whole(args.quantity, 'quantity', 1, 1_000_000),
        sort_order: orderKey(lastChildOrder('product_parts', String(container.id)), null),
      }, writeOpts(workspaceId, ctx));

      /*
       * A package that still says `single` is one whose parts nothing renders,
       * so putting something in one is what makes it a package. Said here
       * rather than left to the caller, because the alternative is a product
       * with parts that no screen shows and nobody can see why.
       */
      if (container.kind !== 'bundle') {
        writeEntity('product', String(container.id), { kind: 'bundle' }, writeOpts(workspaceId, ctx));
      }

      return { id: row.id, package: container.name, product: part.name, quantity: row.quantity };
    },
  },
  {
    name: 'list_promotions',
    title: 'List campaigns',
    description:
      'Promotions in the workspace: what they take off, what they apply to, what running them '
      + 'costs, and whether they are running today. The phase is worked out from the dates rather '
      + 'than stored, so it is never a day out of date.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...PROMOTION_STATUS] },
        running: { type: 'boolean', description: 'Only the ones live and inside their dates today' },
        product: { type: 'string', description: 'Only the ones covering this product' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'products');
      const today = new Date().toISOString().slice(0, 10);
      const product = str(args.product) ? findProduct(String(args.product), workspaceId) : null;

      const rows = all<Row>(`SELECT * FROM promotions WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
        .map((row) => serialize('promotion', row) as unknown as Promotion)
        .filter((row) => (args.status ? row.status === args.status : true))
        .filter((row) => (args.running ? promotionPhase(row, today) === 'running' : true))
        .filter((row) => {
          if (!product) return true;
          const scoped = row.products ?? [];
          const groups = row.groups ?? [];
          if (!scoped.length && !groups.length) return true;
          return scoped.includes(String(product.id))
            || (!!product.group_id && groups.includes(String(product.group_id)));
        });

      return {
        promotions: rows.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          // Percent as a percentage, everything else as money: the value column
          // means two different things and one label for both is a trap.
          value: row.kind === 'percent' ? `${row.value / 100}%` : formatMoney(row.value, row.currency, 'en'),
          window: `${row.starts_on ?? '…'} → ${row.ends_on ?? '…'}`,
          phase: promotionPhase(row, today),
          status: row.status,
          products: row.products,
          groups: row.groups,
          uplift_percent: row.uplift_bps / 100,
          ...money(row.currency, { spend: row.spend }),
        })),
        total: rows.length,
      };
    },
  },
  {
    name: 'create_promotion',
    title: 'Create a campaign',
    description:
      'Plan a promotion: a discount over a window, what it applies to, what running it costs and '
      + 'how much more it is expected to sell. Leave both `products` and `groups` out and it '
      + 'covers the whole catalogue. It is a draft until `status` says otherwise, and nothing '
      + 'applies it to a price until a simulation names it.',
    schema: {
      type: 'object',
      required: ['name', 'kind', 'value'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        kind: { type: 'string', enum: [...PROMOTION_KINDS], description: 'percent off, amount off, or a fixed price' },
        value: { type: 'string', description: 'A percentage for `percent`, otherwise an amount' },
        starts_on: { type: 'string', description: 'YYYY-MM-DD' },
        ends_on: { type: 'string', description: 'YYYY-MM-DD' },
        products: { type: 'array', items: { type: 'string' }, description: 'Product ids, names or codes' },
        groups: { type: 'array', items: { type: 'string' }, description: 'Product group ids or names' },
        spend: { type: 'string', description: 'What running it costs' },
        uplift_percent: { type: 'number', description: 'Expected extra volume, e.g. 25' },
        status: { type: 'string', enum: [...PROMOTION_STATUS] },
        currency: { type: 'string' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');

      const kind = (PROMOTION_KINDS as readonly string[]).includes(String(args.kind)) ? String(args.kind) : 'percent';
      const groups = all<Row>(`SELECT * FROM product_groups WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId);
      /*
       * Resolved by name here rather than stored as typed, and an unknown one
       * is an error. A campaign that quietly covers fewer products than asked
       * for is a campaign whose figures are wrong in the flattering direction —
       * the same call `allocationsFromArgs` makes about a project split.
       */
      const named = (refs: unknown, resolve: (ref: string) => string): string[] =>
        (Array.isArray(refs) ? refs : []).filter((ref): ref is string => typeof ref === 'string' && !!ref.trim())
          .map((ref) => resolve(ref.trim()));

      const { row } = writeEntity('promotion', uid(), {
        workspace_id: workspaceId,
        name: String(args.name).trim(),
        description: str(args.description) ?? null,
        kind,
        value: kind === 'percent' ? bps(args.value, 'value', 0, 100) : requireMoney(args.value, 'value'),
        starts_on: isoDay(args.starts_on, 'starts_on'),
        ends_on: isoDay(args.ends_on, 'ends_on'),
        products: named(args.products, (ref) => String(findProduct(ref, workspaceId).id)),
        groups: named(args.groups, (ref) => {
          const wanted = ref.toLowerCase();
          const found = groups.find((group) => group.id === ref || String(group.name).toLowerCase() === wanted);
          if (!found) throw new McpError(`No product group "${ref}" in this workspace`);
          return String(found.id);
        }),
        spend: args.spend === undefined ? 0 : requireMoney(args.spend, 'spend'),
        uplift_bps: args.uplift_percent === undefined ? 0 : bps(args.uplift_percent, 'uplift_percent', -100, 10_000),
        status: (PROMOTION_STATUS as readonly string[]).includes(String(args.status)) ? args.status : 'draft',
        currency: String(args.currency ?? 'EUR').trim().toUpperCase(),
      }, writeOpts(workspaceId, ctx));

      return { id: row.id, name: row.name, kind: row.kind, status: row.status, url: `${env.publicUrl}/products?tab=promotions` };
    },
  },
  {
    name: 'simulate_product',
    title: 'Simulate a product',
    description:
      'Project a product forward month by month under one set of assumptions: volume and its '
      + 'growth, a price or cost adjustment, how often it is delivered, and which campaigns are '
      + 'running. Answers with the month the cumulative margin turns positive, what was turned '
      + 'away by capacity, and the whole series. Nothing is written — the prices and costs it '
      + 'reads are untouched. Pass `scenario` to run one that was saved, or the fields to run an '
      + 'ad-hoc one.',
    readOnly: true,
    schema: {
      type: 'object',
      required: ['product'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code' },
        scenario: { type: 'string', description: 'A saved scenario id or name to run instead' },
        months: { type: 'number', description: 'How far to project. Defaults to 12' },
        units: { type: 'number', description: 'Units sold in the first month' },
        growth_percent: { type: 'number', description: 'Month on month change in units, e.g. 5' },
        price_percent: { type: 'number', description: 'Move the price by this, e.g. -10' },
        cost_percent: { type: 'number', description: 'Move every cost by this' },
        deliveries: { type: 'number', description: 'Deliveries a month. Defaults to 1' },
        promotions: { type: 'array', items: { type: 'string' }, description: 'Campaign ids or names to apply' },
        churn_percent: { type: 'number', description: 'Use this monthly churn instead of the product\'s own' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'products');
      const found = findProduct(String(args.product), workspaceId);
      const product = serialize('product', found) as unknown as Product;
      const today = new Date().toISOString().slice(0, 10);

      const promotions = all<Row>(`SELECT * FROM promotions WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
        .map((row) => serialize('promotion', row) as unknown as Promotion);

      /*
       * A saved scenario is the floor, not the whole answer: the arguments are
       * laid over it, so "run the summer scenario but with eight deliveries" is
       * one call. Without that, comparing two numbers means saving a scenario
       * for each, and nobody does that in a conversation.
       */
      let saved: ProductAssumptions = {};
      if (str(args.scenario)) {
        const wanted = String(args.scenario).toLowerCase();
        const row = all<Row>(`SELECT * FROM product_scenarios WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
          .find((candidate) => candidate.id === args.scenario || String(candidate.name).toLowerCase() === wanted);
        if (!row) throw new McpError(`No scenario "${args.scenario}" in this workspace`);
        saved = (serialize('productScenario', row) as unknown as { assumptions: ProductAssumptions }).assumptions ?? {};
      }

      const named = (Array.isArray(args.promotions) ? args.promotions : [])
        .filter((ref: unknown): ref is string => typeof ref === 'string' && !!ref.trim())
        .map((ref: string) => {
          const wanted = ref.trim().toLowerCase();
          const found2 = promotions.find((row) => row.id === ref.trim() || row.name.toLowerCase() === wanted);
          if (!found2) throw new McpError(`No promotion "${ref}" in this workspace`);
          return found2.id;
        });

      const assumptions: ProductAssumptions = {
        ...saved,
        ...(args.months === undefined ? {} : { months: whole(args.months, 'months', 1, 120) }),
        ...(args.units === undefined ? {} : { units: whole(args.units, 'units', 0, 1_000_000) }),
        ...(args.growth_percent === undefined ? {} : { growth_bps: bps(args.growth_percent, 'growth_percent') }),
        ...(args.price_percent === undefined ? {} : { price_bps: bps(args.price_percent, 'price_percent') }),
        ...(args.cost_percent === undefined ? {} : { cost_bps: bps(args.cost_percent, 'cost_percent') }),
        ...(args.deliveries === undefined ? {} : { deliveries: whole(args.deliveries, 'deliveries', 0, 1000) }),
        ...(named.length ? { promotions: named } : {}),
        ...(args.churn_percent === undefined ? {} : { churn_bps: bps(args.churn_percent, 'churn_percent', 0, 100) }),
      };

      /*
       * The parts too, and the resolver that reads what each of them costs.
       * A package simulated without them is a package that costs nothing to
       * deliver, which is the most flattering wrong answer available here.
       */
      const unitCostOfPart = unitCosts({
        costsOf: (id: string) => productChildren('productCost', id) as unknown as ProductCost[],
        contributorsOf: (id: string) => productChildren('productContributor', id) as unknown as ProductContributor[],
        partsOf: (id: string) => productChildren('productPart', id) as unknown as ProductPart[],
      });

      const result = simulate({
        product,
        prices: productChildren('productPrice', String(found.id)) as unknown as ProductPrice[],
        costs: productChildren('productCost', String(found.id)) as unknown as ProductCost[],
        contributors: productChildren('productContributor', String(found.id)) as unknown as ProductContributor[],
        parts: productChildren('productPart', String(found.id)) as unknown as ProductPart[],
        unitCostOfPart,
        promotions,
        assumptions,
        today,
      });
      const settled = assumptionsOf(assumptions);

      return {
        product: product.name,
        assumptions: {
          months: settled.months,
          units: settled.units,
          growth_percent: settled.growth_bps / 100,
          price_percent: settled.price_bps / 100,
          cost_percent: settled.cost_bps / 100,
          deliveries: settled.deliveries,
          promotions: result.promotions,
          churn_percent: (settled.churn_bps ?? product.churn_bps) / 100,
        },
        ...money(result.currency, {
          list_price: result.listPrice ?? 0,
          price: result.price ?? 0,
          unit_cost: result.unitCost,
          revenue: result.revenue,
          cost: result.cost,
          margin: result.margin,
        }),
        ...(result.price === null ? { price: null, price_text: null, list_price: null, list_price_text: null } : {}),
        break_even_month: result.breakEvenMonth,
        turned_away: result.turnedAway,
        months: result.months.map((month) => ({
          month: month.month,
          units: month.units,
          active: month.active,
          ...money(result.currency, {
            revenue: month.revenue, cost: month.cost, margin: month.margin, cumulative: month.cumulative,
          }),
        })),
      };
    },
  },
  {
    name: 'retention_outlook',
    title: 'Retention and lifetime value',
    description:
      'What a customer of each product is worth and how long they stay, from the churn and the '
      + 'acquisition cost recorded against it. Everything here is an assumption — nothing in '
      + 'Kolibri counts customers — so the answer says which numbers it was given and which it '
      + 'could not compute.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'One product. Omit for every subscription product' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'products');
      const { entries } = catalogueOf(workspaceId);
      const wanted = str(args.product) ? String(findProduct(String(args.product), workspaceId).id) : null;

      const rows = entries
        .filter((entry) => (wanted ? entry.product.id === wanted : !Number(entry.product.archived)))
        .map((entry) => {
          const retention = retentionOf({
            product: entry.product,
            contribution: entry.economics.contribution,
            recurrence: entry.periods.find((every) => every !== 'once') ?? 'once',
          });
          return {
            id: entry.product.id,
            name: entry.product.name,
            periods: entry.periods,
            renewal: entry.product.renewal,
            term_months: entry.product.term_months,
            churn_percent: entry.product.churn_bps / 100,
            expected_months: retention.months,
            ...money(entry.economics.currency, {
              monthly_contribution: retention.monthly ?? 0,
              lifetime_value: retention.value ?? 0,
              acquisition_cost: entry.product.acquisition_cost,
            }),
            ...(retention.value === null ? { lifetime_value: null, lifetime_value_text: null } : {}),
            payback_months: retention.payback,
            /*
             * Named rather than left as a null the caller has to interpret. A
             * model that sees `lifetime_value: null` will guess why; this says
             * so, and the two reasons need different answers from a person.
             */
            missing: [
              entry.economics.price === null ? 'price' : null,
              entry.product.churn_bps === 0 && entry.product.renewal !== 'none' ? 'churn' : null,
            ].filter((reason): reason is string => !!reason),
          };
        });

      return { products: rows, total: rows.length };
    },
  },
];
