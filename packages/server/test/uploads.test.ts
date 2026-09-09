/**
 * What a file does after it is uploaded.
 *
 * Two questions, and the second one is the one that bites: who may read it,
 * and what does a browser do with it when they do. The second answer is
 * different on disk and on an object store, and it should not be.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-uploads-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');

let base = '';

interface Person { cookie: string; workspace: string }

async function register(email: string): Promise<Person> {
  resetRateLimits();
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: email.split('@')[0], password: 'correct horse battery' }),
  });
  const session = await response.json() as any;
  return { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], workspace: session.workspaces[0].id };
}

const upload = (who: Person, name: string, mime: string, bytes: string) =>
  fetch(`${base}/api/workspaces/${who.workspace}/files`, {
    method: 'POST',
    headers: { cookie: who.cookie, 'content-type': mime, 'x-filename': name },
    body: bytes,
  });

let ada: Person;
let mallory: Person;

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ada = await register('ada@example.com');
  mallory = await register('mallory@example.com');
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

describe('a file somebody else uploaded', () => {
  it('is not readable from another workspace', async () => {
    const { hash, url } = await (await upload(ada, 'secret.png', 'image/png', 'ada-only-bytes')).json() as any;
    assert.ok(hash);
    const attempt = await fetch(`${base}${url}`, { headers: { cookie: mallory.cookie } });
    assert.equal(attempt.status, 403);
  });

  /**
   * Blobs are content-addressed, so two workspaces uploading identical bytes
   * share one row — and that row remembers whichever workspace got there
   * first. The second uploader must still be able to read what they uploaded:
   * they have the bytes, they are not learning anything by holding them.
   */
  it('does not lock the second uploader out of their own upload', async () => {
    const bytes = 'the same picture, sent by two people';
    await (await upload(ada, 'shared.png', 'image/png', bytes)).json();
    const mine = await (await upload(mallory, 'shared.png', 'image/png', bytes)).json() as any;

    const read = await fetch(`${base}${mine.url}`, { headers: { cookie: mallory.cookie } });
    assert.equal(read.status, 200, 'uploading a file somebody else already has must not make it unreadable');
  });
});

