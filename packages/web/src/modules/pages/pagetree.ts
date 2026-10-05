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
import { compareOrder, orderKey } from '@kolibri/shared';
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
  const out: T[] = [];
  const seen = new Set<string>([pageId]);
  let edge = childrenOf(pages, pageId);
  while (edge.length) {
    const next: T[] = [];
    for (const page of edge) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      out.push(page);
      next.push(...childrenOf(pages, page.id));
    }
    edge = next;
  }
  return out;
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
