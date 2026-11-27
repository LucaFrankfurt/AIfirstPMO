import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  formatHtml, htmlOutline, isBoardFormat, isSuperseded, htmlToMarkdown, outlineOf, pageExcerpt, pageResolver, renderMarkdown,
  comparePages, statusOf, type Anchor, type Label, type Page, type PageFormat, type PageStatus, type PageType,
} from '@kolibri/shared';
import { Header, Trail, type Crumb } from '../../../kernel/design-system/chrome';
import { Comments } from '../../work/comments';
import {
  ACCESS_KEY, PageCover, PageHistory, PageLabelChips, VersionDiff, labelItems, moveItems,
  useCover, useExport, usePageLabels, usePrint, useWatching,
} from '../page-parts';
import { groupBranches, pagesMatching, pagesWhere, trailsOf } from '../page-tree';
import {
  DriftNotice, isPinned, isSeries, PageTypeChip, pinItem, SeriesEntries, seriesItem, SupersededNotice, successorItems,
  typeItems, typeOf, usePageTypes,
} from '../organise';
import { PageStatusChip, statusItems, usePageStatuses } from '../status';
import { PublicKnowledgeChip, PublicKnowledgeNotice, isPublicKnowledge } from '../public-knowledge';
import { PageTree, foldableIds, usePageFolds } from '../PageTree';
import { PageBulkBar } from '../page-bulk';
import { HEADING_PREFIX, useBacklinks, usePageGraph, useRenamePage, useTrail, useUnwritten } from '../page-links';
import { PageGraph } from '../PageGraph';
import { Markdown, MarkdownEditor } from '../Markdown';
import { HtmlEditor, HtmlView } from '../Html';
import { ImportPages } from '../import';
import { CanvasView } from '../Canvas';
import { BoardPageView } from '../BoardPage';
import { BOARD_ICON } from '../blocks';
import { copyBoards, downloadBoards } from '../boards';
import { useBoardAi } from '../../ai-review/board-ai';
import { Attachments } from '../../../kernel/files/Attachments';
import { Empty } from '../../../kernel/design-system/ui/empty';
import { Icon } from '../../../kernel/design-system/ui/icon';
import { MenuButton } from '../../../kernel/design-system/ui/menu-button';
import { useConfirm } from '../../../kernel/design-system/ui/sheet';
import { useToast } from '../../../kernel/design-system/ui/toast';
import { ShareSheet } from '../../share/share';
import { useHighlights, useSelectionAnchor } from '../annotate';
import { relativeTime } from '../../../kernel/design-system/format';

import { byOrder, createPage, remove, update } from '../../../kernel/sync/mutations';
import { byId, list, useQuery, useRow } from '../../../kernel/sync/store';
import { useCollaborativeText } from '../collab';
import { useCanWrite, useMe, useMemberMap, useSession } from '../../../kernel/identity/session';
import { Button } from '../../../kernel/design-system/ui/button';
import { Input } from '../../../kernel/design-system/ui/field';
import { EmojiPicker } from '../../../kernel/design-system/ui/emoji-picker';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { navItem } from '../../../kernel/design-system/ui/nav';
import { Chip, chipDot } from '../../../kernel/design-system/ui/chip';
import { useSelection } from '../../../kernel/design-system/selection';
import { useT, type TranslationKey } from '../../../kernel/i18n/i18n';
import { cn } from '../../../kernel/design-system/cn';
import { useMinute } from '../../../kernel/design-system/minute';
import { pageBody } from '../../../kernel/design-system/ui/page';

/**
 * The headings of a page, as something to jump by.
 *
 * Collapsed, and above the text rather than beside it. A handbook chapter is
 * the case this is for and those are long, but the reading column here is a
 * fixed measure — a sticky aside would have to take width from it, and a
 * narrower line of prose to make room for a table of contents is a bad trade on
 * the screen most people read on. One click, no scrolling past it.
 *
 * Only where there is enough of a page to get lost in. An outline over two
 * headings is furniture.
 */
/** What a new canvas is marked with in the tree, until somebody picks another. */
const CANVAS_ICON = '🎨';

