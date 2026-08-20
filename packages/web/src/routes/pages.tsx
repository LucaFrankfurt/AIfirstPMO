import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { compareOrder, excerpt, type Anchor, type Page } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { Comments } from '../components/comments';
import {
  ACCESS_KEY, PageLabelChips, VersionDiff, labelItems, useExport, usePageLabels, usePrint, useWatching,
} from '../components/page-parts';
import { Markdown, MarkdownEditor } from '../components/Markdown';
import { Empty, Icon, MenuButton, Sheet, useConfirm, useToast } from '../components/ui';
import { ShareSheet } from '../components/share';
import { useHighlights, useSelectionAnchor } from '../components/annotate';
import { api } from '../lib/api';
import { relativeTime, shortDate } from '../lib/format';

import { createPage, remove, update } from '../lib/mutations';
import { byId, list, useQuery, useRow } from '../lib/store';
import { pull } from '../lib/sync';
import { useCollaborativeText } from '../lib/collab';
import { useCanWrite, useMe, useMemberMap, useSession } from '../session';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/field';
import { SectionHeading } from '../components/ui/section';
import { navItem } from '../components/ui/nav';
import { chipDot } from '../components/ui/chip';
import { useT } from '../lib/i18n';

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

function TreeItem({ node, depth, activeId }: { node: TreeNode; depth: number; activeId?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  return (
    <>
      <div className="flex items-center gap-2" style={{ gap: 0, paddingInlineStart: depth * 12 }}>
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
      {open && node.children.map((child) => <TreeItem key={child.page.id} node={child} depth={depth + 1} activeId={activeId} />)}
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
        {inUse.length > 0 && (
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
        {templates.length > 0 && (
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
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => navigate(`/pages/${createPage({ title: t('common.untitled') }, me)}`)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('page.new')}</span>
          </Button>
        )}
      </Header>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        {!pages.length ? (
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
            <h2 className="mb-2 text-sm font-semibold">{t('page.all')}</h2>
            {tree.map((node) => <TreeItem key={node.page.id} node={node} depth={0} />)}
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
  const [history, setHistory] = useState<any[] | null>(null);
  const [diffing, setDiffing] = useState<string | null>(null);

  const children = useQuery(() => list('page', (p) => p.parent_id === id && !p.archived), [id]);
  const labels = usePageLabels((page ?? { project_id: null }) as any);
  const { watching, toggle: toggleWatch } = useWatching((page ?? { id, watchers: [] }) as any);
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
      <Header title={<span className="flex items-center gap-2 gap-1.5"><span>{page.icon ?? '📄'}</span><span className="truncate">{page.title || t('common.untitled')}</span></span>}>
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
              onSelect: () => api.pageVersions(id).then(setHistory).catch(() => toast(t('page.historyFailed'))) },
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
            <div className="flex items-center gap-2 flex-wrap gap-1.5 mb-3.5"><PageLabelChips page={page} /></div>
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
        <Sheet title={t('page.history')} onClose={() => setHistory(null)}>
          {history.length === 0 && <p className="text-muted">{t('page.noVersions')}</p>}
          {history.map((version) => (
            <div className="flex items-center gap-2" key={version.id} style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
              <div className="flex-1 min-w-0">
                <strong className="text-[13.5px]">{version.title}</strong>
                <div className="text-muted text-[12.5px]">
                  {shortDate(version.created_at)} · {members.get(version.author_id)?.name ?? t('common.someone')} · {t('page.versionSize', { count: version.size })}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setDiffing(version.id)}>{t('page.compare')}</Button>
              <Button size="sm"
                onClick={async () => {
                  if (!(await confirm(t('page.restoreConfirm'), t('action.restore')))) return;
                  await api.restoreVersion(id, version.id);
                  await pull();
                  setHistory(null);
                  toast(t('page.restored'));
                }}
              >
                {t('action.restore')}
              </Button>
            </div>
          ))}
        </Sheet>
      )}
      {diffing && <VersionDiff page={page} versionId={diffing} onClose={() => setDiffing(null)} />}
      {dialog}
    </>
  );
}
