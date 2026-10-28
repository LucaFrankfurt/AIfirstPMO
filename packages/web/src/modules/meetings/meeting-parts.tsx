/**
 * The pieces of a meeting that appear somewhere other than its own screen, and
 * the agenda point, which is most of that screen.
 *
 * Here rather than in `routes/meetings.tsx` because a route file is the top of
 * its module — only the shell may import one — and two of these are wanted
 * from elsewhere: the task detail says which meeting a task came out of, which
 * is the half of "create tasks from the agenda" that is still useful a month
 * later.
 *
 * The agenda point is the part worth reading. Its notes are written by several
 * people at once, during the meeting, so they go through the same
 * collaborative editor a page body does — `useCollaborativeText`, pointed at
 * the point's own two columns — and while somebody is typing in one, everybody
 * else sees their name under it. That uses the presence channel chat already
 * has, with the point's id where a conversation's would be: it is ephemeral,
 * it never touches a row, and a client that ignores it loses nothing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AGENDA_STATUS, agendaOf, agendaTally, isOverdue, nextAgendaKey, orderKey,
  type AgendaItem, type AgendaStatus, type Meeting, type MinutesWords, type Task, type User,
} from '@kolibri/shared';
import { AvatarStack, Icon, MenuButton, Sheet, StateDot, useConfirm, useToast } from '../../kernel/design-system/ui';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Label, Select, Textarea } from '../../kernel/design-system/ui/field';
import { exactTime, longDate, clockTime } from '../../kernel/design-system/format';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { create, createTask, remove, update } from '../../kernel/sync/mutations';
import { byId, list, useQuery, useRow } from '../../kernel/sync/store';
import { useCanWrite, useFeature, useMe, useMemberMap, useSession } from '../../kernel/identity/session';
import { useCollaborativeText, type CollabTarget } from '../pages/collab';
import { setTyping, useTypists } from '../chat/presence';

/** Where an agenda point keeps its notes: the CRDT, and what it reads as. */
const NOTES: CollabTarget = { entity: 'agendaItem', state: 'notes_body', text: 'notes' };

export const statusKey = (status: AgendaStatus): TranslationKey => `meeting.status.${status}` as TranslationKey;

