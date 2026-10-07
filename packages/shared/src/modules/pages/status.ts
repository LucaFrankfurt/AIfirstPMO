/**
 * How finished a page is — reading a ladder a workspace wrote itself.
 *
 * The rungs are rows, so every name here is somebody's own word and nothing
 * downstream may branch on one. What *is* fixed is `kind`, and these four
 * functions are the only places that read it. Keeping them together is the
 * point: the export marker, the tidy screen, the chip and the default for a
 * new page all have to agree about what "not finished" means, and a product
 * where two screens disagree about that is worse than one with no status at
 * all.
 *
 * **A page with no status is a draft.** `status_id` is NULL on every page
 * written before the ladder existed, and on one whose rung somebody deleted.
 * Both read as the draft, which is the honest answer — a page nobody has said
 * anything about is exactly that — and it is why nothing ever had to rewrite
 * the wiki to ship this.
 */
import { compareOrder } from '../../kernel/registry/order.ts';
import type { Page, PageStatus, PageStatusKind } from '../../kernel/registry/types.ts';

/**
 * The rungs in the order a workspace put them in.
 *
 * `compareOrder` and not `localeCompare`: `sort_order` is a base-62 fraction,
 * and locale collation reads `k` before `V` — so a ladder reordered often
 * enough to grow a lower-case key would have started drawing itself in the
 * wrong order, silently and only sometimes. `check:ordering` caught this one
 * in writing, which is the entire reason that check exists.
 */
export const ladder = (statuses: PageStatus[]): PageStatus[] =>
  [...statuses].sort((a, b) => compareOrder(a.sort_order ?? '', b.sort_order ?? ''));

/**
 * Where a page with nothing said about it starts.
 *
 * The first rung of its kind rather than the first rung full stop: a workspace
 * may put "Final" at the top because that is how they read a list, and a new
 * page landing there would be this feature asserting something false about
 * every page anybody writes. Falls back to the first rung when no draft is
 * left, and to nothing when the ladder is empty — a workspace may delete all
 * of them, and a page with no status is a thing this file already answers.
 */
export const defaultStatus = (statuses: PageStatus[]): PageStatus | undefined => {
  const rungs = ladder(statuses);
  return rungs.find((status) => status.kind === 'draft') ?? rungs[0];
};

/** The rung a page stands on, or the one it stands on by saying nothing. */
export const statusOf = (
  page: Pick<Page, 'status_id'>,
  statuses: PageStatus[],
): PageStatus | undefined =>
  (page.status_id ? statuses.find((status) => status.id === page.status_id) : undefined)
    ?? defaultStatus(statuses);

/**
 * What a page's rung *means*, for the three readers that need to know.
 *
 * `'draft'` for a page whose status is gone or was never set, which is what
 * `statusOf` already answers — stated again here so a caller that only wants
 * the kind does not have to know that.
 */
export const kindOf = (
  page: Pick<Page, 'status_id'>,
  statuses: PageStatus[],
): PageStatusKind => statusOf(page, statuses)?.kind ?? 'draft';
