/**
 * The boards on a canvas, and who may have them.
 *
 * A board has no access setting of its own: it is exactly as visible as the
 * page it is on. That is one sentence, and this repository has learned what it
 * costs to write such a sentence down in only some of the places it has to be
 * true — a private page's files reached the workspace through the one door
 * that did not ask (see `page-files.test.ts`). So every door is asked here,
 * through the door rather than through the function: the pull, the single
 * read, the listing, a change, a delete, and a write pushed from a device.
 *
 * Then the three things a board inherits from its page besides visibility:
 * going to the trash with it, coming back with it, and reaching the people a
 * page is opened up to — who were skipped by every pull while it was private.
 *
 * And the frame the board is drawn in, whose headers are the whole of what
 * keeps a board's scripts away from the app.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-artboards-${process.pid}`;
// A web build of exactly two files, so the frame's headers can be asked about
// without building the client first.
process.env.KOLIBRI_WEB_DIR = `/tmp/kolibri-artboards-web-${process.pid}`;

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Clock } from '@kolibri/shared';

mkdirSync(process.env.KOLIBRI_WEB_DIR, { recursive: true });
writeFileSync(`${process.env.KOLIBRI_WEB_DIR}/index.html`, '<!doctype html><title>app</title>');
writeFileSync(`${process.env.KOLIBRI_WEB_DIR}/artboard.html`, '<!doctype html><title>frame</title>');

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';
const clock = new Clock('artboards-test');

interface Person { cookie: string; id: string }

async function call(path: string, options: { cookie?: string; body?: unknown; method?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, setCookie: response.headers.get('set-cookie') };
}

async function ok<T = any>(path: string, options: Parameters<typeof call>[1] = {}): Promise<T> {
  const result = await call(path, options);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${result.body?.message ?? ''}`);
  return result.body as T;
}

let author: Person;
let colleague: Person;
let workspace = '';
let shut = '';
let open = '';
let secretBoard = '';
let openBoard = '';

const board = (cookie: string, page: string, title: string, content = `<h1>${title}</h1>`) =>
  ok(`/api/workspaces/${workspace}/artboards`, { cookie, body: { page_id: page, title, content, w: 800, h: 600 } });

/** The titles of the boards a person's device would be sent, from a cursor. */
async function pulled(person: Person, since = 0): Promise<string[]> {
  const body = await ok(`/api/sync/pull?workspace=${workspace}&since=${since}`, { cookie: person.cookie });
  return (body.changes?.artboard ?? []).map((row: { title: string }) => row.title);
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const register = async (email: string): Promise<Person> => {
    resetRateLimits();
    const result = await call('/api/auth/register', {
      body: { email, name: email.split('@')[0], password: 'correct horse battery' },
    });
    if (result.status >= 400) throw new Error(`register ${email}: ${result.body?.message}`);
    return { cookie: result.setCookie!.split(';')[0], id: result.body.user.id };
  };

  author = await register('canvas-author@example.com');
  workspace = (await ok('/api/session', { cookie: author.cookie })).workspaces[0].id;
  const invite = await ok(`/api/workspaces/${workspace}/invites`, { cookie: author.cookie, body: { role: 'member' } });
  colleague = await register('canvas-colleague@example.com');
  await ok(`/api/invites/${invite.code}/accept`, { cookie: colleague.cookie, body: {} });

  shut = (await ok(`/api/workspaces/${workspace}/pages`, {
    cookie: author.cookie, body: { title: 'Pricing ideas', format: 'canvas', access: 'private' },
  })).id;
  open = (await ok(`/api/workspaces/${workspace}/pages`, {
    cookie: author.cookie, body: { title: 'Pipeline', format: 'canvas' },
  })).id;
  secretBoard = (await board(author.cookie, shut, 'Secret pricing')).id;
  openBoard = (await board(author.cookie, open, 'Open pipeline')).id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
  rmSync(process.env.KOLIBRI_WEB_DIR!, { recursive: true, force: true });
});

describe('a canvas page', () => {
  it('keeps its format rather than being folded to markdown', async () => {
    assert.equal((await ok(`/api/pages/${open}`, { cookie: author.cookie })).format, 'canvas');
  });
});

