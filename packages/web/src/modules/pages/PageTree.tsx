/**
 * The wiki tree, drawn once and used in three places.
 *
 * It was a pair of components inside `routes/pages.tsx` that only the index
 * screen could show, and it said less than it knew. Four things are new, and
 * each one is a question the old tree answered wrongly rather than quietly:
 *
 * - **Guides and depth.** Indentation alone is not a structure: at the third
 *   level a reader counts pixels to work out whose child a page is. A line per
 *   level costs nothing and makes the answer automatic.
 * - **A count of what is folded away.** A page with eleven sub-pages and a page
 *   with one looked identical while closed, so closing one hid how much.
 * - **Folds that survive.** Every node was `useState(true)`, so the tree sprang
 *   fully open on every navigation and every re-render. Which branches *I*
 *   have folded is a fact about this device and nothing else — the project tree
 *   in `AppShell.tsx` reached the same conclusion and keeps it the same way,
 *   in `localStorage` and never synced. Two people fighting over a chevron is
 *   what syncing it would mean.
 * - **A filter that keeps the path.** Matching rows alone would turn the tree
 *   into a flat list and throw away the one thing the tree is for, so a match
 *   is drawn with everything it hangs under (`withAncestors`), and the
 *   scaffolding is drawn as scaffolding.
 *
 * Selection is optional and the component knows nothing about what is done
 * with one — `page-bulk.tsx` holds that, the way `selection-bar.tsx` does for
 * tasks.
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { compareOrder, type Page } from '@kolibri/shared';
import { useT } from '../../kernel/i18n/i18n';
import { Icon } from '../../kernel/design-system/ui';
import { Button } from '../../kernel/design-system/ui/button';
import { navCount, navItem } from '../../kernel/design-system/ui/nav';
import { chipDot } from '../../kernel/design-system/ui/chip';
import { PAGE_DRAG, idFrom, isDrag, startDrag } from '../../kernel/design-system/drag';
import { SelectBox, type Selection } from '../../kernel/design-system/selection';
import { useSession } from '../../kernel/identity/session';
import { byId } from '../../kernel/sync/store';
import { familyOf, type DropZone } from './pagetree';
import { movePage } from './page-parts';

/** Which branches this device has folded. Never synced — see the note above. */
const FOLDED_KEY = 'kolibri.folded-pages';

const readFolded = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[]);
  } catch {
    // A browser with site data blocked, or a key some older version wrote.
    // Everything open is the right answer to not knowing.
    return new Set();
  }
};

export interface Folds {
  /** The set itself, so a caller's `useMemo` has something stable to depend on. */
  folded: ReadonlySet<string>;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  /** `true` folds every page that has children; `false` opens all of them. */
  setAll: (folded: boolean, ids: string[]) => void;
  count: number;
}

/**
 * The folds, shared by whichever trees are on screen.
 *
 * Written through on every change rather than on unload: the tree in the aside
 * and the tree on the index are two components, and a `beforeunload` save
 * would lose whichever one the reader did not touch last.
 *
 * The returned object is memoised, and that is not tidiness either: the tree
 * below takes it as a prop and derives its drawing order from it, so a fresh
 * object every render is a `useMemo` that never hits and an O(n²) walk of the
 * whole wiki on every keystroke in the filter box.
 */
export function usePageFolds(): Folds {
  const [folded, setFolded] = useState<Set<string>>(readFolded);

  const keep = useCallback((next: Set<string>) => {
    setFolded(next);
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
    } catch { /* private window, blocked storage — the session still works */ }
  }, []);

  return useMemo(() => ({
    folded,
    has: (id: string) => folded.has(id),
    toggle: (id: string) => {
      const next = new Set(folded);
      if (!next.delete(id)) next.add(id);
      keep(next);
    },
    setAll: (shut: boolean, ids: string[]) => keep(shut ? new Set(ids) : new Set()),
    count: folded.size,
  }), [folded, keep]);
}

