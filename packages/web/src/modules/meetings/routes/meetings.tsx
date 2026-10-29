/**
 * The meeting screens: what is coming up, and one meeting with its agenda.
 *
 * The index leads with what is still ahead, soonest first, and keeps the
 * closed ones underneath rather than in an archive — the minutes of a meeting
 * are the half of it still worth something a month later, and "what did we
 * agree in the October weekly" is asked of exactly this list.
 *
 * The detail is the agenda, read top to bottom the way the meeting runs it.
 * Everything a meeting produces is reached from here: the notes in each point,
 * the decisions put to a vote at it and the tasks filed from it — gathered
 * again under the agenda as its outcomes — the unfinished points carried
 * forward, and the minutes filed as a page. The last two go through `@kolibri/shared`, so the
 * rows they write are the rows an assistant asked to do the same thing writes.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  byBallotOrder, carryOver, followUp, isOpen, meetingsInOrder, minutesMarkdown, nextMeeting, tallyOf, type Meeting,
} from '@kolibri/shared';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import { AvatarStack, Empty, Icon, Sheet, useConfirm, useToast } from '../../../kernel/design-system/ui';
import { Button } from '../../../kernel/design-system/ui/button';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { useT } from '../../../kernel/i18n/i18n';
import { create, createPage, remove, update } from '../../../kernel/sync/mutations';
import { byId, list, useQuery, useRow } from '../../../kernel/sync/store';
import { useCanWrite, useFeature, useMe, useMemberMap, usePeople } from '../../../kernel/identity/session';
import {
  AddTopic, AgendaPoint, MeetingCard, MeetingFields, MeetingForm, MeetingOutcomes, MeetingState, meetingWhen, useAgenda,
  useMinutesWords,
} from '../meeting-parts';

function SwitchedOff() {
  const t = useT();
  return <Empty emoji="🔕" title={t('meeting.offTitle')} hint={t('meeting.offHint')} />;
}

const trail = (label: string) => [{ to: '/meetings', label, icon: <Icon name="agenda" size={13} /> }];

/* ------------------------------------------------------------------ index */

export function MeetingIndex() {
  const t = useT();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const enabled = useFeature('meetings');
  const [creating, setCreating] = useState(false);
  const meetings = useQuery(() => list('meeting'), []);
  const { open, done } = useMemo(() => meetingsInOrder(meetings), [meetings]);

  if (!enabled) return <><Header title={t('meeting.title')} /><SwitchedOff /></>;

  return (
    <>
      <Header title={t('meeting.title')}>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('meeting.new')}</span>
          </Button>
        )}
      </Header>

      {!open.length && !done.length ? (
        <Empty emoji="🗓️" title={t('meeting.emptyTitle')} hint={t('meeting.emptyHint')} />
      ) : (
        <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
          {open.length > 0 && <SectionHeading tight>{t('meeting.upcoming')}</SectionHeading>}
          {open.map((meeting) => <MeetingCard key={meeting.id} meeting={meeting} />)}
          {done.length > 0 && <SectionHeading tight={!open.length}>{t('meeting.closedList')}</SectionHeading>}
          {done.map((meeting) => <MeetingCard key={meeting.id} meeting={meeting} />)}
        </div>
      )}

      {creating && <MeetingForm onClose={() => setCreating(false)} onSaved={(id) => navigate(`/meetings/${id}`)} />}
    </>
  );
}

/* ----------------------------------------------------------------- detail */

/**
 * Where the unfinished points would go, said before anything is written.
 *
 * The next planned meeting after this one if there is one; otherwise a
 * follow-up a week later, which this creates. Either way the sheet names the
 * meeting and the number of points first, because carrying topics into the
 * wrong week is the mistake this button makes possible.
 */
