import { useEffect, useState } from 'react';
import { PRIORITIES, type Priority } from '@kolibri/shared';
import { list, useQuery } from '../lib/store';
import { createTask, defaultStateId } from '../lib/mutations';
import { api } from '../lib/api';
import { pull } from '../lib/sync';
import { priorityKey, useT } from '../lib/i18n';
import { useMe, useMembers, useSession } from '../session';
import { MarkdownEditor } from './Markdown';
import { useStates } from './task-parts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/field';
import { Avatar, Icon, MenuButton, PriorityBars, Sheet, StateDot, useToast, type MenuItem } from './ui';

const LAST_PROJECT_KEY = 'kolibri.last-project';

/**
 * Create a task from anywhere (`c` or the + button). Everything is optional
 * except the title — filling in details later is the normal case.
 */
export function QuickAdd({ onClose, projectId: initialProject, cycleId }: { onClose: () => void; projectId?: string; cycleId?: string }) {
  const t = useT();
  const { workspaceId } = useSession();
  const me = useMe();
  const members = useMembers();
  const toast = useToast();

  const projects = useQuery(
    () => list('project', (p) => p.workspace_id === workspaceId && !p.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [workspaceId],
  );

  const [projectId, setProjectId] = useState(
    initialProject ?? localStorage.getItem(LAST_PROJECT_KEY) ?? projects[0]?.id ?? '',
  );
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('none');
  const [assignees, setAssignees] = useState<string[]>([]);
  const [stateId, setStateId] = useState<string | undefined>(undefined);
  const [due, setDue] = useState('');
  const [more, setMore] = useState(false);
  const [applying, setApplying] = useState(false);

  // Templates for this project, plus the workspace-wide ones.
  const templates = useQuery(
    () => list('template', (row) => row.workspace_id === workspaceId && !row.archived
      && (!row.project_id || row.project_id === projectId)),
    [workspaceId, projectId],
  );

  const states = useStates(projectId);
  const project = projects.find((p) => p.id === projectId);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => setStateId(defaultStateId(projectId)), [projectId]);

  const submit = (keepOpen = false) => {
    if (!title.trim() || !projectId) return;
    createTask({
      project_id: projectId,
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      assignees,
      state_id: stateId,
      due_date: due || null,
      cycle_id: cycleId ?? null,
    }, me);
    localStorage.setItem(LAST_PROJECT_KEY, projectId);
    toast(t('quickAdd.added', { project: project?.name ?? t('quickAdd.project') }));
    if (keepOpen) {
      setTitle('');
      setDescription('');
      setDue('');
    } else {
      onClose();
    }
  };

  const projectItems: MenuItem[] = projects.map((p) => ({
    id: p.id,
    label: `${p.icon ?? ''} ${p.name}`.trim(),
    hint: p.key,
    onSelect: () => setProjectId(p.id),
  }));

  const memberItems: MenuItem[] = members.map((member) => ({
    id: member.id,
    label: member.name,
    hint: assignees.includes(member.id) ? '✓' : undefined,
    icon: <Avatar user={member} size={20} />,
    onSelect: () => setAssignees((current) => (current.includes(member.id) ? current.filter((id) => id !== member.id) : [...current, member.id])),
  }));

  return (
    <Sheet
      title={t('quickAdd.title')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => submit(true)} disabled={!title.trim() || !projectId} title={t('quickAdd.saveAndNewHint')}>
            {t('quickAdd.saveAndNew')}
          </Button>
          <Button variant="primary" onClick={() => submit(false)} disabled={!title.trim() || !projectId}>
            {t('quickAdd.create')}
          </Button>
        </>
      }
    >
      {!projects.length ? (
        <p className="text-muted">{t('quickAdd.needProject')}</p>
      ) : (
        <>
          <Input
            autoFocus
            placeholder={t('quickAdd.placeholder')}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(false);
            }}
            style={{ fontSize: 16, marginBottom: 10 }}
          />

          <div className="flex items-center gap-2 flex-wrap" style={{ gap: 6, marginBottom: 10 }}>
            <MenuButton items={projectItems} variant="secondary" size="sm" search>
              <span>{project ? `${project.icon ?? ''} ${project.name}` : t('quickAdd.project')}</span>
              <Icon name="chevronDown" size={13} />
            </MenuButton>

            <MenuButton
              variant="secondary" size="sm"
              items={states.map((state) => ({
                id: state.id,
                label: state.name,
                icon: <StateDot group={state.group_key} color={state.color} />,
                onSelect: () => setStateId(state.id),
              }))}
            >
              <StateDot group={states.find((s) => s.id === stateId)?.group_key} color={states.find((s) => s.id === stateId)?.color} />
              {states.find((s) => s.id === stateId)?.name ?? t('task.state')}
            </MenuButton>

            <MenuButton
              variant="secondary" size="sm"
              items={PRIORITIES.map((value) => ({
                id: value,
                label: t(priorityKey(value)),
                icon: <PriorityBars priority={value} />,
                onSelect: () => setPriority(value),
              }))}
            >
              <PriorityBars priority={priority} />
              {t(priorityKey(priority))}
            </MenuButton>

            <MenuButton items={memberItems} variant="secondary" size="sm" search>
              <Icon name="users" size={14} />
              {assignees.length ? t('quickAdd.assigned', { count: assignees.length }) : t('quickAdd.assign')}
            </MenuButton>

            <Input type="date" style={{ width: 152 }} value={due} onChange={(event) => setDue(event.target.value)} />

            <MenuButton
              variant="secondary" size="sm"
              disabled={applying}
              empty={t('tpl.pickEmpty')}
              items={templates.map((template) => ({
                id: template.id,
                label: `${template.icon ?? '📋'} ${template.name}`,
                onSelect: async () => {
                  setApplying(true);
                  try {
                    const task = await api.applyTemplate(template.id, { project_id: projectId, assignees });
                    await pull();
                    toast(t('tpl.used', { identifier: task.identifier }));
                    onClose();
                  } catch (error) {
                    toast(error instanceof Error ? error.message : t('common.somethingWentWrong'));
                  } finally {
                    setApplying(false);
                  }
                },
              }))}
            >
              <Icon name="copy" size={13} /> {t('tpl.pick')}
            </MenuButton>
          </div>

          {more ? (
            <MarkdownEditor value={description} onChange={setDescription} minHeight={110} placeholder={t('quickAdd.descriptionPlaceholder')} />
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setMore(true)}>
              <Icon name="plus" size={13} /> {t('quickAdd.addDescription')}
            </Button>
          )}
        </>
      )}
    </Sheet>
  );
}