describe('a board on a private canvas', () => {
  it('reaches its author', async () => {
    assert.ok((await pulled(author)).includes('Secret pricing'));
    assert.equal((await call(`/api/artboards/${secretBoard}`, { cookie: author.cookie })).status, 200);
  });

  it('is not sent to another member of the workspace', async () => {
    assert.ok(!(await pulled(colleague)).includes('Secret pricing'));
    assert.ok((await pulled(colleague)).includes('Open pipeline'), 'a board everybody may see still travels');
    assert.equal((await call(`/api/artboards/${openBoard}`, { cookie: colleague.cookie })).status, 200);
  });

  it('is refused to them through every door of the API', async () => {
    assert.equal((await call(`/api/artboards/${secretBoard}`, { cookie: colleague.cookie })).status, 403);
    const listed = await ok(`/api/workspaces/${workspace}/artboards`, { cookie: colleague.cookie });
    const titles = (listed.items ?? listed).map((row: { title: string }) => row.title);
    assert.ok(!titles.includes('Secret pricing'), 'the listing named a private board');
    assert.ok(titles.includes('Open pipeline'));
    assert.equal((await call(`/api/artboards/${secretBoard}`, {
      cookie: colleague.cookie, method: 'PATCH', body: { title: 'mine now' },
    })).status, 403);
    assert.equal((await call(`/api/artboards/${secretBoard}`, { cookie: colleague.cookie, method: 'DELETE' })).status, 403);
  });

  it('cannot be added to by them, over REST or from a device', async () => {
    assert.equal((await call(`/api/workspaces/${workspace}/artboards`, {
      cookie: colleague.cookie, body: { page_id: shut, title: 'Planted', content: '<p>hi</p>' },
    })).status, 403);
    const pushed = await ok('/api/sync/push', {
      cookie: colleague.cookie,
      body: {
        workspaceId: workspace, clientId: 'colleague-device',
        mutations: [{
          id: crypto.randomUUID(), entity: 'artboard', entityId: crypto.randomUUID(), op: 'upsert',
          patch: { workspace_id: workspace, page_id: shut, title: 'Planted offline', content: '<p>hi</p>' },
          hlc: clock.now(),
        }],
      },
    });
    assert.equal(pushed.rejected.length, 1, 'a push put a board onto somebody else\'s private canvas');
    assert.ok(!(await pulled(author)).includes('Planted offline'));
  });
});

describe('what a board is made of', () => {
  it('keeps its HTML as a merge, and says what it reads as', async () => {
    const html = '<!doctype html><html><body><h1>Q3</h1><script>document.title = "x"</script></body></html>';
    const row = await board(author.cookie, open, 'Quarter', html);
    assert.equal(row.content, html, 'the server must store a board exactly as written');
    assert.ok(row.body && Array.isArray(row.body.r), 'a board written as text gets a CRDT under it');
  });

  it('is put right rather than refused when a number or a kind is nonsense', async () => {
    const row = await ok(`/api/workspaces/${workspace}/artboards`, {
      cookie: author.cookie, body: { page_id: open, title: 'Odd', kind: 'video', w: 3, h: 99999, x: 'left' },
    });
    assert.equal(row.kind, 'html');
    assert.equal(row.w, 40);
    assert.equal(row.h, 8000);
    assert.equal(row.x, 0);
  });

  it('has to be on a page that is there', async () => {
    assert.equal((await call(`/api/workspaces/${workspace}/artboards`, {
      cookie: author.cookie, body: { page_id: 'no-such-page', title: 'Lost' },
    })).status, 400);
  });

  it('records who made it, whatever the client claimed', async () => {
    const row = await ok(`/api/workspaces/${workspace}/artboards`, {
      cookie: author.cookie, body: { page_id: open, title: 'Claimed', created_by: colleague.id },
    });
    assert.equal(row.created_by, author.id);
  });
});

