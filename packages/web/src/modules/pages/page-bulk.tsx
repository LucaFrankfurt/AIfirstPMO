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
import type { Label, Page } from '@kolibri/shared';
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
import { movePage } from './page-parts';

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
   * Through `movePage` rather than a bare `parent_id` patch, so each page gets
   * a `sort_order` between the target's existing children instead of landing
   * on whatever key it already had. One at a time and in reverse, because each
   * move is plotted against the tree as it stands after the last: `inside`
   * appends, so reversing keeps the selection's own order on arrival.
   *
   * A refusal is counted rather than thrown. Moving a branch under its own
   * child is refused by `plotMove`, and in a bulk move that is one page of
   * several — the rest should still go.
   */
  const moveUnder = (target: Page | null) => {
    let moved = 0;
    for (const page of [...selected].reverse()) {
      if (target) {
        if (movePage(page.id, target.id, 'inside', workspaceId)) moved += 1;
      } else if (page.parent_id) {
        update('page', page.id, { parent_id: null });
        moved += 1;
      }
    }
    toast(moved === count ? done(moved) : t('page.bulkMovedSome', { count: moved, total: count }));
    selection.clear();
  };

  /**
   * What a page may be put under: anything in the tree that is not in the
   * selection and not under it.
   *
   * Filtered here rather than left to `plotMove` to refuse, because a menu
   * listing twenty pages of which four do nothing is a menu that teaches people
   * to distrust it.
   */
  const targets = useMemo(() => {
    const barred = new Set(selected.map((page) => page.id));
    for (const page of selected) for (const child of descendantsOf(pages, page.id)) barred.add(child.id);
    return pages
      .filter((page) => !barred.has(page.id))
      // By title, not by tree position: this is a menu somebody reads down
      // looking for a name, and the tree order means nothing out of the tree.
      // Capped because a popover is not a page picker — a wiki past this many
      // is one where the right gesture is to drag, or to open the page and use
      // its own Move.
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      .slice(0, 40);
  }, [pages, selected]);

  const items: MenuItem[] = [
    ...targets.map((page) => ({
      id: `under-${page.id}`,
      section: t('page.bulkMoveUnder'),
      label: `${page.icon ?? '📄'} ${page.title || t('common.untitled')}`,
      onSelect: () => moveUnder(page),
    })),
    { id: 'under-none', section: t('page.bulkMoveUnder'), label: t('page.bulkTopLevel'), onSelect: () => moveUnder(null) },
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
