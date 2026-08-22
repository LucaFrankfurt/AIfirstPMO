import { useEffect, useMemo, useState } from 'react';
import { PRIORITIES, parseQuickAdd, QUICK_ADD_SYNTAX, type Priority } from '@kolibri/shared';
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
import { Chip } from './ui/chip';

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

  // A container holds projects, not tasks, so it is not somewhere a task can
  // go — in the menu or through a `#KEY` token.
  const projects = useQuery(
    () => list('project', (p) => p.workspace_id === workspaceId && !p.archived && !p.is_container)
      .sort((a, b) => a.name.localeCompare(b.name)),
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

  const labels = useQuery(
    () => list('label', (row) => row.workspace_id === workspaceId),
    [workspaceId],
  );

  /**
   * What the line says, as it is typed.
   *
   * The parser never invents a field, so `??` here is exactly right: a token
   * wins where one was typed, and every dropdown keeps whatever it was set to
   * otherwise. Typing `!high` and then choosing *Low* from the menu leaves the
   * `!high` visible in the box, which is why the token wins — the alternative
   * is a form that disagrees with the words next to it.
   */
  const parsed = useMemo(() => {
    const vocabulary = {
      today: new Date().toISOString().slice(0, 10),
      meId: me,
      people: members.map((member) => ({ id: member.id, name: member.name })),
      projects: projects.map((row) => ({ id: row.id, key: row.key, name: row.name })),
      labels: labels.map((row) => ({ id: row.id, name: row.name })),
    };
    /*
     * Twice, and the second time with the labels narrowed to one project.
     *
     * A label belongs to a project, so a workspace with three projects has
     * three rows called `bug` — and the parser drops a token that matches more
     * than one, because two labels of the same name are not something it can
     * choose between. That made `*bug` do nothing at all in any workspace with
     * more than one project, silently, since the word looked like it had been
     * understood right up until the task arrived without it.
     *
     * The project is what settles it, and the project may be in the line: the
     * first pass is only there to find `#KEY`. Both passes are pure and run on
     * a string somebody is still typing, so this costs nothing worth counting.
     */
    const scope = parseQuickAdd(title, vocabulary).projectId ?? projectId;
    return parseQuickAdd(title, {
      ...vocabulary,
      labels: labels
        .filter((row) => !row.project_id || row.project_id === scope)
        .map((row) => ({ id: row.id, name: row.name })),
    });
  }, [title, me, members, projects, labels, projectId]);

  const effective = {
    projectId: parsed.projectId ?? projectId,
    priority: parsed.priority ?? priority,
    assignees: parsed.assignees.length ? parsed.assignees : assignees,
    due: parsed.dueDate ?? due,
  };
  const project = projects.find((p) => p.id === effective.projectId);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => setStateId(defaultStateId(projectId)), [projectId]);

  const submit = (keepOpen = false) => {
    if (!parsed.title.trim() || !effective.projectId) return;
    createTask({
      project_id: effective.projectId,
      title: parsed.title.trim(),
      description: description.trim() || undefined,
      priority: effective.priority,
      assignees: effective.assignees,
      labels: parsed.labels.length ? parsed.labels : undefined,
      // A state chosen for the old project is not a state in the new one: it
      // belongs to the project, and `#KEY` can change which project this is
      // after it was picked.
      state_id: parsed.projectId && parsed.projectId !== projectId ? undefined : stateId,
      due_date: effective.due || null,
      cycle_id: cycleId ?? null,
      recurrence: parsed.recurrence,
    }, me);
    localStorage.setItem(LAST_PROJECT_KEY, effective.projectId);
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
          <Button onClick={() => submit(true)} disabled={!parsed.title.trim() || !effective.projectId} title={t('quickAdd.saveAndNewHint')}>
            {t('quickAdd.saveAndNew')}
          </Button>
          <Button variant="primary" onClick={() => submit(false)} disabled={!parsed.title.trim() || !effective.projectId}>
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
            className="text-base mb-2.5"
          />

          {/* What the line was read as. Shown rather than only applied, because a
              parser that quietly changes the priority is a parser nobody
              trusts — and the token is still in the box to be deleted. */}
          {parsed.found.length > 0 && (
            <p className="flex items-center flex-wrap gap-1.5 mb-2.5 text-[12.5px] text-muted">
              <Icon name="sparkle" size={13} />
              {t('quickAdd.read')}
              {parsed.found.map((entry) => (
                <Chip key={`${entry.kind}-${entry.token}`} title={entry.token}>{entry.label}</Chip>
              ))}
            </p>
          )}
          {!parsed.found.length && title.trim().length > 2 && (
            <p className="mb-2.5 text-[12px] text-muted font-mono truncate">{QUICK_ADD_SYNTAX}</p>
          )}

          <div className="flex items-center flex-wrap gap-1.5 mb-2.5">
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
              <PriorityBars priority={effective.priority} />
              {t(priorityKey(effective.priority))}
            </MenuButton>

            <MenuButton items={memberItems} variant="secondary" size="sm" search>
              <Icon name="users" size={14} />
              {effective.assignees.length ? t('quickAdd.assigned', { count: effective.assignees.length }) : t('quickAdd.assign')}
            </MenuButton>

            {/* Every other control in this row says what it is. This one said it
                only to a screen reader: an empty `type="date"` draws a
                placeholder on some browsers and nothing at all on others, so on
                a phone it arrived as a blank box between two labelled chips and
                read as a field that had failed to load. The word is the fix. */}
            <label className="flex items-center gap-1.5 text-[12.5px]">
              <span className="text-muted">{t('task.due')}</span>
              <Input
                type="date" style={{ width: 152 }} aria-label={t('task.due')}
                value={effective.due} onChange={(event) => setDue(event.target.value)}
              />
            </label>

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
