/**
 * The bytes behind a private page, and who may fetch them.
 *
 * A page is the one row that can be private without its project being private:
 * `access: 'private'` means its author and nobody else. Three doors already knew
 * that — the REST guard in `routes/entities.ts`, the pull filter in `sync.ts`,
 * and `canSeePage` over MCP — and the fourth did not. `canSeeFile` walked the
 * attachment rows, answered for a task-bound one and fell off the end with
 * `return true` for a page-bound one, so `GET /files/:hash/*` handed the
 * screenshot inside somebody's private page to any member of the workspace who
 * had the hash.
 *
 * That is the shape the repository has been bitten by twice: the same question
 * answered differently depending on which door you came through. It is why the
 * rule now lives once, in `repo.ts`, beside `canSeeTask` and `canSeeBudget` —
 * and why this file asks it through the door that was wrong rather than through
 * the function.
 *
 * The hash is not a secret and must not be treated as one. It is a checksum of
 * the content, it appears in the page body, it is in the browser's cache and in
 * an access log, and two people uploading the same image get the same one. A
 * rule that rests on nobody guessing it is not a rule.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-page-files-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';

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

/** Upload a byte or two against a page, and answer with its hash. */
async function attach(cookie: string, workspace: string, query: string, name: string): Promise<string> {
  const response = await fetch(`${base}/api/workspaces/${workspace}/files?${query}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'image/webp', 'x-filename': name },
    // Distinct bytes per call: the hash is a checksum, so two identical uploads
    // would share one and the test would be asking about the wrong row.
    body: Buffer.from(`RIFF....WEBPVP8 ${name}`),
  });
  if (!response.ok) throw new Error(`upload ${name}: ${response.status}`);
  return (await response.json() as { hash: string }).hash;
}

const fetchFile = (hash: string, cookie: string) =>
  fetch(`${base}/files/${hash}/shot.webp`, { headers: { cookie } });

let author: Person;
let colleague: Person;
let outsider: Person;
let workspace = '';
let project = '';

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

  author = await register('page-files-author@example.com');
  workspace = (await ok('/api/session', { cookie: author.cookie })).workspaces[0].id;

  // A member of the workspace, so the only thing left between them and the
  // bytes is the page's own `access` column — which is the whole question.
  const invite = await ok(`/api/workspaces/${workspace}/invites`, {
    cookie: author.cookie, body: { role: 'member' },
  });
  colleague = await register('page-files-colleague@example.com');
  await ok(`/api/invites/${invite.code}/accept`, { cookie: colleague.cookie, body: {} });

  outsider = await register('page-files-outsider@example.com');

  project = (await ok(`/api/workspaces/${workspace}/projects`, {
    cookie: author.cookie, body: { name: 'Handbook', key: 'HB' },
  })).id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('an attachment on a private page', () => {
  let hash = '';

  before(async () => {
    const page = await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie,
      body: { title: 'Notes to self', project_id: project, access: 'private' },
    });
    hash = await attach(author.cookie, workspace, `page_id=${page.id}`, 'private.webp');
  });

  it('is fetched by its author', async () => {
    assert.equal((await fetchFile(hash, author.cookie)).status, 200);
  });

  it('is refused to another member of the same workspace', async () => {
    // The disclosure this file exists for. `canSeeFile` used to fall off the
    // end of its own walk and answer `true` here.
    assert.equal((await fetchFile(hash, colleague.cookie)).status, 403);
  });

  it('is refused to somebody outside the workspace', async () => {
    assert.equal((await fetchFile(hash, outsider.cookie)).status, 403);
  });
});

describe('an attachment on a page in a private project', () => {
  let hash = '';

  before(async () => {
    const closed = await ok(`/api/workspaces/${workspace}/projects`, {
      cookie: author.cookie, body: { name: 'Acquisition', key: 'ACQ', visibility: 'private' },
    });
    const page = await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'Term sheet', project_id: closed.id },
    });
    hash = await attach(author.cookie, workspace, `page_id=${page.id}`, 'closed.webp');
  });

  it('is fetched by somebody on the project', async () => {
    assert.equal((await fetchFile(hash, author.cookie)).status, 200);
  });

  it('is refused to a member who is not on it', async () => {
    // The second half of the rule, and the one `guardProject` gets right for
    // every other row: a page with no `access` of its own still follows its
    // project.
    assert.equal((await fetchFile(hash, colleague.cookie)).status, 403);
  });
});

describe('an attachment on a comment on a private page', () => {
  let hash = '';

  before(async () => {
    const page = await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie,
      body: { title: 'Draft', project_id: project, access: 'private' },
    });
    const comment = await ok(`/api/workspaces/${workspace}/comments`, {
      cookie: author.cookie, body: { page_id: page.id, body: 'see the screenshot' },
    });
    hash = await attach(author.cookie, workspace, `comment_id=${comment.id}`, 'comment.webp');
  });

  it('follows the page the comment is on', async () => {
    // A comment with no `task_id` used to answer `true` unconditionally, for
    // the same reason the page branch did.
    assert.equal((await fetchFile(hash, author.cookie)).status, 200);
    assert.equal((await fetchFile(hash, colleague.cookie)).status, 403);
  });
});

describe('the row, not only the bytes', () => {
  /*
   * The other half of the same disclosure, and the reason it is worth its own
   * cases: the attachment *row* carries the filename, the size and the hash.
   * Mirroring it to every device in the workspace tells everybody what is
   * attached to somebody's private page and hands them the hash to try — which
   * is a disclosure even now that the hash no longer opens the door.
   */
  before(async () => {
    const shut = await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'Salary bands', project_id: project, access: 'private' },
    });
    const open = await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'Team charter', project_id: project },
    });
    await attach(author.cookie, workspace, `page_id=${shut.id}`, 'bands.webp');
    await attach(author.cookie, workspace, `page_id=${open.id}`, 'charter.webp');
  });

  /*
   * Matched on `name` rather than on the hash, because an attachment row does
   * not carry one: the registry lists `url`, and the checksum only appears
   * inside it. The filename is also the more honest thing to assert on — it is
   * what actually leaks.
   */
  const pulled = async (person: Person): Promise<string[]> => {
    const body = await ok(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: person.cookie });
    return (body.changes?.attachment ?? []).map((row: { name: string }) => row.name);
  };

  it('mirrors an attachment on a private page only to its author', async () => {
    assert.ok((await pulled(author)).includes('bands.webp'));
    assert.ok(!(await pulled(colleague)).includes('bands.webp'), 'a private page listed its files to the workspace');
  });

  it('still mirrors one on a page everybody may read', async () => {
    assert.ok((await pulled(colleague)).includes('charter.webp'));
  });
});

describe('what must not change', () => {
  it('a page everybody may read is still readable by everybody', async () => {
    // The regression that matters more than the fix: tightening this rule must
    // not take the ordinary case with it. Almost every page is this one.
    const page = await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'Onboarding', project_id: project },
    });
    const hash = await attach(author.cookie, workspace, `page_id=${page.id}`, 'open.webp');
    assert.equal((await fetchFile(hash, colleague.cookie)).status, 200);
  });

  it('an attachment that hangs off nothing is still served', async () => {
    // Bytes with no attachment row are the avatar and the workspace logo. They
    // answered `true` before and have to go on doing so.
    const hash = await attach(author.cookie, workspace, 'x=1', 'loose.webp');
    assert.equal((await fetchFile(hash, colleague.cookie)).status, 200);
  });
});