describe('what a browser is told to do with it', () => {
  it('renders a picture inline', async () => {
    const { url } = await (await upload(ada, 'photo.png', 'image/png', 'PNGDATA')).json() as any;
    const served = await fetch(`${base}${url}`, { headers: { cookie: ada.cookie } });
    assert.match(served.headers.get('content-disposition') ?? '', /^inline/);
    assert.equal(served.headers.get('content-type'), 'image/png');
  });

  /**
   * An SVG is a document that can carry script, and an uploader chooses its
   * content type. Served inline from the app's own origin that is stored XSS,
   * so it is a download with a neutral type and `nosniff` on top.
   */
  it('refuses to render an uploaded document, whatever type it claims', async () => {
    for (const [name, mime] of [['x.svg', 'image/svg+xml'], ['x.html', 'text/html'], ['x.xml', 'application/xml']]) {
      const { url } = await (await upload(ada, name, mime, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).json() as any;
      const served = await fetch(`${base}${url}`, { headers: { cookie: ada.cookie } });
      assert.match(served.headers.get('content-disposition') ?? '', /^attachment/, mime);
      assert.equal(served.headers.get('content-type'), 'application/octet-stream', mime);
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff', mime);
    }
  });

  /**
   * A filename ends up inside a response header, so a filename containing a
   * newline is a filename that writes headers. What matters is not that the
   * text is gone — `evil=1` is harmless as text — but that the characters
   * which end a header value are.
   */
  /**
   * The filename in `Content-Disposition` comes from the URL path, which is
   * percent-decoded — so `%0d%0a` is a line break inside a header value, which
   * is a way to write headers of one's own. (The upload header cannot carry
   * one: Node's parser rejects a raw newline before any of this code runs.
   * The path is the half that decodes, so the path is the half to test.)
   */
  it('cannot be made to write a header through the name in the URL', async () => {
    const { hash } = await (await upload(ada, 'photo.png', 'image/png', 'PNGDATA')).json() as any;
    const nasty = encodeURIComponent('a"; evil=1\r\nX-Injected: yes');
    const served = await fetch(`${base}/files/${hash}/${nasty}`, { headers: { cookie: ada.cookie } });

    assert.equal(served.status, 200);
    assert.equal(served.headers.get('x-injected'), null, 'a header was smuggled in');
    const value = served.headers.get('content-disposition') ?? '';
    assert.doesNotMatch(value, /[\r\n]/, 'no line break survives into the header');
    // The quote is what would end the quoted-string early, so it goes too.
    assert.equal(value.match(/"/g)?.length, 2, 'exactly the two quotes that delimit the name');
  });
});

/**
 * The object store hands out a signed URL instead of proxying the bytes, and
 * the browser then obeys whatever that URL says — so the URL has to say the
 * same thing the disk path would have.
 */
describe('the signed URL an object store hands out', () => {
  const config = { endpoint: 'https://s3.example.com', region: 'auto', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: true };

  it('does not offer to render a document inline', async () => {
    const { presignGet } = await import('../src/adapters/s3/s3.ts');
    const signed = presignGet(config, 'ab/cd/abcd.svg', 300, new Date(), 'x.svg', 'image/svg+xml');
    const params = new URL(signed).searchParams;
    assert.match(params.get('response-content-disposition') ?? '', /^attachment/);
    assert.equal(params.get('response-content-type'), 'application/octet-stream');
  });

  it('still renders a picture inline', async () => {
    const { presignGet } = await import('../src/adapters/s3/s3.ts');
    const params = new URL(presignGet(config, 'ab/cd/abcd.png', 300, new Date(), 'x.png', 'image/png')).searchParams;
    assert.match(params.get('response-content-disposition') ?? '', /^inline/);
    assert.equal(params.get('response-content-type'), 'image/png');
  });

  it('signs whatever it ends up saying', async () => {
    const { presignGet } = await import('../src/adapters/s3/s3.ts');
    const url = new URL(presignGet(config, 'ab/cd/abcd.svg', 300, new Date(), 'x.svg', 'image/svg+xml'));
    const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '');
    assert.equal(signed, 'host');
    // The overrides are query parameters, so they are inside the signature by
    // construction — a tampered one invalidates the whole URL.
    assert.ok(url.searchParams.get('X-Amz-Signature'));
    assert.ok(url.searchParams.toString().includes('response-content-type'));
  });
});

/**
 * Uploading the same file to the same place twice.
 *
 * The blob was already deduplicated and the `files` row with it; the
 * attachment was not, so a retried upload left the same picture in a task's
 * Files section twice. It matters because of where clients repeat: a task
 * create is an upsert on an id the caller chooses, so a retried report finds
 * its task and then hangs a second screenshot on it — and the only way around
 * that was an extra request per report asking whether the first one had
 * landed.
 *
 * The delete-and-upload-again case is the one to get right. Matching a
 * tombstone would make removing a file permanent for those exact bytes, which
 * is a worse bug than the duplicate this replaces.
 */
describe('uploading the same file to the same task twice', () => {
  let taskId = '';
  const BYTES = 'RIFF....WEBPthe very same screenshot';

  const attach = (who: Person, name: string, bytes = BYTES) =>
    fetch(`${base}/api/workspaces/${who.workspace}/files?task_id=${taskId}`, {
      method: 'POST',
      headers: { cookie: who.cookie, 'content-type': 'image/webp', 'x-filename': name },
      body: bytes,
    }).then((response) => response.json() as any);

  const attachments = async (who: Person) => {
    const response = await fetch(`${base}/api/workspaces/${who.workspace}/attachments?task_id=${taskId}`, {
      headers: { cookie: who.cookie },
    });
    return (await response.json() as any[]).filter((row) => !row.deleted_at);
  };

  before(async () => {
    const project = await fetch(`${base}/api/workspaces/${ada.workspace}/projects`, {
      method: 'POST',
      headers: { cookie: ada.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Retries', key: 'RET' }),
    }).then((r) => r.json() as any);
    taskId = await fetch(`${base}/api/workspaces/${ada.workspace}/tasks`, {
      method: 'POST',
      headers: { cookie: ada.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: project.id, title: 'a report that gets retried' }),
    }).then(async (r) => (await r.json() as any).id);
  });

  it('produces one attachment, not two', async () => {
    const first = await attach(ada, 'screenshot.webp');
    const second = await attach(ada, 'screenshot.webp');
    assert.equal(second.attachment.id, first.attachment.id, 'the retry made a second row');
    assert.equal((await attachments(ada)).length, 1, 'the task lists the same picture twice');
  });

  it('answers the retry as though it had done the work', async () => {
    // The caller cannot tell, and should not have to: same shape, same id, a
    // usable URL. Anything less and a client still needs a special case.
    const again = await attach(ada, 'screenshot.webp');
    assert.ok(again.attachment?.id, 'the retry came back without an attachment to point at');
    assert.equal(again.hash, (await attach(ada, 'screenshot.webp')).hash);
    assert.match(String(again.url), /^\/files\//);
  });

  it('still adds a row for different bytes under the same name', async () => {
    // The match is on the checksum, so the name is not what makes two uploads
    // the same upload — two files are very often both `screenshot.webp`.
    await attach(ada, 'screenshot.webp', 'RIFF....WEBPa different screenshot entirely');
    assert.equal((await attachments(ada)).length, 2, 'a genuinely different file was swallowed as a duplicate');
  });

  it('adds a row again after the first was detached', async () => {
    const [existing] = await attachments(ada);
    await fetch(`${base}/api/attachments/${existing.id}`, { method: 'DELETE', headers: { cookie: ada.cookie } });
    const before = (await attachments(ada)).length;

    const restored = await attach(ada, existing.name, BYTES);
    assert.notEqual(restored.attachment.id, existing.id, 'the deleted row came back instead of a new one');
    assert.equal(
      (await attachments(ada)).length, before + 1,
      'deleting a file made re-uploading it impossible — the worse half of this trade',
    );
  });

  it('does not reach across tasks, or across no task at all', async () => {
    // Same bytes, same workspace, a different target: a genuinely new
    // attachment. The match is on where the file hangs, not only on what it is.
    const project = await fetch(`${base}/api/workspaces/${ada.workspace}/projects`, {
      method: 'POST',
      headers: { cookie: ada.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Elsewhere', key: 'ELS' }),
    }).then((r) => r.json() as any);
    const elsewhere = await fetch(`${base}/api/workspaces/${ada.workspace}/tasks`, {
      method: 'POST',
      headers: { cookie: ada.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: project.id, title: 'another report' }),
    }).then(async (r) => (await r.json() as any).id);

    const attached = await fetch(`${base}/api/workspaces/${ada.workspace}/files?task_id=${elsewhere}`, {
      method: 'POST',
      headers: { cookie: ada.cookie, 'content-type': 'image/webp', 'x-filename': 'screenshot.webp' },
      body: BYTES,
    }).then((r) => r.json() as any);
    assert.ok(attached.attachment?.id, 'the same bytes on a different task got no row of their own');
    assert.equal(
      attached.attachment.task_id, elsewhere,
      'the second task was handed the first task’s attachment',
    );

    // And a bare upload still creates none, which is what makes an avatar an
    // avatar rather than an attachment to nothing.
    const bare = await upload(ada, 'loose.webp', 'image/webp', BYTES).then((r) => r.json() as any);
    assert.equal(bare.attachment, undefined, 'an upload with no target grew an attachment row');
  });
});
