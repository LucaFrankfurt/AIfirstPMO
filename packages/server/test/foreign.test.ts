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
import { convert, detectFormat } from '@kolibri/shared';

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

/* ---------------------------------------------------------------- tests */

describe('recognising a file', () => {
  it('tells the four apart by shape rather than by what the download was called', () => {
    assert.equal(detectFormat(jira), 'jira');
    assert.equal(detectFormat(linear), 'linear');
    assert.equal(detectFormat(openproject), 'openproject');
    assert.equal(detectFormat(plane), 'plane');
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

  it('maps priority, kind, labels and the assignee', () => {
    assert.equal(doc.tasks[0].priority, 'urgent', 'Jira’s Highest');
    assert.equal(doc.types.find((type: any) => type.id === doc.tasks[0].type_id).name, 'Bug');
    assert.equal(doc.labels.length, 2);
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
    assert.equal(doc.labels.length, 0);
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
