/**
 * What is sold, what it is worth, and what it would take to sell more of it.
 *
 * A deliberate asymmetry runs through them: every read answers with
 * the *derived* figures — margin, break-even, lifetime value — rather than with
 * the rows, because an assistant handed four price rows and eleven cost rows
 * will do the arithmetic itself and get a different answer from the screen.
 * The arithmetic lives in `@kolibri/shared` and both sides call it.
 */
import {
  assumptionsOf, capabilitiesOf, capabilityKey, capabilityName,
  COST_BASIS, COST_CATEGORIES, COST_RECURRENCES, DEFAULT_ASSUMPTIONS,
  formatMoney, healthOfProduct, orderKey, overlappingPrices, PRICE_KINDS, priceChangeRefusal, priceFor,
  priceHistory,
  PRODUCT_KINDS, PRODUCT_STATUS, PROMOTION_KINDS, PROMOTION_STATUS, promotionPhase, raisePrice, RENEWALS,
  retentionOf, simulate, unitCosts, type ProductAssumptions,
  type ProductContributor, type ProductCost, type ProductPart, type ProductPrice, type Promotion, type Product,
} from '@kolibri/shared';
import { all, type Row } from '../../../kernel/platform/db/index.ts';
import { env } from '../../../kernel/platform/env.ts';
import { deleteEntity, serialize, writeEntity } from '../../../kernel/write-path/repo.ts';
import { uid } from '../../../kernel/platform/ids.ts';
import {
  catalogueOf, findProduct, isoDay, lastChildOrder, McpError, money, PRODUCT_CHILD_TABLES, productChildren,
  productsOf, productView, requireFeature, requireMoney, requireWrite, str, type ProductChild, type ToolDef,
  workspaceOf, writeOpts,
} from '../kit.ts';

/**
 * One of a product's children, by its id or by the name somebody gave it.
 *
 * Scoped to the product on purpose. "The RTB cost" means nothing across a
 * workspace and everything inside one product, and a lookup that searched wider
 * would edit a row on a product the caller never named — the one mistake a
 * changing tool must not make, because unlike a create it destroys what was
 * there.
 */
function findChild(
  entity: ProductChild,
  product: Row,
  ref: string,
  label: string,
): Row {
  const rows = productChildren(entity, String(product.id));
  const wanted = ref.trim().toLowerCase();
  const found = rows.find((row) => String(row.id) === ref.trim())
    ?? rows.find((row) => String(row.name ?? '').trim().toLowerCase() === wanted);
  if (!found) {
    throw new McpError(rows.length
      ? `No ${label} "${ref}" on ${product.name}. It has: ${rows.map((row) => String(row.name ?? row.id)).join(', ')}`
      : `${product.name} has no ${label} at all`);
  }
  return found;
}

/**
 * The product a child is on, and the child — with the product optional.
 *
 * Naming the product was documented as optional and was not: the fallback read
 * `args.product ?? args.price` and looked the *price* up as a product, so a
 * caller who had a price id and nothing else was told "No product
 * \"pr_9f2…\" in this workspace" — a true sentence about the wrong noun, and
 * no way forward from it. An id is unique on its own, so it answers which
 * product it is on. A name is not: "Setup" is a cost on four products, and
 * that path still needs the product named, which is now what it says.
 */
function findOn(
  entity: ProductChild,
  args: Record<string, any>,
  field: string,
  label: string,
  workspaceId: string,
): { product: Row; row: Row } {
  const ref = String(args[field] ?? '').trim();
  /*
   * `required` in a tool schema is advice to a client and nothing on this
   * boundary reads it — `index.ts` hands `params.arguments` straight to `run`.
   * So a call that simply omits the reference arrives here as an empty string,
   * and without this it is answered with `No price with id ""`, which reads
   * like a lookup that failed rather than an argument that was never sent.
   */
  if (!ref) throw new McpError(`Name the ${label}: \`${field}\` is required and was not given`);
  if (args.product !== undefined) {
    const product = findProduct(String(args.product), workspaceId);
    return { product, row: findChild(entity, product, ref, label) };
  }
  /*
   * Joined to `products` so the workspace bounds the lookup, not just the
   * `findProduct` below it. Without the join a child id from another workspace
   * came back and was refused one line later as "No product <its id> in this
   * workspace" — a refusal that confirms the row exists and names what it
   * hangs off. Same belt-and-braces `findTask` documents: scope the query, not
   * only the answer.
   */
  const owner = all<Row>(
    `SELECT c.product_id FROM ${PRODUCT_CHILD_TABLES[entity]} c JOIN products p ON p.id = c.product_id
     WHERE c.id = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.workspace_id = ?`,
    ref, workspaceId,
  )[0];
  if (!owner) {
    throw new McpError(
      `No ${label} with id "${ref}". If that is a name rather than an id, name the product too — `
      + `a ${label} name only means something inside one product.`,
    );
  }
  const product = findProduct(String(owner.product_id), workspaceId);
  return { product, row: findChild(entity, product, ref, label) };
}

/**
 * Text a caller typed, or a complaint. Never a coercion.
 *
 * `String(raw).trim()` is what the creating tools do, and on a create the worst
 * it costs is a row called `null` that somebody deletes. On an *update* the
 * same line overwrites the name that was there, so a client that sends JSON
 * null for a field it means to leave alone renames the product to the four
 * letters n-u-l-l and the old name is gone. Refusing costs one call; the
 * coercion costs the name.
 */
function requireText(raw: unknown, field: string): string {
  const value = str(raw);
  if (!value) throw new McpError(`\`${field}\` must be a non-empty string`);
  return value;
}

/**
 * What the write actually took, rather than what it was offered.
 *
 * The write path drops a field whose stored stamp is newer than this write's —
 * a browser whose clock runs fast leaves one behind, which is the case
 * `check:clocks` opens a second browser for — and a `changed` list built from
 * the patch names that field anyway. So it is measured against the row: what
 * is listed here moved. A field set to the value it already held does not
 * appear, which is the same word used truthfully.
 */
function changedFields(before: Row, after: Row, patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
}

/** The packages holding this product, by name. A cost that moves here moves their margin too. */
const containingPackages = (productId: string): string[] =>
  all<Row>(
    `SELECT p.name FROM product_parts pt JOIN products p ON p.id = pt.product_id
     WHERE pt.part_id = ? AND pt.deleted_at IS NULL AND p.deleted_at IS NULL`,
    productId,
  ).map((row) => String(row.name));

