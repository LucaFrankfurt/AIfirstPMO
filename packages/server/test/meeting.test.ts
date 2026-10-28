/**
 * The rules a meeting screen and an assistant have to agree on, without a
 * server: the order an agenda is read in, what carrying the unfinished points
 * forward writes, and what the minutes say.
 *
 * Carrying over is the part worth the length. Its promise is that pressing the
 * button twice — or on two devices — writes the same rows, and that is a
 * property of the ids it derives, so it is tested on the ids.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agendaTally, byAgendaOrder, carriedItemId, carryOver, followUp, isOverdue, meetingsInOrder,
  minutesMarkdown, nextAgendaKey, nextMeeting, orderKey, originOf,
  type AgendaItem, type Meeting, type MinutesWords,
} from '@kolibri/shared';

const HOUR = 3_600_000;

function meeting(id: string, over: Partial<Meeting> = {}): Meeting {
  return {
    id, workspace_id: 'w', title: 'Weekly', description: null, starts_at: null, location: null,
    attendees: [], status: 'planned', minutes_page_id: null, created_by: 'ada',
    created_at: 1, updated_at: 1, deleted_at: null, seq: 1,
    ...over,
  } as Meeting;
}

function item(id: string, over: Partial<AgendaItem> = {}): AgendaItem {
  return {
    id, workspace_id: 'w', meeting_id: 'm1', title: id, description: null, projects: [], assignees: [],
    status: 'open', notes: null, notes_body: null, created_by: 'ada', carried_from: null,
    sort_order: 'V', created_at: 1, updated_at: 1, deleted_at: null, seq: 1,
    ...over,
  } as AgendaItem;
}

describe('the order of an agenda', () => {
  it('compares keys byte for byte, so a lowercase key after `V` stays after it', () => {
    const first = orderKey(null, null);
    const second = orderKey(first, null);
    const sorted = [item('b', { sort_order: second }), item('a', { sort_order: first })].sort(byAgendaOrder);
    assert.deepEqual(sorted.map((one) => one.id), ['a', 'b']);
  });

  it('appends after the highest key, whatever order it is handed the rows in', () => {
    const first = orderKey(null, null);
    const second = orderKey(first, null);
    const next = nextAgendaKey([item('b', { sort_order: second }), item('a', { sort_order: first })]);
    assert.ok(next > second);
  });

  it('counts each state, and only the live points', () => {
    const tally = agendaTally([
      item('a'), item('b', { status: 'discussed' }), item('c', { status: 'deferred' }), item('d', { deleted_at: 5 }),
    ]);
    assert.deepEqual(tally, { open: 1, discussed: 1, deferred: 1, total: 3 });
  });
});

describe('which meetings are still ahead', () => {
  it('keeps a meeting nobody closed on the open side, after the dated ones if it has no time', () => {
    const { open, done } = meetingsInOrder([
      meeting('undated'),
      meeting('later', { starts_at: 3 * HOUR }),
      meeting('sooner', { starts_at: 2 * HOUR }),
      meeting('closed', { starts_at: HOUR, status: 'done' }),
      meeting('gone', { starts_at: HOUR, deleted_at: 9 }),
    ]);
    assert.deepEqual(open.map((one) => one.id), ['sooner', 'later', 'undated']);
    assert.deepEqual(done.map((one) => one.id), ['closed']);
  });

  it('calls a meeting unclosed only once its day is over', () => {
    const now = 100 * HOUR;
    assert.equal(isOverdue(meeting('m', { starts_at: now - HOUR }), now), false, 'people may still be sitting in it');
    assert.equal(isOverdue(meeting('m', { starts_at: now - 13 * HOUR }), now), true);
    assert.equal(isOverdue(meeting('m', { starts_at: now - 13 * HOUR, status: 'done' }), now), false);
  });

  it('finds the next planned meeting after this one, and never an undated one', () => {
    const current = meeting('now', { starts_at: 10 * HOUR });
    const found = nextMeeting([
      current,
      meeting('undated'),
      meeting('earlier', { starts_at: 5 * HOUR }),
      meeting('far', { starts_at: 50 * HOUR }),
      meeting('near', { starts_at: 20 * HOUR }),
      meeting('closed', { starts_at: 15 * HOUR, status: 'done' }),
    ], current);
    assert.equal(found?.id, 'near');
  });

  it('calls a follow-up a week later, with the same people and none of the minutes', () => {
    const next = followUp(meeting('m', { starts_at: 10 * HOUR, attendees: ['ada'], location: 'Room 2', minutes_page_id: 'p' }));
    assert.equal(next.starts_at, 10 * HOUR + 7 * 24 * HOUR);
    assert.deepEqual(next.attendees, ['ada']);
    assert.equal(next.location, 'Room 2');
    assert.equal(next.minutes_page_id, null);
    assert.equal(next.status, 'planned');
  });
});

describe('carrying the unfinished points forward', () => {
  const agenda = [
    item('a', { sort_order: orderKey(null, null), status: 'open', projects: ['p1'], assignees: ['lin'], notes: 'said in m1' }),
    item('b', { sort_order: orderKey(orderKey(null, null), null), status: 'discussed' }),
    item('c', { sort_order: orderKey(orderKey(orderKey(null, null), null), null), status: 'deferred' }),
  ];

  it('carries what was not discussed, open, and defers what was still open', () => {
    const plan = carryOver(agenda, 'm2', []);
    assert.deepEqual(plan.create.map((point) => point.id), ['m2.a', 'm2.c']);
    assert.deepEqual(plan.defer, ['a']);
    const first = plan.create[0].patch;
    assert.equal(first.meeting_id, 'm2');
    assert.equal(first.status, 'open');
    assert.equal(first.carried_from, 'a');
    assert.deepEqual(first.projects, ['p1']);
    assert.deepEqual(first.assignees, ['lin'], 'a topic deferred is not a topic handed back');
    assert.equal('notes' in first, false, 'the notes belong to the meeting that had them');
    assert.ok(plan.create[0].patch.sort_order < plan.create[1].patch.sort_order, 'and in the order they had');
  });

  it('writes nothing new the second time, so two devices pressing it agree', () => {
    const first = carryOver(agenda, 'm2', []);
    const landed = first.create.map((point) => item(point.id, { ...point.patch }));
    assert.deepEqual(carryOver(agenda, 'm2', landed).create, []);
  });

  it('lands after what the next meeting already has on its agenda', () => {
    const there = item('x', { meeting_id: 'm2', sort_order: orderKey(orderKey(null, null), null) });
    const plan = carryOver(agenda, 'm2', [there]);
    assert.ok(plan.create.every((point) => point.patch.sort_order > there.sort_order));
  });

  it('names a topic by where it was first raised, so its id does not grow each week', () => {
    assert.equal(carriedItemId('m2', 'a'), 'm2.a');
    assert.equal(carriedItemId('m3', 'm2.a'), 'm3.a');
    assert.equal(originOf('m3.a'), 'a');
    assert.equal(originOf('a'), 'a');
  });
});

describe('the minutes', () => {
  const words: MinutesWords = {
    when: 'Tuesday, 3 November 2026 at 10:00',
    attendees: 'Attendees', projects: 'Projects', assignees: 'Responsible', broughtBy: 'Brought by', notes: 'Notes', tasks: 'Tasks',
    continued: 'continued from an earlier meeting', empty: 'Nothing was on the agenda.',
    status: { open: 'Open', discussed: 'Discussed', deferred: 'Deferred' },
  };
  const people = new Map([['ada', 'Ada'], ['lin', 'Lin']]);
  const projects = new Map([['p1', 'WEB']]);

  it('writes each point with its state, projects, author, notes and tasks', () => {
    const text = minutesMarkdown({
      meeting: meeting('m', { attendees: ['ada', 'lin', 'nobody'], location: 'Room 2' }),
      items: [
        item('b', { title: 'Pricing page', sort_order: orderKey(orderKey(null, null), null), status: 'deferred', carried_from: 'z' }),
        item('a', { title: 'Release', sort_order: orderKey(null, null), status: 'discussed', projects: ['p1'], assignees: ['lin', 'nobody'], notes: 'Ship on Friday.' }),
      ],
      tasks: [{ agenda_item_id: 'a', identifier: 'WEB-7', title: 'Tag the release', state: 'Todo', assignees: ['Lin'] }],
      people, projects, words,
    });
    assert.match(text, /\*\*Tuesday, 3 November 2026 at 10:00\*\* · Room 2\n/);
    assert.match(text, /\*\*Attendees:\*\* Ada, Lin\n/, 'an id nobody can name is left out, not printed');
    assert.ok(text.indexOf('## 1. Release') < text.indexOf('## 2. Pricing page'), 'in agenda order');
    assert.match(text, /_Discussed_ · Projects: WEB · Responsible: Lin · Brought by: Ada/);
    assert.match(text, /### Notes\n\nShip on Friday\./);
    assert.match(text, /- WEB-7 Tag the release — Todo \(Lin\)/);
    assert.match(text, /_Deferred_ · Brought by: Ada · continued from an earlier meeting/);
    assert.doesNotMatch(text, /\[ \]/, 'a task is not a checkbox somebody can tick on the page');
  });

  it('keeps a link in the place out of the bold, so it cannot take the closing marks', () => {
    const text = minutesMarkdown({
      meeting: meeting('m', { location: 'https://meet.example.com/weekly' }), items: [], tasks: [], people, projects, words,
    });
    assert.match(text, /^\*\*Tuesday, 3 November 2026 at 10:00\*\* · https:\/\/meet\.example\.com\/weekly\n/);
  });

  it('says so when nothing was on the agenda', () => {
    assert.match(minutesMarkdown({ meeting: meeting('m'), items: [], tasks: [], people, projects, words }), /_Nothing was on the agenda\._/);
  });
});
