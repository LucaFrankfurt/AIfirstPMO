/**
 * Two people editing one page, through the real write path.
 *
 * The CRDT has its own tests; this is about the plumbing around it — that a
 * `body` arriving at the server is *merged* rather than replacing what is
 * there, that `content` is kept saying whatever the merged state reads as, and
 * that a caller who knows nothing about any of this can still PATCH a page and
 * get what they sent.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-collab-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { crdt, type CrdtState } from '@kolibri/shared';

const { server } = await import('../src/index.ts');
const { get } = await import('../src/kernel/platform/db/index.ts');

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

const patch = (path: string, body: unknown) => ok(path, body, 'PATCH');
const bodyOf = (id: string): CrdtState | null => {
  const raw = get<any>(`SELECT body FROM pages WHERE id = ?`, id)?.body;
  return raw ? JSON.parse(String(raw)) : null;
};

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

const makePage = (content: string) =>
  ok(`/api/workspaces/${workspaceId}/pages`, { title: 'Handbook', content });

describe('a page written the old way', () => {
  it('gets a CRDT of its own, so nothing has to be migrated in one go', async () => {
    const page = await makePage('# Handbook\n\nHow we work.\n');
    const state = bodyOf(page.id);
    assert.ok(state, 'created with one');
    assert.equal(crdt.textOf(state), '# Handbook\n\nHow we work.\n');
  });

  it('still answers to a plain PATCH, because the API knows nothing about CRDTs', async () => {
    const page = await makePage('before');
    await patch(`/api/pages/${page.id}`, { content: 'after' });
    assert.equal(get<any>(`SELECT content FROM pages WHERE id = ?`, page.id).content, 'after');
    assert.equal(crdt.textOf(bodyOf(page.id)), 'after', 'and the CRDT is rebuilt to agree with it');
  });
});

describe('two people at once', () => {
  it('keeps both paragraphs, which last-writer-wins could not', async () => {
    const page = await makePage('Intro.\n');
    const start = bodyOf(page.id)!;

    // Two devices, each editing the page as they last saw it. Neither has seen
    // the other — this is exactly the state a train tunnel produces.
    const ada = crdt.edit(start, 'Intro.\n\nAda’s paragraph.\n', 'device-ada');
    const lin = crdt.edit(start, 'Intro.\n\nLin’s paragraph.\n', 'device-lin');

    await patch(`/api/pages/${page.id}`, { body: ada });
    await patch(`/api/pages/${page.id}`, { body: lin });

    const content = get<any>(`SELECT content FROM pages WHERE id = ?`, page.id).content as string;
    assert.match(content, /Ada’s paragraph/);
    assert.match(content, /Lin’s paragraph/, 'the second write did not replace the first');
    assert.equal(crdt.textOf(bodyOf(page.id)), content, 'and the text says what the CRDT says');
  });

  it('does not care which order the two arrive in', async () => {
    const first = await makePage('x\n');
    const second = await makePage('x\n');
    const start = bodyOf(first.id)!;
    const a = crdt.edit(start, 'x\nA\n', 'device-a');
    const b = crdt.edit(start, 'x\nB\n', 'device-b');

    await patch(`/api/pages/${first.id}`, { body: a });
    await patch(`/api/pages/${first.id}`, { body: b });
    await patch(`/api/pages/${second.id}`, { body: b });
    await patch(`/api/pages/${second.id}`, { body: a });

    assert.equal(
      get<any>(`SELECT content FROM pages WHERE id = ?`, first.id).content,
      get<any>(`SELECT content FROM pages WHERE id = ?`, second.id).content,
    );
  });

  it('takes the same write twice without doubling anything', async () => {
    const page = await makePage('once\n');
    const edited = crdt.edit(bodyOf(page.id)!, 'once\nand again\n', 'device-a');
    await patch(`/api/pages/${page.id}`, { body: edited });
    await patch(`/api/pages/${page.id}`, { body: edited });
    assert.equal(get<any>(`SELECT content FROM pages WHERE id = ?`, page.id).content, 'once\nand again\n');
  });

  it('ignores a `content` sent beside a `body`, because it was computed before the merge', async () => {
    const page = await makePage('start\n');
    const edited = crdt.edit(bodyOf(page.id)!, 'start\nreal text\n', 'device-a');
    await patch(`/api/pages/${page.id}`, { body: edited, content: 'a lie' });
    assert.equal(get<any>(`SELECT content FROM pages WHERE id = ?`, page.id).content, 'start\nreal text\n');
  });

  it('lets a deletion stand against a concurrent edit elsewhere', async () => {
    const page = await makePage('keep\ndrop\nkeep\n');
    const start = bodyOf(page.id)!;
    const remover = crdt.edit(start, 'keep\nkeep\n', 'device-a');
    const writer = crdt.edit(start, 'keep\ndrop\nkeep\nmore\n', 'device-b');

    await patch(`/api/pages/${page.id}`, { body: remover });
    await patch(`/api/pages/${page.id}`, { body: writer });

    const content = get<any>(`SELECT content FROM pages WHERE id = ?`, page.id).content as string;
    assert.equal(content.includes('drop'), false, 'what was deleted stays deleted');
    assert.match(content, /more/, 'and the other person’s line arrived');
  });
});

describe('a page rewritten whole, twice', () => {
  /*
   * The shape of a real bug. An agent rewrote a page over MCP, the page read
   * correctly everywhere — and the editor, the only screen that renders the
   * CRDT rather than the text, opened on the previous draft and would not stop.
   *
   * The cause was `fromText` on the second write: it mints `server:0,
   * server:1, …` every time, so the two states named the same characters and
   * disagreed about what letter each one was. `crdt.merge` keeps the identity
   * it already holds, so the device that had the first version kept it, and no
   * amount of pulling could shift it. What a replacement has to do instead is
   * *tombstone* what it replaces.
   */
  const seen = (text: string) => crdt.fromText(text, 'server');

  it('leaves a state that supersedes the one a device already has', async () => {
    const page = await makePage('Stand 09.10.2026 — Entwurf.\n');
    const onTheDevice = bodyOf(page.id)!;
    await patch(`/api/pages/${page.id}`, { content: 'Stand 10.10.2026 — Entwurf.\n' });

    assert.equal(
      crdt.textOf(crdt.merge(onTheDevice, bodyOf(page.id))),
      'Stand 10.10.2026 — Entwurf.\n',
      'a device holding the old state lands on the new text, not beside it',
    );
  });

  it('says the same thing whichever way round the two are merged', async () => {
    const page = await makePage('first\n');
    const onTheDevice = bodyOf(page.id)!;
    await patch(`/api/pages/${page.id}`, { content: 'second\n' });
    const after = bodyOf(page.id)!;

    assert.equal(crdt.textOf(crdt.merge(onTheDevice, after)), crdt.textOf(crdt.merge(after, onTheDevice)));
  });

  it('supersedes the seed a device makes for itself from the text alone', async () => {
    // A page from before any of this: the device has `content` and no state,
    // and seeds one the same way the server would — see `pages/collab.ts`.
    const page = await makePage('an older page\n');
    const seededOnTheDevice = seen('an older page\n');
    await patch(`/api/pages/${page.id}`, { content: 'rewritten\n' });

    assert.equal(crdt.textOf(crdt.merge(seededOnTheDevice, bodyOf(page.id))), 'rewritten\n');
  });

  it('still keeps a paragraph the device had not sent yet', async () => {
    const page = await makePage('shared line\n');
    const typing = crdt.edit(bodyOf(page.id)!, 'shared line\nnot sent yet\n', 'device-a');
    await patch(`/api/pages/${page.id}`, { content: 'shared line, rewritten\n' });

    const merged = crdt.textOf(crdt.merge(typing, bodyOf(page.id)));
    assert.match(merged, /not sent yet/, 'a replacement is not a reason to lose an unsent edit');
    assert.match(merged, /rewritten/);
  });

  it('does not grow a new document on every rewrite', async () => {
    const page = await makePage('# Title\n\nA paragraph that stays.\n');
    for (let n = 0; n < 8; n++) {
      await patch(`/api/pages/${page.id}`, { content: `# Title\n\nA paragraph that stays.\n\nRevision ${n}.\n` });
    }
    const state = bodyOf(page.id)!;
    assert.equal(crdt.textOf(state), '# Title\n\nA paragraph that stays.\n\nRevision 7.\n');
    assert.ok(
      crdt.sizeOf(state) < 8 * '# Title\n\nA paragraph that stays.\n'.length,
      'the unchanged prefix is kept rather than retyped — tombstones are only what changed',
    );
  });
});

describe('everything else that reads a page', () => {
  it('sees the merged text — search, sharing, export and the API all read `content`', async () => {
    const page = await makePage('nothing findable\n');
    const edited = crdt.edit(bodyOf(page.id)!, 'nothing findable\nsalamander\n', 'device-a');
    await patch(`/api/pages/${page.id}`, { body: edited });

    const hits = await ok(`/api/workspaces/${workspaceId}/search?q=salamander`);
    const list_ = Array.isArray(hits) ? hits : hits.results ?? [];
    assert.ok(
      list_.some((hit: any) => hit.id === page.id),
      'the search index is built from `content`, which is why deriving it matters',
    );
  });
});