/** Which third of a row the pointer is in, and therefore what a drop means.
 *
 * The middle half is `inside` rather than a third: dropping *onto* a page to
 * nest under it is the move people reach for, and the two edges only need to be
 * wide enough to hit deliberately. */
function zoneAt(event: React.DragEvent, element: HTMLElement): DropZone {
  const box = element.getBoundingClientRect();
  const offset = (event.clientY - box.top) / (box.height || 1);
  if (offset < 0.25) return 'before';
  if (offset > 0.75) return 'after';
  return 'inside';
}

interface Shared {
  workspaceId: string;
  /** Page id → its children, in drawing order. See `familyOf`. */
  kin: Map<string | null, Page[]>;
  activeId?: string;
  canWrite: boolean;
  folds: Folds;
  selection?: Selection;
  /** The ids to draw at all. Unset draws the whole tree. */
  keep?: Set<string>;
  /** Of those, the ones that actually matched; the rest are the path to them. */
  matched?: Set<string>;
  /** Every id the selection's shift-click counts along, in drawing order. */
  order: string[];
  /** Labels and the project, for a tree being used to tidy rather than to read. */
  marks?: boolean;
}

function TreeRow({ page, depth, shared }: { page: Page; depth: number; shared: Shared }) {
  const t = useT();
  const navigate = useNavigate();
  const [over, setOver] = useState<DropZone | null>(null);
  const { workspaceId, kin, activeId, canWrite, folds, selection, keep, matched, order, marks } = shared;

  const children = kin.get(page.id) ?? [];
  const drawn = keep ? children.filter((child) => keep.has(child.id)) : children;
  // A filter that hid its own matches behind a fold would be useless, so while
  // one is running the folds are ignored rather than cleared — they are still
  // there when the box is emptied.
  const open = keep ? true : !folds.has(page.id);
  const scaffold = !!matched && !matched.has(page.id);
  const labels = marks ? (page.labels ?? []).map((id) => byId('label', id)).filter(Boolean) : [];

  return (
    <>
      <div
        className={`page-row${over ? ` page-drop-${over}` : ''}${selection?.has(page.id) ? ' selected' : ''}`}
        draggable={canWrite && !selection?.count}
        onDragStart={(event) => {
          event.stopPropagation();
          startDrag(event, PAGE_DRAG, page.id);
        }}
        onDragOver={(event) => {
          if (!canWrite || !isDrag(event, PAGE_DRAG)) return;
          // Only with `preventDefault` is this a drop target at all; the zone is
          // read on every move because the answer changes as the pointer travels
          // down the row.
          event.preventDefault();
          event.stopPropagation();
          setOver(zoneAt(event, event.currentTarget));
        }}
        onDragLeave={() => setOver(null)}
        onDrop={(event) => {
          if (!canWrite || !isDrag(event, PAGE_DRAG)) return;
          event.preventDefault();
          event.stopPropagation();
          const zone = zoneAt(event, event.currentTarget);
          setOver(null);
          // A refusal is silent on purpose — the only one is dropping a page
          // into its own subtree, and the page visibly not moving says it.
          if (movePage(idFrom(event, PAGE_DRAG), page.id, zone, workspaceId) && zone === 'inside' && folds.has(page.id)) {
            folds.toggle(page.id);
          }
        }}
      >
        {/* One line per level the page sits under, so whose child this is can be
            read rather than measured. Drawn by the row itself: adjacent rows
            make the segments meet, which is what turns them into lines. */}
        {Array.from({ length: depth }, (_, at) => <span key={at} className="page-guide" aria-hidden="true" />)}
        {children.length > 0 ? (
          <Button
            variant="ghost" size="iconSm"
            onClick={() => folds.toggle(page.id)}
            aria-label={t('page.toggleTree')}
            aria-expanded={open}
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          </Button>
        ) : (
          <span className="page-stub" aria-hidden="true" />
        )}
        {selection && <SelectBox id={page.id} order={order} selection={selection} label={page.title || t('common.untitled')} />}
        <button
          className={navItem({ active: activeId === page.id })}
          style={scaffold ? { opacity: 0.55 } : undefined}
          onClick={() => navigate(`/pages/${page.id}`)}
        >
          <span style={{ width: 16 }}>{page.icon ?? '📄'}</span>
          <span className="flex-1 min-w-0 truncate">{page.title || t('common.untitled')}</span>
          {marks && labels.map((label) => (
            <span key={label!.id} className={chipDot} style={{ background: label!.color }} title={label!.name} />
          ))}
          {/* How much is behind the chevron, said while it is shut. Open, the
              rows themselves answer it and a number beside them is furniture. */}
          {!open && children.length > 0 && <span className={navCount}>{children.length}</span>}
        </button>
      </div>
      {open && drawn.map((child) => (
        <TreeRow key={child.id} page={child} depth={depth + 1} shared={shared} />
      ))}
    </>
  );
}

