import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { compareOrder, excerpt, type Page } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { Comments } from '../components/comments';
import {
  ACCESS_KEY, PageLabelChips, VersionDiff, labelItems, useExport, usePageLabels, usePrint, useWatching,
} from '../components/page-parts';
import { Markdown, MarkdownEditor } from '../components/Markdown';
import { Empty, Icon, MenuButton, Sheet, useConfirm, useToast } from '../components/ui';
import { ShareSheet } from '../components/share';
import { api } from '../lib/api';
import { relativeTime, shortDate } from '../lib/format';

import { createPage, remove, update } from '../lib/mutations';
import { byId, list, useQuery, useRow } from '../lib/store';
import { pull } from '../lib/sync';
import { useCanWrite, useMe, useMemberMap, useSession } from '../session';
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
      <div className="row" style={{ gap: 0, paddingInlineStart: depth * 12 }}>
        {node.children.length > 0 ? (
          <button className="btn ghost sm icon" onClick={() => setOpen(!open)} aria-label={t('page.toggleTree')}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          </button>
        ) : (
          <span style={{ width: 27 }} />
        )}
        <button
          className={`nav-item${activeId === node.page.id ? ' active' : ''}`}
          onClick={() => navigate(`/pages/${node.page.id}`)}
        >
          <span style={{ width: 16 }}>{node.page.icon ?? '📄'}</span>
          <span className="grow truncate">{node.page.title || t('common.untitled')}</span>
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
            className="btn sm"
            items={[
              { id: 'all', label: t('page.allPages'), hint: filter ? undefined : '✓', onSelect: () => setFilter('') },
              ...inUse.map((label) => ({
                id: label.id,
                section: t('page.filterByLabel'),
                label: label.name,
                icon: <span className="dot" style={{ background: label.color }} />,
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
            className="btn sm"
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
          <button className="btn primary sm" onClick={() => navigate(`/pages/${createPage({ title: t('common.untitled') }, me)}`)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('page.new')}</span>
          </button>
        )}
      </Header>
      <div className="page">
        {!pages.length ? (
          <Empty
            emoji="📓" title={t('page.emptyTitle')}
            hint={t('page.emptyHint')} guide="pages"
            action={<button className="btn primary" onClick={() => navigate(`/pages/${createPage({ title: t('common.untitled') }, me)}`)}>{t('page.writeFirst')}</button>}
          />
        ) : (
          <>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>{t('page.recentlyEdited')}</h2>
            <div className="grid two" style={{ marginBottom: 22 }}>
              {recent.map((page) => (
                <button className="card" key={page.id} style={{ textAlign: 'left' }} onClick={() => navigate(`/pages/${page.id}`)}>
                  <div className="row" style={{ marginBottom: 4 }}>
                    <span>{page.icon ?? '📄'}</span>
                    <strong className="grow truncate">{page.title || t('common.untitled')}</strong>
                  </div>
                  <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{excerpt(page.content, 110) || t('page.emptyPage')}</p>
                  <span className="muted" style={{ fontSize: 11.5 }}>{t('page.updated', { time: relativeTime(page.updated_at) })}</span>
                </button>
              ))}
            </div>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>{t('page.all')}</h2>
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
  const [content, setContent] = useState(page?.content ?? '');
  const [title, setTitle] = useState(page?.title ?? '');
  const [history, setHistory] = useState<any[] | null>(null);
  const [diffing, setDiffing] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const children = useQuery(() => list('page', (p) => p.parent_id === id && !p.archived), [id]);
  const labels = usePageLabels((page ?? { project_id: null }) as any);
  const { watching, toggle: toggleWatch } = useWatching((page ?? { id, watchers: [] }) as any);
  const exportPage = useExport();
  const printPage = usePrint();
  const [sharing, setSharing] = useState(false);
  const canWrite = useCanWrite();
  const projects = useQuery(() => list('project'), []);

  useEffect(() => {
    setContent(page?.content ?? '');
    setTitle(page?.title ?? '');
  }, [id, page?.content, page?.title]);

  // Autosave while typing: the sync engine debounces the network on top.
  useEffect(() => {
    if (!editing || !page || content === page.content) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => update('page', id, { content }), 900);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [content, editing, id, page]);

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
      <Header title={<span className="row" style={{ gap: 6 }}><span>{page.icon ?? '📄'}</span><span className="truncate">{page.title || t('common.untitled')}</span></span>}>
        <button className="btn sm" hidden={!canWrite} onClick={() => {
          if (editing) update('page', id, { content, title });
          setEditing(!editing);
        }}>
          {editing ? <><Icon name="check" size={14} /> {t('action.done')}</> : <>{t('action.edit')}</>}
        </button>
        <MenuButton
          className="btn ghost sm icon"
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

      <div className="page" style={{ maxWidth: 820 }}>
        {editing ? (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <input
                className="input" style={{ width: 60, textAlign: 'center', fontSize: 18 }} value={page.icon ?? '📄'}
                maxLength={4} onChange={(event) => update('page', id, { icon: event.target.value })}
              />
              <input
                className="input grow" style={{ fontSize: 19, fontWeight: 600 }} value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => update('page', id, { title: title.trim() || t('common.untitled') })}
              />
            </div>
            <MarkdownEditor value={content} onChange={setContent} minHeight={420} attachTo={{ page_id: id }} />
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 26, marginBottom: 6 }}>{page.title || t('common.untitled')}</h1>
            <div className="row muted" style={{ fontSize: 12, marginBottom: 18 }}>
              <span>{author ? t('page.byAuthor', { name: author.name }) : ''}</span>
              <span>· {t('page.updatedAgo', { time: relativeTime(page.updated_at) })}</span>
              {page.project_id && <span>· {byId('project', page.project_id)?.name}</span>}
              {page.access !== 'workspace' && <span>· {t(ACCESS_KEY[page.access])}</span>}
              {watching && <span>· {t('page.watching')}</span>}
              {!!page.is_template && <span>· {t('page.template')}</span>}
            </div>
            <div className="row wrap" style={{ gap: 6, marginBottom: 14 }}><PageLabelChips page={page} /></div>
            {page.content?.trim()
              ? <Markdown source={page.content} />
              : <button className="btn" onClick={() => setEditing(true)}>{t('page.startWriting')}</button>}
          </>
        )}

        {children.length > 0 && (
          <section style={{ marginTop: 28 }}>
            <h3 style={{ fontSize: 14, marginBottom: 6 }}>{t('page.subpages')}</h3>
            {children.map((child) => (
              <button key={child.id} className="task-row" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`/pages/${child.id}`)}>
                <span>{child.icon ?? '📄'}</span>
                <span className="grow truncate">{child.title}</span>
              </button>
            ))}
          </section>
        )}

        {/* Last, and only while reading: the page is the point, the thread is
            what people said about it — and mid-edit it is simply in the way. */}
        {!editing && (
          <section style={{ marginTop: 32, borderTop: '1px solid var(--line)', paddingTop: 18 }}>
            <h3 style={{ fontSize: 14, marginBottom: 12 }}>{t('page.discussion')}</h3>
            <Comments target={{ page_id: id }} empty={t('page.noComments')} />
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
          {history.length === 0 && <p className="muted">{t('page.noVersions')}</p>}
          {history.map((version) => (
            <div className="row" key={version.id} style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
              <div className="grow">
                <strong style={{ fontSize: 13 }}>{version.title}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {shortDate(version.created_at)} · {members.get(version.author_id)?.name ?? t('common.someone')} · {t('page.versionSize', { count: version.size })}
                </div>
              </div>
              <button className="btn ghost sm" onClick={() => setDiffing(version.id)}>{t('page.compare')}</button>
              <button
                className="btn sm"
                onClick={async () => {
                  if (!(await confirm(t('page.restoreConfirm'), t('action.restore')))) return;
                  await api.restoreVersion(id, version.id);
                  await pull();
                  setHistory(null);
                  toast(t('page.restored'));
                }}
              >
                {t('action.restore')}
              </button>
            </div>
          ))}
        </Sheet>
      )}
      {diffing && <VersionDiff page={page} versionId={diffing} onClose={() => setDiffing(null)} />}
      {dialog}
    </>
  );
}
