import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { compareOrder, excerpt, type Anchor, type Page } from '@kolibri/shared';
import { Header } from '../../../kernel/design-system/AppShell';
import { Comments } from '../../work/comments';
import {
  ACCESS_KEY, PageCover, PageHistory, PageLabelChips, VersionDiff, labelItems, moveItems, movePage,
  useCover, useExport, usePageLabels, usePrint, useWatching,
} from '../page-parts';
import type { DropZone } from '../pagetree';
import { Markdown, MarkdownEditor } from '../Markdown';
import { Empty, Icon, MenuButton, useConfirm, useToast } from '../../../kernel/design-system/ui';
import { PAGE_DRAG, idFrom, isDrag, startDrag } from '../../../kernel/design-system/drag';
import { ShareSheet } from '../../../adapters/share/share';
import { useHighlights, useSelectionAnchor } from '../annotate';
import { relativeTime } from '../../../kernel/design-system/format';

import { createPage, remove, update } from '../../../kernel/sync/mutations';
import { byId, list, useQuery, useRow } from '../../../kernel/sync/store';
import { useCollaborativeText } from '../collab';
import { useCanWrite, useMe, useMemberMap, useSession } from '../../../kernel/identity/session';
import { Button } from '../../../kernel/design-system/ui/button';
import { Input } from '../../../kernel/design-system/ui/field';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { navItem } from '../../../kernel/design-system/ui/nav';
import { chipDot } from '../../../kernel/design-system/ui/chip';
import { useT } from '../../../kernel/i18n/i18n';

/* ------------------------------------------------------------------- tree */

interface TreeNode {
  page: Page;
  children: TreeNode[];
}