/**
 * One row of a package, by its id or by the name of the product in it.
 *
 * A part has no name of its own — it is a pointer — so it is found by the name
 * of the product inside it, which is what somebody reading the package sees.
 * Nothing stops a package holding the same product twice, so that name can
 * match two rows, and `find` answered the first of them: on `remove_product_part`
 * that is a coin flip about which row is destroyed. Two matches is a question,
 * so it is asked rather than guessed.
 */
function findPart(container: Row, ref: unknown, workspaceId: string): Row {
  const parts = productChildren('productPart', String(container.id));
  const wanted = String(ref ?? '').trim();
  const lowered = wanted.toLowerCase();
  const catalogue = productsOf(workspaceId);
  const nameOf = (row: Row) => String(catalogue.find((item) => item.id === row.part_id)?.name ?? row.part_id);
  const byId = parts.find((row) => String(row.id) === wanted);
  if (byId) return byId;
  const byName = parts.filter((row) => nameOf(row).toLowerCase() === lowered);
  if (byName.length > 1) {
    throw new McpError(
      `${container.name} holds ${nameOf(byName[0])} ${byName.length} times — name the row by its id: ${byName.map((row) => row.id).join(', ')}`,
    );
  }
  if (!byName.length) {
    throw new McpError(parts.length
      ? `No part "${ref}" in ${container.name}. It holds: ${parts.map(nameOf).join(', ')}`
      : `${container.name} holds nothing yet`);
  }
  return byName[0];
}

/** A campaign by its id or its name, scoped to the workspace. */
function findPromotion(ref: unknown, workspaceId: string): Row {
  const wanted = String(ref).trim();
  const lowered = wanted.toLowerCase();
  const found = all<Row>(`SELECT * FROM promotions WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
    .find((row) => String(row.id) === wanted || String(row.name).toLowerCase() === lowered);
  if (!found) throw new McpError(`No campaign "${ref}" in this workspace`);
  return found;
}

/** The workspace's capability vocabulary, in the order the screens show it. */
const capabilitiesIn = (workspaceId: string): Row[] => all<Row>(
  `SELECT * FROM product_capabilities WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
  workspaceId,
);

/**
 * One capability, by its id or by what it is called.
 *
 * Workspace-scoped, which is the opposite of `findChild` above and for the
 * opposite reason. A price named "List" means something only inside the product
 * that carries it; a capability is the one thing here that is deliberately
 * *shared* — "Online-Terminbuchung" has to mean the same on the module and on
 * every package holding it, or the comparison the vocabulary exists for stops
 * working.
 *
 * An unknown name is refused rather than created on the way past. The whole
 * value of a shared vocabulary is that there is one spelling of each entry, and
 * a tool that quietly adds one is how a catalogue ends up claiming both
 * "Online-Terminbuchung" and "Online Terminbuchung" and comparing neither.
 */
function findCapability(ref: unknown, known: readonly Row[]): Row {
  const wanted = requireText(ref, 'capability');
  const key = capabilityKey(wanted);
  const found = known.find((row) => String(row.id) === wanted)
    ?? known.find((row) => capabilityKey(String(row.name)) === key);
  if (found) return found;
  throw new McpError(
    known.length
      ? `No capability "${wanted}". This workspace knows: ${known.map((row) => `"${row.name}"`).join(', ')}. `
        + 'Add it with create_capability first.'
      : `No capability "${wanted}" — this workspace has none yet. Add one with create_capability.`,
  );
}

/**
 * Everything a product can do, its parts included, at any depth.
 *
 * `capabilitiesOf` in `@kolibri/shared` unions one product with its parts; this
 * feeds itself back in as `capabilitiesOfPart` so a package inside a package
 * still answers for what is at the bottom of it. Memoised and cycle-guarded for
 * the reason `unitCosts` is: the write path refuses a package that contains
 * itself, and a mirror can still hold a stale ring for the length of one sync.
 *
 * This exists because the two surfaces disagreed. The screen has always shown a
 * package the union — it is what the customer gets — while `product_status`
 * answered with the package's *own* list, which is empty for every package here
 * and reads as a package that does nothing.
 */
function capabilitySpread(
  known: ReadonlySet<string>,
  productOf: (id: string) => { capabilities?: readonly string[] } | undefined,
  partsOf: (id: string) => readonly ProductPart[],
): (productId: string) => string[] {
  const cache = new Map<string, string[]>();
  const walking = new Set<string>();
  const of = (productId: string): string[] => {
    const hit = cache.get(productId);
    if (hit) return hit;
    if (walking.has(productId)) return [];
    walking.add(productId);
    const union = capabilitiesOf({
      product: { capabilities: (productOf(productId)?.capabilities ?? []) as string[] },
      parts: partsOf(productId),
      capabilitiesOfPart: of,
      known,
    });
    walking.delete(productId);
    cache.set(productId, union);
    return union;
  };
  return of;
}

/**
 * The fields a caller actually named, as a patch.
 *
 * `undefined` means "not mentioned" and everything else — `null` included —
 * means "set it to this". Written once because every update tool here needs the
 * same distinction, and writing it out per field is how one of them eventually
 * clears something nobody asked to clear.
 */
function patchOf(args: Record<string, any>, fields: Record<string, (raw: any) => unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [name, read] of Object.entries(fields)) {
    if (args[name] !== undefined) patch[name] = read(args[name]);
  }
  return patch;
}

/** A value from a closed list, or a complaint naming what was allowed. */
function oneOf<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
  const value = String(raw);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new McpError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * An ISO 4217 code, or a complaint. Never a fallback.
 *
 * The write path snaps anything that is not three capitals to `EUR`
 * (`rules/products.ts`), which is right for sync traffic — a row has to land
 * somewhere — and wrong for a caller who typed the code. `currency: 'Dollars'`
 * would come back as a silently euro-denominated product with every amount
 * restated and nothing said. The form beside this uses a closed list for the
 * same reason, written down there: a field that corrects you without saying so.
 */
