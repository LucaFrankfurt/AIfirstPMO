/**
 * Selecting several pages and doing one thing to all of them.
 *
 * The same arrangement `modules/work/selection-bar.tsx` has, for the same
 * reason: tidying a wiki is nine identical decisions in a row — archive these
 * four drafts, label those three, put this handful under the handbook — and
 * nine trips through a page's own menu is why nobody did it.
 *
 * What a page offers is not what a task offers. There are no states and no
 * assignees, the labels are workspace-wide rather than per project (so a
 * selection spanning two projects loses nothing), and there is one action a
 * task has no equivalent of: **move under**, which is the whole reason a tree
 * gets untidy in the first place.
 *
 * Two things are deliberately *not* here:
 *
 * - **A bulk edit of anything inside a page.** Content, access and format each
 *   need the page in front of you.
 * - **A silent cascade onto sub-pages.** Archiving a parent and leaving its
 *   children live is how the `detached` finding in `tidy.ts` gets made, so the
 *   sub-pages are counted and offered as a second, named action rather than
 *   decided for somebody.
 */
import { useMemo } from 'react';
import { statusOf, type Label, type Page } from '@kolibri/shared';
import { useT } from '../../kernel/i18n/i18n';
import { remove, update } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSession } from '../../kernel/identity/session';
import type { Selection } from '../../kernel/design-system/selection';
import { Button } from '../../kernel/design-system/ui/button';
import { navCount } from '../../kernel/design-system/ui/nav';
import { chipDot } from '../../kernel/design-system/ui/chip';
import { Icon, MenuButton, useConfirm, useToast, type MenuItem } from '../../kernel/design-system/ui';
import { descendantsOf } from './pagetree';
import { usePageStatuses } from './status';
import { movePage, movePageToTop } from './page-parts';

/**
 * The bar that appears once something is selected, fixed above the tab bar
 * where a thumb already is. `.selection-bar` is the board's own, unchanged:
 * two bars that drift apart visually would read as two different mechanisms.
 */