/** `datetime-local` wants minutes in the reader's own zone, not an epoch. */
export const asLocal = (at: number | null | undefined): string => {
  if (!at) return '';
  const local = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

/** The next full hour, which is when most meetings somebody is calling right now start. */
const nextHour = (): number => {
  const at = new Date();
  at.setMinutes(0, 0, 0);
  return at.getTime() + 3_600_000;
};

/** "Tuesday, 3 November · 10:00", or nothing for a meeting without a time. */
export function meetingWhen(meeting: Pick<Meeting, 'starts_at'>): string {
  if (!meeting.starts_at) return '';
  return `${longDate(meeting.starts_at)} · ${clockTime(meeting.starts_at)}`;
}

/** The projects a person may tag a point with: live, not archived, not a folder. */
export function useTaggableProjects() {
  const { workspaceId } = useSession();
  return useQuery(
    () => list('project', (project) => project.workspace_id === workspaceId && !project.archived && !project.is_container)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [workspaceId],
  );
}

/**
 * A point as the screen reads it: every list it carries is a list.
 *
 * `assignees` arrived a day after the table did, and the server does not send
 * a row again because a column was added to it — so a device that synced its
 * agenda before the upgrade holds every point without the field until somebody
 * next edits each one. Read straight, that was `undefined.includes` inside the
 * people picker, and the whole meeting screen went to the error boundary on the
 * first real instance it reached. Filled in here, where the screen reads its
 * rows, rather than at every place a list is touched. The row is returned as it
 * was when nothing is missing, so the notes editor keeps the state it holds.
 */
const withLists = (item: AgendaItem): AgendaItem => (Array.isArray(item.assignees) && Array.isArray(item.projects)
  ? item
  : { ...item, assignees: item.assignees ?? [], projects: item.projects ?? [] });

/** The live points of a meeting, synced, in agenda order. */
export function useAgenda(meetingId: string): AgendaItem[] {
  return useQuery(
    () => agendaOf(meetingId, list('agendaItem', (item) => item.meeting_id === meetingId)).map(withLists),
    [meetingId],
  );
}

/* ------------------------------------------------------------------ index */

/** One meeting as it appears in the list: when, where, who, and how far the agenda got. */
export function MeetingCard({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const members = useMemberMap();
  const agenda = useAgenda(meeting.id);
  const tally = agendaTally(agenda);
  const people = meeting.attendees.map((id) => members.get(id)).filter(Boolean);

  return (
    <section className="agenda-card flex flex-wrap items-center justify-between gap-3 p-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <Link to={`/meetings/${meeting.id}`} className="meeting-link">{meeting.title || t('meeting.untitled')}</Link>
        <span className="row-sub">
          {meetingWhen(meeting) || t('meeting.noTime')}
          {meeting.location && ` · ${meeting.location}`}
          {` · ${t('meeting.points', { count: tally.total })}`}
          {tally.open > 0 && meeting.status !== 'done' && ` · ${t('meeting.openPoints', { count: tally.open })}`}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {people.length > 0 && <AvatarStack users={people} max={4} />}
        <MeetingState meeting={meeting} />
      </div>
    </section>
  );
}

export function MeetingState({ meeting }: { meeting: Meeting }) {
  const t = useT();
  if (meeting.status === 'done') return <Chip>{t('meeting.done')}</Chip>;
  if (isOverdue(meeting)) return <Chip>{t('meeting.unclosed')}</Chip>;
  return <Chip tone="on">{t('meeting.planned')}</Chip>;
}

/* ------------------------------------------------------------------ forms */

/**
 * Chips for what is chosen, a menu for the rest.
 *
 * One shape for the two lists a meeting has — the people expected, and the
 * projects a point is about — because both are "any number of these, from a
 * list that grows with the workspace", and the menu's own search is what
 * makes forty names usable.
 */
function PickChips({
  chosen, options, onChange, addLabel, removeLabel, disabled,
}: {
  chosen: string[];
  options: { id: string; label: string }[];
  onChange: (next: string[]) => void;
  addLabel: string;
  removeLabel: (label: string) => string;
  disabled?: boolean;
}) {
  const named = new Map(options.map((option) => [option.id, option.label]));
  const rest = options.filter((option) => !chosen.includes(option.id));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chosen.filter((id) => named.has(id)).map((id) => (
        <Chip key={id} className="gap-1 pr-0.5">
          {named.get(id)}
          {!disabled && (
            <button
              type="button"
              className="pick-remove"
              aria-label={removeLabel(named.get(id) ?? '')}
              onClick={() => onChange(chosen.filter((one) => one !== id))}
            >
              <Icon name="close" size={11} />
            </button>
          )}
        </Chip>
      ))}
      {!disabled && rest.length > 0 && (
        <MenuButton
          size="sm"
          label={addLabel}
          search={rest.length > 8}
          items={rest.map((option) => ({ id: option.id, label: option.label, onSelect: () => onChange([...chosen, option.id]) }))}
        >
          <Icon name="plus" size={13} /> <span>{addLabel}</span>
        </MenuButton>
      )}
    </div>
  );
}

/**
 * The people a meeting can name: the workspace's members, and not its guests.
 *
 * The same line the server draws — a guest is never sent a meeting, so
 * expecting one at it or making one responsible for a point would put a name
 * on a screen its owner cannot open. Offering them here and having the write
 * path take them back off would be a picker that lies for a round trip.
 */
