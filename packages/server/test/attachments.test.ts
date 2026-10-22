/**
 * A file on something that is not a task, and getting rid of one.
 *
 * Two features and one fix, and the fix is the reason this file is long.
 *
 * Attachments could hang off a task, a page or a comment, and each of those was
 * a column — which meant the rule "an attachment is as private as whatever it
 * hangs on" had been written four times: in the pull filter, in the REST guard,
 * in `canSeeFile`, and in MCP's `findAttachment`. Two of the four had already
 * ended in a `return true` for a case their author had not thought of, both
 * recorded in `TODO.md`, and **the third was still wrong when this was
 * written**: `visibleRow` in `routes/entities.ts` read `row.task_id == null` as
 * "nothing to check", so `GET`, `PATCH` and `DELETE /api/attachments/:id` were
 * open to every member of the workspace for any file on a private page. The
 * name of the file, and the right to detach it.
 *
 * So the rule is now one function, `canSeeSubject`, and these cases ask it
 * through every door rather than through the function — which is the only
 * arrangement that would have caught the bug above. `page-files.test.ts` beside
 * this does the same for the bytes route and the pull.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-attachments-${process.pid}`;

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

/** Upload a byte or two against whatever the query string names. */
async function upload(cookie: string, query: string, name: string) {
  const response = await fetch(`${base}/api/workspaces/${workspace}/files?${query}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'text/csv', 'x-filename': name },
    // Distinct bytes per call: the hash is a checksum, so two identical uploads
    // would share one and a case would be asking about the wrong row.
    body: `name,count\n${name},1\n`,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function attach(cookie: string, query: string, name: string) {
  const result = await upload(cookie, query, name);
  if (result.status >= 400) throw new Error(`upload ${name}: ${result.status} ${result.body?.message ?? ''}`);
  return result.body as { hash: string; url: string; attachment: { id: string } };
}

let author: Person;
let colleague: Person;
let workspace = '';
/** A project everybody in the workspace is on. */
let open = '';
/** A project only its creator is on. */
let closed = '';

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

  author = await register('attach-author@example.com');
  workspace = (await ok('/api/session', { cookie: author.cookie })).workspaces[0].id;

  const invite = await ok(`/api/workspaces/${workspace}/invites`, {
    cookie: author.cookie, body: { role: 'member' },
  });
  colleague = await register('attach-colleague@example.com');
  await ok(`/api/invites/${invite.code}/accept`, { cookie: colleague.cookie, body: {} });

  open = (await ok(`/api/workspaces/${workspace}/projects`, {
    cookie: author.cookie, body: { name: 'Website', key: 'WEB' },
  })).id;
  closed = (await ok(`/api/workspaces/${workspace}/projects`, {
    cookie: author.cookie, body: { name: 'Acquisition', key: 'ACQ', visibility: 'private' },
  })).id;
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const newDecision = (projectId: string | null, question: string) =>
  ok(`/api/workspaces/${workspace}/decisions`, {
    cookie: author.cookie, body: { question, project_id: projectId, mode: 'majority' },
  });

describe('a file on a decision', () => {
  let decision = '';
  let file: Awaited<ReturnType<typeof attach>>;

  before(async () => {
    decision = (await newDecision(open, 'Which database?')).id;
    file = await attach(author.cookie, `subject=decision&subject_id=${decision}`, 'benchmarks.csv');
  });

  it('is stored under the generic pair, not under a column of its own', async () => {
    const row = await ok(`/api/attachments/${file.attachment.id}`, { cookie: author.cookie });
    assert.equal(row.subject_kind, 'decision');
    assert.equal(row.subject_id, decision);
    // The three named columns stay empty: exactly one of the five says where a
    // file hangs, which is what every reader depends on.
    assert.equal(row.task_id, null);
    assert.equal(row.page_id, null);
    assert.equal(row.comment_id, null);
  });

  it('comes back from the listing', async () => {
    const rows = await ok(`/api/workspaces/${workspace}/attachments`, { cookie: author.cookie });
    assert.ok(rows.some((row: any) => row.id === file.attachment.id && row.name === 'benchmarks.csv'));
  });

  it('serves its bytes to somebody who can see the decision', async () => {
    const response = await fetch(`${base}${file.url}`, { headers: { cookie: colleague.cookie } });
    assert.equal(response.status, 200);
  });

  it('is uploaded only once for the same bytes on the same decision', async () => {
    // The de-duplication `storeFile` does for tasks, asked of the generic pair:
    // a client that retries must not leave the decision listing the same file
    // twice. It is the reason the match includes the two new columns.
    const again = await attach(author.cookie, `subject=decision&subject_id=${decision}`, 'benchmarks.csv');
    assert.equal(again.attachment.id, file.attachment.id);
  });
});

describe('a file on a decision in a private project', () => {
  let decision = '';
  let file: Awaited<ReturnType<typeof attach>>;

  before(async () => {
    decision = (await newDecision(closed, 'Do we buy them?')).id;
    file = await attach(author.cookie, `subject=decision&subject_id=${decision}`, 'valuation.csv');
  });

  it('follows the decision, which follows its project', async () => {
    assert.equal((await fetch(`${base}${file.url}`, { headers: { cookie: author.cookie } })).status, 200);
    assert.equal((await fetch(`${base}${file.url}`, { headers: { cookie: colleague.cookie } })).status, 403);
  });

  it('is not in the listing a member who is not on the project asks for', async () => {
    const rows = await ok(`/api/workspaces/${workspace}/attachments`, { cookie: colleague.cookie });
    assert.ok(!rows.some((row: any) => row.id === file.attachment.id), 'a private project listed its files');
  });

  it('is not read, patched or deleted by that member either', async () => {
    const path = `/api/attachments/${file.attachment.id}`;
    assert.equal((await call(path, { cookie: colleague.cookie })).status, 403);
    assert.equal((await call(path, { cookie: colleague.cookie, method: 'PATCH', body: { name: 'mine.csv' } })).status, 403);
    assert.equal((await call(path, { cookie: colleague.cookie, method: 'DELETE' })).status, 403);
    // And it is still there afterwards, which is the half a 403 does not prove.
    assert.ok((await ok(path, { cookie: author.cookie })).id);
  });

  it('does not mirror to that member’s devices', async () => {
    const body = await ok(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: colleague.cookie });
    const names = (body.changes?.attachment ?? []).map((row: { name: string }) => row.name);
    assert.ok(!names.includes('valuation.csv'), 'the pull handed over the name and the hash');
    // The author's own pull still carries it: tightening the rule must not take
    // the ordinary case with it.
    const mine = await ok(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: author.cookie });
    assert.ok((mine.changes?.attachment ?? []).some((row: { name: string }) => row.name === 'valuation.csv'));
  });
});

describe('the door that was open', () => {
  /*
   * A file on a private page, over plain REST.
   *
   * `page_id` is set and `task_id` is not, which is exactly the shape
   * `visibleRow` read as "nothing to check". The bytes route and the pull had
   * both been fixed; this one had not, and it is the door that lets somebody
   * *delete* the file rather than merely read its name.
   */
  let file: Awaited<ReturnType<typeof attach>>;

  before(async () => {
    const page = await ok(`/api/workspaces/${workspace}/pages`, {
      cookie: author.cookie, body: { title: 'Notes to self', project_id: open, access: 'private' },
    });
    file = await attach(author.cookie, `page_id=${page.id}`, 'private.csv');
  });

  it('refuses to read the row to another member', async () => {
    assert.equal((await call(`/api/attachments/${file.attachment.id}`, { cookie: colleague.cookie })).status, 403);
  });

  it('refuses to let another member detach it', async () => {
    assert.equal(
      (await call(`/api/attachments/${file.attachment.id}`, { cookie: colleague.cookie, method: 'DELETE' })).status,
      403,
    );
    assert.ok((await ok(`/api/attachments/${file.attachment.id}`, { cookie: author.cookie })).id, 'it survived');
  });

  it('still lets its author detach it', async () => {
    await ok(`/api/attachments/${file.attachment.id}`, { cookie: author.cookie, method: 'DELETE' });
  });
});

describe('deleting an attachment', () => {
  let decision = '';
  let file: Awaited<ReturnType<typeof attach>>;

  before(async () => {
    decision = (await newDecision(open, 'Which host?')).id;
    file = await attach(author.cookie, `subject=decision&subject_id=${decision}`, 'quotes.csv');
  });

  it('takes the row out of the listing', async () => {
    await ok(`/api/attachments/${file.attachment.id}`, { cookie: author.cookie, method: 'DELETE' });
    const rows = await ok(`/api/workspaces/${workspace}/attachments`, { cookie: author.cookie });
    assert.ok(!rows.some((row: any) => row.id === file.attachment.id));
  });

  it('leaves the stored bytes alone, because they are shared', async () => {
    // The whole reason this is a tombstone on a row rather than a delete of a
    // blob: storage is content-addressed, so the same file on two things is one
    // blob with two rows. Removing it here must not take the other one with it.
    const response = await fetch(`${base}${file.url}`, { headers: { cookie: author.cookie } });
    assert.equal(response.status, 200, 'detaching a file deleted the bytes somebody else is using');
  });

  it('can be undone, which is what soft means', async () => {
    await ok(`/api/attachments/${file.attachment.id}`, {
      cookie: author.cookie, method: 'PATCH', body: { deleted_at: null },
    });
    const rows = await ok(`/api/workspaces/${workspace}/attachments`, { cookie: author.cookie });
    assert.ok(rows.some((row: any) => row.id === file.attachment.id), 'restore did not bring it back');
  });

  it('can be re-attached after being detached', async () => {
    /*
     * The same bytes, on the same decision, after a delete.
     *
     * `storeFile` matches an existing row on `deleted_at IS NULL` on purpose,
     * and this is the case that depends on it: matching the tombstone would
     * make deletion permanent for exactly those bytes, and "I removed it and
     * now it will not come back" is a worse bug than a duplicate.
     */
    await ok(`/api/attachments/${file.attachment.id}`, { cookie: author.cookie, method: 'DELETE' });
    const again = await attach(author.cookie, `subject=decision&subject_id=${decision}`, 'quotes.csv');
    assert.notEqual(again.attachment.id, file.attachment.id);
    assert.equal(again.hash, file.hash, 'the bytes are the same bytes');
  });
});

describe('a subject in the trash', () => {
  /*
   * An attachment inherits its subject's *visibility*, not its existence.
   *
   * Nothing cascades a delete to an attachment, so a file on a deleted decision
   * has to go on reaching the devices that hold it. The first draft of the pull
   * filter asked `deleted_at IS NULL` of the subject, which reads as tidy and
   * loses files: a device that first synced while the decision sat in the trash
   * would get the decision and none of its files, and restoring it would never
   * bring them — the attachment rows' `seq` has not moved, so that device is
   * never sent them again. `canSeeTask` and `canSeePage` record the same
   * decision, which is the one this had to match.
   */
  let decision = '';
  let file: Awaited<ReturnType<typeof attach>>;

  before(async () => {
    decision = (await newDecision(open, 'Which vendor?')).id;
    file = await attach(author.cookie, `subject=decision&subject_id=${decision}`, 'shortlist.csv');
    await ok(`/api/decisions/${decision}`, { cookie: author.cookie, method: 'DELETE' });
  });

  it('still mirrors its files, so a restore is not an empty one', async () => {
    const body = await ok(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: author.cookie });
    const names = (body.changes?.attachment ?? []).map((row: { name: string }) => row.name);
    assert.ok(names.includes('shortlist.csv'), 'a decision in the trash took its files out of the mirror');
  });

  it('still serves their bytes', async () => {
    assert.equal((await fetch(`${base}${file.url}`, { headers: { cookie: author.cookie } })).status, 200);
  });

  it('and still keeps them from somebody who could not see the decision', async () => {
    // The other half: ignoring deletion must not quietly widen the rule.
    const shut = (await newDecision(closed, 'Which vendor, privately?')).id;
    const hidden = await attach(author.cookie, `subject=decision&subject_id=${shut}`, 'private-shortlist.csv');
    await ok(`/api/decisions/${shut}`, { cookie: author.cookie, method: 'DELETE' });
    assert.equal((await fetch(`${base}${hidden.url}`, { headers: { cookie: colleague.cookie } })).status, 403);
    const body = await ok(`/api/sync/pull?workspace=${workspace}&since=0`, { cookie: colleague.cookie });
    const names = (body.changes?.attachment ?? []).map((row: { name: string }) => row.name);
    assert.ok(!names.includes('private-shortlist.csv'));
  });
});

describe('what may be attached to, and by whom', () => {
  it('refuses an upload against a decision the uploader cannot see', async () => {
    const decision = (await newDecision(closed, 'Secret question')).id;
    const refused = await upload(colleague.cookie, `subject=decision&subject_id=${decision}`, 'nosy.csv');
    assert.equal(refused.status, 403);
  });

  it('refuses a subject that is not something a file hangs on', async () => {
    const refused = await upload(author.cookie, `subject=workspace&subject_id=${workspace}`, 'odd.csv');
    assert.equal(refused.status, 400);
  });

  it('refuses an upload that names two things', async () => {
    const decision = (await newDecision(open, 'Which one?')).id;
    const task = await ok(`/api/workspaces/${workspace}/tasks`, {
      cookie: author.cookie, body: { title: 'Pick one', project_id: open },
    });
    const refused = await upload(
      author.cookie, `task_id=${task.id}&subject=decision&subject_id=${decision}`, 'both.csv',
    );
    assert.equal(refused.status, 400);
  });

  it('refuses an attachment row posted against a decision the writer cannot see', async () => {
    // The second door. `storeFile` is not the only way a row appears — a client
    // may post one, and a phone that was offline pushes the same row through
    // sync — so the refusal lives in the write path as well as on the upload.
    const decision = (await newDecision(closed, 'Also secret')).id;
    const refused = await call(`/api/workspaces/${workspace}/attachments`, {
      cookie: colleague.cookie,
      body: { subject_kind: 'decision', subject_id: decision, name: 'nosy.csv', url: '/files/x/nosy.csv' },
    });
    assert.equal(refused.status, 403);
  });

  it('refuses a subject that is in another workspace', async () => {
    /*
     * The second question the guard asks, and it is not implied by the first:
     * a private project refuses a stranger, but a product belongs to its whole
     * workspace — so somebody in two workspaces could otherwise file a row in
     * one against a row in the other. Nothing would see that row, which is the
     * reason to refuse rather than shrug.
     */
    const other = (await ok('/api/workspaces', {
      cookie: author.cookie, body: { name: 'Elsewhere' },
    })).workspace.id;
    const elsewhere = (await ok(`/api/workspaces/${other}/decisions`, {
      cookie: author.cookie, body: { question: 'Not here', mode: 'majority' },
    })).id;
    const refused = await call(`/api/workspaces/${workspace}/attachments`, {
      cookie: author.cookie,
      body: { subject_kind: 'decision', subject_id: elsewhere, name: 'astray.csv', url: '/files/x/astray.csv' },
    });
    assert.equal(refused.status, 400);
  });

  it('refuses an unknown subject_kind by name rather than writing a row nothing can see', async () => {
    const refused = await call(`/api/workspaces/${workspace}/attachments`, {
      cookie: author.cookie,
      body: { subject_kind: 'wombat', subject_id: 'x', name: 'odd.csv', url: '/files/x/odd.csv' },
    });
    assert.equal(refused.status, 400);
  });

  it('moves the generic spelling of a task onto its own column', async () => {
    /*
     * One spelling per attachment.
     *
     * `{subject_kind: 'task'}` and `{task_id}` would be the same attachment and
     * would not compare equal — the task's own Files section reads `task_id`,
     * and so does the export. A client asking the sensible thing is corrected
     * rather than refused, and is told what was written.
     */
    const task = await ok(`/api/workspaces/${workspace}/tasks`, {
      cookie: author.cookie, body: { title: 'Has a file', project_id: open },
    });
    const row = await ok(`/api/workspaces/${workspace}/attachments`, {
      cookie: author.cookie,
      body: { subject_kind: 'task', subject_id: task.id, name: 'moved.csv', url: '/files/x/moved.csv' },
    });
    assert.equal(row.task_id, task.id);
    assert.equal(row.subject_kind, null);
    assert.equal(row.subject_id, null);
  });

  it('never leaves a row with two links set', async () => {
    /*
     * The shape a `PATCH` can produce and the upload route cannot: naming a
     * generic subject on a row that still has its `task_id`. Exactly one of the
     * five columns may say where a file hangs, or the task's own Files section,
     * the project export and `storeFile`'s de-duplication each read a different
     * answer. The named column wins — which is what every reader of such a row
     * would answer anyway — and the stray pair is cleared rather than the write
     * being refused, because this one may be a row from a device that has been
     * away.
     */
    const task = await ok(`/api/workspaces/${workspace}/tasks`, {
      cookie: author.cookie, body: { title: 'Holds one file', project_id: open },
    });
    const decision = (await newDecision(open, 'Where does it go?')).id;
    const file = await attach(author.cookie, `task_id=${task.id}`, 'contested.csv');

    const patched = await ok(`/api/attachments/${file.attachment.id}`, {
      cookie: author.cookie, method: 'PATCH', body: { subject_kind: 'decision', subject_id: decision },
    });
    assert.equal(patched.task_id, task.id, 'the file left the task without being told to');
    assert.equal(patched.subject_kind, null);
    assert.equal(patched.subject_id, null);

    // And saying where to take it from does move it.
    const moved = await ok(`/api/attachments/${file.attachment.id}`, {
      cookie: author.cookie,
      method: 'PATCH',
      body: { task_id: null, subject_kind: 'decision', subject_id: decision },
    });
    assert.equal(moved.task_id, null);
    assert.equal(moved.subject_kind, 'decision');
    assert.equal(moved.subject_id, decision);
  });

  it('refuses moving a file onto something the mover cannot see', async () => {
    // A create-only check would miss this: the file starts somewhere legitimate
    // and is patched across.
    const mine = (await newDecision(open, 'Open question')).id;
    const theirs = (await newDecision(closed, 'Closed question')).id;
    const file = await attach(colleague.cookie, `subject=decision&subject_id=${mine}`, 'drift.csv');
    const refused = await call(`/api/attachments/${file.attachment.id}`, {
      cookie: colleague.cookie, method: 'PATCH', body: { subject_id: theirs },
    });
    assert.equal(refused.status, 403);
  });
});

describe('a decision that belongs to no project', () => {
  /*
   * The workspace's, which is the pull filter's reading of a null `project_id`
   * — and the case where `canSeeProject` answers `true` without being told
   * whose workspace it is. Every caller scopes by workspace before asking,
   * which is precisely what was true on the day that stopped being enough
   * (see `canSeeProject` in `repo.ts`), so the membership half is asked too.
   */
  let file: Awaited<ReturnType<typeof attach>>;

  before(async () => {
    const decision = (await newDecision(null, 'What do we call it?')).id;
    file = await attach(author.cookie, `subject=decision&subject_id=${decision}`, 'naming.csv');
  });

  it('reaches everybody in the workspace', async () => {
    assert.equal((await fetch(`${base}${file.url}`, { headers: { cookie: colleague.cookie } })).status, 200);
    const rows = await ok(`/api/workspaces/${workspace}/attachments`, { cookie: colleague.cookie });
    assert.ok(rows.some((row: any) => row.id === file.attachment.id));
  });

  it('and nobody outside it', async () => {
    resetRateLimits();
    const stranger = await call('/api/auth/register', {
      body: { email: 'attach-stranger@example.com', name: 'stranger', password: 'correct horse battery' },
    });
    const cookie = stranger.setCookie!.split(';')[0];
    assert.equal((await fetch(`${base}${file.url}`, { headers: { cookie } })).status, 403);
  });
});

describe('what must not change', () => {
  it('a file on a task still behaves exactly as it did', async () => {
    const task = await ok(`/api/workspaces/${workspace}/tasks`, {
      cookie: author.cookie, body: { title: 'Still works', project_id: open },
    });
    const file = await attach(author.cookie, `task_id=${task.id}`, 'ordinary.csv');
    const row = await ok(`/api/attachments/${file.attachment.id}`, { cookie: author.cookie });
    assert.equal(row.task_id, task.id);
    assert.equal(row.subject_kind, null);
    assert.equal((await fetch(`${base}${file.url}`, { headers: { cookie: colleague.cookie } })).status, 200);
  });

  it('bytes that hang off nothing are still served to the workspace', async () => {
    // An avatar, a workspace logo, an image pasted into a chat message: stored
    // with no attachment row at all, and there is no narrower rule available
    // for them than workspace membership.
    const file = await attach(author.cookie, 'x=1', 'loose.csv');
    assert.equal((await fetch(`${base}${file.url}`, { headers: { cookie: colleague.cookie } })).status, 200);
  });
});