describe('a canvas and its boards, together', () => {
  it('takes its boards to the trash and brings them back', async () => {
    const page = (await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'Roadmap', format: 'canvas' },
    })).id;
    const kept = (await board(author.cookie, page, 'Kept')).id;
    const gone = (await board(author.cookie, page, 'Removed earlier')).id;
    await ok(`/api/artboards/${gone}`, { cookie: author.cookie, method: 'DELETE' });

    await ok(`/api/pages/${page}`, { cookie: author.cookie, method: 'DELETE' });
    const afterDelete = await call(`/api/artboards/${kept}`, { cookie: author.cookie });
    assert.ok(afterDelete.status === 404 || afterDelete.body.deleted_at !== null, 'a board outlived the canvas it was on');

    await ok(`/api/pages/${page}`, { cookie: author.cookie, method: 'PATCH', body: { deleted_at: null } });
    const back = await call(`/api/artboards/${kept}`, { cookie: author.cookie });
    assert.equal(back.status, 200);
    assert.equal(back.body.deleted_at, null, 'restoring the canvas left its board in the trash');
    const stillGone = await call(`/api/artboards/${gone}`, { cookie: author.cookie });
    assert.ok(stillGone.status === 404 || stillGone.body.deleted_at !== null,
      'a board deleted before the canvas came back with it');
  });

  it('sends its boards to the people it is opened up to', async () => {
    // The colleague's device is up to date and has never been sent the board.
    const cursor = (await ok(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: colleague.cookie })).cursor;
    assert.ok(!(await pulled(colleague)).includes('Secret pricing'));

    await ok(`/api/pages/${shut}`, { cookie: author.cookie, method: 'PATCH', body: { access: 'workspace' } });

    // A delta pull from where the device stood. Without a fresh `seq` on the
    // board this is empty: the board's own row did not change.
    assert.ok((await pulled(colleague, cursor)).includes('Secret pricing'),
      'opening a canvas sent the page and not what is on it');
  });
});

describe('a canvas carried in a project export', () => {
  it('arrives with its boards, and its pins on the new boards', async () => {
    const project = await ok(`/api/workspaces/${workspace}/projects`, {
      cookie: author.cookie, body: { name: 'Sales', key: 'SAL' },
    });
    const page = (await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'Sales canvas', format: 'canvas', project_id: project.id },
    })).id;
    const original = (await board(author.cookie, page, 'Funnel', '<h1>Funnel</h1>')).id;
    await ok(`/api/workspaces/${workspace}/comments`, {
      cookie: author.cookie, body: { page_id: page, body: 'Too wide', anchor: { board: original, x: 10, y: 20 } },
    });

    const document = await ok(`/api/workspaces/${workspace}/projects/${project.id}/export`, { cookie: author.cookie });
    assert.equal(document.artboards.length, 1);
    const imported = await ok(`/api/workspaces/${workspace}/import/json`, {
      cookie: author.cookie, body: { document, name: 'Sales copy', key: 'SC' },
    });

    const pages = await ok(`/api/workspaces/${workspace}/pages?limit=500`, { cookie: author.cookie });
    const copy = (pages.items ?? pages).find((one: { title: string; project_id: string }) =>
      one.title === 'Sales canvas' && one.project_id === imported.project.id);
    assert.ok(copy, 'the canvas page did not come across');
    assert.equal(copy.format, 'canvas');
    const boards = await ok(`/api/workspaces/${workspace}/artboards?limit=500`, { cookie: author.cookie });
    const arrived = (boards.items ?? boards).filter((one: { page_id: string }) => one.page_id === copy.id);
    assert.deepEqual(arrived.map((one: { content: string }) => one.content), ['<h1>Funnel</h1>']);

    const comments = await ok(`/api/workspaces/${workspace}/comments?limit=500`, { cookie: author.cookie });
    const pinned = (comments.items ?? comments).find((one: { page_id: string }) => one.page_id === copy.id);
    assert.deepEqual(pinned.anchor, { board: arrived[0].id, x: 10, y: 20 },
      'the pin still named the board in the project it came from');
  });
});

describe('a canvas in a copied project', () => {
  it('arrives with its boards', async () => {
    const project = await ok(`/api/workspaces/${workspace}/projects`, {
      cookie: author.cookie, body: { name: 'Launch', key: 'LCH' },
    });
    const page = (await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'Launch canvas', format: 'canvas', project_id: project.id },
    })).id;
    await board(author.cookie, page, 'Timeline', '<h1>Timeline</h1>');
    const copied = await ok(`/api/workspaces/${workspace}/projects/${project.id}/copy`, {
      cookie: author.cookie, body: { name: 'Launch 2', key: 'LC2', include: { pages: true } },
    });
    assert.equal(copied.counts.artboards, 1);
    const pages = await ok(`/api/workspaces/${workspace}/pages?limit=500`, { cookie: author.cookie });
    const copy = (pages.items ?? pages).find((one: { project_id: string }) => one.project_id === copied.project.id);
    const boards = await ok(`/api/workspaces/${workspace}/artboards?limit=500`, { cookie: author.cookie });
    assert.deepEqual((boards.items ?? boards).filter((one: { page_id: string }) => one.page_id === copy.id)
      .map((one: { title: string }) => one.title), ['Timeline']);
  });
});

