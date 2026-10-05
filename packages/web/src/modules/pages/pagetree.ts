/**
 * Where a page lands when it is moved, worked out on its own.
 *
 * Kept apart from the store and the drop handler for the reason `family.ts` is:
 * this is the half with the edge cases — the last child, the only child, a page
 * dropped on itself, a page dropped into its own subtree — and the half worth
 * proving without a browser. The component does the two things it is for:
 * reading the pages out of the store and writing the answer back.
 *
 * Order is a fractional key, the same one the board's cards and the saved views
 * use, so a move is one field on one row rather than a renumbering of every
 * sibling. Nothing wrote it after a page was created until now, which is why
 * the tree could only ever be in the order things happened to be made.
 */
import { compareOrder, matchesTerms, orderKey, parseTerms } from '@kolibri/shared';
import { wouldLoop } from '../../kernel/design-system/family';

/**
 * Which third of a row a drop was released over, and therefore what it means.
 *
 * A tree has two questions where a list has one: `inside` makes the dragged
 * page a child of the target, `before` and `after` leave it a sibling and only
 * change the order.
 */
export type DropZone = 'before' | 'inside' | 'after';

/** The least a page has to say for a move to be worked out. */
export interface PageNode {
  id: string;
  parent_id: string | null;
  sort_order?: string;
}

/** The children of one page, in the order the tree draws them. */
export const childrenOf = <T extends PageNode>(pages: T[], parentId: string | null): T[] =>
  pages
    .filter((page) => (page.parent_id ?? null) === parentId)
    .sort((a, b) => compareOrder(a.sort_order ?? '', b.sort_order ?? ''));

/**
 * The patch that moves `pageId` to `zone` of `targetId`, or `null` for a move
 * that is refused.
 *
 * Both halves together — the parent and the position — because they are one
 * gesture, and two writes would sync as two states, the middle of which is a
 * page briefly in the wrong place on everybody else's screen.
 *
 * There are three refusals, and all three are things somebody actually does: a
 * page dropped on itself, a page dropped into its own subtree (which detaches
 * the branch and leaves it reachable only by URL), and a drop on a page that is
 * not in the list — an archived parent, or one in a project this screen never
 * loaded.
 */
export function plotMove(
  pageId: string,
  targetId: string,
  zone: DropZone,
  pages: PageNode[],
): { parent_id: string | null; sort_order: string } | null {
  const page = pages.find((row) => row.id === pageId);
  const target = pages.find((row) => row.id === targetId);
  if (!page || !target || page.id === target.id) return null;

  const parentId = zone === 'inside' ? target.id : target.parent_id ?? null;
  // Walks upwards from the proposed parent, so it costs the depth of the tree
  // and also answers `true` for a page offered itself as its own parent.
  if (wouldLoop(page.id, parentId, pages)) return null;

  const siblings = childrenOf(pages, parentId).filter((row) => row.id !== page.id);
  let at = siblings.length;
  if (zone !== 'inside') {
    const index = siblings.findIndex((row) => row.id === target.id);
    if (index < 0) return null;
    at = zone === 'before' ? index : index + 1;
  }
  return {
    parent_id: parentId,
    sort_order: orderKey(siblings[at - 1]?.sort_order ?? null, siblings[at]?.sort_order ?? null),
  };
}

/**
 * Where a page lands when it is lifted out of the tree to the top level.
 *
 * `plotMove` cannot answer this: every one of its moves is expressed relative
 * to a target page, and "no parent at all" has none. Written out here rather
 * than as a bare `{ parent_id: null }` patch at the call site, which is what
 * the bulk bar did — a page keeping the `sort_order` it was given among its old
 * siblings can collide with the keys already at the top level and land in an
 * order nobody chose, since `compareOrder` has no idea the key came from
 * somewhere else.
 *
 * It goes *after* the current last root, which is the same answer `plotMove`
 * gives for a drop at the end of a list. A page that is already at the top
 * level is left exactly where it is: re-keying it would shuffle the root list
 * to no purpose, and "it is already where you asked" is not a refusal.
 */
export function plotToTop<T extends PageNode>(
  pageId: string,
  pages: T[],
): { parent_id: null; sort_order: string } | null {
  const page = pages.find((row) => row.id === pageId);
  if (!page || !page.parent_id) return null;
  const roots = childrenOf(pages, null).filter((row) => row.id !== pageId);
  return { parent_id: null, sort_order: orderKey(roots[roots.length - 1]?.sort_order ?? null, null) };
}

/**
 * The four moves an outliner has always had, as the pages each one targets.
 *
 * Drag is the fast way and the only way somebody on a keyboard cannot take —
 * and "drag it into place" is poor instructions on a phone besides. Between
 * them these reach every position in the tree: indent under the sibling above,
 * outdent to sit after the parent, or swap with a neighbour.
 *
 * A move is absent rather than disabled when it means nothing — there is no
 * "up" for a first child — because a menu item that does nothing is worse than
 * one that is not there.
 */
export function moveTargets(pageId: string, pages: PageNode[]): {
  up?: string; down?: string; in?: string; out?: string;
} {
  const page = pages.find((row) => row.id === pageId);
  if (!page) return {};
  const siblings = childrenOf(pages, page.parent_id ?? null);
  const at = siblings.findIndex((row) => row.id === pageId);
  if (at < 0) return {};
  return {
    up: at > 0 ? siblings[at - 1].id : undefined,
    // The same page as `up`, and a different gesture: one swaps with the page
    // above, the other goes underneath it.
    in: at > 0 ? siblings[at - 1].id : undefined,
    down: at < siblings.length - 1 ? siblings[at + 1].id : undefined,
    out: page.parent_id && pages.some((row) => row.id === page.parent_id) ? page.parent_id : undefined,
  };
}

