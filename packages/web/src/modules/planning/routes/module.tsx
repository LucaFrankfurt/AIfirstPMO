/** One module: what it is for, its papers, its tasks, and what has to be true when it lands. */
import { Suspense, lazy, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import { TaskViews, useVisibleTasks, ViewControls } from '../../work/views';
import { DEFAULT_VIEW, type ViewConfig } from '../../work/task-parts';
import { Markdown, MarkdownEditor } from '../../pages/Markdown';
import { Empty } from '../../../kernel/design-system/ui/empty';
import { Icon } from '../../../kernel/design-system/ui/icon';
import { update } from '../../../kernel/sync/mutations';
import { useOpenTask } from '../../../kernel/design-system/navigation';
import { list, useQuery, useRow } from '../../../kernel/sync/store';
import { useCanWrite, useFeature } from '../../../kernel/identity/session';
import { useT } from '../../../kernel/i18n/i18n';
import { Button } from '../../../kernel/design-system/ui/button';
import { Attachments } from '../../../kernel/files/Attachments';
import { pageBody } from '../../../kernel/design-system/ui/page';
import { planningCrumbs } from '../parts';

/** Fetched rather than imported, for the reason `ProjectKpis` is — see `routes/projects.tsx`. */
const MilestoneKpis = lazy(() => import('../../kpis/routes/kpis').then((m) => ({ default: m.MilestoneKpis })));

export function ModulePage() {
  const t = useT();
  const navigate = useNavigate();
  const openTask = useOpenTask();
  const { id = '' } = useParams();
  const module = useRow('module', id);
  const [view, setView] = useState<ViewConfig>(DEFAULT_VIEW);
  const [editing, setEditing] = useState(false);
  const tasks = useQuery(() => list('task', (t) => t.module_id === id), [id]);
  const visible = useVisibleTasks(tasks, view);
  const canWrite = useCanWrite();
  const kpis = useFeature('kpi');
  if (!module) {
    return (
      <>
        <Header title={t('module.title')} />
        <div className="px-3 pt-4 sm:px-6 sm:pt-5">
          <Trail parts={[{ to: '/projects', label: t('nav.projects'), icon: <Icon name="board" size={13} /> }]} />
        </div>
        <Empty
          emoji="🕳️" title={t('module.notFound')}
          action={<Button onClick={() => navigate('/projects')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }
  return (
    <>
      <Header title={module.name}>
        {/* A module's description has always been rendered as markdown here and
            has never had an editor anywhere — it could only be set through the
            API, an import or an assistant. Same Edit/Done as a page, because it
            is the same job. */}
        {canWrite && (
          <Button size="sm" onClick={() => setEditing(!editing)}>
            {editing ? <><Icon name="check" size={14} /> {t('action.done')}</> : t('action.edit')}
          </Button>
        )}
      </Header>
      <div className={pageBody}>
        <Trail parts={planningCrumbs(module.project_id, 'modules', t('nav.projects'))} />
        {editing ? (
          <div className="mb-3.5">
            <MarkdownEditor
              value={module.description ?? ''} minHeight={130} autoFocus label={t('module.description')}
              attachTo={{ kind: 'module', id: module.id }}
              onChange={(value) => update('module', module.id, { description: value })}
            />
          </div>
        ) : module.description ? (
          <div className="mb-3.5"><Markdown source={module.description} /></div>
        ) : null}
        {/* What the milestone is being judged against: the spec, the signed
            acceptance criteria, the screenshots from the review. */}
        <Attachments on={{ kind: 'module', id: module.id }} className="mb-3.5" />
        {/* `?? undefined` for the same reason the cycle page does it: a module
            several projects work on has no single project to scope a view to. */}
        <ViewControls view={view} onChange={setView} projectId={module.project_id ?? undefined} className="mb-3" />
        <TaskViews tasks={visible} view={view} projectId={module.project_id ?? undefined} onOpen={openTask} implied={{ moduleId: module.id }} />
        {/* A milestone is described by what gets built; this is what has to be
            *true* by the time it lands. Renders nothing when nothing has been
            promised against it, rather than an empty frame. */}
        {kpis && <Suspense fallback={null}><MilestoneKpis moduleId={module.id} /></Suspense>}
      </div>
    </>
  );
}
