/**
 * Custom fields, and the one design decision they rest on: an answer is a row
 * of its own, with an id derived from the task and the field.
 *
 * That is what makes two people filling in two different fields on one task
 * merge, and two devices answering the *same* field offline converge on one row
 * instead of two.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-fields-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import {
  FIELD_ANSWERED, FIELD_EMPTY, fieldChoices, fieldKeys, fieldMatches, fieldValueId,
  fieldsForTask, isGroupable, readFieldValue, writeFieldValue,
} from '@kolibri/shared';

const { server } = await import('../src/index.ts');
const { get } = await import('../src/db/index.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';
let bugTypeId = '';
let featureTypeId = '';

async function call(path: string, body?: unknown, method?: string) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const ok = async (path: string, body?: unknown, method?: string) => {
  const result = await call(path, body, method);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${JSON.stringify(result.body)}`);
  return result.body;
};

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ok('/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' });
  workspaceId = session.workspaces[0].id;
  const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Fields', key: 'FLD' });
  projectId = project.id;
  const types = await ok(`/api/workspaces/${workspaceId}/task-types?project_id=${projectId}`);
  bugTypeId = types.find((type: any) => /bug/i.test(type.name))?.id ?? types[0].id;
  featureTypeId = types.find((type: any) => type.id !== bugTypeId)?.id ?? types[1].id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a field a project invented', () => {
  it('round-trips its shape, options and all', async () => {
    const field = await ok(`/api/workspaces/${workspaceId}/fields`, {
      project_id: projectId, name: 'Severity', kind: 'select',
      options: ['Low', 'High'], type_ids: [bugTypeId], required: 1,
    });
    assert.deepEqual(field.options, ['Low', 'High'], 'JSON columns come back as arrays, not as strings');
    assert.deepEqual(field.type_ids, [bugTypeId]);

    const listed = await ok(`/api/workspaces/${workspaceId}/fields?project_id=${projectId}`);
    assert.equal(listed.length, 1);
  });

  it('is asked only on the types it names', async () => {
    const fields = await ok(`/api/workspaces/${workspaceId}/fields?project_id=${projectId}`);
    assert.equal(fieldsForTask(fields, bugTypeId).length, 1, 'a bug is asked');
    assert.equal(fieldsForTask(fields, featureTypeId).length, 0, 'a feature is not');
    assert.equal(fieldsForTask(fields, null).length, 0, 'nor is a task with no type at all');

    const everywhere = await ok(`/api/workspaces/${workspaceId}/fields`, {
      project_id: projectId, name: 'Customer', kind: 'text', options: [], type_ids: [],
    });
    const both = await ok(`/api/workspaces/${workspaceId}/fields?project_id=${projectId}`);
    assert.equal(fieldsForTask(both, featureTypeId).length, 1, 'an empty type list means every type');
    assert.equal(fieldsForTask(both, null).length, 1, 'including a task that has none');
    assert.ok(everywhere.id);
  });
});

describe('an answer', () => {
  let taskId = '';
  let fieldId = '';

  before(async () => {
    const task = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Broken', type_id: bugTypeId });
    taskId = task.id;
    fieldId = (await ok(`/api/workspaces/${workspaceId}/fields?project_id=${projectId}`))
      .find((f: any) => f.name === 'Severity').id;
  });

  it('lives at an id derived from the task and the field, so two devices converge', async () => {
    const id = fieldValueId(taskId, fieldId);
    const first = await ok(`/api/workspaces/${workspaceId}/field-values`, {
      id, project_id: projectId, task_id: taskId, field_id: fieldId, value: 'Low',
    });
    assert.equal(first.id, id);

    // The second device, offline until now, answers the same field. Same id, so
    // this is a merge rather than a second row nobody can choose between.
    const second = await ok(`/api/workspaces/${workspaceId}/field-values`, {
      id, project_id: projectId, task_id: taskId, field_id: fieldId, value: 'High',
    });
    assert.equal(second.id, id);

    const all = await ok(`/api/workspaces/${workspaceId}/field-values?task_id=${taskId}`);
    assert.equal(all.length, 1, 'one answer, not two');
    assert.equal(all[0].value, 'High');
  });

  it('goes when the field goes', async () => {
    const id = fieldValueId(taskId, fieldId);
    await ok(`/api/fields/${fieldId}`, undefined, 'DELETE');

    const row = get<any>(`SELECT deleted_at FROM field_values WHERE id = ?`, id);
    assert.ok(row?.deleted_at, 'as a tombstone, because other devices hold the row too');

    const remaining = await ok(`/api/workspaces/${workspaceId}/field-values?task_id=${taskId}`);
    assert.equal(remaining.length, 0);
  });
});

describe('over MCP', () => {
  it('reads back only the fields the task’s type is asked for, and writes one by name', async () => {
    const field = await ok(`/api/workspaces/${workspaceId}/fields`, {
      project_id: projectId, name: 'Environment', kind: 'select', options: ['prod', 'staging'], type_ids: [bugTypeId],
    });
    const bug = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Crash', type_id: bugTypeId });
    const feature = await ok(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title: 'Shiny', type_id: featureTypeId });

    const rpc = async (name: string, args: unknown) => {
      const result = await ok('/mcp', {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
      });
      if (result.error) throw new Error(result.error.message);
      return JSON.parse(result.result.content[0].text);
    };

    await rpc('update_task', { task: bug.identifier, fields: { environment: 'prod' } });
    const read = await rpc('get_task', { task: bug.identifier });
    assert.deepEqual(
      read.fields.find((f: any) => f.name === 'Environment'),
      { name: 'Environment', kind: 'select', value: 'prod' },
    );

    const other = await rpc('get_task', { task: feature.identifier });
    assert.equal(other.fields.some((f: any) => f.name === 'Environment'), false, 'a feature is not asked a bug’s question');
    assert.ok(other.fields.some((f: any) => f.name === 'Customer'), 'but it is asked the ones that apply to everything');

    await assert.rejects(
      () => rpc('update_task', { task: feature.identifier, fields: { Environment: 'prod' } }),
      /not asked on this kind/i,
      'and cannot be made to answer it',
    );
    await assert.rejects(
      () => rpc('update_task', { task: bug.identifier, fields: { Nonsense: 'x' } }),
      /No field called/i,
      'a typo is an error, not a silent no-op',
    );
    assert.ok(field.id);
  });
});

describe('reading and writing a value', () => {
  it('survives the round trip through text for every kind', () => {
    const cases: [string, unknown][] = [
      ['text', 'a string'],
      ['number', 42],
      ['checkbox', true],
      ['date', '2026-08-19'],
      ['multi_select', ['a', 'b']],
      ['person', 'user-1'],
    ];
    for (const [kind, value] of cases) {
      const written = writeFieldValue(kind as never, value);
      assert.deepEqual(readFieldValue(kind as never, written), value, `${kind} came back changed`);
    }
  });

  it('treats an emptied field as no answer rather than as an empty string', () => {
    assert.equal(writeFieldValue('text', '   '), null);
    assert.equal(writeFieldValue('number', ''), null);
    assert.equal(writeFieldValue('checkbox', false), null);
    assert.equal(writeFieldValue('multi_select', []), null);
  });

  it('reads a single choice written before the field became a multi-select', () => {
    // The stored text is not JSON, because it was written by a plain select.
    assert.deepEqual(readFieldValue('multi_select', 'High'), ['High'], 'rather than losing it');
  });

  it('refuses to turn nonsense into a number', () => {
    assert.equal(writeFieldValue('number', 'twelve'), null);
    assert.equal(readFieldValue('number', 'twelve'), null);
  });
});

describe('filtering and grouping by a field', () => {
  it('puts a several-of answer in every group it names, and a missing one in none', () => {
    assert.deepEqual(fieldKeys('multi_select', '["a","b"]'), ['a', 'b']);
    assert.deepEqual(fieldKeys('select', 'High'), ['High']);
    assert.deepEqual(fieldKeys('checkbox', 'true'), ['true']);
    assert.deepEqual(fieldKeys('text', null), [], 'no answer is no groups, not one called ""');
    assert.deepEqual(fieldKeys('text', ''), []);
  });

  it('matches on any of the wanted answers, which is how every other filter reads', () => {
    assert.equal(fieldMatches('select', 'High', ['High', 'Urgent']), true);
    assert.equal(fieldMatches('select', 'Low', ['High', 'Urgent']), false);
    assert.equal(fieldMatches('multi_select', '["a","c"]', ['c']), true, 'one of several is enough');
    assert.equal(fieldMatches('select', 'Low', []), true, 'an empty filter filters nothing');
  });

  it('can ask a free-text field the only two questions it has', () => {
    assert.equal(fieldMatches('long_text', null, [FIELD_EMPTY]), true);
    assert.equal(fieldMatches('long_text', 'steps: …', [FIELD_EMPTY]), false);
    assert.equal(fieldMatches('long_text', 'steps: …', [FIELD_ANSWERED]), true);
    assert.equal(fieldMatches('long_text', null, [FIELD_ANSWERED]), false);
    // The one collision the tokens allow gives the right answer anyway: a field
    // whose answer is literally an asterisk does have an answer.
    assert.equal(fieldMatches('text', '*', [FIELD_ANSWERED]), true);
  });

  it('offers grouping only where the answers come from a list', () => {
    assert.deepEqual(
      ['select', 'multi_select', 'checkbox', 'person', 'text', 'long_text', 'number', 'date', 'url']
        .filter((kind) => isGroupable(kind as never)),
      ['select', 'multi_select', 'checkbox', 'person'],
      'grouping by a note would be one heading per task',
    );
  });

  it('offers a field’s own choices, and nothing for a field that has none', () => {
    assert.deepEqual(fieldChoices({ kind: 'select', options: ['Low', 'High'] } as never), ['Low', 'High']);
    assert.deepEqual(fieldChoices({ kind: 'checkbox', options: null } as never), ['true']);
    assert.deepEqual(fieldChoices({ kind: 'long_text', options: null } as never), []);
  });
});