/**
 * Everything under a page, level by level.
 *
 * Breadth-first, and deliberately *not* claiming to be drawing order — the
 * tree draws depth-first, and neither caller here cares: one counts these
 * ("and the 7 pages under them"), the other bars them as move targets. Saying
 * "in the order the tree draws it" would be a sentence somebody later relies on.
 *
 * It does not include the page itself, because both callers want "and its
 * sub-pages" as a separate thing to say.
 *
 * `seen` is not defensive tidiness: `wouldLoop` refuses a move that would close
 * a cycle, but a database that already holds one — two devices that each made a
 * legal move while apart, then met — would otherwise hang the screen rather
 * than draw a wrong tree, and a wrong tree can at least be fixed by the person
 * looking at it.
 */
export function descendantsOf<T extends PageNode>(pages: T[], pageId: string): T[] {
  const kin = familyOf(pages);
  const out: T[] = [];
  const seen = new Set<string>([pageId]);
  let edge = kin.get(pageId) ?? [];
  while (edge.length) {
    const next: T[] = [];
    for (const page of edge) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      out.push(page);
      next.push(...(kin.get(page.id) ?? []));
    }
    edge = next;
  }
  return out;
}

/**
 * One page's children, for every page, in a single pass.
 *
 * `childrenOf` filters and sorts the whole list, which is the right shape for a
 * caller asking once and the wrong one inside a walk: asking it per node made
 * `descendantsOf` quadratic, and the bulk bar ran that walk for every selected
 * page. Same order and the same `compareOrder` — a fractional index has to be
 * compared with it — read from a map instead.
 */
export function familyOf<T extends PageNode>(pages: T[]): Map<string | null, T[]> {
  const kin = new Map<string | null, T[]>();
  for (const page of pages) {
    const at = page.parent_id ?? null;
    const same = kin.get(at);
    if (same) same.push(page);
    else kin.set(at, [page]);
  }
  for (const brood of kin.values()) brood.sort((a, b) => compareOrder(a.sort_order ?? '', b.sort_order ?? ''));
  return kin;
}

/**
 * Every page's ancestors, for every page, in one pass.
 *
 * `ancestorsOf` rebuilds a map of the whole wiki on each call, which is fine
 * once and not fine per row: the tidying screen draws a page's path beside its
 * title and a page in three findings is three rows, so an 80-row report over a
 * 300-page wiki built 80 maps of 300 entries — and `useMinute` re-renders it
 * every minute. Memoised once by the caller and looked up per row instead.
 */
export function trailsOf<T extends PageNode>(pages: T[]): Map<string, T[]> {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const trails = new Map<string, T[]>();
  const walk = (id: string): T[] => {
    const known = trails.get(id);
    if (known) return known;
    // Written before the recursion, so a tree that already loops — two devices
    // that each made a legal move while apart — terminates on an empty trail
    // rather than overflowing the stack.
    trails.set(id, []);
    const page = byId.get(id);
    const parent = page?.parent_id ? byId.get(page.parent_id) : undefined;
    const trail = parent ? [...walk(parent.id), parent] : [];
    trails.set(id, trail);
    return trail;
  };
  for (const page of pages) walk(page.id);
  return trails;
}

/** The pages a page sits under, outermost first. The same guard, for the same reason. */
export function ancestorsOf<T extends PageNode>(pages: T[], pageId: string): T[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const trail: T[] = [];
  const seen = new Set<string>([pageId]);
  let at = byId.get(pageId)?.parent_id ?? null;
  while (at && !seen.has(at)) {
    seen.add(at);
    const parent = byId.get(at);
    if (!parent) break;
    trail.unshift(parent);
    at = parent.parent_id ?? null;
  }
  return trail;
}

/**
 * Which ids a filtered tree has to draw, from what somebody typed.
 *
 * The two trees — the one on the index and the one beside a page — had this as
 * five identical lines each, differing only in the name of the list handed in.
 * Which is how two trees come to disagree about what counts as a match, and
 * the one thing they must agree about is exactly that.
 *
 * `undefined` rather than "everything" for an empty box, because that is what
 * `PageTree` reads as "no filter running" — and a filter that is not running
 * must not override the folds.
 */
export function pagesMatching<T extends PageNode & { title?: string | null }>(
  pages: T[],
  typed: string,
): { keep?: Set<string>; matched?: Set<string> } {
  // The same reading every search box in the app does, rather than a lowercased
  // substring: a wiki named in German is looked for by half-remembering what a
  // page was called, and `jorg` has to find "Jörg".
  const terms = parseTerms(typed);
  if (!terms.length) return { keep: undefined, matched: undefined };
  const hits = new Set(pages.filter((page) => matchesTerms(page.title || '', terms)).map((page) => page.id));
  return { keep: withAncestors(pages, hits), matched: hits };
}

/**
 * Which ids a filtered tree has to draw: the matches, plus everything they
 * hang under.
 *
 * Because the answer to "where is the leave policy" is the path, not the row.
 * A filter that returns bare matching rows turns the tree into a flat list and
 * throws away the one thing the tree is for — which is also why the ancestors
 * are marked as scaffolding by their absence from `matched` rather than by a
 * second list: the caller draws them differently, and nothing has to agree
 * about two sets.
 */
export function withAncestors<T extends PageNode>(pages: T[], matched: Iterable<string>): Set<string> {
  const keep = new Set<string>();
  for (const id of matched) {
    keep.add(id);
    for (const parent of ancestorsOf(pages, id)) keep.add(parent.id);
  }
  return keep;
}
