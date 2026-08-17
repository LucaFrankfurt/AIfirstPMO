import { useEffect, useState } from 'react';
import { PRIORITIES, type Priority } from '@kolibri/shared';
import { list, useQuery } from '../lib/store';
import { createTask, defaultStateId } from '../lib/mutations';
import { PRIORITY_LABEL } from '../lib/format';
import { useMe, useMembers, useSession } from '../session';
import { MarkdownEditor } from './Markdown';
import { useStates } from './task-parts';
import { Avatar, Icon, MenuButton, PriorityBars, Sheet, StateDot, useToast, type MenuItem } from './ui';

const LAST_PROJECT_KEY = 'kolibri.last-project';

/**
 * Create a task from anywhere (`c` or the + button). Everything is optional
 * except the title — filling in details later is the normal case.
 */
export function QuickAdd({ onClose, projectId: initialProject, cycleId }: { onClose: () => void; projectId?: string; cycleId?: string }) {
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
    toast(`Added to ${project?.name ?? 'project'}`);
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
      title="New task"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => submit(true)} disabled={!title.trim() || !projectId} title="Create and keep the form open">
            Save & new
          </button>
          <button className="btn primary" onClick={() => submit(false)} disabled={!title.trim() || !projectId}>
            Create task
          </button>
        </>
      }
    >
      {!projects.length ? (
        <p className="muted">Create a project first — tasks live inside projects.</p>
      ) : (
        <>
          <input
            className="input"
            autoFocus
            placeholder="What needs doing?"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(false);
            }}
            style={{ fontSize: 16, marginBottom: 10 }}
          />

          <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
            <MenuButton items={projectItems} className="btn sm" search>
              <span>{project ? `${project.icon ?? ''} ${project.name}` : 'Project'}</span>
              <Icon name="chevronDown" size={13} />
            </MenuButton>

            <MenuButton
              className="btn sm"
              items={states.map((state) => ({
                id: state.id,
                label: state.name,
                icon: <StateDot group={state.group_key} color={state.color} />,
                onSelect: () => setStateId(state.id),
              }))}
            >
              <StateDot group={states.find((s) => s.id === stateId)?.group_key} color={states.find((s) => s.id === stateId)?.color} />
              {states.find((s) => s.id === stateId)?.name ?? 'State'}
            </MenuButton>

            <MenuButton
              className="btn sm"
              items={PRIORITIES.map((value) => ({
                id: value,
                label: PRIORITY_LABEL[value],
                icon: <PriorityBars priority={value} />,
                onSelect: () => setPriority(value),
              }))}
            >
              <PriorityBars priority={priority} />
              {PRIORITY_LABEL[priority]}
            </MenuButton>

            <MenuButton items={memberItems} className="btn sm" search>
              <Icon name="users" size={14} />
              {assignees.length ? `${assignees.length} assigned` : 'Assign'}
            </MenuButton>

            <input className="input" type="date" style={{ width: 152 }} value={due} onChange={(event) => setDue(event.target.value)} />
          </div>

          {more ? (
            <MarkdownEditor value={description} onChange={setDescription} minHeight={110} placeholder="Add context, acceptance criteria, links…" />
          ) : (
            <button className="btn ghost sm" onClick={() => setMore(true)}>
              <Icon name="plus" size={13} /> Add description
            </button>
          )}
        </>
      )}
    </Sheet>
  );
}