function PageOutline({ source, format }: { source: string; format: PageFormat }) {
  const t = useT();
  // Two readers, one list. The slugs come out the same because both outline
  // functions count with the same slug maker the renderers put on the headings.
  const headings = useMemo(
    () => (format === 'html' ? htmlOutline(source) : outlineOf(source)).filter((one) => one.level <= 3),
    [source, format],
  );
  if (headings.length < 3) return null;
  return (
    <details className="page-outline">
      <summary>{t('page.outline')}</summary>
      <ul>
        {headings.map((heading) => (
          <li key={heading.slug} style={{ paddingInlineStart: (heading.level - 1) * 12 }}>
            {/* A plain anchor, not a router link: a fragment on the page you are
                already on is the browser's job, and it does it better. */}
            <a href={`#${encodeURIComponent(HEADING_PREFIX + heading.slug)}`}>{heading.text}</a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * `[[A page nobody has written]]`, followed.
 *
 * Obsidian's one genuinely load-bearing idea: a link to a page that does not
 * exist is how the page gets written. The alternative — a dead bracket, and a
 * New page button somewhere else that starts you at Untitled — is why wikis
 * fill up with pages nobody meant and stay missing the ones somebody did.
 *
 * A route rather than a click handler on the renderer, so the link is a real
 * link: middle-click opens it in a tab, the address bar shows what it will do,
 * and `Markdown` stays a component that renders text and knows nothing about
 * creating anything.
 *
 * It resolves once more before creating. Between the render that drew the link
 * and the click that followed it, somebody else's page may have arrived over
 * sync — or the reader may have followed the same broken link twice — and a
 * second page with the same title would take every other link with it.
 */
export function PageFromLink() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const me = useMe();
  const { workspaceId } = useSession();
  const canWrite = useCanWrite();
  const wanted = (params.get('title') ?? '').trim();
  // React runs an effect twice in development, and creating a page is not a
  // thing to do twice.
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const existing = pageResolver(list('page', (page) => page.workspace_id === workspaceId))(wanted);
    if (existing) navigate(`/pages/${existing.id}`, { replace: true });
    else if (!wanted || !canWrite) navigate('/pages', { replace: true });
    else navigate(`/pages/${createPage({ title: wanted }, me)}`, { replace: true });
  }, [wanted, workspaceId, canWrite, me, navigate]);

  return null;
}

/** How the index draws the wiki, kept on this device like the folds. */
type Grouping = 'tree' | 'project' | 'type' | 'status';
const GROUP_KEY = 'kolibri.page-group';
const GROUPINGS: Grouping[] = ['tree', 'project', 'type', 'status'];
const GROUP_LABEL: Record<Grouping, TranslationKey> = {
  tree: 'page.groupTree', project: 'page.groupProject', type: 'page.groupType', status: 'page.groupStatus',
};

const readGrouping = (): Grouping => {
  try {
    const kept = localStorage.getItem(GROUP_KEY) as Grouping | null;
    return kept && GROUPINGS.includes(kept) ? kept : 'tree';
  } catch {
    return 'tree';
  }
};

/** What the type filter is set to when it asks for pages with none. */
const NO_TYPE = '__none';

/**
 * The order within each level: the one people dragged, or by age — when a page
 * was made. Kept on this device like the grouping.
 */
type Sorting = 'manual' | 'newest' | 'oldest';
const SORT_KEY = 'kolibri.page-sort';
const SORTINGS: Sorting[] = ['manual', 'newest', 'oldest'];
const SORT_LABEL: Record<Sorting, TranslationKey> = {
  manual: 'page.sortManual', newest: 'page.sortNewest', oldest: 'page.sortOldest',
};
const BY_AGE: Record<Exclude<Sorting, 'manual'>, (a: Page, b: Page) => number> = {
  newest: (a, b) => b.created_at - a.created_at || comparePages(a, b),
  oldest: (a, b) => a.created_at - b.created_at || comparePages(a, b),
};

const readSorting = (): Sorting => {
  try {
    const kept = localStorage.getItem(SORT_KEY) as Sorting | null;
    return kept && SORTINGS.includes(kept) ? kept : 'manual';
  } catch {
    return 'manual';
  }
};

export function PagesIndex() {
  useMinute(); // re-reads the ages below once a minute — `design-system/minute.ts`
  const t = useT();
  const { workspaceId } = useSession();
  const me = useMe();
  const navigate = useNavigate();
  const all = useQuery(() => list('page', (p) => p.workspace_id === workspaceId && !p.archived), [workspaceId]);
  const allLabels = useQuery(() => list('label', (label) => label.workspace_id === workspaceId) as Label[], [workspaceId]);
  const projects = useQuery(() => list('project', (project) => !project.archived).sort(byOrder), [workspaceId]);
  /** The labels to show, any of them; empty for all. */
  const [labelsOn, setLabelsOn] = useState<string[]>([]);
  /** The rung to show, or '' for all of them. */
  const [rung, setRung] = useState<string>('');
  /** The type to show, `NO_TYPE` for pages without one, or '' for all. */
  const [typeOn, setTypeOn] = useState<string>('');
  /** Leave out the pages marked as public knowledge — they have a view of their own. Off unless asked. */
  const [hideKnowledge, setHideKnowledge] = useState(false);
  const statuses = usePageStatuses();
  const types = usePageTypes();
  const [importing, setImporting] = useState(false);
  const canWrite = useCanWrite();
  const [grouping, setGroupingState] = useState<Grouping>(readGrouping);
  const setGrouping = (next: Grouping) => {
    setGroupingState(next);
    try {
      localStorage.setItem(GROUP_KEY, next);
    } catch { /* blocked storage — the session still works */ }
  };
  const [sorting, setSortingState] = useState<Sorting>(readSorting);
  const setSorting = (next: Sorting) => {
    setSortingState(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch { /* blocked storage — the session still works */ }
  };
  const byAge = sorting === 'manual' ? undefined : BY_AGE[sorting];
  // Dragging decides the manual order, so it is only offered while that is the
  // order on screen: a drop between two pages sorted by age would land
  // somewhere else the moment it was made.
  const canDrag = canWrite && !byAge;

  /*
   * The archive is on the tidying screen now, and this is why.
   *
   * It used to be a second mode of this one — a button that swapped the tree
   * for a flat list — which was the right fix for the problem it had ("every
   * list filters `!archived`, so the control that undoes it lived on a page you
   * could no longer find") and the wrong place for it. The archive, the trash
   * and the findings all answer one question, *what is not in the tree and what
   * of it do I still want*, and three screens answering a third of it each is
   * how the answer goes stale. So this screen draws the wiki and nothing else,
   * and the button below leads to the one that draws everything it is not.
   */

  // Templates are kept out of the tree: they are starting points, not content,
  // and a handbook with three half-written templates in it reads as a mess.
  const templates = useMemo(() => all.filter((page) => page.is_template), [all]);
  const pages = useMemo(() => all.filter((page) => !page.is_template) as Page[], [all]);
  /*
   * Recently edited, without the pages somebody replaced: "what is current" is
   * the question this row answers, and last quarter's prices were the most
   * recently touched page on the first real wiki the week they were retired.
   */
  const recent = useMemo(
    () => pages.filter((page) => !isSuperseded(page, statuses))
      .sort((a, b) => b.updated_at - a.updated_at).slice(0, 6),
    [pages, statuses],
  );
  /*
   * The reference pages: what the first real wiki kept as a hand-written table
   * at the bottom of a cleanup page — which page counts, per subject. Above the
   * recent ones, because "what is current" outranks "what moved".
   */
  const pinned = useMemo(
    () => pages.filter((page) => isPinned(page) && !isSuperseded(page, statuses))
      .sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    [pages, statuses],
  );
  /*
   * Every label any page carries, from wherever it was made.
   *
   * This asked only for workspace-wide labels, while a page's own menu offered
   * every label there was — so a page labelled with one of its project's
   * labels could be labelled and never filtered by it. On the first real
   * instance 72 of 73 labels belonged to a project, and the filter had one
   * label to offer.
   */
  const inUse = useMemo(() => {
    const used = new Set(pages.flatMap((page) => page.labels ?? []));
    return allLabels.filter((label) => used.has(label.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [pages, allLabels]);
  // What the wiki has asked for and nobody has written: the only to-do list
  // here that writes itself.
  const unwritten = useUnwritten();
  const graph = usePageGraph();
  // The tree is the way in and stays the default; the picture answers a
  // different question and waits to be asked.
  const [drawn, setDrawn] = useState(false);

  /* ------------------------------------------------------- tidying up */

  const folds = usePageFolds();
  const selection = useSelection();
  /** Whether the checkboxes are showing. A tree is read far more often than it is sorted. */
  const [picking, setPicking] = useState(false);
  const [hunt, setHunt] = useState('');
  const foldable = useMemo(() => foldableIds(pages), [pages]);

  /**
   * The filters, as one question asked of a page — or none.
   *
   * Labels are *any of*: a page about pricing or about sales is what somebody
   * ticking both is looking for. The rung is by where a page *stands*, which is
   * not the same as its column: a page that never had a status stands on the
   * draft, and a filter that asked the column would hide exactly the pages
   * this feature was built to find.
   *
   * Hiding the knowledge base is the one filter that leaves pages *out* rather
   * than picking them, and it is asked the same way so it behaves the same: a
   * page kept under a hidden article still draws the article, faint, as the
   * path to it — rather than turning up at the top level as if it had none.
   */
  const knowledge = useMemo(() => pages.some(isPublicKnowledge), [pages]);
  const filtering = labelsOn.length + (rung ? 1 : 0) + (typeOn ? 1 : 0) + (hideKnowledge ? 1 : 0);
  const test = useMemo(() => (filtering
    ? (page: Page) => (!labelsOn.length || labelsOn.some((id) => (page.labels ?? []).includes(id)))
      && (!rung || statusOf(page, statuses)?.id === rung)
      && (!typeOn || (typeOn === NO_TYPE ? !typeOf(page, types) : page.type_id === typeOn))
      && (!hideKnowledge || !isPublicKnowledge(page))
    : null), [filtering, labelsOn, rung, typeOn, hideKnowledge, statuses, types]);

  /**
   * The filters and the box, as a set of ids to draw: matches *plus the path to
   * each of them*, because the answer to "where is the leave policy" is the
   * path and not the row. The label and status filters used to narrow the list
   * before the tree was built instead, which drew every matching sub-page as a
   * chapter of its own — see `pagesWhere`.
   */
  const { keep, matched } = useMemo(() => pagesWhere(pages, test, hunt), [pages, test, hunt]);
  const trails = useMemo(() => trailsOf(pages), [pages]);

  /*
   * The sections, when the wiki is drawn in them.
   *
   * By project, the tree is kept whole and filed by where each branch's top
   * page is filed — a sub-page stays under its parent even when the two sit in
   * different projects. By type or by status there is no tree to keep: those
   * are said of each page on its own, so the sections are flat lists with each
   * page's path beside it.
   */
  const sections = useMemo((): { id: string; label: string; icon?: React.ReactNode; pages: Page[] }[] => {
    if (grouping === 'project') {
      // A project id that names nothing any more is filed with the workspace,
      // rather than as a second section called the same thing. An archived
      // project still has a name, and keeps its own section after the live ones.
      return groupBranches(pages, (root) => (root.project_id && byId('project', root.project_id) ? root.project_id : null),
        [null, ...projects.map((project) => project.id)])
        .map(({ key, pages: rows }) => {
          const project = key ? byId('project', key) : undefined;
          return {
            id: key ?? 'none',
            label: project?.name ?? t('page.workspaceLevel'),
            icon: project?.icon ?? undefined,
            pages: rows,
          };
        })
        .filter((section) => !keep || section.pages.some((page) => keep.has(page.id)));
    }
    if (grouping === 'type' || grouping === 'status') {
      const shown = pages.filter((page) => !matched || matched.has(page.id));
      const keyOf = (page: Page) => (grouping === 'type' ? typeOf(page, types)?.id : statusOf(page, statuses)?.id) ?? null;
      const order = grouping === 'type' ? types : statuses;
      return [...order.map((one) => one.id), null]
        .map((id) => {
          const one = order.find((row) => row.id === id);
          return {
            id: id ?? 'none',
            label: one?.name ?? t(grouping === 'type' ? 'page.typeNone' : 'pageStatus.draft'),
            icon: grouping === 'type'
              ? (one as PageType | undefined)?.icon ?? undefined
              : one ? <span className={chipDot} style={{ background: (one as PageStatus).color }} /> : undefined,
            pages: shown.filter((page) => keyOf(page) === id)
              .sort(byAge ?? ((a, b) => (a.title || '').localeCompare(b.title || ''))),
          };
        })
        .filter((section) => section.pages.length > 0);
    }
    return [];
  }, [grouping, pages, projects, types, statuses, keep, matched, t, byAge]);
  const flat = grouping === 'type' || grouping === 'status';

  const toggleLabel = (id: string) =>
    setLabelsOn(labelsOn.includes(id) ? labelsOn.filter((one) => one !== id) : [...labelsOn, id]);

  return (
    <>
      <Header title={t('page.listTitle')}>
        {/*
          * The way to everything this screen does not draw: the archive, the
          * trash, and what `tidy.ts` found.
          *
          * It carried a count, and the count was wrong twice. It summed the
          * findings *and* the archive while the screen it opens reports the
          * findings alone and puts the archive in a tile of its own — two
          * numbers for one thing, which is the one duplication this repository
          * will not keep. And it was computed over `pages`, already narrowed by
          * the label filter above, so picking a label made it drop as though
          * something had been tidied.
          *
          * Getting it right would also have meant a third full parse of every
          * page body on this screen: `tidyPages` builds a `linkGraph`, and
          * `usePageGraph` and `useUnwritten` below each build one already. For
          * a badge. So the number lives where it can be checked against what is
          * under it, and the button is a label.
          */}
        <Button variant="secondary" size="sm" onClick={() => navigate('/pages/tidy')}>
          <Icon name="archive" size={14} />
          <span className="hide-sm">{t('page.tidy')}</span>
        </Button>
        {/* The same pages, gathered: those marked for people outside. */}
        <Button
          variant="secondary" size="sm" title={t('page.publicKnowledge')} aria-label={t('page.publicKnowledge')}
          onClick={() => navigate('/pages/knowledge')}
        >
          <Icon name="globe" size={14} />
          <span className="hide-sm">{t('page.publicKnowledge')}</span>
        </Button>
        {/* One filter button with drawers rather than three buttons. This
            header is one row 52px tall and scrolls sideways when it does not
            fit; a control per question costs more than the questions are worth,
            and all of them narrow the same tree. Drawers, because labels and
            types are lists that grow with the workspace — see `check:menus`. */}
        {(inUse.length > 0 || statuses.length > 0 || types.length > 0 || knowledge) && (
          <MenuButton
            variant="secondary" size="sm"
            items={[
              { id: 'all', label: t('page.allPages'), hint: filtering ? undefined : '✓',
                onSelect: () => { setLabelsOn([]); setRung(''); setTypeOn(''); setHideKnowledge(false); } },
              // A switch rather than a list, so a row of its own and not a drawer.
              ...(knowledge ? [{
                id: 'hide-knowledge',
                label: t('page.hideKnowledge'),
                icon: <Icon name="globe" size={14} />,
                hint: hideKnowledge ? '✓' : undefined,
                onSelect: () => setHideKnowledge(!hideKnowledge),
              }] : []),
              ...(inUse.length ? [{
                id: 'labels',
                label: t('page.labels'),
                icon: <Icon name="tag" size={14} />,
                hint: labelsOn.length ? String(labelsOn.length) : undefined,
                search: inUse.length > 8,
                items: inUse.map((label) => ({
                  id: `label-${label.id}`,
                  label: label.name,
                  icon: <span className={chipDot} style={{ background: label.color }} />,
                  // Which project's: eight projects each seeded a `Bug`, and the
                  // name alone names none of them.
                  hint: [labelsOn.includes(label.id) ? '✓' : null,
                    label.project_id ? byId('project', label.project_id)?.name : null].filter(Boolean).join(' ') || undefined,
                  keepOpen: true,
                  onSelect: () => toggleLabel(label.id),
                })),
              }] : []),
              ...(statuses.length ? [{
                id: 'status',
                label: t('page.status'),
                icon: <Icon name="check" size={14} />,
                hint: statuses.find((status) => status.id === rung)?.name,
                items: statuses.map((status) => ({
                  id: `status-${status.id}`,
                  label: status.name,
                  icon: <span className={chipDot} style={{ background: status.color }} />,
                  hint: rung === status.id ? '✓' : undefined,
                  onSelect: () => setRung(rung === status.id ? '' : status.id),
                })),
              }] : []),
              ...(types.length ? [{
                id: 'type',
                label: t('page.type'),
                icon: <Icon name="page" size={14} />,
                hint: typeOn === NO_TYPE ? t('page.typeNone') : types.find((type) => type.id === typeOn)?.name,
                items: [
                  ...types.map((type) => ({
                    id: `type-${type.id}`,
                    label: type.name,
                    icon: <span aria-hidden="true">{type.icon ?? '•'}</span>,
                    hint: typeOn === type.id ? '✓' : undefined,
                    onSelect: () => setTypeOn(typeOn === type.id ? '' : type.id),
                  })),
                  { id: 'type-none', label: t('page.typeNone'), hint: typeOn === NO_TYPE ? '✓' : undefined,
                    onSelect: () => setTypeOn(typeOn === NO_TYPE ? '' : NO_TYPE) },
                ],
              }] : []),
            ]}
          >
            <Icon name="filter" size={14} />
            <span className="hide-sm">{filtering ? t('page.filters', { count: filtering }) : t('page.filterByLabel')}</span>
          </MenuButton>
        )}
        {templates.length > 0 && (
          <MenuButton
            variant="secondary" size="sm"
            items={templates.map((template) => ({
              id: template.id,
              label: `${template.icon ?? '📄'} ${template.title}`,
              // A copy, not a link: a template is a starting point, and editing
              // the new page must not edit the template. In the template's own
              // format, with its icon and its type — an HTML template used to
              // become a markdown page showing its tags — and with copies of
              // its boards when it is a canvas or a board page.
              onSelect: () => {
                const made = createPage({
                  title: template.title, content: template.content, project_id: template.project_id,
                  format: template.format ?? 'markdown', icon: template.icon ?? undefined, type_id: template.type_id ?? null,
                }, me);
                copyBoards(template, { id: made, title: template.title, format: template.format ?? 'markdown' });
                navigate(`/pages/${made}`);
              },
            }))}
          >
            <Icon name="copy" size={14} />
            <span className="hide-sm">{t('page.newFromTemplate')}</span>
          </MenuButton>
        )}
        {canWrite && (
          <Button variant="secondary" size="sm" onClick={() => setImporting(true)}>
            <Icon name="attach" size={14} /> <span className="hide-sm">{t('page.import')}</span>
          </Button>
        )}
        {canWrite && (
          <Button
            variant="secondary" size="sm" title={t('canvas.new')} aria-label={t('canvas.new')}
            onClick={() => navigate(`/pages/${createPage({ title: t('common.untitled'), format: 'canvas', icon: CANVAS_ICON }, me)}`)}
          >
            <Icon name="canvas" size={14} /> <span className="hide-sm">{t('canvas.new')}</span>
          </Button>
        )}
        {canWrite && (
          <Button
            variant="secondary" size="sm" title={t('board.new')} aria-label={t('board.new')}
            onClick={() => navigate(`/pages/${createPage({ title: t('common.untitled'), format: 'board', icon: BOARD_ICON }, me)}`)}
          >
            <Icon name="page" size={14} /> <span className="hide-sm">{t('board.new')}</span>
          </Button>
        )}
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => navigate(`/pages/${createPage({ title: t('common.untitled') }, me)}`)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('page.new')}</span>
          </Button>
        )}
      </Header>
      <div className={pageBody}>
        {!pages.length ? (
          <Empty
            emoji="📓" title={t('page.emptyTitle')}
            hint={t('page.emptyHint')} guide="pages"
            action={<Button variant="primary" onClick={() => navigate(`/pages/${createPage({ title: t('common.untitled') }, me)}`)}>{t('page.writeFirst')}</Button>}
          />
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                <h2 className="mb-2 text-title font-semibold">{t('page.pinned')}</h2>
                <div className="mb-6 grid gap-3 sm:grid-cols-2">
                  {pinned.map((page) => <PageCard key={page.id} page={page} />)}
                </div>
              </>
            )}
            <h2 className="mb-2 text-title font-semibold">{t('page.recentlyEdited')}</h2>
            {/* Links, not buttons that navigate: a page is a thing people open
                in a second tab, and a button cannot be. */}
            <div className="mb-6 grid gap-3 sm:grid-cols-2">
              {recent.map((page) => <PageCard key={page.id} page={page} />)}
            </div>
            <div className="flex items-center flex-wrap gap-2 mb-2">
              <h2 className="text-title font-semibold">{t('page.all')}</h2>
              {!drawn && canDrag && !picking && !flat && <span className="text-label text-muted hide-sm">{t('page.dragHint')}</span>}
              <span className="flex-1 min-w-0" />
              {!drawn && (
                <>
                  {/* Typing is the fast way to a page in a tree of ninety, and
                      until now the only one was the command palette — which
                      opens the page rather than showing you where it sits. */}
                  <Input
                    style={{ maxWidth: 200 }}
                    placeholder={t('page.filterTree')}
                    aria-label={t('page.filterTree')}
                    value={hunt}
                    onChange={(event) => setHunt(event.target.value)}
                  />
                  <MenuButton
                    variant="ghost" size="sm"
                    items={GROUPINGS.map((one) => ({
                      id: `group-${one}`,
                      label: t(GROUP_LABEL[one]),
                      hint: grouping === one ? '✓' : undefined,
                      onSelect: () => {
                        // A selection made in a tree means nothing in a flat
                        // list, and the flat lists have no Select to end it with.
                        selection.clear();
                        if (one === 'type' || one === 'status') setPicking(false);
                        setGrouping(one);
                      },
                    }))}
                  >
                    <Icon name="folder" size={14} />
                    <span className="hide-sm">{t(GROUP_LABEL[grouping])}</span>
                  </MenuButton>
                  <MenuButton
                    variant="ghost" size="sm"
                    items={SORTINGS.map((one) => ({
                      id: `sort-${one}`,
                      label: t(SORT_LABEL[one]),
                      hint: sorting === one ? '✓' : undefined,
                      onSelect: () => setSorting(one),
                    }))}
                  >
                    <Icon name="calendar" size={14} />
                    <span className="hide-sm">{t(SORT_LABEL[sorting])}</span>
                  </MenuButton>
                  {foldable.length > 0 && !keep && !flat && (
                    <Button
                      variant="ghost" size="sm"
                      title={folds.count ? t('page.unfoldAll') : t('page.foldAll')}
                      aria-label={folds.count ? t('page.unfoldAll') : t('page.foldAll')}
                      onClick={() => folds.setAll(!folds.count, foldable)}
                    >
                      <Icon name={folds.count ? 'chevronDown' : 'chevronRight'} size={14} />
                    </Button>
                  )}
                  {canWrite && !flat && (
                    <Button
                      variant={picking ? 'primary' : 'ghost'} size="sm"
                      aria-pressed={picking}
                      onClick={() => {
                        selection.clear();
                        setPicking(!picking);
                      }}
                    >
                      <Icon name="check" size={14} />
                      <span className="hide-sm">{t('page.select')}</span>
                    </Button>
                  )}
                </>
              )}
              {graph.nodes.length > 1 && (
                <Button
                  variant={drawn ? 'primary' : 'ghost'} size="sm"
                  aria-pressed={drawn}
                  onClick={() => setDrawn(!drawn)}
                >
                  <Icon name="hierarchy" size={14} />
                  <span className="hide-sm">{t('page.graph')}</span>
                </Button>
              )}
            </div>
            {drawn ? (
              <PageGraph nodes={graph.nodes} edges={graph.edges} />
            ) : keep?.size === 0 ? (
              <p className="text-muted text-label">{filtering ? t('page.filterNoMatch') : t('page.filterNone')}</p>
            ) : grouping === 'tree' ? (
              <PageTree
                pages={pages}
                canWrite={canDrag}
                folds={folds}
                selection={picking ? selection : undefined}
                keep={keep}
                matched={matched}
                marks
                sort={byAge}
              />
            ) : (
              sections.map((section) => (
                <section key={section.id} className="mb-5">
                  <SectionHeading tight>
                    <span className="flex items-center gap-1.5">
                      {section.icon && <span aria-hidden="true">{section.icon}</span>}
                      <span>{section.label}</span>
                      {/* What the section shows: its matches while a filter
                          runs, not the whole branch set behind them. */}
                      <span className="text-muted text-label font-normal">
                        {matched ? section.pages.filter((page) => matched.has(page.id)).length : section.pages.length}
                      </span>
                    </span>
                  </SectionHeading>
                  {flat ? section.pages.map((page) => (
                    <Link key={page.id} to={`/pages/${page.id}`} className="page-row">
                      <span className={cn(navItem(), 'page-row-main')}>
                        <span style={{ width: 16 }}>{page.icon ?? '📄'}</span>
                        <span className="flex-1 min-w-0 truncate">{page.title || t('common.untitled')}</span>
                        {/* The path, because out of the tree "Preise" could be
                            any of four pages and where it hangs says which. */}
                        <span className="text-caption text-muted truncate hide-sm" style={{ maxWidth: '40%' }}>
                          {(trails.get(page.id) ?? []).map((parent) => parent.title || t('common.untitled')).join(' › ')}
                        </span>
                        <PageStatusChip page={page} dot />
                      </span>
                    </Link>
                  )) : (
                    <PageTree
                      pages={section.pages}
                      canWrite={canDrag}
                      folds={folds}
                      selection={picking ? selection : undefined}
                      keep={keep}
                      matched={matched}
                      marks
                      sort={byAge}
                    />
                  )}
                </section>
              ))
            )}

            {canWrite && unwritten.length > 0 && (
              <section className="mt-7">
                <h2 className="mb-1 text-title font-semibold">{t('page.unwritten')}</h2>
                <p className="mb-3 text-label text-muted">{t('page.unwrittenHint')}</p>
                {unwritten.slice(0, 8).map((entry) => (
                  <Link
                    key={entry.title}
                    to={`/pages/new?title=${encodeURIComponent(entry.title)}`}
                    className="page-row"
                  >
                    <span className={cn(navItem(), 'page-row-main')}>
                      {/* The app's own pencil rather than a `✎` character: a
                          glyph the reader's font may or may not have looked
                          like a paperclip in one of the three it fell back to. */}
                      <span style={{ width: 16 }} className="text-muted"><Icon name="pencil" size={13} /></span>
                      <span className="flex-1 min-w-0 truncate">{entry.title}</span>
                      <span className="text-caption text-muted hide-sm">
                        {t('page.wantedBy', { count: entry.from.length })}
                      </span>
                    </span>
                  </Link>
                ))}
              </section>
            )}
          </>
        )}
      </div>
      {importing && <ImportPages onClose={() => setImporting(false)} />}
      {picking && <PageBulkBar selection={selection} pages={pages} />}
    </>
  );
}

/**
 * A page as a card: the reference pages and the recent ones, drawn alike.
 *
 * `min-w-0`, because a grid item's automatic minimum is its content: the title
 * inside truncates, but the *card* was sized to the untruncated title and
 * pushed the track wider than the column. Measured at 340px with a real
 * handbook's titles — a 452px card in a 340px screen, and `main` scrolling
 * sideways by 124px on a phone.
 */
function PageCard({ page }: { page: Page }) {
  const t = useT();
  return (
    <Link
      to={`/pages/${page.id}`}
      className="flex min-w-0 flex-col gap-1 rounded border border-line bg-raised p-3.5 text-left transition-colors hover:border-line-strong hover:bg-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <span className="flex items-center gap-2">
        <span aria-hidden="true">{page.icon ?? '📄'}</span>
        <strong className="flex-1 min-w-0 truncate">{page.title || t('common.untitled')}</strong>
        <PageTypeChip page={page} dot />
        <PageStatusChip page={page} dot />
      </span>
      <p className="m-0 text-label text-muted">{page.format === 'canvas' ? t('canvas.kind') : page.format === 'board' ? t('board.kind') : pageExcerpt(page.content, page.format, 110) || t('page.emptyPage')}</p>
      <span className="text-caption text-muted">{t('page.updated', { time: relativeTime(page.updated_at) })}</span>
    </Link>
  );
}

/* ------------------------------------------------------------------- page */

/** Whether this device wants the tree beside the page. Never synced — see below. */
const TREE_KEY = 'kolibri.page-aside';


export function PageDetail() {
  useMinute(); // re-reads the ages below once a minute — `design-system/minute.ts`
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const page = useRow('page', id);
  const me = useMe();
  const members = useMemberMap();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const [editing, setEditing] = useState(false);
  /*
   * A board page's editor, apart from the text editor's flag: that one
   * survives moving to another page — this component is not remounted — and a
   * board page opened while it was set would open straight into its editor.
   */
  const [editingBoard, setEditingBoard] = useState(false);
  useEffect(() => setEditingBoard(false), [id]);
  /** Bumped by *Download → PDF* on a canvas or a board page, whose view holds the print layer. */
  const [printRequest, setPrintRequest] = useState(0);
  const [title, setTitle] = useState(page?.title ?? '');
  const [history, setHistory] = useState(false);
  const [diffing, setDiffing] = useState<string | null>(null);

  const { workspaceId } = useSession();
  // In the tree's order, which the store's is not — see `comparePages`.
  const children = useQuery(() => (list('page', (p) => p.parent_id === id && !p.archived) as Page[]).sort(comparePages), [id]);
  // Where this page sits, and what points at it: the tree and the web, the two
  // halves of finding your way around a wiki.
  const trail = useTrail(id);
  const backlinks = useBacklinks(id);
  const rename = useRenamePage();
  const labels = usePageLabels((page ?? { project_id: null }) as any);
  const statuses = usePageStatuses();
  const types = usePageTypes();
  const { watching, toggle: toggleWatch } = useWatching((page ?? { id, watchers: [] }) as any);
  const cover = useCover((page ?? { id, cover_url: null }) as any);
  const exportPage = useExport();
  const printPage = usePrint();
  const [sharing, setSharing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  /** Whether the passage in `anchor` was picked to suggest a change rather than to comment. */
  const [suggesting, setSuggesting] = useState(false);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const canWrite = useCanWrite();
  // Composed here, where a route may reach any capability: see `canvas-dialogs.tsx`.
  const boardAi = useBoardAi();
  const projects = useQuery(() => list('project'), []);
  const pageComments = useQuery(() => list('comment', (entry) => entry.page_id === id), [id]);
  const boards = useQuery(() => list('artboard', (board) => board.page_id === id), [id]);

  /* --------------------------------------------- the tree beside the page */

  /** The whole tree, which is what navigation needs — not this page's branch. */
  const siblings = useQuery(
    () => list('page', (p) => p.workspace_id === workspaceId && !p.archived && !p.is_template) as Page[],
    [workspaceId],
  );
  const folds = usePageFolds();
  const [hunt, setHunt] = useState('');
  /**
   * Whether the aside is showing, kept on this device.
   *
   * Shown by default and remembered when it is turned off, because a reader
   * who wants the full width wants it on every page and not once. Not synced,
   * for the reason the folds are not: it is a fact about this screen, not
   * about the workspace.
   */
  const [aside, setAside] = useState(() => {
    try {
      return localStorage.getItem(TREE_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const showTree = (on: boolean) => {
    setAside(on);
    try {
      localStorage.setItem(TREE_KEY, on ? 'on' : 'off');
    } catch { /* blocked storage — the session still works */ }
  };
  const { keep, matched } = useMemo(() => pagesMatching(siblings, hunt), [siblings, hunt]);

  // The body is a CRDT, so two people typing at once is a merge rather than a
  // race. Everything else on this screen still reads `page.content`, which the
  // server derives from it.
  const { text: content, setText: setContent, fieldRef, flush, rewrite, merged } = useCollaborativeText(
    id, page?.body, page?.content ?? '', editing,
  );

  // Selecting a passage offers a comment on it; the anchored passages are
  // painted back onto the rendered page afterwards.
  const { bubble } = useSelectionAnchor(
    body, page?.content ?? '',
    (picked) => { setSuggesting(false); setAnchor(picked); },
    canWrite ? (picked) => { setSuggesting(true); setAnchor(picked); } : undefined,
  );
  useHighlights(body, page?.content ?? '', pageComments, activeComment, setActiveComment);

  useEffect(() => {
    setTitle(page?.title ?? '');
  }, [id, page?.title]);

  /**
   * Arrive at the section a link named.
   *
   * The browser scrolls to a fragment on a page it loaded; this is a router
   * moving between two screens it already has, and it does not. Waited for
   * rather than done at once, because the body is rendered from text that
   * arrives with the row — the element the fragment names does not exist yet on
   * the render that changes the URL.
   */
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const target = decodeURIComponent(hash.slice(1));
    const frame = requestAnimationFrame(() => {
      document.getElementById(target)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, id, page?.content]);

  if (!page) {
    return (
      <>
        <Header title={t('page.title')} />
        {/* A deleted page still opens from a bookmark or from somebody else's
            link, and this screen used to be a dead end. The trail says where
            you still are; the button is for the middle of the screen, which is
            where the eye goes when there is nothing else on it. */}
        <div className="px-3 pt-4 sm:px-6 sm:pt-5">
          <Trail parts={[{ to: '/pages', label: t('page.listTitle'), icon: <Icon name="page" size={13} /> }]} />
        </div>
        <Empty
          emoji="🕳️" title={t('page.notFound')}
          action={<Button onClick={() => navigate('/pages')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }

  const author = members.get(page.created_by);

  const crumbs: Crumb[] = [
    { to: '/pages', label: t('page.listTitle'), icon: <Icon name="page" size={13} /> },
    ...trail.map((parent) => ({
      to: `/pages/${parent.id}`,
      label: parent.title || t('common.untitled'),
      icon: parent.icon ?? '📄',
    })),
  ];

  /**
   * Commit the title, and take the links to it along.
   *
   * Said out loud when it happens. Rewriting somebody else's page is a real
   * thing to have done, however right it is, and a rename that quietly touched
   * four other documents is the kind of surprise that ends with people not
   * trusting the feature.
   */
  /**
   * Change the language the page is written in, and rewrite it into that
   * language.
   *
   * The conversion is the whole feature. Switching the flag alone would leave a
   * markdown page rendering its own `##` as literal text, or an HTML page
   * showing its tags — technically a format switch, practically a broken page,
   * and the thing everybody would then do by hand is exactly what
   * `renderMarkdown` and `htmlToMarkdown` already do properly.
   *
   * It is asked about first, because it *is* a rewrite: markdown out of HTML
   * cannot keep what markdown has no way to say. The safety net is the one the
   * page already has — the write puts the old text into the page's history, so
   * a conversion somebody regrets is one Restore away.
   */
  const convert = async (to: PageFormat): Promise<void> => {
    if (page.format === to) return;
    const text = page.content ?? '';
    if (text.trim() && !(await confirm(t(to === 'html' ? 'page.convertToHtml' : 'page.convertToMarkdown'), t('page.convertAction')))) return;
    update('page', id, {
      format: to,
      content: !text.trim() ? text : to === 'html' ? formatHtml(renderMarkdown(text)) : htmlToMarkdown(text),
    });
    toast(t('page.converted'));
  };

  const renameTo = (wanted: string) => {
    const next = wanted.trim() || t('common.untitled');
    if (next === page.title) return;
    const moved = rename(page, next);
    if (moved.refused) toast(t('page.renameRefused'));
    else if (moved.pages) toast(t('page.renameLinks', { count: moved.pages }));
  };
  const commitTitle = () => renameTo(title);

  /*
   * A canvas and a board page are the same rows shown two ways, so either can
   * become the other — a board page into a canvas to put things beside it, a
   * canvas back into a board page while it holds one board and nothing else.
   * The server refuses the second when that is no longer true by the time it
   * arrives.
   */
  const htmlBoards = boards.filter((board) => board.kind === 'html');
  const canBeBoardPage = page.format === 'canvas' && htmlBoards.length === 1 && boards.length === 1;

  return (
    <>
      <Header title={<span className="flex items-center gap-1.5"><span>{page.icon ?? '📄'}</span><span className="truncate">{page.title || t('common.untitled')}</span></span>}>
        {/* Rendered only where it applies, not hidden elsewhere: a second, invisible "Edit" on
            every page is the one a script asking for the first "Edit" finds. */}
        {canWrite && page.format === 'board' && htmlBoards.length > 0 && (
          <Button size="sm" onClick={() => setEditingBoard(true)}>{t('action.edit')}</Button>
        )}
        <Button size="sm" hidden={!canWrite || isBoardFormat(page.format)} onClick={() => {
          if (editing) {
            flush();
            commitTitle();
          }
          setEditing(!editing);
        }}>
          {editing ? <><Icon name="check" size={14} /> {t('action.done')}</> : <>{t('action.edit')}</>}
        </Button>
        <MenuButton
          variant="ghost" size="iconSm"
          label={t('common.moreActions')}
          items={[
            { id: 'child', label: t('page.addSubpage'), icon: <Icon name="plus" size={14} />,
              onSelect: () => navigate(`/pages/${createPage({ parent_id: id, project_id: page.project_id, title: t('common.untitled') }, me)}`) },
            { id: 'child-canvas', label: t('canvas.addSubcanvas'), icon: <Icon name="canvas" size={14} />,
              onSelect: () => navigate(`/pages/${createPage({ parent_id: id, project_id: page.project_id, title: t('common.untitled'), format: 'canvas', icon: CANVAS_ICON }, me)}`) },
            { id: 'child-board', label: t('board.addSubboard'), icon: <Icon name="page" size={14} />,
              onSelect: () => navigate(`/pages/${createPage({ parent_id: id, project_id: page.project_id, title: t('common.untitled'), format: 'board', icon: BOARD_ICON }, me)}`) },
            // Beside "add a sub-page", because that is what it does — several
            // at once, out of files somebody already has.
            { id: 'import', label: t('page.importHere'), icon: <Icon name="attach" size={14} />,
              onSelect: () => setImporting(true) },
            // A page's history is its text's, and a canvas or a board page has
            // none: each board keeps its own, in the editor.
            ...(isBoardFormat(page.format) ? [] : [{ id: 'history', label: t('page.history'), icon: <Icon name="refresh" size={14} />,
              onSelect: () => setHistory(true) }]),
            ...(page.format === 'board' && canWrite ? [{ id: 'to-canvas', label: t('board.toCanvas'), icon: <Icon name="canvas" size={14} />,
              onSelect: () => update('page', id, { format: 'canvas' }) }] : []),
            ...(canBeBoardPage && canWrite ? [{ id: 'to-board', label: t('board.fromCanvas'), icon: <Icon name="page" size={14} />,
              onSelect: () => update('page', id, { format: 'board' }) }] : []),
            // In the menu as well as on the aside's own button, and not in the
            // header: on the screens where the aside exists at all there is
            // room for it, and on the ones where there is not, a control for
            // something invisible is worse than no control.
            { id: 'aside', label: aside ? t('page.sidebarHide') : t('page.sidebarShow'),
              icon: <Icon name="hierarchy" size={14} />, hint: aside ? '✓' : undefined,
              onSelect: () => showTree(!aside) },
            { id: 'watch', label: watching ? t('page.unwatch') : t('page.watch'), icon: <Icon name="bell" size={14} />,
              hint: watching ? '✓' : undefined, onSelect: toggleWatch },
            // Three ways out of the same door, so one row rather than three. A
            // canvas or a board page is its boards, not text, so it leaves as a
            // file of its boards or a PDF of them — the print layer is the view's.
            {
              id: 'download',
              label: t('page.download'),
              icon: <Icon name="page" size={14} />,
              items: isBoardFormat(page.format) ? [
                { id: 'export-html', label: t('page.exportHtml'), onSelect: () => { void downloadBoards(page, t('common.untitled')); } },
                { id: 'print', label: t('page.print'), onSelect: () => setPrintRequest((n) => n + 1) },
              ] : [
                { id: 'export-md', label: t('page.export'), onSelect: () => exportPage(page, 'markdown') },
                { id: 'export-html', label: t('page.exportHtml'), onSelect: () => exportPage(page, 'html') },
                { id: 'print', label: t('page.print'), onSelect: () => printPage(page) },
              ],
            },
            // A canvas is not text in another language: its boards are rows of
            // their own, and "convert" would have nothing to convert them into.
            ...(isBoardFormat(page.format) ? [] : [{
              id: 'format',
              label: t('page.format'),
              icon: <Icon name="code" size={14} />,
              // Coalesced, because a page mirrored into this browser before the
              // column existed carries no format at all, and every reader of it
              // has to agree that means markdown.
              hint: t((page.format ?? 'markdown') === 'html' ? 'page.formatHtml' : 'page.formatMarkdown'),
              items: (['markdown', 'html'] as const).map((one) => ({
                id: `format-${one}`,
                label: t(one === 'html' ? 'page.formatHtml' : 'page.formatMarkdown'),
                hint: (page.format ?? 'markdown') === one ? '✓' : undefined,
                onSelect: () => { void convert(one); },
              })),
            }]),
            // On every format: a shared canvas or board page frames its boards
            // (`adapters/share/boards.ts`), and a page made from one as a
            // template is given copies of them (`boards.ts`).
            { id: 'share', label: t('share.action'), icon: <Icon name="link" size={14} />,
              onSelect: () => setSharing(true) },
            /*
             * What a page is *used as*, in one drawer: the reference on its
             * subject, a series of dated entries, a template, something a
             * visitor may be told. Four switches of one kind, and in a drawer
             * rather than four rows because this menu has to fit a laptop and
             * a phone (`check:menus`) and it gained two lists the same day.
             */
            {
              id: 'mark-as',
              label: t('page.markAs'),
              icon: <Icon name="star" size={14} />,
              hint: [isPinned(page) && t('page.pinnedChip'), isSeries(page) && t('page.series'),
                page.is_template && t('page.template')].filter(Boolean).join(', ') || undefined,
              items: [
                { ...pinItem(page, t), keepOpen: true },
                { ...seriesItem(page, t), keepOpen: true },
                { id: 'template', label: page.is_template ? t('page.unmarkTemplate') : t('page.markTemplate'),
                  icon: <Icon name="copy" size={14} />, hint: page.is_template ? '✓' : undefined, keepOpen: true,
                  onSelect: () => update('page', id, { is_template: page.is_template ? 0 : 1 }) },
                { id: 'public-knowledge',
                  label: isPublicKnowledge(page) ? t('page.unmarkPublicKnowledge') : t('page.markPublicKnowledge'),
                  icon: <Icon name="globe" size={14} />, hint: isPublicKnowledge(page) ? '✓' : undefined, keepOpen: true,
                  onSelect: () => update('page', id, { public_knowledge: isPublicKnowledge(page) ? 0 : 1 }) },
              ],
            },
            ...cover.items(t('page.cover')),
            ...moveItems(page, workspaceId, t('page.move')),
            labelItems(page, labels, t('page.labels')),
            statusItems(page, statuses, t('page.status')),
            ...(types.length || page.type_id ? [typeItems(page, types, t('page.type'), t('page.typeNone'))] : []),
            successorItems(page, siblings, statuses, t),
            {
              id: 'access',
              label: t('page.access'),
              icon: <Icon name="lock" size={14} />,
              hint: t(ACCESS_KEY[page.access]),
              items: (['workspace', 'project', 'private'] as const).map((access) => ({
                id: `access-${access}`,
                label: t(ACCESS_KEY[access]),
                hint: page.access === access ? '✓' : undefined,
                onSelect: () => {
                  // `project` access on a page that belongs to no project would
                  // hide it from everybody, including its author.
                  if (access === 'project' && !page.project_id) {
                    toast(t('page.accessNeedsProject'));
                    return;
                  }
                  update('page', id, { access });
                },
              })),
            },
            {
              id: 'project',
              label: t('page.moveToProject'),
              icon: <Icon name="folder" size={14} />,
              hint: page.project_id ? byId('project', page.project_id)?.name : t('page.workspaceLevel'),
              search: projects.length > 8,
              items: [
                ...projects.map((project) => ({
                  id: `move-${project.id}`,
                  label: `${project.icon ?? ''} ${project.name}`.trim(),
                  hint: page.project_id === project.id ? '✓' : undefined,
                  onSelect: () => update('page', id, { project_id: project.id }),
                })),
                { id: 'move-none', label: t('page.workspaceLevel'), hint: page.project_id ? undefined : '✓',
                  onSelect: () => update('page', id, { project_id: null }) },
              ],
            },
            { id: 'copy', label: t('action.copyLink'), icon: <Icon name="link" size={14} />, onSelect: () => {
              void navigator.clipboard?.writeText(`${location.origin}/pages/${id}`);
              toast(t('common.copied'));
            } },
            { id: 'archive', section: t('module.danger'), label: page.archived ? t('action.unarchive') : t('action.archive'),
              onSelect: () => update('page', id, { archived: page.archived ? 0 : 1 }) },
            { id: 'delete', section: t('module.danger'), label: t('page.delete'), danger: true, onSelect: async () => {
              if (await confirm(t('page.deleteConfirm', { title: page.title }))) {
                remove('page', id);
                navigate('/pages');
              }
            } },
          ]}
        >
          <Icon name="dots" size={15} />
        </MenuButton>
      </Header>

      {/* A canvas or a board page draws its own surface below, so the one
          notice that applies to it — replaced, and by what — goes above. */}
      {isBoardFormat(page.format) && isSuperseded(page, statuses) && (
        <div className="px-3 pt-3 sm:px-6"><SupersededNotice page={page} /></div>
      )}
      {page.format === 'canvas' ? (
        <CanvasView page={page} canWrite={canWrite} ai={boardAi} printRequest={printRequest} thread={(props) => <Comments {...props} />} />
      ) : page.format === 'board' ? (
        // Keyed by the page: this screen is not remounted between pages, and a pin
        // half-placed on one board page belongs to nobody on the next.
        <BoardPageView
          key={page.id}
          page={page} canWrite={canWrite} ai={boardAi} editing={editingBoard} onEditing={setEditingBoard}
          onRename={renameTo} printRequest={printRequest} thread={(props) => <Comments {...props} />}
        />
      ) : (
      <div className={cn(pageBody, 'page-with-tree')}>
        {/*
          * The tree, beside the page rather than one screen back.
          *
          * `PageOutline` above decided the other way about the *outline*, and
          * the reasoning still holds: a sticky aside that takes width from the
          * reading column is a bad trade, because a narrower line of prose is
          * worse than one extra click. This is not that trade — the column keeps
          * its 820px measure exactly and the aside lives in the gutter a wide
          * screen already wastes. Which width that starts at is the whole of
          * the promise and is argued in `app.css`, where it was first written
          * too low and measured afterwards. Also why this is navigation rather
          * than a second table of contents: moving between pages is the thing a
          * wiki makes you do twenty times an hour.
          */}
        {aside ? (
          <aside className="page-aside" aria-label={t('page.listTitle')}>
            <div className="flex items-center gap-1 mb-1.5">
              <Input
                className="flex-1 min-w-0"
                placeholder={t('page.filterTree')}
                aria-label={t('page.filterTree')}
                value={hunt}
                onChange={(event) => setHunt(event.target.value)}
              />
              <Button variant="ghost" size="iconSm" className="shrink-0" onClick={() => showTree(false)} title={t('page.sidebarHide')} aria-label={t('page.sidebarHide')}>
                <Icon name="sidebar" size={15} />
              </Button>
            </div>
            {keep?.size === 0
              ? <p className="text-muted text-label">{t('page.filterNone')}</p>
              : <PageTree pages={siblings} activeId={id} canWrite={canWrite} folds={folds} keep={keep} matched={matched} />}
          </aside>
        ) : (
          /* Where the tree was, so it comes back from the place it went. Only
             at the widths the aside can exist at — see `.page-aside-open`. */
          <Button variant="ghost" size="iconSm" className="page-aside-open" onClick={() => showTree(true)} title={t('page.sidebarShow')} aria-label={t('page.sidebarShow')}>
            <Icon name="sidebar" size={15} />
          </Button>
        )}
        <div className="page-reading">
        {/* Said on the page, not only in the menu: an archived page still opens
            from a bookmark, from a link in another page and from a search on the
            server, and it used to look exactly like a live one. */}
        {!!page.archived && (
          <div className="page-archived">
            <Icon name="archive" size={15} />
            <span className="flex-1 min-w-0">{t('page.archivedNotice')}</span>
            {canWrite && (
              <Button size="sm" onClick={() => update('page', id, { archived: 0 })}>{t('action.unarchive')}</Button>
            )}
          </div>
        )}
        {/* The same place, for the same question: is this the page I should be
            reading, and is it still what was signed off. */}
        <SupersededNotice page={page} />
        <DriftNotice page={page} onCompare={setDiffing} />
        {/* The wiki itself is the first crumb, then the pages this one is
            nested under. Without the first one a top-level page had no trail at
            all, and no route back to the wiki except the sidebar. */}
        <Trail parts={crumbs} />
        <PageCover page={page} />
        {cover.input}
        {editing ? (
          <>
            <div className="flex items-center gap-2 mb-2.5">
              <EmojiPicker
                value={page.icon} fallback="📄"
                onChange={(next) => update('page', id, { icon: next })}
              />
              <Input
                className="flex-1 min-w-0 font-semibold text-headline" value={title}
                aria-label={t('page.titleLabel')}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={commitTitle}
              />
            </div>
            <PublicKnowledgeNotice page={page} />
            {page.format === 'html'
              ? <HtmlEditor value={content} onChange={setContent} minHeight={420} attachTo={{ kind: 'page', id }} />
              : <MarkdownEditor value={content} onChange={setContent} minHeight={420} attachTo={{ kind: 'page', id }} fieldRef={fieldRef} label={t('page.contentLabel')} />}
            {/* Quiet, and only while it is true: somebody wanting to know why a
                sentence appeared under their cursor should be able to find out,
                and nobody else should have to look at it. */}
            {merged && <span className="text-label text-muted mt-1.5" style={{ display: 'block' }}>{t('page.mergedIn')}</span>}
          </>
        ) : (
          <>
            <h1 className="text-display" style={{ marginBottom: 6 }}>{page.title || t('common.untitled')}</h1>
            <div className="flex items-center gap-2 text-muted text-label mb-[18px]">
              <span>{author ? t('page.byAuthor', { name: author.name }) : ''}</span>
              <span>· {t('page.updatedAgo', { time: relativeTime(page.updated_at) })}</span>
              {page.project_id && <span>· {byId('project', page.project_id)?.name}</span>}
              {page.access !== 'workspace' && <span>· {t(ACCESS_KEY[page.access])}</span>}
              {watching && <span>· {t('page.watching')}</span>}
              {!!page.is_template && <span>· {t('page.template')}</span>}
            </div>
            {/* Beside the labels rather than in the line of grey text above:
                the status is a thing somebody sets, and the chips are where the
                things somebody sets already live. */}
            <div className="flex items-center flex-wrap gap-1.5 mb-3.5">
              <PageStatusChip page={page} />
              <PageTypeChip page={page} />
              {isPinned(page) && <Chip title={t('page.pin')}><Icon name="star" size={11} /> {t('page.pinnedChip')}</Chip>}
              <PublicKnowledgeChip page={page} />
              <PageLabelChips page={page} />
            </div>
            <PageOutline source={page.content ?? ''} format={page.format} />
            {page.content?.trim()
              ? (
                <div className="annotatable" ref={setBody}>
                  {page.format === 'html'
                    ? <HtmlView source={page.content} asPage />
                    : (
                      /*
                       * Ticked where it is read, like a checklist in a task.
                       *
                       * It was inert here for as long as the body has been a
                       * CRDT, and the reason was sound while the only way to
                       * write this field was to replace it: a tick sent as a
                       * whole document tombstones every character of it, so two
                       * people with the page open would have lost each other's
                       * paragraph to a box. `rewrite` is the missing half —
                       * the tick goes through `crdt.edit`, which is what a
                       * keystroke does. An HTML page stays inert: there the
                       * allowlist draws a picture of a state, not a control.
                       */
                      <Markdown
                        source={page.content}
                        asPage
                        onChange={canWrite ? rewrite : undefined}
                      />
                    )}
                  {bubble}
                </div>
              )
              : <Button onClick={() => setEditing(true)}>{t('page.startWriting')}</Button>}
          </>
        )}

        {/* A series draws its entries newest first and offers the next one;
            every other page lists its sub-pages in the tree's order. */}
        {isSeries(page) && <SeriesEntries page={page} entries={children as Page[]} />}
        {!isSeries(page) && children.length > 0 && (
          <section className="mt-7">
            <SectionHeading tight>{t('page.subpages')}</SectionHeading>
            {children.map((child) => (
              <button key={child.id} className="task-row text-left" style={{ width: '100%' }} onClick={() => navigate(`/pages/${child.id}`)}>
                <span>{child.icon ?? '📄'}</span>
                <span className="flex-1 min-w-0 truncate">{child.title}</span>
              </button>
            ))}
          </section>
        )}

        {/* The other direction. Sub-pages are what this page contains; these are
            what it is part of, and a wiki without them is a set of documents
            that can only be read downwards. Quoted with the sentence the link
            was written in, because "who links here" without "why" is a list
            somebody has to open five pages to understand. */}
        {backlinks.length > 0 && (
          <section className="mt-7">
            <SectionHeading tight>{t('page.backlinks', { count: backlinks.length })}</SectionHeading>
            {backlinks.map(({ page: from, context }) => (
              <Link key={from.id} to={`/pages/${from.id}`} className="page-backlink">
                <span className="flex items-center gap-2">
                  <span aria-hidden="true">{from.icon ?? '📄'}</span>
                  <strong className="flex-1 min-w-0 truncate">{from.title || t('common.untitled')}</strong>
                </span>
                {context && <span className="text-label text-muted">{context}</span>}
              </Link>
            ))}
          </section>
        )}

        {/* What is attached, above the discussion and below the page.
            `page_id` has been a column on `attachments` since the table was
            written and the only way to fill it was to paste an image into the
            body — so a page could carry a picture and could not carry the
            spreadsheet the picture was of. */}
        {!editing && <Attachments on={{ kind: 'page', id }} className="mt-7" />}

        {/* Last, and only while reading: the page is the point, the thread is
            what people said about it — and mid-edit it is simply in the way. */}
        {!editing && (
          <section style={{ marginTop: 32, borderTop: '1px solid var(--line)', paddingTop: 18 }}>
            <div className="flex items-center gap-2 mb-3">
              <SectionHeading tight>{t('page.discussion')}</SectionHeading>
              <span className="text-muted text-label">· {t('annotate.hint')}</span>
            </div>
            <Comments
              target={{ page_id: id }}
              empty={t('page.noComments')}
              source={page.content ?? ''}
              anchor={anchor}
              suggesting={suggesting}
              onAnchorDone={() => { setAnchor(null); setSuggesting(false); }}
              active={activeComment}
              onPick={(commentId) => {
                setActiveComment(commentId);
                body?.querySelector(`mark.anchor[data-comment="${commentId}"]`)
                  ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }}
            />
          </section>
        )}
        </div>
      </div>
      )}

      {sharing && (
        <ShareSheet
          target={{ kind: 'page', page_id: id, project_id: page.project_id ?? null, name: page.title }}
          onClose={() => setSharing(false)}
        />
      )}

      {importing && <ImportPages parentId={id} projectId={page.project_id ?? null} onClose={() => setImporting(false)} />}

      {history && (
        <PageHistory
          page={page}
          onClose={() => setHistory(false)}
          onCompare={(versionId) => setDiffing(versionId)}
        />
      )}
      {diffing && <VersionDiff page={page} versionId={diffing} onClose={() => setDiffing(null)} />}
      {dialog}
    </>
  );
}