export function PageBulkBar({ selection, pages }: { selection: Selection; pages: Page[] }) {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const { workspaceId } = useSession();
  const labels = useQuery(() => list('label', (label) => !label.project_id) as Label[], [workspaceId]);
  const projects = useQuery(() => list('project', (project) => !project.archived), [workspaceId]);
  const statuses = usePageStatuses();

  const selected = useMemo(() => pages.filter((page) => selection.has(page.id)), [pages, selection]);
  /**
   * The pages under the selection that are not themselves in it.
   *
   * Counted so "and the 7 pages under them" can be an offer rather than a
   * surprise, and de-duplicated because selecting a parent *and* its child
   * would otherwise count the grandchildren twice.
   */
  const below = useMemo(() => {
    const picked = new Set(selected.map((page) => page.id));
    const out = new Map<string, Page>();
    for (const page of selected) {
      for (const child of descendantsOf(pages, page.id)) {
        if (!picked.has(child.id)) out.set(child.id, child);
      }
    }
    return [...out.values()];
  }, [selected, pages]);

  /**
   * What a page may be put under: anything in the tree that is not in the
   * selection and not under it.
   *
   * Filtered here rather than left to `plotMove` to refuse, because a menu
   * listing twenty pages of which four do nothing is a menu that teaches people
   * to distrust it.
   *
   * Above the early return, and that is not style. Every hook a component calls
   * has to be called on every render of it, and this one sat *after* the
   * `if (!selected.length) return null` below: with nothing selected the render
   * bailed before reaching it, so the first tick of a checkbox ran one hook more
   * than the render before and React threw `Rendered more hooks than during the
   * previous render` — the screen, not the bar. Nothing caught it because
   * nothing in CI had ever selected a page; `smoke.mjs` does now.
   *
   * `below` is reused rather than walked again. The barred set is the selection
   * plus everything under it, which is exactly what `below` already computed —
   * and `descendantsOf` filters the whole page list per node, so the second
   * walk was the same quadratic cost a second time on every render.
   */
  const targets = useMemo(() => {
    const barred = new Set<string>(selected.map((page) => page.id));
    for (const page of below) barred.add(page.id);
    return pages
      .filter((page) => !barred.has(page.id))
      // By title, not by tree position: this is a menu somebody reads down
      // looking for a name, and the tree order means nothing out of the tree.
      // Capped because a popover is not a page picker — a wiki past this many
      // is one where the right gesture is to drag, or to open the page and use
      // its own Move.
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      .slice(0, 40);
  }, [pages, selected, below]);

  if (!selected.length) return null;

  const count = selected.length;
  const done = (n: number) => t('page.bulkApplied', { count: n });

  const applyTo = (rows: Page[], patch: Record<string, unknown>) => {
    for (const page of rows) update('page', page.id, patch);
    toast(done(rows.length));
    selection.clear();
  };

  /** Add or remove one label across the selection, by what most of them say. */
  const toggleLabel = (label: Label) => {
    const missing = selected.filter((page) => !(page.labels ?? []).includes(label.id));
    // If any page lacks it, the gesture means "give it to all of them";
    // only when every page has it does the same click take it away.
    const adding = missing.length > 0;
    for (const page of selected) {
      const on = new Set(page.labels ?? []);
      if (adding) on.add(label.id);
      else on.delete(label.id);
      update('page', page.id, { labels: [...on] });
    }
    toast(done(count));
    selection.clear();
  };

  /**
   * Put the selection under one page — or at the top level.
   *
   * Always through the two move functions in `page-parts.tsx`, never a bare
   * `parent_id` patch, so each page gets a `sort_order` plotted against where
   * it is going rather than keeping the key it had among its old siblings. The
   * top-level branch *was* that bare patch, two lines under a docblock saying
   * it was not: a page lifted out kept a key chosen relative to pages it no
   * longer sat with, and `compareOrder` has no way to know that.
   *
   * One at a time and in reverse, because each move is plotted against the tree
   * as it stands after the last: both `inside` and the top level append, so
   * reversing keeps the selection's own order on arrival.
   *
   * **Refused is counted; already-there is not.** Moving a branch under its own
   * child is refused by `plotMove`, and in a bulk move that is one page of
   * several — the rest should still go, and the toast should say so. A page
   * already at the top level when the top level is what was asked for is not a
   * refusal, and counting it as one is how "Top level" on three top-level pages
   * came to report "0 of 3 moved — the rest would have sat inside themselves",
   * which is false twice over.
   */
  const moveUnder = (target: Page | null) => {
    let refused = 0;
    for (const page of [...selected].reverse()) {
      if (target) {
        if (!movePage(page.id, target.id, 'inside', workspaceId)) refused += 1;
      } else if (page.parent_id) {
        if (!movePageToTop(page.id, workspaceId)) refused += 1;
      }
    }
    toast(refused
      ? t('page.bulkMovedSome', { count: count - refused, total: count })
      : done(count));
    selection.clear();
  };

  const items: MenuItem[] = [
    ...targets.map((page) => ({
      id: `under-${page.id}`,
      section: t('page.bulkMoveUnder'),
      label: `${page.icon ?? '📄'} ${page.title || t('common.untitled')}`,
      onSelect: () => moveUnder(page),
    })),
    { id: 'under-none', section: t('page.bulkMoveUnder'), label: t('page.bulkTopLevel'), onSelect: () => moveUnder(null) },
    ...statuses.map((status) => ({
      id: `status-${status.id}`,
      section: t('page.bulkStatus'),
      label: status.name,
      icon: <span className={chipDot} style={{ background: status.color }} />,
      // Ticked only when *every* page in the selection is on this rung: a tick
      // that meant "some of them" would be a tick nobody could act on.
      hint: selected.every((page) => statusOf(page, statuses)?.id === status.id) ? '✓' : undefined,
      onSelect: () => applyTo(selected, { status_id: status.id }),
    })),
    ...labels.map((label) => ({
      id: `label-${label.id}`,
      section: t('page.labels'),
      label: label.name,
      icon: <span className={chipDot} style={{ background: label.color }} />,
      hint: selected.every((page) => (page.labels ?? []).includes(label.id)) ? '✓' : undefined,
      onSelect: () => toggleLabel(label),
    })),
    ...projects.map((project) => ({
      id: `project-${project.id}`,
      section: t('page.moveToProject'),
      label: `${project.icon ?? ''} ${project.name}`.trim(),
      onSelect: () => applyTo(selected, { project_id: project.id }),
    })),
    { id: 'project-none', section: t('page.moveToProject'), label: t('page.workspaceLevel'),
      onSelect: () => applyTo(selected, { project_id: null }) },
  ];

  return (
    <>
      <div className="selection-bar" role="toolbar" aria-label={t('page.bulkTitle')}>
        <span className="count">{t('page.bulkCount', { count })}</span>
        {below.length > 0 && <span className={navCount} title={t('page.bulkBelowHint')}>+{below.length}</span>}

        <MenuButton variant="ghost" size="sm" items={items}>
          <Icon name="hierarchy" size={14} /> <span className="hide-sm">{t('page.bulkOrganise')}</span>
        </MenuButton>

        <Button variant="ghost" size="sm" onClick={() => applyTo(selected, { archived: 1 })}>
          <Icon name="archive" size={14} /> <span className="hide-sm">{t('action.archive')}</span>
        </Button>
        {below.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => applyTo([...selected, ...below], { archived: 1 })}>
            <Icon name="archive" size={14} /> {t('page.bulkWithBelow', { count: below.length })}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => applyTo(selected, { archived: 0 })}>
          <Icon name="refresh" size={14} /> <span className="hide-sm">{t('action.unarchive')}</span>
        </Button>

        {/* Deletion asks, and says how much it is about to take: the sub-pages
            go with the parent whether or not anybody thought about them, so the
            number is in the question rather than in a release note. */}
        <Button
          variant="ghost" size="sm"
          onClick={async () => {
            const confirmed = await confirm(
              below.length
                ? t('page.bulkDeleteWithBelow', { count, below: below.length })
                : t('page.bulkDelete', { count }),
              t('page.delete'),
            );
            if (!confirmed) return;
            for (const page of selected) remove('page', page.id);
            toast(done(count));
            selection.clear();
          }}
        >
          <Icon name="trash" size={13} /> <span className="hide-sm">{t('action.delete')}</span>
        </Button>

        <span className="flex-1 min-w-0" />
        <Button variant="ghost" size="sm" onClick={selection.clear}>{t('select.clear')}</Button>
      </div>
      {dialog}
    </>
  );
}