export function useMeetingPeople(): User[] {
  const { workspaceId } = useSession();
  return useQuery(() => list('member', (member) => member.workspace_id === workspaceId && member.role !== 'guest')
    .map((member) => byId('user', member.user_id))
    .filter((user): user is User => !!user)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')), [workspaceId]);
}

/** Any number of the workspace's members, as chips — who is expected, or who is responsible. */
export function PeoplePicker({
  value, onChange, disabled, addLabel,
}: { value: string[]; onChange: (next: string[]) => void; disabled?: boolean; addLabel: string }) {
  const t = useT();
  const people = useMeetingPeople();
  return (
    <PickChips
      chosen={value}
      options={people.map((user) => ({ id: user.id, label: user.name ?? user.email ?? user.id }))}
      onChange={onChange}
      addLabel={addLabel}
      removeLabel={(name) => t('meeting.removePerson', { name })}
      disabled={disabled}
    />
  );
}

export function ProjectChips({ value, onChange, disabled }: { value: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const t = useT();
  const projects = useTaggableProjects();
  return (
    <PickChips
      chosen={value}
      options={projects.map((project) => ({ id: project.id, label: project.key ? `${project.key} · ${project.name}` : project.name }))}
      onChange={onChange}
      addLabel={t('meeting.addProject')}
      removeLabel={(name) => t('meeting.removeProject', { name })}
      disabled={disabled}
    />
  );
}

/** When, where, who and what for — the same fields on a new meeting and an existing one. */
export function MeetingFields({
  meeting, onChange, disabled,
}: {
  meeting: Partial<Meeting>;
  onChange: (patch: Partial<Meeting>) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <Label label={t('meeting.name')}>
        <Input
          value={meeting.title ?? ''}
          placeholder={t('meeting.namePlaceholder')}
          disabled={disabled}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </Label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label label={t('meeting.when')}>
          <Input
            type="datetime-local"
            value={asLocal(meeting.starts_at)}
            disabled={disabled}
            onChange={(event) => onChange({ starts_at: event.target.value ? new Date(event.target.value).getTime() : null })}
          />
        </Label>
        <Label label={t('meeting.where')}>
          <Input
            value={meeting.location ?? ''}
            placeholder={t('meeting.wherePlaceholder')}
            disabled={disabled}
            onChange={(event) => onChange({ location: event.target.value || null })}
          />
        </Label>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-soft">{t('meeting.attendees')}</span>
        <PeoplePicker
          value={meeting.attendees ?? []}
          onChange={(attendees) => onChange({ attendees })}
          disabled={disabled}
          addLabel={t('meeting.addPerson')}
        />
      </div>
      <Label label={t('meeting.purpose')}>
        <Textarea
          rows={2}
          value={meeting.description ?? ''}
          disabled={disabled}
          onChange={(event) => onChange({ description: event.target.value || null })}
        />
      </Label>
    </div>
  );
}

/** A new meeting: the next full hour, with the person calling it already in it. */
export function MeetingForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const t = useT();
  const me = useMe();
  const [draft, setDraft] = useState<Partial<Meeting>>({
    title: '', description: null, location: null, attendees: me ? [me] : [], starts_at: nextHour(),
  });

  return (
    <Sheet
      title={t('meeting.new')}
      onClose={onClose}
      footer={(
        <Button
          variant="primary"
          disabled={!draft.title?.trim()}
          onClick={() => {
            const id = create('meeting', {
              title: draft.title?.trim() || t('meeting.untitled'),
              description: draft.description ?? null,
              location: draft.location ?? null,
              attendees: draft.attendees ?? [],
              starts_at: draft.starts_at ?? null,
              status: 'planned',
              minutes_page_id: null,
              created_by: me,
            });
            onSaved(id);
          }}
        >
          {t('action.create')}
        </Button>
      )}
    >
      <MeetingFields meeting={draft} onChange={(patch) => setDraft({ ...draft, ...patch })} />
    </Sheet>
  );
}

/* ------------------------------------------------------------ the agenda */

/**
 * A topic at the end of the agenda, with the optional description and the
 * projects it is about.
 *
 * Open to anybody who may write in the workspace — that is the whole of
 * "everybody can bring a topic". Who brought it is not asked: the server files
 * it under whoever sent it.
 */
export function AddTopic({ meetingId, agenda }: { meetingId: string; agenda: AgendaItem[] }) {
  const t = useT();
  const me = useMe();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);

  return (
    <form
      className="agenda-card flex flex-col gap-2 p-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        const text = title.trim();
        if (!text) return;
        create('agendaItem', {
          meeting_id: meetingId,
          title: text,
          description: description.trim() || null,
          projects,
          assignees,
          status: 'open',
          notes: null,
          notes_body: null,
          carried_from: null,
          created_by: me,
          sort_order: nextAgendaKey(agenda),
        });
        setTitle('');
        setDescription('');
        setProjects([]);
        setAssignees([]);
      }}
    >
      <Label label={t('meeting.addTopic')}>
        <Input value={title} placeholder={t('meeting.topicPlaceholder')} onChange={(event) => setTitle(event.target.value)} />
      </Label>
      {title.trim() && (
        <>
          <Textarea
            rows={2}
            aria-label={t('meeting.topicDescription')}
            placeholder={t('meeting.topicDescription')}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <PeoplePicker value={assignees} onChange={setAssignees} addLabel={t('meeting.addAssignee')} />
          <ProjectChips value={projects} onChange={setProjects} />
        </>
      )}
      <div>
        <Button size="sm" type="submit" disabled={!title.trim()}>
          <Icon name="plus" size={13} /> {t('meeting.addTopic')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Who else is writing in this point right now, under its notes.
 *
 * A fixed line, as the chat's is, so a name arriving does not push the notes
 * of every point below it down the screen while somebody is reading them.
 */
function Writing({ itemId }: { itemId: string }) {
  const t = useT();
  const me = useMe();
  const members = useMemberMap();
  const who = useTypists(itemId, me);
  const name = (id: string) => members.get(id)?.name ?? t('common.someone');
  const text = who.length === 0 ? ''
    : who.length === 1 ? t('meeting.writing', { name: name(who[0]) })
    : who.length === 2 ? t('meeting.writingTwo', { first: name(who[0]), second: name(who[1]) })
    : t('meeting.writingMany');
  return <p className="m-0 h-[15px] truncate text-[11.5px] text-muted"><span aria-live="polite">{text}</span></p>;
}

/** The notes of one point, written by everybody in the room at once. */
function Notes({ item, canWrite }: { item: AgendaItem; canWrite: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const { text, setText, fieldRef, flush, merged } = useCollaborativeText(
    item.id, item.notes_body, item.notes ?? '', editing, NOTES,
  );

  /*
   * Leaving the screen mid-sentence has to send the sentence. A blur does that
   * when somebody clicks away, but a keyboard shortcut or the back button can
   * take the field off the page without one, and the last 700ms of typing —
   * the part not yet settled into a state — would go with it.
   */
  const leave = useRef(flush);
  leave.current = flush;
  // Only this point's own "is writing" is this point's to clear: another
  // point disappearing must not silence somebody typing in the next one.
  const typingHere = useRef(false);
  useEffect(() => () => {
    leave.current();
    if (typingHere.current) setTyping(null);
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <Textarea
        ref={fieldRef}
        rows={3}
        aria-label={t('meeting.notes')}
        placeholder={canWrite ? t('meeting.notesPlaceholder') : ''}
        readOnly={!canWrite}
        value={text}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          flush();
          setEditing(false);
          typingHere.current = false;
          setTyping(null);
        }}
        onChange={(event) => {
          setText(event.target.value);
          typingHere.current = true;
          setTyping(item.id);
        }}
      />
      <Writing itemId={item.id} />
      {merged && <span className="text-[12px] text-muted">{t('page.mergedIn')}</span>}
    </div>
  );
}

/** The tasks that came out of one point, and the form that files another. */
function PointTasks({ item, canWrite }: { item: AgendaItem; canWrite: boolean }) {
  const t = useT();
  const me = useMe();
  const toast = useToast();
  const members = useMeetingPeople();
  const projects = useTaggableProjects();
  const tasks = useQuery(() => list('task', (task) => task.agenda_item_id === item.id && !task.deleted_at), [item.id]);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [assignee, setAssignee] = useState('');

  const chosenProject = projectId || item.projects.find((id) => projects.some((project) => project.id === id)) || projects[0]?.id || '';

  return (
    <div className="flex flex-col gap-1.5">
      {tasks.length > 0 && (
        <ul className="flex list-none flex-col gap-1 p-0">
          {tasks.map((task) => <PointTask key={task.id} task={task} />)}
        </ul>
      )}
      {canWrite && !open && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              // Whoever is responsible for the point is the likeliest owner of
              // what comes out of it — a default, changed in one click.
              setAssignee(item.assignees.find((id) => members.some((user) => user.id === id)) ?? '');
              setOpen(true);
            }}
          >
            <Icon name="plus" size={13} /> {t('meeting.newTask')}
          </Button>
        </div>
      )}
      {canWrite && open && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!chosenProject) return;
            createTask({
              project_id: chosenProject,
              title: title.trim() || item.title,
              assignees: assignee ? [assignee] : [],
              agenda_item_id: item.id,
            }, me);
            toast(t('meeting.taskCreated', { title: title.trim() || item.title }));
            setTitle('');
            setAssignee('');
            setOpen(false);
          }}
        >
          <Label label={t('meeting.taskTitle')} className="min-w-[200px] flex-1">
            <Input inputSize="sm" value={title} placeholder={item.title} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </Label>
          <Label label={t('meeting.taskProject')}>
            <Select inputSize="sm" value={chosenProject} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.key ? `${project.key} · ${project.name}` : project.name}</option>)}
            </Select>
          </Label>
          <Label label={t('meeting.taskAssignee')}>
            <Select inputSize="sm" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
              <option value="">{t('meeting.nobody')}</option>
              {members.map((user) => <option key={user.id} value={user.id}>{user.name ?? user.email}</option>)}
            </Select>
          </Label>
          <div className="flex gap-1.5">
            <Button size="sm" type="submit" variant="primary" disabled={!chosenProject}>{t('action.create')}</Button>
            <Button size="sm" onClick={() => setOpen(false)}>{t('action.cancel')}</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function PointTask({ task }: { task: Task }) {
  const state = useRow('state', task.state_id);
  const members = useMemberMap();
  const people = task.assignees.map((id) => members.get(id)).filter(Boolean);
  return (
    <li className="flex items-center gap-2 text-[13px]">
      <StateDot group={state?.group_key} color={state?.color} />
      <Link to={`/t/${task.id}`} className="block min-w-0 truncate leading-6">
        <span className="text-muted">{task.identifier}</span> {task.title}
      </Link>
      {people.length > 0 && <AvatarStack users={people} size={18} max={2} />}
    </li>
  );
}