function CarrySheet({ meeting, onClose }: { meeting: Meeting; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const meetings = useQuery(() => list('meeting'), []);
  const agenda = useAgenda(meeting.id);
  const target = useMemo(() => nextMeeting(meetings, meeting), [meetings, meeting]);
  const targetAgenda = useAgenda(target?.id ?? '');
  const draft = useMemo(() => followUp(meeting), [meeting]);
  const plan = useMemo(() => carryOver(agenda, target?.id ?? 'next', targetAgenda), [agenda, target?.id, targetAgenda]);
  const count = plan.create.length;

  const carry = () => {
    const into = target?.id ?? create('meeting', { ...draft });
    const already = list('agendaItem', (row) => row.meeting_id === into);
    const { create: points, defer } = carryOver(agenda, into, already);
    for (const point of points) {
      // Brought by whoever brought it the first time — the server copies the
      // same from the point it continues, and this is what the screen shows
      // until that comes back.
      const source = agenda.find((item) => item.id === point.patch.carried_from);
      create('agendaItem', { ...point.patch, notes: null, notes_body: null, created_by: source?.created_by ?? null }, point.id);
    }
    for (const id of defer) update('agendaItem', id, { status: 'deferred' });
    toast(t('meeting.carried', { count: points.length }));
    onClose();
    navigate(`/meetings/${into}`);
  };

  return (
    <Sheet
      title={t('meeting.carryTitle')}
      onClose={onClose}
      footer={count > 0 ? (
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" onClick={carry}>{t('meeting.carryGo')}</Button>
        </>
      ) : undefined}
    >
      <p className="m-0 text-[13.5px]">
        {count === 0 ? t('meeting.carryNone')
          : target ? t('meeting.carryInto', { count, meeting: target.title, when: meetingWhen(target) || t('meeting.noTime') })
          : t('meeting.carryNew', { count, when: meetingWhen(draft) })}
      </p>
    </Sheet>
  );
}

export function MeetingDetail() {
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const enabled = useFeature('meetings');
  const decisionsOn = useFeature('decisions');
  const me = useMe();
  const toast = useToast();
  const members = useMemberMap();
  const people = usePeople();
  const meeting = useRow('meeting', id);
  const agenda = useAgenda(id);
  const minutesPage = useRow('page', meeting?.minutes_page_id);
  const words = useMinutesWords(meeting);
  const { confirm, dialog } = useConfirm();
  const [carrying, setCarrying] = useState(false);

  // A link to one point — from a task, or from the point it continues — lands
  // on that point once the agenda has rendered.
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, agenda.length]);

  if (!enabled) return <><Header title={t('meeting.title')} /><SwitchedOff /></>;
  if (!meeting || meeting.deleted_at) {
    return (
      <>
        <Header title={t('meeting.title')} />
        <div className="px-3 pt-4 sm:px-6 sm:pt-5"><Trail parts={trail(t('meeting.title'))} /></div>
        <Empty
          emoji="🗓️" title={t('meeting.gone')}
          action={<Button onClick={() => navigate('/meetings')}>{t('nav.backToList')}</Button>}
        />
      </>
    );
  }

  const filed = minutesPage && !minutesPage.deleted_at ? minutesPage : null;
  const attendees = meeting.attendees.map((userId) => members.get(userId)).filter(Boolean);

  /**
   * Write the meeting up as a page, or rewrite the page it was written up as.
   *
   * A rewrite asks first, though nothing is lost — the page keeps its previous
   * version like any other — because somebody may have tidied the minutes by
   * hand, and the button would put back every word they took out.
   */
  const fileMinutes = async () => {
    if (filed && !(await confirm(t('meeting.minutesConfirm'), t('meeting.minutesRewrite')))) return;
    const ids = new Set(agenda.map((item) => item.id));
    /*
     * Only what everybody who can read the page could see anyway. The minutes
     * are a workspace page, and this device holds the private projects its
     * owner is in — filing them would publish a private task's title, or a
     * private project's name, to the whole wiki. A public project is the one
     * every person in the workspace can open. MCP draws the same line.
     */
    const everybody = (projectId: string) => byId('project', projectId)?.visibility === 'public';
    const tasks = list('task', (task) => !!task.agenda_item_id && ids.has(task.agenda_item_id) && !task.deleted_at && everybody(task.project_id))
      .sort((a, b) => a.created_at - b.created_at);
    const nameOf = (userId: string) => people.get(userId)?.name ?? people.get(userId)?.email;
    // A decision for the whole workspace is everybody's by definition; one
    // taken in a project is published only where the project is public.
    const decisions = decisionsOn
      ? list('decision', (row) => !!row.agenda_item_id && ids.has(row.agenda_item_id) && (!row.project_id || everybody(row.project_id)))
        .sort((a, b) => a.created_at - b.created_at)
      : [];
    const content = minutesMarkdown({
      meeting,
      items: agenda,
      tasks: tasks.map((task) => ({
        agenda_item_id: task.agenda_item_id,
        identifier: task.identifier,
        title: task.title,
        state: byId('state', task.state_id)?.name ?? '',
        assignees: task.assignees.map(nameOf).filter((name): name is string => !!name),
      })),
      decisions: decisions.map((decision) => {
        const options = list('decisionOption', (row) => row.decision_id === decision.id).sort(byBallotOrder);
        const votes = list('decisionVote', (row) => row.decision_id === decision.id);
        return {
          agenda_item_id: decision.agenda_item_id,
          question: decision.question,
          open: isOpen(decision),
          leading: tallyOf(decision, options, votes).leading.map((row) => row.option.label),
        };
      }),
      people: new Map([...people.keys()].map((userId) => [userId, nameOf(userId) ?? ''])),
      projects: new Map(list('project', (project) => everybody(project.id)).map((project) => [project.id, project.key || project.name])),
      words,
    });
    if (filed) {
      update('page', filed.id, { content });
    } else {
      const pageId = createPage({ title: t('meeting.minutesTitle', { title: meeting.title }), content, icon: '📝' }, me);
      update('meeting', meeting.id, { minutes_page_id: pageId });
    }
    toast(t('meeting.minutesFiled'));
  };

  return (
    <>
      <Header title={meeting.title || t('meeting.untitled')}>
        {canWrite && (
          <Button size="sm" onClick={() => update('meeting', meeting.id, { status: meeting.status === 'done' ? 'planned' : 'done' })}>
            {meeting.status === 'done' ? t('meeting.reopen') : t('meeting.close')}
          </Button>
        )}
      </Header>

      <div className="mx-auto flex max-w-[860px] flex-col gap-3 px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <Trail parts={trail(t('meeting.title'))} />

        <div className="flex flex-wrap items-center gap-2">
          <MeetingState meeting={meeting} />
          <span className="text-[13px] text-soft">
            {meetingWhen(meeting) || t('meeting.noTime')}
            {meeting.location && ` · ${meeting.location}`}
          </span>
          {attendees.length > 0 && <AvatarStack users={attendees} max={6} />}
        </div>
        {meeting.description && <p className="m-0 text-[13px]">{meeting.description}</p>}

        <div className="flex flex-wrap items-center gap-2">
          {canWrite && (
            <Button size="sm" onClick={() => setCarrying(true)}>
              <Icon name="refresh" size={13} /> {t('meeting.carry')}
            </Button>
          )}
          {canWrite && (
            <Button size="sm" onClick={() => void fileMinutes()}>
              <Icon name="page" size={13} /> {filed ? t('meeting.minutesAgain') : t('meeting.minutes')}
            </Button>
          )}
          {filed && <Link to={`/pages/${filed.id}`} className="inline-flex min-h-8 items-center text-[13px]">{t('meeting.minutesOpen')}</Link>}
        </div>

        <SectionHeading>{t('meeting.agenda')}</SectionHeading>
        {!agenda.length && <p className="m-0 text-[13px] text-muted">{t('meeting.agendaEmpty')}</p>}
        <ol className="flex list-none flex-col gap-3 p-0">
          {agenda.map((item, index) => (
            <li key={item.id}>
              <AgendaPoint item={item} number={index + 1} previous={agenda[index - 1]} next={agenda[index + 1]} />
            </li>
          ))}
        </ol>
        {canWrite && <AddTopic meetingId={meeting.id} agenda={agenda} />}

        <MeetingOutcomes agenda={agenda} words={words} />

        {canWrite && (
          <>
            <SectionHeading>{t('meeting.details')}</SectionHeading>
            <MeetingFields meeting={meeting} onChange={(patch) => update('meeting', meeting.id, patch)} />
            <div>
              <Button
                variant="danger"
                size="sm"
                onClick={async () => {
                  if (await confirm(t('meeting.deleteConfirm'))) {
                    remove('meeting', meeting.id);
                    navigate('/meetings');
                  }
                }}
              >
                {t('action.delete')}
              </Button>
            </div>
          </>
        )}
      </div>
      {carrying && <CarrySheet meeting={meeting} onClose={() => setCarrying(false)} />}
      {dialog}
    </>
  );
}