describe('a board\'s history', () => {
  it('keeps what a board said before each sitting, and puts it back', async () => {
    const page = (await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'History canvas', format: 'canvas' },
    })).id;
    const id = (await board(author.cookie, page, 'Plan', '<h1>v1</h1>')).id;
    const edit = (who: Person, content: string) =>
      ok(`/api/artboards/${id}`, { cookie: who.cookie, method: 'PATCH', body: { content } });

    await edit(author, '<h1>v2</h1>');
    // The same person, a moment later: the same sitting, so no second version.
    await edit(author, '<h1>v3</h1>');
    await edit(colleague, '<h1>v4</h1>');

    const versions = await ok(`/api/artboards/${id}/versions`, { cookie: author.cookie });
    assert.equal(versions.length, 2, 'a version per write is a history nobody can read');
    const said = await Promise.all(versions.map((version: { id: string }) =>
      ok(`/api/artboards/${id}/versions/${version.id}`, { cookie: author.cookie })));
    assert.deepEqual(said.map((version: { content: string }) => version.content), ['<h1>v3</h1>', '<h1>v1</h1>']);

    const restored = await ok(`/api/artboards/${id}/versions`, {
      cookie: author.cookie, body: { restore: versions[1].id },
    });
    assert.equal(restored.content, '<h1>v1</h1>');
    const after = await ok(`/api/artboards/${id}/versions`, { cookie: author.cookie });
    const newest = await ok(`/api/artboards/${id}/versions/${after[0].id}`, { cookie: author.cookie });
    assert.equal(newest.content, '<h1>v4</h1>', 'the state a restore replaced was lost');
  });

  it('is as private as the canvas', async () => {
    await ok(`/api/artboards/${secretBoard}`, { cookie: author.cookie, method: 'PATCH', body: { content: '<p>changed</p>' } });
    // The canvas was opened up by an earlier case; close it again for this one.
    await ok(`/api/pages/${shut}`, { cookie: author.cookie, method: 'PATCH', body: { access: 'private' } });
    assert.equal((await call(`/api/artboards/${secretBoard}/versions`, { cookie: colleague.cookie })).status, 403);
    const versions = await ok(`/api/artboards/${secretBoard}/versions`, { cookie: author.cookie });
    assert.ok(versions.length >= 1);
    assert.equal((await call(`/api/artboards/${secretBoard}/versions/${versions[0].id}`, { cookie: colleague.cookie })).status, 403);
    assert.equal((await call(`/api/artboards/${secretBoard}/versions`, {
      cookie: colleague.cookie, body: { restore: versions[0].id },
    })).status, 403);
  });
});

describe('a board in search', () => {
  const found = async (person: Person, words: string) =>
    JSON.stringify((await ok(`/api/workspaces/${workspace}/search?q=${encodeURIComponent(words)}`, { cookie: person.cookie })).results);

  it('is found by the words on it, not by its markup or its script', async () => {
    const page = (await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'Search canvas', format: 'canvas' },
    })).id;
    await board(author.cookie, page, 'Quarterly', '<div class="gridwombat"><h1>Pelicanforecast numbers</h1></div><script>var hiddenotter = 1</script>');
    assert.match(await found(author, 'pelicanforecast'), /"kind":"artboard"/);
    assert.doesNotMatch(await found(author, 'gridwombat'), /artboard/, 'a class name was indexed');
    assert.doesNotMatch(await found(author, 'hiddenotter'), /artboard/, 'a script was indexed');
  });

  it('is found only by those who may see its canvas', async () => {
    const page = (await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'Private search canvas', format: 'canvas', access: 'private' },
    })).id;
    await board(author.cookie, page, 'Salaries', '<p>Flamingosalary bands</p>');
    assert.match(await found(author, 'flamingosalary'), /artboard/);
    assert.doesNotMatch(await found(colleague, 'flamingosalary'), /artboard|Flamingo/i);
  });
});

describe('the frame a board is drawn in', () => {
  it('is served under its own policy, which runs scripts and reaches nothing', async () => {
    const response = await fetch(`${base}/artboard.html?v=test`);
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /(^|; )sandbox allow-scripts(;|$)/, 'without `sandbox` the frame shares the app\'s origin');
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(response.headers.get('x-frame-options'), null, 'DENY would stop the app framing it at all');
    assert.match(response.headers.get('cache-control') ?? '', /immutable/, 'offline, the HTTP cache is the only copy');
  });

  it('leaves every other file under the app\'s policy', async () => {
    const response = await fetch(`${base}/index.html`);
    assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.doesNotMatch(response.headers.get('content-security-policy') ?? '', /unsafe-inline' 'unsafe-eval/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  });
});
