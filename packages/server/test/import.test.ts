/**
 * Importing a backlog.
 *
 * The cases that decide whether an import is usable are not "does a good file
 * work". They are: a row that is nearly right still lands, the thing that could
 * not be read is *named*, and a dry run really changes nothing — because an
 * import you cannot preview is one people run once and undo by hand.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-import-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { guessMapping, readDate, readPriority } = await import('@kolibri/shared');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : (null as T);
}

const importCsv = (csv: string, mapping: Record<string, string>, dryRun = false, extra: Record<string, unknown> = {}) =>
  api(`/api/workspaces/${workspaceId}/import`, { csv, project_id: projectId, mapping, dry_run: dryRun, ...extra });

const tasks = async (): Promise<any[]> => api(`/api/workspaces/${workspaceId}/tasks?project_id=${projectId}`);

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await api('/api/auth/register', { email: 'ada@example.com', name: 'Ada Lovelace', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  projectId = (await api(`/api/workspaces/${workspaceId}/projects`, { name: 'Imported', key: 'IMP' })).id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('guessing what the columns are', () => {
  it('recognises the headers the three tools people leave actually write', () => {
    assert.equal(guessMapping(['Summary'])['Summary'], 'title', 'Jira');
    assert.equal(guessMapping(['Subject'])['Subject'], 'title', 'OpenProject');
    assert.equal(guessMapping(['Name'])['Name'], 'title', 'Plane');
    assert.equal(guessMapping(['Titel'])['Titel'], 'title', 'a German export');
  });

  it('does not let a second candidate overwrite the first', () => {
    // A Jira export has both `Summary` and `Description`; some also carry a
    // `Name`. Whichever comes first should stay the title.
    const mapping = guessMapping(['Summary', 'Name', 'Description']);
    assert.equal(mapping['Summary'], 'title');
    assert.equal(mapping['Name'], undefined, 'not mapped over the first one');
    assert.equal(mapping['Description'], 'description');
  });

  it('leaves a column it does not recognise alone', () => {
    assert.equal(guessMapping(['Sprint velocity'])['Sprint velocity'], undefined);
  });
});

describe('reading single values', () => {
  it('takes the priority words of both languages and of Jira', () => {
    for (const [input, expected] of [
      ['Highest', 'urgent'], ['Blocker', 'urgent'], ['dringend', 'urgent'],
      ['High', 'high'], ['hoch', 'high'], ['Major', 'high'],
      ['Normal', 'medium'], ['mittel', 'medium'],
      ['Low', 'low'], ['Trivial', 'low'], ['niedrig', 'low'],
      ['', 'none'],
    ] as const) {
      assert.equal(readPriority(input), expected, `${input} → ${expected}`);
    }
    assert.equal(readPriority('yesterday'), null, 'and says so when it cannot');
  });

  it('refuses an ambiguous date rather than guessing five weeks wrong', () => {
    assert.deepEqual(readDate('2026-03-04'), { date: '2026-03-04' });
    assert.deepEqual(readDate('4.3.2026'), { date: '2026-03-04' }, 'the German form is unambiguous');

    const slashes = readDate('01/02/2026');
    assert.ok('error' in slashes && /ambiguous/.test(slashes.error), 'day/month or month/day cannot be told apart');

    const impossible = readDate('2026-02-30');
    assert.ok('error' in impossible, 'and a date that does not exist is not rolled forward into March');
  });
});

describe('importing a file', () => {
  it('previews without writing anything', async () => {
    const before = (await tasks()).length;
    const result = await importCsv(
      'Summary,Priority\nFirst thing,High\nSecond thing,Low\n',
      { Summary: 'title', Priority: 'priority' },
      true,
    );
    assert.equal(result.created, 2, 'it says what it would create');
    assert.equal(result.preview[0].title, 'First thing');
    assert.equal(result.preview[0].priority, 'high');
    assert.equal((await tasks()).length, before, 'and nothing was written');
  });

  it('creates the tasks, resolving people and labels by name', async () => {
    const result = await importCsv(
      [
        'Summary,Description,Status,Priority,Assignee,Labels,Due',
        'Ship the thing,"Needs a review, then ship",Todo,High,ada@example.com,"bug, urgent-ish",2026-09-01',
        'Write it down,,Backlog,Low,Ada Lovelace,bug,',
      ].join('\n'),
      {
        Summary: 'title', Description: 'description', Status: 'state', Priority: 'priority',
        Assignee: 'assignee', Labels: 'labels', Due: 'due_date',
      },
    );
    assert.equal(result.created, 2);
    assert.deepEqual(result.problems, [], 'a clean file reports nothing');

    const all = await tasks();
    const first = all.find((task: any) => task.title === 'Ship the thing');
    assert.equal(first.priority, 'high');
    assert.equal(first.due_date, '2026-09-01');
    assert.equal(first.description, 'Needs a review, then ship');
    assert.equal(first.assignees.length, 1, 'matched on email');
    assert.equal(first.labels.length, 2);

    const second = all.find((task: any) => task.title === 'Write it down');
    assert.equal(second.assignees.length, 1, 'and on full name');

    // "bug" appears in both rows: one label in this project, not two. (The
    // workspace has another `bug` from the starter project's seeded set, which
    // is why this counts within the project rather than across the workspace.)
    const labels = await api(`/api/workspaces/${workspaceId}/labels?project_id=${projectId}`);
    assert.equal(labels.filter((label: any) => label.name === 'bug').length, 1);
  });

  it('lands a nearly-right row and names what it could not read', async () => {
    const result = await importCsv(
      [
        'Summary,Status,Priority,Assignee,Due',
        'Still worth having,Nonexistent state,yesterday,nobody@example.com,01/02/2026',
      ].join('\n'),
      { Summary: 'title', Status: 'state', Priority: 'priority', Assignee: 'assignee', Due: 'due_date' },
    );

    assert.equal(result.created, 1, 'the row still lands — that is the point');
    assert.equal(result.problems.length, 4, 'and every unreadable value is named');
    const messages = result.problems.map((problem: any) => problem.message).join(' | ');
    assert.match(messages, /Nonexistent state/);
    assert.match(messages, /yesterday/);
    assert.match(messages, /nobody@example\.com/);
    assert.match(messages, /ambiguous/);
    assert.ok(result.problems.every((problem: any) => problem.row === 2), 'pointing at the spreadsheet row');

    assert.equal(result.preview[0].assignee, null,
      'the preview shows who it will go to, not the address that matched nobody');

    const created = (await tasks()).find((task: any) => task.title === 'Still worth having');
    assert.ok(created.state_id, 'with the default state rather than none');
    assert.equal(created.assignees.length, 0);
  });

  it('skips a row with no title and says which one', async () => {
    const result = await importCsv('Summary,Priority\n,High\nHas one,Low\n', { Summary: 'title', Priority: 'priority' });
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.problems[0].row, 2);
  });

  it('reads a semicolon file from a German Excel', async () => {
    const result = await importCsv(
      'Titel;Priorität\nEtwas erledigen;hoch\nNoch etwas, mit Komma;niedrig\n',
      { Titel: 'title', 'Priorität': 'priority' },
    );
    assert.equal(result.created, 2);
    const created = (await tasks()).find((task: any) => task.title === 'Noch etwas, mit Komma');
    assert.ok(created, 'the comma inside a field did not split the row');
    assert.equal(created.priority, 'low');
  });

  it('refuses a file with no title column instead of importing blanks', async () => {
    const result = await importCsv('Notes\nsomething\n', { Notes: 'description' });
    assert.equal(result.created, 0);
    assert.match(result.problems[0].message, /title/);
  });

  it('keeps the original key so somebody can find where a task came from', async () => {
    await importCsv('Key,Summary\nPROJ-417,Came from elsewhere\n', { Key: 'external_id', Summary: 'title' });
    const created = (await tasks()).find((task: any) => task.title === 'Came from elsewhere');
    assert.match(created.description, /PROJ-417/);
  });

  it('will not write a column the mapping made up', async () => {
    // A client sending `{ Summary: 'is_admin' }` must not reach a field the
    // importer does not own.
    const result = await importCsv('Summary,X\nA task,1\n', { Summary: 'title', X: 'archived' as any });
    assert.equal(result.created, 1);
    const created = (await tasks()).find((task: any) => task.title === 'A task');
    assert.equal(created.archived, 0, 'the invented mapping was ignored');
  });
});