/**
 * The tree, from a flat list of pages.
 *
 * A page whose parent is not in the list is drawn at the top level rather than
 * dropped — its parent may be archived, deleted, or in a project this reader
 * cannot open, and losing the page would be worse than drawing it in the wrong
 * place. That it *is* the wrong place is a finding of its own: `tidy.ts`
 * reports it as `detached`, which is where the honest version of this sentence
 * lives.
 */
export function PageTree({ pages, activeId, canWrite, folds, selection, keep, matched, marks }: {
  pages: Page[];
  activeId?: string;
  canWrite: boolean;
  folds: Folds;
  selection?: Selection;
  keep?: Set<string>;
  matched?: Set<string>;
  marks?: boolean;
}) {
  const { workspaceId } = useSession();
  const kin = useMemo(() => familyOf(pages), [pages]);
  /**
   * The top of the tree: a page with no parent, *or* one whose parent is not in
   * this list.
   *
   * The second half is the whole reason this is not `kin.get(null)`. A page
   * whose parent was archived, deleted or made a template would otherwise be
   * drawn nowhere at all — and losing a page is worse than drawing it in the
   * wrong place. That it *is* the wrong place is a finding of its own:
   * `tidy.ts` reports it as `detached`.
   */
  const roots = useMemo(() => {
    const here = new Set(pages.map((page) => page.id));
    return pages
      .filter((page) => !page.parent_id || !here.has(page.parent_id))
      .sort((a, b) => compareOrder(a.sort_order ?? '', b.sort_order ?? ''));
  }, [pages]);
  const drawn = useMemo(
    () => (keep ? roots.filter((page) => keep.has(page.id)) : roots),
    [roots, keep],
  );

  /**
   * Every row in drawing order, for shift-click.
   *
   * Which is what makes "select from here to there" mean the same thing in a
   * tree as in a list: the range follows what the eye sees, not the order the
   * pages were created or the order they sit in the store.
   */
  const order = useMemo(() => {
    const out: string[] = [];
    const walk = (page: Page) => {
      out.push(page.id);
      // While a filter is running the folds are ignored, here as in the row.
      if (!keep && folds.folded.has(page.id)) return;
      for (const child of kin.get(page.id) ?? []) {
        if (!keep || keep.has(child.id)) walk(child);
      }
    };
    for (const page of drawn) walk(page);
    return out;
  }, [kin, drawn, keep, folds.folded]);

  const shared: Shared = { workspaceId, kin, activeId, canWrite, folds, selection, keep, matched, order, marks };
  return <>{drawn.map((page) => <TreeRow key={page.id} page={page} depth={0} shared={shared} />)}</>;
}

/** The ids in the tree that have anything under them — what "fold all" needs. */
export const foldableIds = (pages: Page[]): string[] => {
  const parents = new Set(pages.map((page) => page.parent_id).filter((id): id is string => !!id));
  return pages.filter((page) => parents.has(page.id)).map((page) => page.id);
};
