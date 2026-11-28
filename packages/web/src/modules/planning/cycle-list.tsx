/** A project's cycles, and the editor a cycle is made and changed in. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addDays, coversProject, isDoneGroup } from '@kolibri/shared';
import { ProjectScopeField, useScopeChoice } from './scope-field';
import type { MarkdownEditor } from '../pages/Markdown';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { Progress } from '../../kernel/design-system/ui/progress';
import { MenuButton } from '../../kernel/design-system/ui/menu-button';
import { Sheet, useConfirm } from '../../kernel/design-system/ui/sheet';
import { shortDate, today } from '../../kernel/design-system/format';
import { create, remove } from '../../kernel/sync/mutations';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { byId, list, useQuery, useRow } from '../../kernel/sync/store';
import { useCanWrite } from '../../kernel/identity/session';
import { useT } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { cn } from '../../kernel/design-system/cn';
import { Input, formField, formRow } from '../../kernel/design-system/ui/field';
import { chipVariants } from '../../kernel/design-system/ui/chip';
import { pageBody } from '../../kernel/design-system/ui/page';
import { useScopeTargets, useStranded } from './parts';

/**
 * A project's cycles. `Editor` is the markdown editor, handed in by the route
 * that composes this tab — see `SettingsSlots` in `project-settings.tsx` for
 * why a planning file is given it rather than importing it.
 */