/**
 * One point on the agenda, and everything that happens to it in the meeting.
 *
 * The title and description are ordinary fields and last-writer-wins, which is
 * right for a sentence one person rewords. The notes are not; see `Notes`.
 */
export function AgendaPoint({
  item, number, previous, next,
}: {
  item: AgendaItem;
  number: number;
  previous?: AgendaItem;
  next?: AgendaItem;
}) {
  const t = useT();
  const canWrite = useCanWrite();
  const members = useMemberMap();
  const { confirm, dialog } = useConfirm();
  const author = item.created_by ? members.get(item.created_by) : undefined;
  const origin = useRow('agendaItem', item.carried_from);
  const originMeeting = useRow('meeting', origin?.meeting_id);
  const heading = `point-${item.id}`;
  const [describing, setDescribing] = useState(false);

  /** Between the neighbour above the one it passes and the one it passes. */
  const move = (direction: -1 | 1) => {
    const agenda = agendaOf(item.meeting_id, list('agendaItem', (row) => row.meeting_id === item.meeting_id));
    const at = agenda.findIndex((row) => row.id === item.id);
    const before = direction === -1 ? agenda[at - 2] : agenda[at + 1];
    const after = direction === -1 ? agenda[at - 1] : agenda[at + 2];
    update('agendaItem', item.id, { sort_order: orderKey(before?.sort_order ?? null, after?.sort_order ?? null) });
  };

  const showDescription = !!item.description || describing;

  return (
    <section id={heading} className="agenda-card flex flex-col gap-2.5 p-3.5" aria-labelledby={`${heading}-title`}>
      {/* Two rows rather than one: the number, the title and the menu, then
          where it got to and who brought it. On one row the status select took
          a third of a phone's width and left the title four words wide. */}
      <div className="flex items-start gap-2.5">
        <span className="agenda-number" aria-hidden>{number}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {canWrite ? (
            <Input
              id={`${heading}-title`}
              inputSize="sm"
              className="agenda-title"
              aria-label={t('meeting.topicTitle', { n: number })}
              value={item.title}
              onChange={(event) => update('agendaItem', item.id, { title: event.target.value })}
            />
          ) : (
            <h3 id={`${heading}-title`} className="m-0 text-[14px] font-semibold">{item.title}</h3>
          )}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <Select
              inputSize="sm"
              className="w-auto"
              aria-label={t('meeting.statusLabel')}
              value={item.status}
              disabled={!canWrite}
              onChange={(event) => update('agendaItem', item.id, { status: event.target.value as AgendaStatus })}
            >
              {AGENDA_STATUS.map((status) => <option key={status} value={status}>{t(statusKey(status))}</option>)}
            </Select>
            <span className="row-sub">
              {author && t('meeting.broughtBy', { name: author.name ?? author.email })}
              {originMeeting && (
                <>
                  {author && ' · '}
                  <Link to={`/meetings/${originMeeting.id}#point-${origin!.id}`}>
                    {t('meeting.continued', { when: meetingWhen(originMeeting) || originMeeting.title })}
                  </Link>
                </>
              )}
            </span>
          </div>
        </div>
        {canWrite && (
          <MenuButton
            size="iconSm"
            label={t('meeting.topicMenu')}
            items={[
              ...(previous ? [{ id: 'up', label: t('meeting.moveUp'), onSelect: () => move(-1) }] : []),
              ...(next ? [{ id: 'down', label: t('meeting.moveDown'), onSelect: () => move(1) }] : []),
              {
                id: 'delete',
                label: t('meeting.deleteTopic'),
                danger: true,
                onSelect: async () => {
                  if (await confirm(t('meeting.deleteTopicConfirm', { title: item.title }))) remove('agendaItem', item.id);
                },
              },
            ]}
          >
            <Icon name="dots" size={15} />
          </MenuButton>
        )}
      </div>

      {/* Who is responsible, then what it is about. Each row carries an icon
          rather than a caption, which would be a fourth label on a card that
          already has three; the caption is still there for a screen reader. */}
      {(canWrite || item.assignees.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted" title={t('meeting.assignees')}>
            <Icon name="users" size={14} />
            <span className="sr-only">{t('meeting.assignees')}</span>
          </span>
          <PeoplePicker
            value={item.assignees}
            disabled={!canWrite}
            addLabel={t('meeting.addAssignee')}
            onChange={(assignees) => update('agendaItem', item.id, { assignees })}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted" title={t('meeting.projects')}>
          <Icon name="folder" size={14} />
          <span className="sr-only">{t('meeting.projects')}</span>
        </span>
        <ProjectChips
          value={item.projects}
          disabled={!canWrite}
          onChange={(projects) => update('agendaItem', item.id, { projects })}
        />
        {/* An empty description field on every point is a form, not an
            agenda. It is a click away instead, and stays once it has words. */}
        {canWrite && !showDescription && (
          <Button size="sm" variant="ghost" onClick={() => setDescribing(true)}>
            <Icon name="plus" size={13} /> {t('meeting.addDescription')}
          </Button>
        )}
      </div>

      {showDescription && (
        <Textarea
          rows={1}
          className="min-h-9"
          aria-label={t('meeting.topicDescription')}
          placeholder={t('meeting.topicDescription')}
          readOnly={!canWrite}
          autoFocus={describing && !item.description}
          value={item.description ?? ''}
          onBlur={() => setDescribing(false)}
          onChange={(event) => update('agendaItem', item.id, { description: event.target.value || null })}
        />
      )}

      <div className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium text-soft">{t('meeting.notes')}</span>
        <Notes item={item} canWrite={canWrite} />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium text-soft">{t('meeting.tasks')}</span>
        <PointTasks item={item} canWrite={canWrite} />
      </div>
      {dialog}
    </section>
  );
}

/* --------------------------------------------------------------- minutes */

/** The words the minutes are written in, in the reader's language. */
export function useMinutesWords(meeting: Meeting | undefined): MinutesWords {
  const t = useT();
  return useMemo(() => ({
    when: meeting?.starts_at ? exactTime(meeting.starts_at) : '',
    attendees: t('meeting.attendees'),
    projects: t('meeting.projects'),
    assignees: t('meeting.assignees'),
    broughtBy: t('meeting.minutesBroughtBy'),
    notes: t('meeting.notes'),
    tasks: t('meeting.tasks'),
    continued: t('meeting.minutesContinued'),
    empty: t('meeting.minutesEmpty'),
    status: { open: t('meeting.status.open'), discussed: t('meeting.status.discussed'), deferred: t('meeting.status.deferred') },
  }), [meeting?.starts_at, t]);
}

/* ------------------------------------------------------- on a task's page */

/**
 * Which meeting a task came out of.
 *
 * Nothing at all for a task that did not, and nothing when meetings are
 * switched off or this device was never sent the meeting — a guest, say. A
 * link to a meeting somebody cannot open is a dead end dressed as a link.
 */
export function TaskAgendaOrigin({ agendaItemId }: { agendaItemId: string | null | undefined }) {
  const t = useT();
  const enabled = useFeature('meetings');
  const item = useRow('agendaItem', agendaItemId);
  const meeting = useRow('meeting', item?.meeting_id);
  if (!enabled || !item || item.deleted_at || !meeting || meeting.deleted_at) return null;
  return (
    <p className="mb-[18px] flex items-center gap-1.5 text-[12.5px] text-muted">
      <Icon name="agenda" size={13} />
      <span>{t('meeting.fromMeeting')}</span>
      <Link to={`/meetings/${meeting.id}#point-${item.id}`} className="min-w-0 truncate">
        {meeting.title}{meetingWhen(meeting) && ` · ${meetingWhen(meeting)}`} — {item.title}
      </Link>
    </p>
  );
}
