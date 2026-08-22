/**
 * A project as a document, and back again.
 *
 * The test that matters is the round trip: export a project, import it, and
 * find the same *shape* — with every reference pointing inside the new copy,
 * nothing pointing back at the instance it came from, and people matched by
 * the only identifier that means anything across two instances.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-transfer-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

let base = '';
let cookie = '';
let workspaceId = '';
let projectId = '';
let graceId = '';

async function ok(path: string, body?: unknown, method?: string, as = cookie): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(as ? { cookie: as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const owner = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' }),
  });
  cookie = (owner.headers.get('set-cookie') ?? '').split(';')[0];
  workspaceId = ((await owner.json()) as any).workspaces[0].id;

  const invite = await ok(`/api/workspaces/${workspaceId}/invites`, { role: 'member' });
  resetRateLimits();
  const grace = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'grace@example.com', name: 'Grace', password: 'correct horse battery', invite: invite.code }),
  });
  graceId = ((await grace.json()) as any).user.id;

  const project = await ok(`/api/workspaces/${workspaceId}/projects`, { name: 'Portable', key: 'PORT' });
  projectId = project.id;

  const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${projectId}`);
  const labels = await ok(`/api/workspaces/${workspaceId}/labels?project_id=${projectId}`);
  const field = await ok(`/api/workspaces/${workspaceId}/fields`, {
    project_id: projectId, name: 'Severity', kind: 'select', options: ['Low', 'High'],
  });

  const parent = await ok(`/api/workspaces/${workspaceId}/tasks`, {
    project_id: projectId, title: 'Move house', state_id: states[0].id, labels: [labels[0].id], assignees: [graceId],
  });
  const child = await ok(`/api/workspaces/${workspaceId}/tasks`, {
    project_id: projectId, title: 'Book the van', parent_id: parent.id,
  });
  await ok(`/api/workspaces/${workspaceId}/relations`, { task_id: child.id, related_task_id: parent.id, kind: 'blocks' });
  await ok(`/api/workspaces/${workspaceId}/comments`, { task_id: parent.id, body: 'Van hire is cheaper midweek.' });
  await ok(`/api/workspaces/${workspaceId}/field-values`, {
    id: `${parent.id}.${field.id}`, project_id: projectId, task_id: parent.id, field_id: field.id, value: 'High',
  });
  await ok(`/api/workspaces/${workspaceId}/pages`, { project_id: projectId, title: 'Checklist', content: '- Boxes' });

  // A conversation about this project, and a private one that must not travel.
  const room = await ok(`/api/workspaces/${workspaceId}/channels`, { name: 'moving-day', project_id: projectId });
  await ok(`/api/workspaces/${workspaceId}/messages`, { channel_id: room.id, body: 'Van booked for Tuesday.' });
  const backroom = await ok(`/api/workspaces/${workspaceId}/channels`, {
    name: 'the-quiet-part', project_id: projectId, is_private: 1,
  });
  await ok(`/api/workspaces/${workspaceId}/messages`, { channel_id: backroom.id, body: 'Do not put this in a file.' });
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const exportDoc = () => ok(`/api/workspaces/${workspaceId}/projects/${projectId}/export`);

describe('exporting', () => {
  it('writes a document that names its format and can be read by a person', async () => {
    const doc = await exportDoc();
    assert.match(doc.format, /^kolibri\.project\//);
    assert.equal(doc.project.name, 'Portable');
    assert.equal(doc.tasks.length, 2);
    assert.equal(doc.relations.length, 1);
    assert.equal(doc.comments.length, 1);
    assert.equal(doc.pages.length, 1);
    assert.equal(doc.field_values.length, 1);
    assert.ok(doc.people.some((p: any) => p.email === 'grace@example.com'), 'with the people it refers to, by email');
    // Dates a person can read, not epoch counts.
    assert.match(doc.tasks[0].created_at_iso, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal('seq' in doc.tasks[0], false, 'and nothing that only means something on the old instance');
    assert.equal('clocks' in doc.tasks[0], false);
  });
});

describe('conversations in a project document', () => {
  it('takes the open channel and what was said in it', async () => {
    const doc = await exportDoc();
    assert.equal(doc.channels.length, 1);
    assert.equal(doc.channels[0].name, 'moving-day');
    assert.equal(doc.messages.length, 1);
    assert.match(doc.messages[0].body, /Van booked/);
  });

  it('leaves a private one behind, contents and all', async () => {
    const raw = JSON.stringify(await exportDoc());
    assert.ok(!raw.includes('the-quiet-part'), 'a private room must not be in a file somebody emails');
    assert.ok(!raw.includes('Do not put this in a file'));
  });

  it('reads them back as a conversation in the new project', async () => {
    const doc = await exportDoc();
    const result = await ok(`/api/workspaces/${workspaceId}/import/json`, { document: doc, name: 'Talkative' });
    const channels = await ok(`/api/workspaces/${workspaceId}/channels?project_id=${result.project.id}`);
    assert.equal(channels.length, 1);
    assert.equal(channels[0].name, 'moving-day');
    const messages = await ok(`/api/workspaces/${workspaceId}/messages?channel_id=${channels[0].id}`);
    assert.equal(messages.length, 1);
    assert.match(messages[0].body, /Van booked/);
    // The author is matched by email like everything else, not rewritten to
    // whoever pressed import.
    assert.ok(messages[0].author_id);
  });
});

describe('importing it back', () => {
  it('makes a second, independent project with every reference rewritten', async () => {
    const doc = await exportDoc();
    const result = await ok(`/api/workspaces/${workspaceId}/import/json`, { document: doc, name: 'Portable (copy)' });
    const id = result.project.id;
    assert.notEqual(id, projectId);

    const tasks = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${id}`);
    assert.equal(tasks.length, 2);
    const parent = tasks.find((task: any) => task.title === 'Move house');
    const child = tasks.find((task: any) => task.title === 'Book the van');
    assert.equal(child.parent_id, parent.id, 'the sub-task hangs off the copy, not the original');
    assert.match(parent.identifier, /-\d+$/);
    assert.notEqual(parent.identifier.split('-')[0], 'PORT', 'and the copy gets a key of its own');

    const states = await ok(`/api/workspaces/${workspaceId}/states?project_id=${id}`);
    assert.ok(states.some((state: any) => state.id === parent.state_id), 'its state is one of this project’s');

    const labels = await ok(`/api/workspaces/${workspaceId}/labels?project_id=${id}`);
    assert.ok(labels.some((label: any) => label.id === parent.labels[0]), 'and so is its label');

    assert.deepEqual(parent.assignees, [graceId], 'Grace is the same person here, matched by email');

    const fields = await ok(`/api/workspaces/${workspaceId}/fields?project_id=${id}`);
    const values = await ok(`/api/workspaces/${workspaceId}/field-values?task_id=${parent.id}`);
    assert.equal(values.length, 1);
    assert.equal(values[0].field_id, fields[0].id);
    assert.equal(values[0].value, 'High');

    const comments = await ok(`/api/workspaces/${workspaceId}/comments?task_id=${parent.id}`);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /midweek/);
  });

  it('can be read twice without the two copies touching each other', async () => {
    const doc = await exportDoc();
    const first = await ok(`/api/workspaces/${workspaceId}/import/json`, { document: doc, name: 'Twice A' });
    const second = await ok(`/api/workspaces/${workspaceId}/import/json`, { document: doc, name: 'Twice B' });
    assert.notEqual(first.project.id, second.project.id);

    const a = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${first.project.id}`);
    const b = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${second.project.id}`);
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert.equal(a.some((task: any) => b.some((other: any) => other.id === task.id)), false, 'no row is in both');
  });

  it('drops people it cannot find, and says whom', async () => {
    const doc = await exportDoc();
    // A document from an instance where nobody here has an account.
    doc.people = doc.people.map((entry: any) => ({ ...entry, email: `${entry.email}.invalid` }));
    const result = await ok(`/api/workspaces/${workspaceId}/import/json`, { document: doc, name: 'Strangers' });

    assert.ok(result.unmatched.length >= 1, 'the report names who could not be matched');
    const tasks = await ok(`/api/workspaces/${workspaceId}/tasks?project_id=${result.project.id}`);
    const parent = tasks.find((task: any) => task.title === 'Move house');
    assert.deepEqual(parent.assignees, [], 'rather than assigning work to somebody who is not here');
  });

  it('refuses a file that is not one of ours', async () => {
    for (const document of [{ hello: 'world' }, { format: 'notion/1', project: {} }, null]) {
      await assert.rejects(
        () => ok(`/api/workspaces/${workspaceId}/import/json`, { document }),
        /not a Kolibri|no project/i,
      );
    }
  });
});
