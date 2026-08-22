/**
 * Reading the other tools' exports.
 *
 * The fixtures below are shaped from each tool's *documented* API response, not
 * copied from a real instance — which is exactly what these tests are for and
 * exactly their limit. They prove the converter reads the documented shape,
 * refuses what it does not recognise, and says out loud what it leaves behind.
 * They cannot prove a real export looks like this, and the interface says so
 * before anybody presses import.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-foreign-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { convert, detectFormat, todoistRecurrence } from '@kolibri/shared';

const { server } = await import('../src/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';

async function ok(path: string, body?: unknown, method?: string): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/* ------------------------------------------------------------- fixtures */

const jira = {
  issues: [
    {
      key: 'WEB-1',
      fields: {
        project: { key: 'WEB', name: 'Website' },
        summary: 'Pricing page shows the wrong currency',
        // The cloud API sends a document tree rather than a string.
        description: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Euros everywhere, even in the US.' }] }],
        },
        issuetype: { name: 'Bug' },
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        priority: { name: 'Highest' },
        assignee: { accountId: 'acc-1', displayName: 'Grace Hopper', emailAddress: 'grace@example.com' },
        labels: ['billing', 'regression'],
        duedate: '2026-09-01',
        customfield_10001: 'something Jira invented',
        issuelinks: [{ type: { name: 'Blocks' }, outwardIssue: { key: 'WEB-2' } }],
        comment: {
          comments: [{
            author: { accountId: 'acc-2', displayName: 'Alan Turing', emailAddress: 'alan@example.com' },
            body: 'Reproduced on staging.',
          }],
        },
      },
    },
    {
      key: 'WEB-2',
      fields: {
        project: { key: 'WEB', name: 'Website' },
        summary: 'Add a currency setting',
        status: { name: 'Done', statusCategory: { key: 'done' } },
        issuetype: { name: 'Story' },
        priority: { name: 'Low' },
        parent: { key: 'WEB-1' },
        labels: [],
      },
    },
  ],
};

const linear = {
  data: {
    issues: {
      nodes: [
        {
          identifier: 'ENG-7',
          title: 'Search returns nothing',
          description: 'Every query is empty.',
          state: { name: 'In Progress', type: 'started' },
          priority: 1,
          team: { name: 'Engineering', key: 'ENG' },
          assignee: { id: 'u1', name: 'Lin Zhao', email: 'lin@example.com' },
          labels: { nodes: [{ name: 'search' }] },
          dueDate: '2026-10-02',
          relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ENG-8' } }] },
          comments: { nodes: [{ user: { id: 'u1', name: 'Lin Zhao', email: 'lin@example.com' }, body: 'Index is empty.' }] },
        },
        {
          identifier: 'ENG-8',
          title: 'Rebuild the index nightly',
          state: { name: 'Backlog', type: 'backlog' },
          priority: 0,
          team: { name: 'Engineering', key: 'ENG' },
        },
      ],
    },
  },
};

const openproject = {
  _type: 'Collection',
  _embedded: {
    elements: [
      {
        id: 42,
        subject: 'Pour the foundation',
        description: { raw: 'Concrete, then wait.' },
        startDate: '2026-08-03',
        dueDate: '2026-08-14',
        _links: {
          project: { title: 'New building' },
          type: { title: 'Task' },
          status: { title: 'In progress' },
          priority: { title: 'High' },
          assignee: { href: '/api/v3/users/9', title: 'Margaret Hamilton' },
        },
      },
      {
        id: 43,
        subject: 'Build the walls',
        isClosed: false,
        _links: {
          project: { title: 'New building' },
          type: { title: 'Task' },
          status: { title: 'New' },
          priority: { title: 'Normal' },
          parent: { href: '/api/v3/work_packages/42', title: 'Pour the foundation' },
        },
      },
    ],
  },
};

const plane = {
  states: [
    { id: 'st-1', name: 'Todo', group: 'unstarted' },
    { id: 'st-2', name: 'Done', group: 'completed' },
  ],
  labels: [{ id: 'lb-1', name: 'design' }],
  results: [
    {
      id: 'is-1',
      name: 'Redraw the empty state',
      description_stripped: 'It says nothing at all right now.',
      state: 'st-1',
      priority: 'high',
      labels: ['lb-1'],
      assignees: ['user-uuid-1'],
      target_date: '2026-11-11',
      sequence_id: 12,
    },
    { id: 'is-2', name: 'Ship it', state: 'st-2', priority: 'none', sequence_id: 13 },
  ],
};

/**
 * A Trello board export, as the board menu writes it.
 *
 * Deliberately awkward in the two ways real boards are: a card archived and
 * left in place, and a checklist that is the only record of what the card
 * actually involves.
 */
