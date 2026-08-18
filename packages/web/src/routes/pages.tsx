import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { compareOrder, type Page } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { Markdown, MarkdownEditor } from '../components/Markdown';
import { Empty, Icon, MenuButton, Sheet, useConfirm, useToast } from '../components/ui';
import { api } from '../lib/api';
import { relativeTime, shortDate } from '../lib/format';
import { excerpt } from '../lib/markdown';
import { createPage, remove, update } from '../lib/mutations';
import { byId, list, useQuery, useRow } from '../lib/store';
import { pull } from '../lib/sync';
import { useMe, useMemberMap, useSession } from '../session';
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
      <div className="row" style={{ gap: 0, paddingLeft: depth * 12 }}>
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
  const pages = useQuery(() => list('page', (p) => p.workspace_id === workspaceId && !p.archived), [workspaceId]);
  const tree = useMemo(() => buildTree(pages), [pages]);
  const recent = useMemo(() => [...pages].sort((a, b) => b.updated_at - a.updated_at).slice(0, 6), [pages]);

  return (
    <>
      <Header title={t('page.listTitle')}>
        <button className="btn primary sm" onClick={() => navigate(`/pages/${createPage({ title: t('common.untitled') }, me)}`)}>
          <Icon name="plus" size={14} /> <span className="hide-sm">{t('page.new')}</span>
        </button>
      </Header>
      <div className="page">
        {!pages.length ? (
          <Empty
            emoji="📓" title={t('page.emptyTitle')}
            hint={t('page.emptyHint')}
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const children = useQuery(() => list('page', (p) => p.parent_id === id && !p.archived), [id]);
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
        <button className="btn sm" onClick={() => {
          if (editing) update('page', id, { content, title });
          setEditing(!editing);
        }}>
          {editing ? <><Icon name="check" size={14} /> {t('action.done')}</> : <>{t('action.edit')}</>}
        </button>
        <MenuButton
          className="btn ghost sm icon"
          items={[
            { id: 'child', label: t('page.addSubpage'), icon: <Icon name="plus" size={14} />,
              onSelect: () => navigate(`/pages/${createPage({ parent_id: id, project_id: page.project_id, title: t('common.untitled') }, me)}`) },
            { id: 'history', label: t('page.history'), icon: <Icon name="refresh" size={14} />,
              onSelect: () => api.pageVersions(id).then(setHistory).catch(() => toast(t('page.historyFailed'))) },
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
            </div>
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
      </div>

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
      {dialog}
    </>
  );
}