export function Cycles({ projectId, Editor }: { projectId: string; Editor: typeof MarkdownEditor }) {
  const t = useT();
  const navigate = useNavigate();
  // This project's own, plus the ones it shares: a cycle that names it, and a
  // cycle every project runs. `coversProject` is the one place that question is
  // answered, so this tab and the server's queries cannot drift apart.
  const cycles = useQuery(
    () => list('cycle', (c) => coversProject(c, projectId))
      .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? '')),
    [projectId],
  );
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const { confirm, dialog } = useConfirm();
  const canWrite = useCanWrite();
  const day = today();

  return (
    <div className={pageBody}>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-title">{t('cycle.title')}</h2>
        <span className="flex-1 min-w-0" />
        {canWrite && <Button size="sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> {t('cycle.new')}</Button>}
      </div>

      {!cycles.length && <Empty emoji="🔁" title={t('cycle.emptyTitle')} hint={t('cycle.emptyHint')} guide="planning" />}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cycles.map((cycle) => {
          const active = cycle.start_date && cycle.end_date && cycle.start_date <= day && cycle.end_date >= day;
          return (
            <div className="rounded border border-line bg-raised p-3.5" key={cycle.id}>
              <div className="flex items-center gap-2 mb-2">
                <strong className="flex-1 min-w-0 truncate">{cycle.name}</strong>
                {/* Said on the card rather than only in the editor: deleting a
                    shared cycle takes it out of every project that is in it,
                    and the menu below offers exactly that. The chip counts the
                    projects when it covers some, because "Shared" alone leaves
                    the reader to guess whether that means two or twelve. */}
                {!cycle.project_id && (
                  <span
                    className={chipVariants()}
                    title={cycle.projects?.length ? t('cycle.sharedSomeHint') : t('cycle.sharedHint')}
                  >
                    {cycle.projects?.length
                      ? t('cycle.sharedCount', { count: cycle.projects.length })
                      : t('cycle.shared')}
                  </span>
                )}
                {active && <span className={chipVariants()} style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>{t('cycle.active')}</span>}
                <MenuButton
                  variant="ghost" size="iconSm"
                  label={t('common.moreActions')}
                  items={[
                    ...(canWrite ? [{ id: 'edit', label: t('action.edit'), onSelect: () => setEditing(cycle.id) }] : []),
                    { id: 'open', label: t('cycle.showTasks'), onSelect: () => navigate(`/cycles/${cycle.id}`) },
                    ...(canWrite ? [{ id: 'delete', label: t('action.delete'), danger: true, onSelect: async () => {
                      if (await confirm(t(cycle.project_id ? 'cycle.deleteConfirm' : 'cycle.deleteSharedConfirm', { name: cycle.name }))) remove('cycle', cycle.id);
                    } }] : []),
                  ]}
                >
                  <Icon name="dots" size={14} />
                </MenuButton>
              </div>
              <CycleProgress cycleId={cycle.id} />
              <Button size="sm" block className="mt-2.5" onClick={() => navigate(`/cycles/${cycle.id}`)}>{t('cycle.open')}</Button>
            </div>
          );
        })}
      </div>

      {editing && (
        <CycleEditor
          Editor={Editor}
          projectId={projectId}
          cycleId={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {dialog}
    </div>
  );
}

/**
 * Making a cycle, and changing one — including what it covers.
 *
 * The scope used to be create-only, on the argument that re-scoping a running
 * cycle can strand work and that doing so behind a dropdown which looks like a
 * setting is how data goes missing without anybody attributing it to the click.
 * The argument was right about the danger and wrong about the remedy: it left
 * the only way to widen a fortnight to a second project an MCP call, so the
 * answer to "add Mobile to this sprint" in the interface was to delete the
 * cycle and build it again — which strands *everything* in it rather than the
 * part that no longer fits.
 *
 * So the control is here, and the consequence is on screen *before* the save
 * rather than reported after it: the tasks that would be left in a cycle their
 * project is no longer covered by are named, by identifier, as the scope is
 * chosen. Named rather than counted, for the reason `update_cycle` names them —
 * "3 tasks" is a number somebody then has to go and find.
 *
 * Nothing is moved either way. A task keeps its `cycle_id`; dropping a project
 * out of a cycle is a decision about the cycle, and taking somebody's task out
 * of a sprint is a different decision that is not this form's to make. The
 * server applies the same rule, so an import and an assistant land the same
 * shape — see `settleProjectScope` and the planning rules.
 */
function CycleEditor({ projectId, cycleId, onClose, Editor }: {
  projectId: string; cycleId?: string; onClose: () => void; Editor: typeof MarkdownEditor;
}) {
  const t = useT();
  const cycle = useRow('cycle', cycleId);
  const saveChanges = useSaveChanges('cycle', cycle);
  const { confirm, dialog } = useConfirm();
  const [form, setForm] = useState({
    name: cycle?.name ?? '',
    description: cycle?.description ?? '',
    start_date: cycle?.start_date ?? today(),
    end_date: cycle?.end_date ?? addDays(today(), 14),
  });
  const choice = useScopeChoice(cycleId ? cycle : undefined, projectId);
  const projects = useScopeTargets();
  const stranded = useStranded('cycle_id', cycleId, choice.settled);

  const save = async () => {
    if (!form.name.trim() || choice.incomplete) return;
    if (cycleId) {
      /* Asked once, and only when there is actually something to lose: the
         names are already on screen, and this is the deliberate second step a
         delete has. The label is given because `confirm` says "Delete" by
         default and nothing here is deleted — a danger button reading "Delete"
         over a sentence promising nothing is removed is a contradiction the
         reader has to resolve under time pressure. */
      if (stranded.length
        && !(await confirm(t('cycle.scopeStrandConfirm', { count: stranded.length }), t('action.save')))) return;
      saveChanges({ ...form, ...choice.settled });
    } else {
      // `projectScope` is what the server would apply anyway; applying it here
      // too means the row this device writes into its own store is already the
      // canonical shape, rather than one that changes under it on the next pull.
      create('cycle', { ...form, ...choice.settled });
    }
    onClose();
  };

  return (
    <>
      <Sheet
        title={cycleId ? t('cycle.edit') : t('cycle.new')}
        onClose={onClose}
        footer={(
          <Button variant="primary" onClick={() => void save()} disabled={!form.name.trim() || choice.incomplete}>
            {t('action.save')}
          </Button>
        )}
      >
        <div className={formField}>
          <label htmlFor="c-name">{t('cycle.name')}</label>
          <Input id="c-name" autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </div>
        <div className={formRow}>
          <div className={cn(formField, 'flex-1 min-w-0')}>
            <label htmlFor="c-start">{t('cycle.starts')}</label>
            <Input id="c-start" type="date" value={form.start_date ?? ''} onChange={(event) => setForm({ ...form, start_date: event.target.value })} />
          </div>
          <div className={cn(formField, 'flex-1 min-w-0')}>
            <label htmlFor="c-end">{t('cycle.ends')}</label>
            <Input id="c-end" type="date" value={form.end_date ?? ''} onChange={(event) => setForm({ ...form, end_date: event.target.value })} />
          </div>
        </div>
        <div className={formField}>
          <label htmlFor="c-goal">{t('cycle.goal')}</label>
          <Editor
            id="c-goal" value={form.description ?? ''} minHeight={90}
            onChange={(value) => setForm({ ...form, description: value })}
          />
        </div>

        <ProjectScopeField
          id="c-scope"
          scope={choice.scope} onScope={choice.setScope}
          picked={choice.picked} onPicked={choice.setPicked}
          projects={projects}
          stranded={stranded}
          labels={{
            legend: t('cycle.scope'),
            this: t('cycle.scopeThis'), some: t('cycle.scopeSome'), all: t('cycle.scopeAll'),
            thisHint: t('cycle.scopeThisHint'), someHint: t('cycle.scopeSomeHint'), allHint: t('cycle.scopeAllHint'),
            pickOne: t('cycle.scopePickOne'),
            strandTitle: t('cycle.scopeStrandTitle', { count: stranded.length }),
            strandMore: t('cycle.scopeStrandMore', { count: stranded.length - 12 }),
            strandHint: t('cycle.scopeStrandHint'),
          }}
        />
      </Sheet>
      {dialog}
    </>
  );
}

/**
 * How far one cycle has got, for its row in the list.
 *
 * It lived in `work/views.tsx` and was imported from there while the list was
 * part of the project route. A cycle's progress is planning's to draw, and
 * `work` already leans on `planning` for the timeline, so the other direction
 * would have been a cycle between the two.
 */
function CycleProgress({ cycleId }: { cycleId: string }) {
  const t = useT();
  const tasks = useQuery(() => list('task', (t) => t.cycle_id === cycleId), [cycleId]);
  const done = tasks.filter((task) => isDoneGroup(byId('state', task.state_id)?.group_key)).length;
  const cycle = byId('cycle', cycleId);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-label">
        <span className="flex-1 min-w-0 truncate">{cycle?.name}</span>
        <span className="text-muted">{done}/{tasks.length}</span>
      </div>
      <Progress value={done} total={tasks.length} />
      {cycle?.end_date && <span className="text-muted text-caption">{t('cycle.endsOn', { date: shortDate(cycle.end_date) })}</span>}
    </div>
  );
}