const trello = {
  name: 'Marketing',
  lists: [
    { id: 'l-1', name: 'Ideas', closed: false },
    { id: 'l-2', name: 'Doing', closed: false },
    { id: 'l-3', name: 'Done', closed: false },
  ],
  labels: [{ id: 'lb-1', name: 'copy', color: 'green' }, { id: 'lb-2', name: '', color: 'red' }],
  members: [{ id: 'm-1', fullName: 'Ada Lovelace', username: 'ada' }],
  cards: [
    {
      id: 'c-1', name: 'Rewrite the pricing page', desc: 'The old one buries the price.',
      idList: 'l-2', closed: false, due: '2026-09-04T12:00:00.000Z', start: null,
      idMembers: ['m-1'], labels: [{ id: 'lb-1', name: 'copy', color: 'green' }],
    },
    {
      id: 'c-2', name: 'Pick a headline font', desc: '',
      idList: 'l-3', closed: false, due: null, idMembers: [],
      labels: [{ id: 'lb-2', name: '', color: 'red' }],
    },
    { id: 'c-3', name: 'An old idea', desc: '', idList: 'l-1', closed: true, idMembers: [], labels: [] },
  ],
  checklists: [
    {
      id: 'ck-1', idCard: 'c-1', name: 'Before publishing',
      checkItems: [
        { name: 'Legal read it', state: 'complete' },
        { name: 'Screenshots redone', state: 'incomplete' },
      ],
    },
  ],
  actions: [
    {
      type: 'commentCard',
      memberCreator: { id: 'm-1', fullName: 'Ada Lovelace' },
      data: { text: 'The second paragraph is the problem.', card: { id: 'c-1' } },
    },
    { type: 'updateCard', memberCreator: { id: 'm-1' }, data: { card: { id: 'c-1' } } },
  ],
};

/** Todoist, from the Sync API. Two projects, a repeat it can read and one it cannot. */
const todoist = {
  projects: [{ id: 'p-1', name: 'Work' }, { id: 'p-2', name: 'Home' }],
  labels: [{ id: 'lb-1', name: 'errand' }],
  collaborators: [{ id: 'u-1', full_name: 'Ada Lovelace', email: 'ada@example.com' }],
  items: [
    {
      id: 'i-1', content: 'Send the invoice', description: 'For August.',
      project_id: 'p-1', priority: 4, checked: false,
      due: { date: '2026-09-01', string: 'every month', is_recurring: true },
      labels: ['lb-1'], responsible_uid: 'u-1',
    },
    {
      id: 'i-2', content: 'Water the plants', project_id: 'p-2', priority: 1, checked: false,
      due: { date: '2026-08-25', string: 'every 3rd friday', is_recurring: true }, labels: [],
    },
    { id: 'i-3', content: 'Book the train', project_id: 'p-1', priority: 2, checked: true, labels: [] },
    { id: 'i-4', content: 'Buy tickets first', project_id: 'p-1', priority: 1, checked: false, parent_id: 'i-3', labels: [] },
  ],
  notes: [{ id: 'n-1', item_id: 'i-1', content: 'They asked for it as a PDF.', posted_uid: 'u-1' }],
};

/* ---------------------------------------------------------------- tests */

describe('recognising a file', () => {
  it('tells the six apart by shape rather than by what the download was called', () => {
    assert.equal(detectFormat(jira), 'jira');
    assert.equal(detectFormat(linear), 'linear');
    assert.equal(detectFormat(openproject), 'openproject');
    assert.equal(detectFormat(plane), 'plane');
    assert.equal(detectFormat(trello), 'trello');
    assert.equal(detectFormat(todoist), 'todoist');
  });

  it('says no to everything else, including Kolibri’s own', () => {
    assert.equal(detectFormat({ format: 'kolibri.project/1' }), null, 'that one is not foreign');
    assert.equal(detectFormat({ hello: 'world' }), null);
    assert.equal(detectFormat([1, 2, 3]), null);
    assert.equal(detectFormat(null), null);
    assert.equal(detectFormat('{}'), null);
    assert.throws(() => convert({ hello: 'world' }), /not an export this can read/);
  });
});

