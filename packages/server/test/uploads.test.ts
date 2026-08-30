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