function currencyCode(raw: unknown): string {
  const code = requireText(raw, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new McpError(`\`currency\` must be a three-letter ISO 4217 code, not "${raw}"`);
  return code;
}

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
      const { entries, prices, today, parts: allParts } = catalogueOf(workspaceId, horizon(args));
      const entry = entries.find((row) => row.product.id === found.id);
      if (!entry) throw new McpError(`No product "${args.product}" in this workspace`);
      const currency = entry.economics.currency;

      const capabilities = all<Row>(
        `SELECT * FROM product_capabilities WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId,
      );
      const parts = productChildren('productPart', String(found.id));
      const named = new Map(productsOf(workspaceId).map((row) => [String(row.id), String(row.name)]));
      const byId = new Map(entries.map((row) => [String(row.product.id), row.product]));
      const spread = capabilitySpread(
        new Set(capabilities.map((row) => String(row.id))),
        (id) => byId.get(id),
        (id) => (allParts.get(id) ?? []) as readonly ProductPart[],
      );

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
          /* What the customer signs for, which for a catalogue of subscription
             modules is the only thing telling three rows apart: same kind, same
             threshold, same "monthly", three different commitments and three
             different amounts. Left out, this answer listed three prices and
             gave no way to say which was which. Null defers to the product's
             own term, and that is reported rather than resolved away. */
          term_months: price.term_months,
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
        price_history: priceHistory(own, Number(entry.product.term_months) || 0).map((change) => ({
          on: change.on,
          name: change.to.name || null,
          kind: change.to.kind,
          recurrence: change.to.recurrence,
          ...money(currency, { was: change.from.amount, now: change.to.amount, change: change.delta }),
          change_percent: change.deltaBps === null ? null : Math.round(change.deltaBps / 100),
        })),
        /* Two prices live at once for the same offer. Reported rather than
           resolved: which was meant is not ours to guess. */
        overlapping_prices: overlappingPrices(own, Number(entry.product.term_months) || 0).map(([a, b]) => [a.id, b.id]),
        /*
         * The union, not the row. A package claims its own capabilities plus
         * every part's — that is what the customer gets and what the screen has
         * always shown — so answering with the package's own list said "this
         * package does nothing" about every package in a real catalogue. `own`
         * and `from` keep the distinction that the union would otherwise lose:
         * which of these is this product's own claim, and which part supplies
         * the rest.
         */
        capabilities: spread(String(found.id))
          .map((id) => capabilities.find((row) => row.id === id))
          .filter((row): row is Row => !!row)
          .map((row) => ({
            id: row.id,
            name: row.name,
            description: row.description,
            own: (entry.product.capabilities ?? []).includes(String(row.id)),
            from: parts
              .filter((part) => spread(String(part.part_id)).includes(String(row.id)))
              .map((part) => named.get(String(part.part_id)) ?? String(part.part_id)),
          })),
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
        bundle: !entry.bundle ? null : {
          ...money(currency, { list_value: entry.bundle.listValue, saving: entry.bundle.saving ?? 0 }),
          saving_percent: entry.bundle.savingBps === null ? null : Math.round(entry.bundle.savingBps / 100),
          unpriced_parts: entry.bundle.unpriced,
          /*
           * One line per billing period, and only when there is more than one
           * — the same rule `terms` follows. A package charging a monthly fee
           * and a one-off setup has no single saving, and the four figures
           * above describe only the period its quoted price is in; without
           * these the one-off is simply missing from the answer.
           */
          ...(entry.bundle.periods.length > 1
            ? {
              recurrence: entry.bundle.recurrence,
              periods: entry.bundle.periods.map((line) => ({
                recurrence: line.recurrence,
                ...money(currency, { list_value: line.listValue }),
                ...(line.price === null ? { price: null, price_text: null } : money(currency, { price: line.price })),
                ...(line.saving === null ? { saving: null, saving_text: null } : money(currency, { saving: line.saving })),
                saving_percent: line.savingBps === null ? null : Math.round(line.savingBps / 100),
              })),
            }
            : {}),
        },
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
        recurrence: { type: 'string', enum: [...COST_RECURRENCES], description: 'How `price` is charged. once is a sale, the rest a subscription. A product sold in several periods gets a `set_product_price` per period' },
        /*
         * The same thing under the name this tool used to give it.
         *
         * `set_product_price` has always called it `recurrence` and this one
         * called it `billing`, which is one concept with two words on two
         * neighbouring tools — and the trap held: twelve package prices went
         * into a live catalogue as `once` because the call said `billing` to
         * the tool that does not have it. Kept so nobody's saved call breaks,
         * named second so a reader learns the word the rest of the surface
         * uses.
         */
        billing: { type: 'string', enum: [...COST_RECURRENCES], description: 'The older spelling of `recurrence`. Both work; `recurrence` is the one everything else says' },
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
      const said = String(args.recurrence ?? args.billing);
      const billing = (COST_RECURRENCES as readonly string[]).includes(said) ? said : 'once';
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
    name: 'update_product',
    title: 'Change a product',
    description:
      'Change anything about a product that is not a price, a cost, a person or a part: its name, '
      + 'code, description, group, kind, status, currency, scope, capacity, or the retention fields. '
      + 'Only the fields named are touched; everything else is left alone. `archived` takes it out of '
      + 'the catalogue while keeping it, `status` says where it is in its life, and `delete_product` '
      + 'removes it — three different meanings of "not on sale", and this tool reaches the first two.',
    schema: {
      type: 'object',
      required: ['product'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code' },
        name: { type: 'string' },
        code: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        group: { type: ['string', 'null'], description: 'Group id or name, or null to take it out of one' },
        kind: { type: 'string', enum: [...PRODUCT_KINDS], description: 'Refused back to single while it still holds parts' },
        status: { type: 'string', enum: [...PRODUCT_STATUS] },
        currency: {
          type: 'string',
          description: 'ISO 4217, three letters, refused otherwise. Nothing anywhere converts between two, so changing this restates every amount on the product rather than converting it — and the answer names any package left summing two',
        },
        unit_label: { type: ['string', 'null'] },
        scope_amount: { type: 'number' },
        scope_unit: { type: ['string', 'null'] },
        capacity: { type: ['number', 'null'], description: 'Units one delivery can take, or null for no ceiling' },
        term_months: { type: 'number', description: 'Minimum commitment. A price may state its own and override this' },
        renewal: { type: 'string', enum: [...RENEWALS] },
        churn_percent: { type: 'number' },
        acquisition_cost: { type: 'string' },
        archived: { type: 'boolean' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const product = findProduct(String(args.product), workspaceId);

      /*
       * A product holding parts cannot go back to being a single one.
       * `unitCosts` recurses through its parts whatever `kind` says, so the
       * catalogue would carry a package's costs under a single product's name.
       * The form disables the option for this reason; a tool has to refuse it.
       */
      if (args.kind !== undefined && args.kind !== 'bundle') {
        const held = productChildren('productPart', String(product.id));
        if (held.length) {
          throw new McpError(
            `${product.name} still holds ${held.length} product(s), so it stays a package — remove them with remove_product_part first`,
          );
        }
      }

      const patch = patchOf(args, {
        name: (raw) => requireText(raw, 'name'),
        code: (raw) => str(raw) ?? null,
        description: (raw) => str(raw) ?? null,
        kind: (raw) => oneOf(raw, PRODUCT_KINDS, 'kind'),
        status: (raw) => oneOf(raw, PRODUCT_STATUS, 'status'),
        currency: (raw) => currencyCode(raw),
        unit_label: (raw) => str(raw) ?? null,
        scope_amount: (raw) => whole(raw, 'scope_amount', 0, 1_000_000),
        scope_unit: (raw) => str(raw) ?? null,
        capacity: (raw) => (raw === null ? null : whole(raw, 'capacity', 1, 1_000_000)),
        term_months: (raw) => whole(raw, 'term_months', 0, 600),
        renewal: (raw) => oneOf(raw, RENEWALS, 'renewal'),
        acquisition_cost: (raw) => requireMoney(raw, 'acquisition_cost'),
      });
      if (args.churn_percent !== undefined) patch.churn_bps = bps(args.churn_percent, 'churn_percent', 0, 100);
      if (args.archived !== undefined) patch.archived = args.archived ? 1 : 0;
      if (args.group !== undefined) {
        const wanted = str(args.group)?.toLowerCase();
        const group = wanted
          ? all<Row>(`SELECT * FROM product_groups WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
            .find((row) => row.id === args.group || String(row.name).toLowerCase() === wanted)
          : null;
        if (wanted && !group) throw new McpError(`No product group "${args.group}" in this workspace`);
        patch.group_id = group ? group.id : null;
      }

      if (!Object.keys(patch).length) throw new McpError('Nothing to change — name at least one field');
      const { row } = writeEntity('product', String(product.id), patch, writeOpts(workspaceId, ctx));
      const changed = changedFields(product, row, patch);
      /*
       * Nothing converts between two currencies anywhere, and `unitCosts` sums
       * a part's costs into the package holding it while `unitEconomics` labels
       * the total with the *package's* currency. So restating this product's
       * amounts in another currency leaves every containing package adding two
       * currencies under one symbol. Named rather than refused, because the
       * form has no such refusal either — but a caller should not have to
       * discover it from a total.
       */
      const packages = changed.includes('currency') ? containingPackages(String(product.id)) : [];
      return {
        id: row.id,
        product: row.name,
        changed,
        status: row.status,
        archived: !!Number(row.archived),
        ...(packages.length ? { packages_now_mixing_currencies: packages } : {}),
      };
    },
  },
  {
    name: 'delete_product',
    title: 'Delete a product',
    description:
      'Soft-delete a product. It leaves every list and goes to the trash, where it can be restored '
      + 'with everything that went with it: its prices, costs, people and the packages it was part of. '
      + 'To take something out of the catalogue without removing it, use `update_product` with '
      + '`archived: true` instead — that is the reversible one a customer-facing list respects.',
    destructive: true,
    schema: {
      type: 'object',
      required: ['product'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const product = findProduct(String(args.product), workspaceId);

      /*
       * Counted before the write, because `cascadeProduct` tombstones these in
       * the same transaction and afterwards there is nothing left to count. A
       * caller deleting a module that four packages contain should be told so
       * by the answer rather than by a customer.
       */
      const packages = containingPackages(String(product.id));
      /*
       * Exactly what `cascadeProduct` will tombstone, counted the way it
       * gathers: its own children, *and* the part rows pointing at it from
       * elsewhere. Counting only the first is what this said at first, and it
       * reported one row taken where three went — the two packages losing it
       * are the half a caller most needs to hear about.
       */
      const children = (Object.keys(PRODUCT_CHILD_TABLES) as ProductChild[])
        .reduce((total, entity) => total + productChildren(entity, String(product.id)).length, 0)
        + all<Row>(`SELECT id FROM product_parts WHERE part_id = ? AND deleted_at IS NULL`, product.id).length;

      /*
       * Saved simulations are not in `PRODUCT_CHILDREN`, so they are not
       * tombstoned and not restored — they stay live pointing at a row that is
       * gone, and once the trash is emptied they point at nothing at all.
       * Whether that should cascade is a decision about saved work and not one
       * to take inside a delete tool; leaving it silent is not a choice at all,
       * so the answer names them.
       */
      const scenarios = all<Row>(
        `SELECT name FROM product_scenarios WHERE product_id = ? AND deleted_at IS NULL`, product.id,
      ).map((row) => String(row.name));

      deleteEntity('product', String(product.id), writeOpts(workspaceId, ctx));
      return {
        deleted: product.name,
        id: product.id,
        rows_taken_with_it: children,
        packages_left_short: packages,
        scenarios_left_dangling: scenarios,
      };
    },
  },
  {
    name: 'set_product_price',
    title: 'Price a product',
    description:
      'Add a price to a product. A product may have several: the published one, a volume price '
      + 'that applies from `min_quantity` upward, a partner price, and an internal transfer price '
      + 'that never counts as revenue, and the same offer on a longer commitment at a lower '
      + 'amount. Which one applies to an order is worked out from the quantity and the day, so '
      + 'they can all exist at once.',
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
        term_months: {
          type: 'number',
          description: 'What the customer commits to for THIS price, in months. Omit to use the '
            + "product's own term. 0 is an explicit no-commitment. Use it to price one product at "
            + 'several terms at once, e.g. 64 monthly, 59 on a year, 54 on two.',
        },
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
        // Null rather than the product's number: the price defers to whatever
        // the product says today and keeps deferring when that changes.
        term_months: args.term_months === undefined ? null : whole(args.term_months, 'term_months', 0, 600),
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
        term_months: row.term_months ?? (Number(product.term_months) || 0),
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
    name: 'update_product_price',
    title: 'Correct a price',
    description:
      'Correct a price in place — a typo in the amount, a wrong threshold, a name, a window. '
      + '**This overwrites: what the price used to say is gone.** To change what a product costs '
      + 'from a date onward, use `change_product_price` instead — that keeps the old amount as '
      + 'history by closing its window and opening a new one, which is what makes a price history '
      + 'readable at all. Use this one only when the old value was never true.',
    destructive: true,
    schema: {
      type: 'object',
      required: ['price'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code. Needed only when `price` is a name rather than an id' },
        price: { type: 'string', description: 'Price id, or its name within that product' },
        name: { type: 'string' },
        kind: { type: 'string', enum: [...PRICE_KINDS] },
        amount: { type: 'string', description: 'Corrects the amount in place, losing what it said. See the description' },
        min_quantity: { type: 'number' },
        recurrence: { type: 'string', enum: [...COST_RECURRENCES] },
        term_months: { type: ['number', 'null'], description: "What the customer commits to for this price. Null defers to the product's own" },
        valid_from: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        valid_to: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        note: { type: ['string', 'null'] },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const { product, row: price } = findOn('productPrice', args, 'price', 'price', workspaceId);

      const patch = patchOf(args, {
        name: (raw) => requireText(raw, 'name'),
        kind: (raw) => oneOf(raw, PRICE_KINDS, 'kind'),
        amount: (raw) => requireMoney(raw, 'amount'),
        min_quantity: (raw) => whole(raw, 'min_quantity', 1, 1_000_000),
        recurrence: (raw) => oneOf(raw, COST_RECURRENCES, 'recurrence'),
        term_months: (raw) => (raw === null ? null : whole(raw, 'term_months', 0, 600)),
        valid_from: (raw) => isoDay(raw, 'valid_from'),
        valid_to: (raw) => isoDay(raw, 'valid_to'),
        note: (raw) => str(raw) ?? null,
      });
      if (!Object.keys(patch).length) throw new McpError('Nothing to change — name at least one field');

      /*
       * A window that ends before it begins matches no day at all, so the price
       * neither applies nor reads as history — it simply disappears. Checked
       * against the merged row rather than the patch, because either end may be
       * the one that moved. Same shape `priceChangeRefusal` guards one door up.
       */
      const merged = { ...price, ...patch } as unknown as ProductPrice;
      if (merged.valid_from && merged.valid_to && merged.valid_to < merged.valid_from) {
        throw new McpError(`That window ends on ${merged.valid_to}, before it starts on ${merged.valid_from} — it would apply to no day at all`);
      }

      const { row } = writeEntity('productPrice', String(price.id), patch, writeOpts(workspaceId, ctx));
      const after = productChildren('productPrice', String(product.id)) as unknown as ProductPrice[];
      return {
        id: row.id,
        product: product.name,
        ...money(String(product.currency), { amount: Number(row.amount) }),
        changed: changedFields(price, row, patch),
        /* A correction can put two prices in one lane. Reported rather than
           refused: which of them was meant is not ours to guess. */
        overlapping_prices: overlappingPrices(after, Number(product.term_months) || 0).map(([a, b]) => [a.id, b.id]),
        /* `bundleValue` reads each part's applicable price, so an amount, a
           window, a threshold or a kind moved here moves what every package
           holding this product is said to be worth — and none of those show up
           as a lane change. */
        packages_affected: containingPackages(String(product.id)),
      };
    },
  },
  {
    name: 'delete_product_price',
    title: 'Remove a price',
    description:
      'Remove a price from a product. Use it for a price that should never have existed — a '
      + 'duplicate, a typo written as a second row. A price whose time has passed does not need '
      + 'removing: give it a `valid_to` with `update_product_price` and it stays readable as what '
      + 'the product used to cost. Removing the last one leaves the product unpriced, and every '
      + 'package holding it then counts it as worth nothing — the answer names them.',
    destructive: true,
    schema: {
      type: 'object',
      required: ['price'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code. Needed only when `price` is a name rather than an id' },
        price: { type: 'string', description: 'Price id, or its name within that product' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const { product, row: price } = findOn('productPrice', args, 'price', 'price', workspaceId);

      const packages = containingPackages(String(product.id));
      deleteEntity('productPrice', String(price.id), writeOpts(workspaceId, ctx));

      /*
       * What the product costs *after* the removal, which is the part a caller
       * cannot work out: taking away the row that applied today leaves a
       * product that answers "unpriced" everywhere, and that should arrive in
       * the reply rather than in a margin somebody reads next week.
       */
      const left = productChildren('productPrice', String(product.id)) as unknown as ProductPrice[];
      const applies = priceFor(left, { on: new Date().toISOString().slice(0, 10), productTerm: Number(product.term_months) || 0 });
      return {
        deleted: String(price.name || price.id),
        product: product.name,
        prices_left: left.length,
        applies_now: applies ? formatMoney(applies.amount, String(product.currency), 'en') : null,
        /* Read together with `applies_now`: a null there and names here is
           every one of those packages worth this product's price less than it
           was a moment ago, because `bundleValue` counts an unpriced part as
           nothing rather than as missing. */
        packages_affected: packages,
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
    name: 'update_product_cost',
    title: 'Change a cost',
    description:
      'Change a cost on a product: its name, what it varies with, its category, its amount, its '
      + 'vendor. **`basis` is the one worth naming.** `period` is incurred every month however many '
      + 'customers there are; `unit` is incurred per unit sold and is the only one that comes off '
      + 'the price — and on a subscription it recurs, every month for every active customer. A cost '
      + 'that grows with the customers filed as `period` reads as a 100% margin, which is why this '
      + 'tool exists.',
    schema: {
      type: 'object',
      required: ['cost'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code. Needed only when `cost` is a name rather than an id' },
        cost: { type: 'string', description: 'Cost id, or its name within that product' },
        name: { type: 'string' },
        basis: { type: 'string', enum: [...COST_BASIS] },
        category: { type: 'string', enum: [...COST_CATEGORIES] },
        amount: { type: 'string', description: 'Per period, per delivery or per unit — see basis' },
        vendor: { type: ['string', 'null'] },
        note: { type: ['string', 'null'] },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const { product, row: cost } = findOn('productCost', args, 'cost', 'cost', workspaceId);

      const patch = patchOf(args, {
        name: (raw) => requireText(raw, 'name'),
        basis: (raw) => oneOf(raw, COST_BASIS, 'basis'),
        category: (raw) => oneOf(raw, COST_CATEGORIES, 'category'),
        amount: (raw) => requireMoney(raw, 'amount'),
        vendor: (raw) => str(raw) ?? null,
        note: (raw) => str(raw) ?? null,
      });
      if (!Object.keys(patch).length) throw new McpError('Nothing to change — name at least one field');

      const { row } = writeEntity('productCost', String(cost.id), patch, writeOpts(workspaceId, ctx));

      /*
       * The margin before and after, because moving a cost between bases moves
       * money between the margin and the break-even and a caller cannot see
       * that from the row it just wrote. This is the whole point of the tool.
       */
      const entry = catalogueOf(workspaceId).entries.find((item) => item.product.id === product.id);
      return {
        id: row.id,
        product: product.name,
        basis: row.basis,
        ...money(String(product.currency), { amount: Number(row.amount) }),
        changed: changedFields(cost, row, patch),
        ...(entry ? {
          ...money(String(product.currency), {
            unit_cost: entry.structure.unit,
            per_delivery: entry.structure.delivery,
            fixed_per_period: entry.structure.period,
            contribution: entry.economics.contribution ?? 0,
          }),
          margin_percent: entry.economics.marginBps === null ? null : Math.round(entry.economics.marginBps / 100),
        } : {}),
        /* A module's cost is a package's cost. The margin above is this
           product's; these are the ones that moved with it and do not say so
           anywhere the caller is looking. */
        packages_affected: containingPackages(String(product.id)),
      };
    },
  },
  {
    name: 'delete_product_cost',
    title: 'Remove a cost',
    description:
      'Remove a cost from a product. The margin and the break-even are recomputed from what is '
      + 'left, and a product whose last cost goes reads as `no_costs` again — which means nobody '
      + 'has costed it, not that it is free.',
    destructive: true,
    schema: {
      type: 'object',
      required: ['cost'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code. Needed only when `cost` is a name rather than an id' },
        cost: { type: 'string', description: 'Cost id, or its name within that product' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const { product, row: cost } = findOn('productCost', args, 'cost', 'cost', workspaceId);

      deleteEntity('productCost', String(cost.id), writeOpts(workspaceId, ctx));
      const entry = catalogueOf(workspaceId).entries.find((item) => item.product.id === product.id);
      return {
        deleted: String(cost.name || cost.id),
        product: product.name,
        costs_left: productChildren('productCost', String(product.id)).length,
        health: entry ? healthOfProduct(entry) : null,
        packages_affected: containingPackages(String(product.id)),
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
    name: 'update_product_contributor',
    title: 'Change an external contributor',
    description:
      'Change what an outside contributor is paid, or on what basis, or who they are. Their fee '
      + 'counts as a cost of exactly that basis, so moving `fee_basis` moves their money between '
      + 'the margin and the break-even the same way a cost does.',
    schema: {
      type: 'object',
      required: ['contributor'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code. Needed only when `contributor` is a name rather than an id' },
        contributor: { type: 'string', description: 'Contributor id, or their name within that product' },
        name: { type: 'string' },
        role: { type: ['string', 'null'] },
        organisation: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] },
        fee: { type: 'string' },
        fee_basis: { type: 'string', enum: [...COST_BASIS] },
        note: { type: ['string', 'null'] },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const { product, row: person } = findOn('productContributor', args, 'contributor', 'contributor', workspaceId);

      const patch = patchOf(args, {
        name: (raw) => requireText(raw, 'name'),
        role: (raw) => str(raw) ?? null,
        organisation: (raw) => str(raw) ?? null,
        email: (raw) => str(raw) ?? null,
        fee: (raw) => requireMoney(raw, 'fee'),
        fee_basis: (raw) => oneOf(raw, COST_BASIS, 'fee_basis'),
        note: (raw) => str(raw) ?? null,
      });
      if (!Object.keys(patch).length) throw new McpError('Nothing to change — name at least one field');

      const { row } = writeEntity('productContributor', String(person.id), patch, writeOpts(workspaceId, ctx));
      return {
        id: row.id,
        product: product.name,
        name: row.name,
        fee_basis: row.fee_basis,
        ...money(String(product.currency), { fee: Number(row.fee) }),
        changed: changedFields(person, row, patch),
        /* A fee is a cost of the product on exactly its basis, and a `unit` one
           rolls into every package holding it. Same reason the cost tools say so. */
        packages_affected: containingPackages(String(product.id)),
      };
    },
  },
  {
    name: 'delete_product_contributor',
    title: 'Remove an external contributor',
    description: 'Take an outside contributor off a product. Their fee stops counting as a cost of it.',
    destructive: true,
    schema: {
      type: 'object',
      required: ['contributor'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code. Needed only when `contributor` is a name rather than an id' },
        contributor: { type: 'string', description: 'Contributor id, or their name within that product' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const { product, row: person } = findOn('productContributor', args, 'contributor', 'contributor', workspaceId);

      deleteEntity('productContributor', String(person.id), writeOpts(workspaceId, ctx));
      /*
       * A fee is a cost of the product, so taking the last contributor off one
       * that has no costs of its own puts it back to `no_costs` — the state a
       * catalogue paints green by omission. Answered here for the same reason
       * `delete_product_cost` answers it, which is also what the tool table
       * says of both.
       */
      const entry = catalogueOf(workspaceId).entries.find((item) => item.product.id === product.id);
      return {
        deleted: String(person.name || person.id),
        product: product.name,
        contributors_left: productChildren('productContributor', String(product.id)).length,
        health: entry ? healthOfProduct(entry) : null,
        packages_affected: containingPackages(String(product.id)),
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
    name: 'update_product_part',
    title: 'Change what a package holds',
    description:
      'Change how many of a product a package holds, or swap which product it is. A package may '
      + 'not end up containing itself at any depth — that is refused rather than corrected, because '
      + 'every correction available is a guess.',
    schema: {
      type: 'object',
      required: ['package', 'part'],
      properties: {
        package: { type: 'string', description: 'The package: product id, name or code' },
        part: { type: 'string', description: 'The part to change, by its id or by the name of the product in it' },
        product: { type: 'string', description: 'Swap it for this product instead' },
        quantity: { type: 'number', description: 'How many of it the package hands over' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const container = findProduct(String(args.package), workspaceId);

      const part = findPart(container, args.part, workspaceId);

      const patch: Record<string, unknown> = {};
      if (args.quantity !== undefined) patch.quantity = whole(args.quantity, 'quantity', 1, 1_000_000);
      if (args.product !== undefined) patch.part_id = findProduct(String(args.product), workspaceId).id;
      if (!Object.keys(patch).length) throw new McpError('Nothing to change — give a quantity or a product');

      const { row } = writeEntity('productPart', String(part.id), patch, writeOpts(workspaceId, ctx));
      const inside = productsOf(workspaceId).find((item) => item.id === row.part_id);
      return { id: row.id, package: container.name, product: inside ? inside.name : row.part_id, quantity: row.quantity };
    },
  },
  {
    name: 'remove_product_part',
    title: 'Take a product out of a package',
    description:
      'Take one product out of a package. The package keeps its own price and its kind — a package '
      + 'holding nothing is still a package, and the answer says how many are left so that an empty '
      + 'one is visible rather than discovered.',
    destructive: true,
    schema: {
      type: 'object',
      required: ['package', 'part'],
      properties: {
        package: { type: 'string', description: 'The package: product id, name or code' },
        part: { type: 'string', description: 'The part to remove, by its id or by the name of the product in it' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const container = findProduct(String(args.package), workspaceId);
      const part = findPart(container, args.part, workspaceId);
      const label = String(productsOf(workspaceId).find((item) => item.id === part.part_id)?.name ?? part.part_id);
      deleteEntity('productPart', String(part.id), writeOpts(workspaceId, ctx));
      return {
        removed: label,
        package: container.name,
        parts_left: productChildren('productPart', String(container.id)).length,
      };
    },
  },
  {
    name: 'list_capabilities',
    title: 'List what the catalogue can do',
    description:
      'The workspace\'s capability vocabulary: a feature named once and ticked on every product '
      + 'that has it, so a module and the packages holding it describe the same thing in the same '
      + 'words. Each entry says which products claim it themselves and which inherit it through a '
      + 'package, because a package\'s list is computed rather than kept in step by hand.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        unclaimed: { type: 'boolean', description: 'Only the ones no product claims. Defaults to false' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireFeature(workspaceId, 'products');
      const known = capabilitiesIn(workspaceId);
      const { entries, parts: allParts } = catalogueOf(workspaceId);
      const byId = new Map(entries.map((row) => [String(row.product.id), row.product]));
      const spread = capabilitySpread(
        new Set(known.map((row) => String(row.id))),
        (id) => byId.get(id),
        (id) => (allParts.get(id) ?? []) as readonly ProductPart[],
      );

      const rows = known.map((capability) => {
        const id = String(capability.id);
        const claimed: string[] = [];
        const inherited: string[] = [];
        for (const entry of entries) {
          const product = String(entry.product.name);
          if ((entry.product.capabilities ?? []).includes(id)) claimed.push(product);
          else if (spread(String(entry.product.id)).includes(id)) inherited.push(product);
        }
        return {
          id: capability.id,
          name: capability.name,
          description: capability.description,
          archived: !!capability.archived,
          claimed_by: claimed,
          inherited_by: inherited,
        };
      });

      const shown = args.unclaimed ? rows.filter((row) => !row.claimed_by.length) : rows;
      return {
        capabilities: shown,
        total: shown.length,
        /* A vocabulary nothing claims is the state this tool exists to make
           visible: it reads as a catalogue that cannot do anything. */
        unclaimed: rows.filter((row) => !row.claimed_by.length).length,
      };
    },
  },
  {
    name: 'create_capability',
    title: 'Name something the catalogue can do',
    description:
      'Add an entry to the capability vocabulary. A name already in use is refused rather than '
      + 'duplicated — two spellings of one feature compare as two features, which is the one thing '
      + 'a shared vocabulary must not do. Attach it to products with set_product_capabilities.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'What the feature is called, in the words a customer would read' },
        description: { type: 'string', description: 'What it means, for the people who have to decide whether a product has it' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      /* `capabilityName` here as well as in the write path, so the refusal
         below compares what will actually be stored rather than what was
         typed — otherwise an escaped name passes the check and then becomes
         its unescaped twin on the way in. */
      const name = capabilityName(requireText(args.name, 'name'));
      if (!name) throw new McpError('`name` must be a non-empty string');
      const known = capabilitiesIn(workspaceId);
      const clash = known.find((row) => capabilityKey(String(row.name)) === capabilityKey(name));
      if (clash) throw new McpError(`"${clash.name}" is already in this workspace's vocabulary (${clash.id})`);

      const { row } = writeEntity('productCapability', uid(), {
        workspace_id: workspaceId,
        name,
        description: str(args.description) ?? null,
        archived: 0,
        sort_order: orderKey(known.length ? String(known[known.length - 1].sort_order) : null, null),
      }, writeOpts(workspaceId, ctx));

      return { id: row.id, name: row.name, description: row.description };
    },
  },
  {
    name: 'update_capability',
    title: 'Rename something the catalogue can do',
    description:
      'Change a capability\'s name or its description. Every product claiming it reads the new '
      + 'wording at once, which is the point of naming it in one place — and the reason a name '
      + 'already in use is refused here too.',
    schema: {
      type: 'object',
      required: ['capability'],
      properties: {
        capability: { type: 'string', description: 'Capability id, or its current name' },
        name: { type: 'string', description: 'What to call it instead' },
        description: { type: 'string', description: 'What it means. Pass an empty string to clear it' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const known = capabilitiesIn(workspaceId);
      const capability = findCapability(args.capability, known);

      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) {
        const name = capabilityName(requireText(args.name, 'name'));
        if (!name) throw new McpError('`name` must be a non-empty string');
        const clash = known.find((row) => row.id !== capability.id && capabilityKey(String(row.name)) === capabilityKey(name));
        if (clash) throw new McpError(`"${clash.name}" is already in this workspace's vocabulary (${clash.id})`);
        patch.name = name;
      }
      if (args.description !== undefined) patch.description = str(args.description) ?? null;
      if (!Object.keys(patch).length) throw new McpError('Nothing to change — give a name or a description');

      const { row } = writeEntity('productCapability', String(capability.id), patch, writeOpts(workspaceId, ctx));
      const claimed = productsOf(workspaceId)
        .map((product) => serialize('product', product) as unknown as Product)
        .filter((product) => (product.capabilities ?? []).includes(String(capability.id)))
        .map((product) => String(product.name));
      return {
        id: row.id,
        was: capability.name,
        name: row.name,
        description: row.description,
        /* Named rather than counted: a rename reaches every product at once,
           and which ones is the part somebody wants confirmed. */
        claimed_by: claimed,
      };
    },
  },
  {
    name: 'delete_capability',
    title: 'Take something out of the vocabulary',
    description:
      'Remove a capability from the workspace. Every product that claimed it stops showing it, and '
      + 'so does every package that inherited it — the answer names them, because that is the part '
      + 'a count would hide. The products themselves are not rewritten: an id nothing resolves is '
      + 'dropped when the list is read, so nothing is left rendering as a blank chip.',
    destructive: true,
    schema: {
      type: 'object',
      required: ['capability'],
      properties: {
        capability: { type: 'string', description: 'Capability id, or its name' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const known = capabilitiesIn(workspaceId);
      const capability = findCapability(args.capability, known);
      const id = String(capability.id);

      const { entries, parts: allParts } = catalogueOf(workspaceId);
      const byId = new Map(entries.map((row) => [String(row.product.id), row.product]));
      const spread = capabilitySpread(
        new Set(known.map((row) => String(row.id))),
        (productId) => byId.get(productId),
        (productId) => (allParts.get(productId) ?? []) as readonly ProductPart[],
      );
      const claimed: string[] = [];
      const inherited: string[] = [];
      for (const entry of entries) {
        const name = String(entry.product.name);
        if ((entry.product.capabilities ?? []).includes(id)) claimed.push(name);
        else if (spread(String(entry.product.id)).includes(id)) inherited.push(name);
      }

      deleteEntity('productCapability', id, writeOpts(workspaceId, ctx));
      return {
        removed: capability.name,
        /* Both lists, because a package loses it through a part rather than
           through a claim of its own and would otherwise go unmentioned. */
        claimed_by: claimed,
        inherited_by: inherited,
        left: capabilitiesIn(workspaceId).length,
      };
    },
  },
  {
    name: 'set_product_capabilities',
    title: 'Say what a product can do',
    description:
      'Replace what one product claims it can do. The list given is what it ends up with, so an '
      + 'entry left out is taken off — the answer names what was added and what was removed rather '
      + 'than reporting a count, because a silent removal is the failure mode of a replacing tool. '
      + 'Name each capability by id or by its exact name; an unknown one is refused, not invented. '
      + 'Never set these on a package: it already claims everything its parts do.',
    schema: {
      type: 'object',
      required: ['product', 'capabilities'],
      properties: {
        product: { type: 'string', description: 'Product id, name or code' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Capability ids or names. An empty list takes them all off',
        },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const product = findProduct(String(args.product), workspaceId);
      if (!Array.isArray(args.capabilities)) throw new McpError('`capabilities` must be an array of ids or names');
      const known = capabilitiesIn(workspaceId);
      const label = new Map(known.map((row) => [String(row.id), String(row.name)]));

      const wanted: string[] = [];
      for (const ref of args.capabilities) {
        const id = String(findCapability(ref, known).id);
        if (!wanted.includes(id)) wanted.push(id);
      }
      const before = ((serialize('product', product) as unknown as Product).capabilities ?? []).map(String);

      const { row } = writeEntity('product', String(product.id), {
        capabilities: JSON.stringify(wanted),
      }, writeOpts(workspaceId, ctx));
      const after = ((serialize('product', row) as unknown as Product).capabilities ?? []).map(String);

      return {
        product: product.name,
        capabilities: after.map((id) => label.get(id) ?? id),
        added: after.filter((id) => !before.includes(id)).map((id) => label.get(id) ?? id),
        removed: before.filter((id) => !after.includes(id)).map((id) => label.get(id) ?? id),
        /* A package's own list is not what the screen shows — see
           `capabilitySpread`. Said here so nobody sets one and wonders why the
           answer is longer than what they asked for. */
        packages_affected: containingPackages(String(product.id)),
      };
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
    name: 'update_promotion',
    title: 'Change a campaign',
    description:
      'Change a campaign: its discount, its window, what it covers, what running it costs, how '
      + 'much more it is expected to sell, or its status. `status: live` is what makes it apply to '
      + 'a price at all — a draft is planned and applies to nothing. Naming `products` or `groups` '
      + 'replaces the whole list; giving both as empty arrays means the whole catalogue.',
    schema: {
      type: 'object',
      required: ['promotion'],
      properties: {
        promotion: { type: 'string', description: 'Campaign id or name' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        kind: { type: 'string', enum: [...PROMOTION_KINDS], description: 'Moving it needs `value` too: the stored number means something different under each' },
        value: { type: 'string', description: 'A percentage for percent, what comes off for amount, what it becomes for price' },
        starts_on: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        ends_on: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        products: { type: 'array', items: { type: 'string' }, description: 'Replaces the list. Product ids, names or codes' },
        groups: { type: 'array', items: { type: 'string' }, description: 'Replaces the list. Group ids or names' },
        spend: { type: 'string' },
        uplift_percent: { type: 'number' },
        status: { type: 'string', enum: [...PROMOTION_STATUS] },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const found = findPromotion(args.promotion, workspaceId);

      const patch = patchOf(args, {
        name: (raw) => requireText(raw, 'name'),
        description: (raw) => str(raw) ?? null,
        kind: (raw) => oneOf(raw, PROMOTION_KINDS, 'kind'),
        starts_on: (raw) => isoDay(raw, 'starts_on'),
        ends_on: (raw) => isoDay(raw, 'ends_on'),
        spend: (raw) => requireMoney(raw, 'spend'),
        status: (raw) => oneOf(raw, PROMOTION_STATUS, 'status'),
        products: (raw) => (raw as unknown[]).map((ref) => findProduct(String(ref), workspaceId).id),
        groups: (raw) => (raw as unknown[]).map((ref) => {
          const name = String(ref).trim().toLowerCase();
          const group = all<Row>(`SELECT * FROM product_groups WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceId)
            .find((row) => String(row.id) === String(ref).trim() || String(row.name).toLowerCase() === name);
          if (!group) throw new McpError(`No product group "${ref}" in this workspace`);
          return group.id;
        }),
      });
      if (args.uplift_percent !== undefined) patch.uplift_bps = bps(args.uplift_percent, 'uplift_percent', 0, 10_000);
      /*
       * The value means three different things — basis points for `percent`,
       * what comes off for `amount`, what it becomes for `price` — so it is
       * read against the kind this campaign will have after the change, not
       * the one it had before.
       *
       * And a kind may not move without it. `2000` under `amount` is twenty
       * euros off a fourteen-hundred-euro seminar; the same row read as
       * `price` sells it for twenty. Nothing in the write path would object,
       * the campaign can be live, and the first evidence would be an invoice.
       * The caller knows which number they mean and is the only one who does.
       */
      if (patch.kind !== undefined && patch.kind !== found.kind && args.value === undefined) {
        throw new McpError(
          `A ${found.kind} campaign's value and a ${patch.kind} campaign's are different numbers `
          + `— give \`value\` as well, or the one ${found.name} already stores survives the change `
          + 'and comes to mean something else',
        );
      }
      if (args.value !== undefined) {
        const kind = String(patch.kind ?? found.kind);
        patch.value = kind === 'percent' ? bps(args.value, 'value', 0, 100) : requireMoney(args.value, 'value');
      }
      if (!Object.keys(patch).length) throw new McpError('Nothing to change — name at least one field');

      const { row } = writeEntity('promotion', String(found.id), patch, writeOpts(workspaceId, ctx));
      const today = new Date().toISOString().slice(0, 10);
      return {
        id: row.id,
        name: row.name,
        phase: promotionPhase(row as unknown as Promotion, today),
        changed: changedFields(found, row, patch),
      };
    },
  },
  {
    name: 'delete_promotion',
    title: 'Remove a campaign',
    description:
      'Remove a campaign. Nothing it discounted keeps the discount: every price it touched goes '
      + 'back to what it was. To stop a campaign without losing the record of it, set its status to '
      + '`ended` with `update_promotion` instead.',
    destructive: true,
    schema: {
      type: 'object',
      required: ['promotion'],
      properties: {
        promotion: { type: 'string', description: 'Campaign id or name' },
        workspace_id: { type: 'string' },
      },
    },
    run: (args, ctx) => {
      const workspaceId = workspaceOf(args, ctx);
      requireWrite(ctx, workspaceId);
      requireFeature(workspaceId, 'products');
      const found = findPromotion(args.promotion, workspaceId);

      deleteEntity('promotion', String(found.id), writeOpts(workspaceId, ctx));
      return { deleted: String(found.name), id: String(found.id) };
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