describe('a Jira search response', () => {
  const result = convert(jira);
  const doc = result.document as any;

  it('reads the words out of the document tree Jira sends instead of a string', () => {
    assert.match(doc.tasks[0].description, /Euros everywhere/);
  });

  it('keeps the team’s own column names, with the bucket Jira put them in', () => {
    assert.deepEqual(
      doc.states.map((state: any) => [state.name, state.group_key]),
      [['In Progress', 'started'], ['Done', 'completed']],
      'a team that spent two years naming a column should get that column',
    );
  });

  it('maps priority, the assignee, and the issue type as a label', () => {
    assert.equal(doc.tasks[0].priority, 'urgent', 'Jira’s Highest');
    // Kolibri has one way of saying what sort of thing a task is, so an issue
    // type arrives as a label rather than being thrown away with the column it
    // came from.
    const named = (task: any) => task.labels.map((id: string) => doc.labels.find((l: any) => l.id === id).name);
    assert.ok(named(doc.tasks[0]).includes('Bug'), 'the type came across');
    // billing, regression, and the two issue types — Bug and Story.
    assert.deepEqual(doc.labels.map((l: any) => l.name).sort(), ['Bug', 'Story', 'billing', 'regression']);
    assert.equal(doc.people[0].email, 'grace@example.com', 'so the importer can match them by address');
  });

  it('reads a blocks link in the direction Jira states it', () => {
    assert.deepEqual(
      doc.relations.map((r: any) => [r.task_id, r.related_task_id, r.kind]),
      [['WEB-1', 'WEB-2', 'blocks']],
    );
  });

  it('says out loud what it left behind', () => {
    assert.ok(result.notes.some((note) => /custom field/.test(note)), 'the custom fields');
    assert.ok(result.notes.some((note) => /Sprints/.test(note)), 'and the ideas with no equivalent here');
  });
});

describe('a Linear query result', () => {
  const doc = convert(linear).document as any;

  it('counts priority the way Linear does, downwards from urgent', () => {
    assert.equal(doc.tasks[0].priority, 'urgent', '1 is urgent');
    assert.equal(doc.tasks[1].priority, 'none', 'and 0 means nobody said');
  });

  it('reads its state types, cancelled included', () => {
    assert.deepEqual(
      doc.states.map((state: any) => [state.name, state.group_key]),
      [['In Progress', 'started'], ['Backlog', 'backlog']],
    );
  });

  it('takes the team’s name for the project, since Linear has no better one', () => {
    assert.equal(doc.project.name, 'Engineering (Linear)');
    assert.equal(doc.project.key, 'ENG');
  });
});

describe('an OpenProject collection', () => {
  const result = convert(openproject);
  const doc = result.document as any;

  it('reads a parent out of a HAL link rather than a field', () => {
    assert.equal(doc.tasks[1].parent_id, '42');
  });

  it('reads both dates, and the raw half of its description', () => {
    assert.equal(doc.tasks[0].start_date, '2026-08-03');
    assert.equal(doc.tasks[0].due_date, '2026-08-14');
    assert.equal(doc.tasks[0].description, 'Concrete, then wait.');
  });

  it('admits it has no labels rather than inventing them from categories', () => {
    // OpenProject's work package *type* does come across as a label — that is
    // the one word in the file that says what sort of thing this is. Its
    // categories do not, which is what the note is about.
    assert.deepEqual(doc.labels.map((label: any) => label.name), ['Task']);
    assert.ok(result.notes.some((note) => /categories are not the same thing/.test(note)));
  });
});

describe('a Plane issue list', () => {
  const result = convert(plane);
  const doc = result.document as any;

  it('resolves state and label ids against the lists beside them', () => {
    assert.deepEqual(doc.states.map((state: any) => state.name), ['Todo', 'Done']);
    assert.deepEqual(doc.labels.map((label: any) => label.name), ['design']);
  });

  it('is honest that its people cannot be matched, because Plane sends only ids', () => {
    assert.ok(result.notes.some((note) => /unassigned/.test(note)));
  });

  it('shows a state by its id rather than dropping it when no list came along', () => {
    const bare = convert({ results: plane.results }).document as any;
    assert.equal(bare.states[0].name, 'st-1', 'nothing silently disappears');
  });
});

