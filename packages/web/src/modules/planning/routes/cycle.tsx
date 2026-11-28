/** One cycle: how far it has got, its papers, and its tasks. */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { isDoneGroup } from '@kolibri/shared';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import { QuickAdd } from '../../work/QuickAdd';
import { TaskViews, useVisibleTasks, ViewControls } from '../../work/views';
import { DEFAULT_VIEW, type ViewConfig } from '../../work/task-parts';
import { Markdown } from '../../pages/Markdown';
import { Empty } from '../../../kernel/design-system/ui/empty';
import { Icon } from '../../../kernel/design-system/ui/icon';
import { Progress } from '../../../kernel/design-system/ui/progress';
import { shortDate } from '../../../kernel/design-system/format';
import { useOpenTask } from '../../../kernel/design-system/navigation';
import { byId, list, useQuery, useRow } from '../../../kernel/sync/store';
import { useCanWrite } from '../../../kernel/identity/session';
import { useT } from '../../../kernel/i18n/i18n';
import { Button } from '../../../kernel/design-system/ui/button';
import { Attachments } from '../../../kernel/files/Attachments';
import { pageBody } from '../../../kernel/design-system/ui/page';
import { planningCrumbs } from '../parts';

export function CyclePage() {
  const t = useT();
  const navigate = useNavigate();
  const openTask = useOpenTask();
  const { id = '' } = useParams();
  const cycle = useRow('cycle', id);
  const [view, setView] = useState<ViewConfig>({ ...DEFAULT_VIEW, groupBy: 'state' });
  const [adding, setAdding] = useState(false);
  const canWrite = useCanWrite();
  const tasks = useQuery(() => list('task', (t) => t.cycle_id === id), [id]);
  const visible = useVisibleTasks(tasks, view);

  const burndown = useMemo(() => {
    const done = tasks.filter((task) => isDoneGroup(byId('state', task.state_id)?.group_key)).length;
    const points = tasks.reduce((sum, task) => sum + (task.estimate ?? 0), 0);
    const donePoints = tasks
      .filter((task) => isDoneGroup(byId('state', task.state_id)?.group_key))
      .reduce((sum, task) => sum + (task.estimate ?? 0), 0);
    return { done, total: tasks.length, points, donePoints };
  }, [tasks]);

  // Without a `Header` this screen lost the app's chrome altogether — no title,
  // no sync pill, and nothing to press. A cycle that has been deleted still
  // opens from a link in a chat message.
  if (!cycle) {
    return (
      <>
        <Header title={t('cycle.title')} />
        <div className="px-3 pt-4 sm:px-6 sm:pt-5">
          <Trail parts={[{ to: '/projects', label: t('nav.projects'), icon: <Icon name="board" size={13} /> }]} />
        </div>
        <Empty
          emoji="🕳️" title={t('cycle.notFound')}
          action={<Button onClick={() => navigate('/projects')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }

  return (
    <>
      <Header title={cycle.name}>
        {/* `?? undefined` on all three below, and it is the whole shared-cycle
            answer on this screen: a cycle several projects run has no single
            project to scope a view to or to file a new task into. QuickAdd
            already offers a picker when it is not told one, which is exactly
            the right question to ask here. */}
        {canWrite && <Button variant="primary" size="sm" title={t('nav.newTask')} onClick={() => setAdding(true)}><Icon name="plus" size={14} /></Button>}
      </Header>
      <div className={pageBody}>
        <Trail parts={planningCrumbs(cycle.project_id, 'cycles', t('nav.projects'))} />
        <div className="rounded border border-line bg-raised p-3.5 mb-3.5">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1 min-w-0">
              <strong>{t('cycle.taskProgress', { done: burndown.done, total: burndown.total })}</strong>
              <div className="text-muted text-label">
                {t('cycle.pointProgress', { done: burndown.donePoints, total: burndown.points })}
                {cycle.start_date && cycle.end_date && ` · ${shortDate(cycle.start_date)} – ${shortDate(cycle.end_date)}`}
              </div>
            </div>
          </div>
          <Progress value={burndown.done} total={burndown.total} />
          {cycle.description && <div className="mt-2 text-label"><Markdown source={cycle.description} /></div>}
        </div>
        {/* The sprint's own papers: the retro notes, the demo recording, the
            capacity sheet somebody built it from. Above the tasks, because it
            is about the cycle and the list below is about the work. */}
        <Attachments on={{ kind: 'cycle', id: cycle.id }} className="mb-3.5" />
        <ViewControls view={view} onChange={setView} projectId={cycle.project_id ?? undefined} className="mb-3" />
        <TaskViews tasks={visible} view={view} projectId={cycle.project_id ?? undefined} onOpen={openTask} implied={{ cycleId: cycle.id }} />
      </div>
      {adding && <QuickAdd projectId={cycle.project_id ?? undefined} cycleId={id} onClose={() => setAdding(false)} />}
    </>
  );
}