function buildTree(pages: Page[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(pages.map((page) => [page.id, { page, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.page.parent_id ? nodes.get(node.page.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => compareOrder(a.page.sort_order ?? '', b.page.sort_order ?? ''));
    list.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}

/**
 * Which third of a row the pointer is in, and therefore what a drop means.
 *
 * The middle half is `inside` rather than a third: dropping *onto* a page to
 * nest under it is the move people reach for, and the two edges only need to be
 * wide enough to hit deliberately.
 */
function zoneAt(event: React.DragEvent, element: HTMLElement): DropZone {
  const box = element.getBoundingClientRect();
  const offset = (event.clientY - box.top) / (box.height || 1);
  if (offset < 0.25) return 'before';
  if (offset > 0.75) return 'after';
  return 'inside';
}

function TreeItem({ node, depth, activeId, canWrite }: {
  node: TreeNode; depth: number; activeId?: string; canWrite: boolean;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { workspaceId } = useSession();
  const [open, setOpen] = useState(true);
  const [over, setOver] = useState<DropZone | null>(null);

  return (
    <>
      <div
        className={`page-row${over ? ` page-drop-${over}` : ''}`}
        style={{ paddingInlineStart: depth * 12 }}
        draggable={canWrite}
        onDragStart={(event) => {
          event.stopPropagation();
          startDrag(event, PAGE_DRAG, node.page.id);
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
          if (movePage(idFrom(event, PAGE_DRAG), node.page.id, zone, workspaceId) && zone === 'inside') setOpen(true);
        }}
      >
        {node.children.length > 0 ? (
          <Button variant="ghost" size="iconSm" onClick={() => setOpen(!open)} aria-label={t('page.toggleTree')}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          </Button>
        ) : (
          <span style={{ width: 27 }} />
        )}
        <button
          className={navItem({ active: activeId === node.page.id })}
          onClick={() => navigate(`/pages/${node.page.id}`)}
        >
          <span style={{ width: 16 }}>{node.page.icon ?? '📄'}</span>
          <span className="flex-1 min-w-0 truncate">{node.page.title || t('common.untitled')}</span>
        </button>
      </div>
      {open && node.children.map((child) => (
        <TreeItem key={child.page.id} node={child} depth={depth + 1} activeId={activeId} canWrite={canWrite} />
      ))}
    </>
  );
}

export function PagesIndex() {
  const t = useT();
  const { workspaceId } = useSession();
  const me = useMe();
  const navigate = useNavigate();
  const all = useQuery(() => list('page', (p) => p.workspace_id === workspaceId && !p.archived), [workspaceId]);
  const labels = useQuery(() => list('label', (label) => !label.project_id), [workspaceId]);
  const [filter, setFilter] = useState<string>('');
  const canWrite = useCanWrite();

  // Archived pages had nowhere to be seen at all. Every list in the app filters
  // them out, so archiving one removed it from the tree, from the palette and
  // from search at once, and the only control that could bring it back lived on
  // the page you could no longer reach. That is deletion wearing another word.
  const archived = useQuery(
    () => list('page', (p) => p.workspace_id === workspaceId && !!p.archived).sort((a, b) => b.updated_at - a.updated_at),
    [workspaceId],
  );
  const [showArchived, setShowArchived] = useState(false);
  // Unarchiving the last one takes the list away with it, so the screen goes
  // back to the pages rather than to an empty box that was full a moment ago.
  const viewingArchive = showArchived && archived.length > 0;

  // Templates are kept out of the tree: they are starting points, not content,
  // and a handbook with three half-written templates in it reads as a mess.
  const templates = useMemo(() => all.filter((page) => page.is_template), [all]);
  const pages = useMemo(
    () => all.filter((page) => !page.is_template && (!filter || (page.labels ?? []).includes(filter))),
    [all, filter],
  );
  const tree = useMemo(() => buildTree(pages), [pages]);
  const recent = useMemo(() => [...pages].sort((a, b) => b.updated_at - a.updated_at).slice(0, 6), [pages]);
  const inUse = useMemo(() => {
    const used = new Set(all.flatMap((page) => page.labels ?? []));
    return labels.filter((label) => used.has(label.id));
  }, [all, labels]);

  return (
    <>
      <Header title={t('page.listTitle')}>
        {archived.length > 0 && (
          <Button
            variant={viewingArchive ? 'primary' : 'secondary'} size="sm"
            aria-pressed={viewingArchive}
            onClick={() => setShowArchived(!viewingArchive)}
          >
            <Icon name="archive" size={14} />
            <span className="hide-sm">{t('page.archivedCount', { count: archived.length })}</span>
          </Button>
        )}
        {!viewingArchive && inUse.length > 0 && (
          <MenuButton
            variant="secondary" size="sm"
            items={[
              { id: 'all', label: t('page.allPages'), hint: filter ? undefined : '✓', onSelect: () => setFilter('') },
              ...inUse.map((label) => ({
                id: label.id,
                section: t('page.filterByLabel'),
                label: label.name,
                icon: <span className={chipDot} style={{ background: label.color }} />,
                hint: filter === label.id ? '✓' : undefined,
                onSelect: () => setFilter(label.id),
              })),
            ]}
          >
            <Icon name="filter" size={14} />
            <span className="hide-sm">{filter ? byId('label', filter)?.name ?? t('page.filterByLabel') : t('page.filterByLabel')}</span>
          </MenuButton>
        )}
        {!viewingArchive && templates.length > 0 && (
          <MenuButton
            variant="secondary" size="sm"
            items={templates.map((template) => ({
              id: template.id,
              label: `${template.icon ?? '📄'} ${template.title}`,
              // A copy, not a link: a template is a starting point, and editing
              // the new page must not edit the template.
              onSelect: () => navigate(`/pages/${createPage({
                title: template.title, content: template.content, project_id: template.project_id,
              }, me)}`),
            }))}
          >
            <Icon name="copy" size={14} />
            <span className="hide-sm">{t('page.newFromTemplate')}</span>
          </MenuButton>
        )}
        {!viewingArchive && canWrite && (
          <Button variant="primary" size="sm" onClick={() => navigate(`/pages/${createPage({ title: t('common.untitled') }, me)}`)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('page.new')}</span>
          </Button>
        )}
      </Header>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        {viewingArchive ? (
          <>
            {/* Flat, not a tree. An archived page's parent is usually still in
                use, so drawing these as a tree would either duplicate live
                pages as scaffolding or leave every row hanging off nothing. */}
            <h2 className="mb-1 text-sm font-semibold">{t('page.archivedTitle')}</h2>
            <p className="mb-3.5 text-[12.5px] text-muted">{t('page.archivedHint')}</p>
            {archived.map((page) => (
              <div className="page-row" key={page.id}>
                <Link to={`/pages/${page.id}`} className={navItem()}>
                  <span style={{ width: 16 }}>{page.icon ?? '\ud83d\udcc4'}</span>
                  <span className="flex-1 min-w-0 truncate">{page.title || t('common.untitled')}</span>
                  <span className="text-[11.5px] text-muted hide-sm">
                    {t('page.updated', { time: relativeTime(page.updated_at) })}
                  </span>
                </Link>
                {canWrite && (
                  <Button size="sm" variant="ghost" onClick={() => update('page', page.id, { archived: 0 })}>
                    {t('action.unarchive')}
                  </Button>
                )}
              </div>
            ))}
          </>
        ) : !pages.length ? (
          <Empty
            emoji="📓" title={t('page.emptyTitle')}
            hint={t('page.emptyHint')} guide="pages"
            action={<Button variant="primary" onClick={() => navigate(`/pages/${createPage({ title: t('common.untitled') }, me)}`)}>{t('page.writeFirst')}</Button>}
          />
        ) : (
          <>
            <h2 className="mb-2 text-sm font-semibold">{t('page.recentlyEdited')}</h2>
            {/* Links, not buttons that navigate: a page is a thing people open
                in a second tab, and a button cannot be. */}
            <div className="mb-6 grid gap-3 sm:grid-cols-2">
              {recent.map((page) => (
                <Link
                  key={page.id}
                  to={`/pages/${page.id}`}
                  className="flex flex-col gap-1 rounded-[var(--radius)] border border-line bg-raised p-3.5 text-left transition-colors hover:border-line-strong hover:bg-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true">{page.icon ?? '📄'}</span>
                    <strong className="flex-1 min-w-0 truncate">{page.title || t('common.untitled')}</strong>
                  </span>
                  <p className="m-0 text-[12.5px] text-muted">{excerpt(page.content, 110) || t('page.emptyPage')}</p>
                  <span className="text-[11.5px] text-muted">{t('page.updated', { time: relativeTime(page.updated_at) })}</span>
                </Link>
              ))}
            </div>
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-sm font-semibold">{t('page.all')}</h2>
              {canWrite && <span className="text-[12px] text-muted">{t('page.dragHint')}</span>}
            </div>
            {tree.map((node) => <TreeItem key={node.page.id} node={node} depth={0} canWrite={canWrite} />)}
          </>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- page */

export function PageDetail() {
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const page = useRow('page', id);
  const me = useMe();
  const members = useMemberMap();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(page?.title ?? '');
  const [history, setHistory] = useState(false);
  const [diffing, setDiffing] = useState<string | null>(null);

  const { workspaceId } = useSession();
  const children = useQuery(() => list('page', (p) => p.parent_id === id && !p.archived), [id]);
  const labels = usePageLabels((page ?? { project_id: null }) as any);
  const { watching, toggle: toggleWatch } = useWatching((page ?? { id, watchers: [] }) as any);
  const cover = useCover((page ?? { id, cover_url: null }) as any);
  const exportPage = useExport();
  const printPage = usePrint();
  const [sharing, setSharing] = useState(false);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const canWrite = useCanWrite();
  const projects = useQuery(() => list('project'), []);
  const pageComments = useQuery(() => list('comment', (entry) => entry.page_id === id), [id]);

  // The body is a CRDT, so two people typing at once is a merge rather than a
  // race. Everything else on this screen still reads `page.content`, which the
  // server derives from it.
  const { text: content, setText: setContent, fieldRef, flush, merged } = useCollaborativeText(
    id, page?.body, page?.content ?? '', editing,
  );

  // Selecting a passage offers a comment on it; the anchored passages are
  // painted back onto the rendered page afterwards.
  const { bubble } = useSelectionAnchor(body, page?.content ?? '', setAnchor);
  useHighlights(body, page?.content ?? '', pageComments, activeComment, setActiveComment);

  useEffect(() => {
    setTitle(page?.title ?? '');
  }, [id, page?.title]);

  if (!page) {
    return (
      <>
        <Header title={t('page.title')} />
        <Empty emoji="🕳️" title={t('page.notFound')} />
      </>
    );
  }

  const author = members.get(page.created_by);

  return (
    <>
      <Header title={<span className="flex items-center gap-1.5"><span>{page.icon ?? '📄'}</span><span className="truncate">{page.title || t('common.untitled')}</span></span>}>
        <Button size="sm" hidden={!canWrite} onClick={() => {
          if (editing) {
            flush();
            if (title !== page.title) update('page', id, { title });
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
            { id: 'history', label: t('page.history'), icon: <Icon name="refresh" size={14} />,
              onSelect: () => setHistory(true) },
            { id: 'watch', label: watching ? t('page.unwatch') : t('page.watch'), icon: <Icon name="bell" size={14} />,
              hint: watching ? '✓' : undefined, onSelect: toggleWatch },
            { id: 'export', label: t('page.export'), icon: <Icon name="page" size={14} />,
              onSelect: () => exportPage(page) },
            { id: 'print', label: t('page.print'), icon: <Icon name="page" size={14} />,
              onSelect: () => printPage(page) },
            { id: 'share', label: t('share.action'), icon: <Icon name="link" size={14} />,
              onSelect: () => setSharing(true) },
            { id: 'template', label: page.is_template ? t('page.unmarkTemplate') : t('page.markTemplate'),
              icon: <Icon name="copy" size={14} />, hint: page.is_template ? '✓' : undefined,
              onSelect: () => update('page', id, { is_template: page.is_template ? 0 : 1 }) },
            ...cover.items(t('page.cover')),
            ...moveItems(page, workspaceId, t('page.move')),
            ...labelItems(page, labels, t('page.labels')),
            ...(['workspace', 'project', 'private'] as const).map((access) => ({
              id: `access-${access}`,
              section: t('page.access'),
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
            { id: 'copy', label: t('action.copyLink'), icon: <Icon name="link" size={14} />, onSelect: () => {
              void navigator.clipboard?.writeText(`${location.origin}/pages/${id}`);
              toast(t('common.copied'));
            } },
            ...projects.map((project) => ({
              id: `move-${project.id}`,
              section: t('page.moveToProject'),
              label: `${project.icon ?? ''} ${project.name}`.trim(),
              onSelect: () => update('page', id, { project_id: project.id }),
            })),
            { id: 'move-none', section: t('page.moveToProject'), label: t('page.workspaceLevel'), onSelect: () => update('page', id, { project_id: null }) },
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

      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5" style={{ maxWidth: 820 }}>
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
        <PageCover page={page} />
        {cover.input}
        {editing ? (
          <>
            <div className="flex items-center gap-2 mb-2.5">
              <Input style={{ width: 60, textAlign: 'center', fontSize: 18 }} value={page.icon ?? '📄'}
                maxLength={4} onChange={(event) => update('page', id, { icon: event.target.value })}
              />
              <Input
                className="flex-1 min-w-0 font-semibold" style={{ fontSize: 19 }} value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => update('page', id, { title: title.trim() || t('common.untitled') })}
              />
            </div>
            <MarkdownEditor value={content} onChange={setContent} minHeight={420} attachTo={{ page_id: id }} fieldRef={fieldRef} />
            {/* Quiet, and only while it is true: somebody wanting to know why a
                sentence appeared under their cursor should be able to find out,
                and nobody else should have to look at it. */}
            {merged && <span className="text-[12px] text-muted mt-1.5" style={{ display: 'block' }}>{t('page.mergedIn')}</span>}
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 26, marginBottom: 6 }}>{page.title || t('common.untitled')}</h1>
            <div className="flex items-center gap-2 text-muted text-[12.5px] mb-[18px]">
              <span>{author ? t('page.byAuthor', { name: author.name }) : ''}</span>
              <span>· {t('page.updatedAgo', { time: relativeTime(page.updated_at) })}</span>
              {page.project_id && <span>· {byId('project', page.project_id)?.name}</span>}
              {page.access !== 'workspace' && <span>· {t(ACCESS_KEY[page.access])}</span>}
              {watching && <span>· {t('page.watching')}</span>}
              {!!page.is_template && <span>· {t('page.template')}</span>}
            </div>
            <div className="flex items-center flex-wrap gap-1.5 mb-3.5"><PageLabelChips page={page} /></div>
            {page.content?.trim()
              ? (
                <div className="annotatable" ref={setBody}>
                  <Markdown source={page.content} />
                  {bubble}
                </div>
              )
              : <Button onClick={() => setEditing(true)}>{t('page.startWriting')}</Button>}
          </>
        )}

        {children.length > 0 && (
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

        {/* Last, and only while reading: the page is the point, the thread is
            what people said about it — and mid-edit it is simply in the way. */}
        {!editing && (
          <section style={{ marginTop: 32, borderTop: '1px solid var(--line)', paddingTop: 18 }}>
            <div className="flex items-center gap-2 mb-3">
              <SectionHeading tight>{t('page.discussion')}</SectionHeading>
              <span className="text-muted text-[12.5px]">· {t('annotate.hint')}</span>
            </div>
            <Comments
              target={{ page_id: id }}
              empty={t('page.noComments')}
              source={page.content ?? ''}
              anchor={anchor}
              onAnchorDone={() => setAnchor(null)}
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

      {sharing && (
        <ShareSheet
          target={{ kind: 'page', page_id: id, project_id: page.project_id ?? null, name: page.title }}
          onClose={() => setSharing(false)}
        />
      )}

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