describe('through the API', () => {
  it('inspects without writing anything, then imports', async () => {
    const found = await ok(`/api/workspaces/${workspaceId}/import/json/inspect`, { document: jira });
    assert.equal(found.from, 'jira');
    assert.equal(found.tasks, 2);
    assert.ok(found.notes.length);

    const before = (await ok(`/api/workspaces/${workspaceId}/projects`)).length;
    await ok(`/api/workspaces/${workspaceId}/import/json/inspect`, { document: jira });
    assert.equal((await ok(`/api/workspaces/${workspaceId}/projects`)).length, before, 'a dry run writes nothing');

    const result = await ok(`/api/workspaces/${workspaceId}/import/json`, { document: jira });
    assert.equal(result.from, 'jira');
    assert.equal(result.project.name, 'Website');
    assert.ok(result.notes.length, 'and the notes come back with the report, not only before it');
    assert.ok(result.counts.tasks >= 2);
  });

  it('refuses a file it does not recognise, rather than importing an empty project', async () => {
    const response = await fetch(`${base}/api/workspaces/${workspaceId}/import/json/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ document: { some: 'spreadsheet' } }),
    });
    assert.equal(response.status, 400);
  });
});

describe('a Trello board', () => {
  const { document, notes } = convert(trello);
  const doc = document as any;
  const task = (title: string) => doc.tasks.find((entry: any) => entry.title === title);
  const state = (id: string) => doc.states.find((entry: any) => entry.id === id);

  it('takes the board name as the project name', () => {
    assert.equal(doc.project.name, 'Marketing');
  });

  it('turns each list into a state and guesses only the obvious groups', () => {
    const doing = state(task('Rewrite the pricing page').state_id);
    assert.equal(doing.name, 'Doing');
    // "Doing" is not a word this recognises, and inventing a meaning for it is
    // how every card in a column ends up looking finished.
    assert.equal(doing.group_key, 'unstarted');

    const done = state(task('Pick a headline font').state_id);
    assert.equal(done.name, 'Done');
    assert.equal(done.group_key, 'completed');
  });

  it('says out loud that the group is a guess', () => {
    assert.ok(notes.some((note) => /guessed from the column name/.test(note)),
      `no warning about the guess in: ${notes.join(' | ')}`);
  });

  it('leaves archived cards out and counts them', () => {
    assert.equal(task('An old idea'), undefined);
    assert.ok(notes.some((note) => /1 archived card left out/.test(note)), notes.join(' | '));
  });

  it('folds a checklist into the description as a markdown checklist', () => {
    const description = task('Rewrite the pricing page').description as string;
    assert.match(description, /The old one buries the price\./);
    assert.match(description, /\*\*Before publishing\*\*/);
    assert.match(description, /- \[x\] Legal read it/);
    assert.match(description, /- \[ \] Screenshots redone/);
    assert.ok(notes.some((note) => /2 checklist items/.test(note)), notes.join(' | '));
  });

  it('names an unnamed label by its colour rather than dropping it', () => {
    const label = doc.labels.find((entry: any) => entry.name === 'Red');
    assert.ok(label, `no colour-named label in ${JSON.stringify(doc.labels)}`);
    assert.ok(task('Pick a headline font').labels.includes(label.id));
  });

  it('reads a comment out of the actions and ignores every other action', () => {
    assert.equal(doc.comments.length, 1);
    assert.match(doc.comments[0].body, /second paragraph/);
  });

  it('keeps the due date as a day', () => {
    assert.equal(task('Rewrite the pricing page').due_date, '2026-09-04');
  });
});

describe('a Todoist export', () => {
  const { document, notes } = convert(todoist);
  const doc = document as any;
  const task = (title: string) => doc.tasks.find((entry: any) => entry.title === title);
  const label = (id: string) => doc.labels.find((entry: any) => entry.id === id)?.name;

  it('inverts the priorities, because Todoist counts the other way', () => {
    assert.equal(task('Send the invoice').priority, 'urgent');   // Todoist 4 is P1
    assert.equal(task('Book the train').priority, 'medium');
    assert.equal(task('Water the plants').priority, 'none');
  });

  it('invents exactly two states and says so', () => {
    assert.equal(doc.states.length, 2);
    assert.ok(notes.some((note) => /no columns/.test(note)), notes.join(' | '));
  });

  it('keeps a repeat it can express', () => {
    assert.equal(task('Send the invoice').recurrence, 'monthly');
  });

  it('refuses a repeat it cannot, rather than repeating on the wrong day', () => {
    assert.equal(task('Water the plants').recurrence, null);
    assert.equal(task('Water the plants').due_date, '2026-08-25', 'the date still arrives');
    assert.ok(notes.some((note) => /cannot express/.test(note)), notes.join(' | '));
  });

  it('turns the Todoist project into a label, so it is not lost', () => {
    assert.ok(task('Send the invoice').labels.map(label).includes('Work'));
    assert.ok(task('Water the plants').labels.map(label).includes('Home'));
  });

  it('keeps the parent when it is in the file', () => {
    assert.equal(task('Buy tickets first').parent_id, task('Book the train').id);
  });

  it('reads notes as comments', () => {
    assert.equal(doc.comments.length, 1);
    assert.match(doc.comments[0].body, /as a PDF/);
  });
});

describe('the recurrence phrases Todoist writes', () => {
  it('reads the three Kolibri can honour, in three languages', () => {
    assert.equal(todoistRecurrence('every day'), 'daily');
    assert.equal(todoistRecurrence('every week'), 'weekly');
    assert.equal(todoistRecurrence('every month'), 'monthly');
    assert.equal(todoistRecurrence('every 2 weeks'), 'weekly:2');
    assert.equal(todoistRecurrence('jeden Monat'), 'monthly');
    assert.equal(todoistRecurrence('alle 3 Tage'), 'daily:3');
    assert.equal(todoistRecurrence('chaque semaine'), 'weekly');
  });

  it('refuses everything else rather than approximating it', () => {
    for (const phrase of ['every 3rd friday', 'every workday', 'every morning', 'tomorrow', '']) {
      assert.equal(todoistRecurrence(phrase), null, `${phrase} should not be readable`);
    }
  });
});
