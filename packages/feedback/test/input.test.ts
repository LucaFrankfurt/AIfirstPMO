// Input validation, client-context sanitization and the multipart reader.
//
// Pure: no database, no session. Whether the reporter comes from the session and not
// from here is the app's integration test to make.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matches } from './helpers.ts';
import {
  parseFeedbackInput,
  sanitizeClientContext,
  readFeedbackForm,
  FeedbackInputError,
  DEFAULT_LIMITS,
  type FeedbackInput,
} from '../src/kernel/feedback/input.ts';
import { de } from '../src/kernel/feedback/messages.ts';

const KINDS = ['BUG', 'IDEE', 'SONSTIGES'] as const;
const png = (size = 100) => ({ bytes: new Uint8Array(size), contentType: 'image/png' });
const input = (over: Partial<FeedbackInput> = {}): FeedbackInput => ({
  kind: 'BUG',
  message: 'Etwas ist kaputt',
  clientContext: {},
  ...over,
});
const parse = (over: Partial<FeedbackInput> = {}) => parseFeedbackInput(input(over), { kinds: KINDS });

describe('parseFeedbackInput — message', () => {
  it('accepts a normal report and trims the message', () => {
    const parsed = parse({ message: '  Speichern geht nicht  ' });
    assert.equal(parsed.message, 'Speichern geht nicht');
    assert.equal(parsed.kind, 'BUG');
  });

  it('rejects an empty or whitespace-only message', () => {
    assert.throws(() => parse({ message: '' }), FeedbackInputError);
    assert.throws(() => parse({ message: '   \n  ' }), FeedbackInputError);
  });

  it('rejects a message past the length cap, accepts one at it', () => {
    assert.throws(() => parse({ message: 'x'.repeat(DEFAULT_LIMITS.maxMessageLength + 1) }), /too long/);
    assert.equal(
      parse({ message: 'x'.repeat(DEFAULT_LIMITS.maxMessageLength) }).message.length,
      DEFAULT_LIMITS.maxMessageLength,
    );
  });

  it('honours a custom limit', () => {
    assert.throws(
      () => parseFeedbackInput(input({ message: 'x'.repeat(11) }), { kinds: KINDS, limits: { maxMessageLength: 10 } }),
      /max\. 10/,
    );
  });

  it('does NOT sanitize the message itself — escaping belongs at the sink', () => {
    // Stripping markup here would corrupt a report that legitimately quotes HTML.
    assert.equal(parse({ message: '<script>alert(1)</script>' }).message, '<script>alert(1)</script>');
  });

  it('answers 400 and speaks the configured language', () => {
    const error = (() => {
      try {
        parseFeedbackInput(input({ message: '' }), { kinds: KINDS, messages: de });
      } catch (e) {
        return e as FeedbackInputError;
      }
    })();
    assert.equal(error?.status, 400);
    assert.equal(error?.message, 'Bitte beschreiben Sie kurz, worum es geht.');
  });
});

describe('parseFeedbackInput — kind', () => {
  for (const kind of KINDS) {
    it(`accepts ${kind}`, () => {
      assert.equal(parse({ kind }).kind, kind);
    });
  }

  it('rejects an unknown kind rather than defaulting to one', () => {
    assert.throws(() => parse({ kind: 'URGENT' }), /Unknown kind/);
    assert.throws(() => parse({ kind: '' }), FeedbackInputError);
  });

  it('is not fooled by an inherited Object property', () => {
    assert.throws(() => parse({ kind: 'constructor' }), FeedbackInputError);
    assert.throws(() => parse({ kind: 'toString' }), FeedbackInputError);
  });

  it('rejects a non-string kind', () => {
    assert.throws(() => parse({ kind: 42 as unknown as string }), FeedbackInputError);
  });
});

describe('parseFeedbackInput — screenshot', () => {
  it('accepts the formats the capture pipeline produces', () => {
    for (const contentType of ['image/webp', 'image/jpeg', 'image/png']) {
      assert.notEqual(parse({ screenshot: { bytes: new Uint8Array(10), contentType } }).screenshot, null);
    }
  });

  it('rejects a screenshot over the cap, accepts one at it', () => {
    assert.throws(() => parse({ screenshot: png(DEFAULT_LIMITS.maxScreenshotBytes + 1) }), /too large/);
    assert.notEqual(parse({ screenshot: png(DEFAULT_LIMITS.maxScreenshotBytes) }).screenshot, null);
  });

  it('rejects a non-image content type', () => {
    assert.throws(
      () => parse({ screenshot: { bytes: new Uint8Array(10), contentType: 'application/pdf' } }),
      /Unsupported image format/,
    );
  });

  it('drops an EMPTY screenshot part instead of failing the whole report', () => {
    const parsed = parse({ screenshot: png(0) });
    assert.equal(parsed.screenshot, null);
    assert.equal(parsed.message, 'Etwas ist kaputt');
  });

  it('treats an absent screenshot as a text-only report (the decline path)', () => {
    assert.equal(parse({ screenshot: null }).screenshot, null);
    assert.equal(parse().screenshot, null);
  });
});

describe('sanitizeClientContext', () => {
  it('keeps scalar browser facts as-is, including null', () => {
    const ctx = sanitizeClientContext({
      url: '/x',
      viewport: '800x600',
      devicePixelRatio: 2,
      online: false,
      connection: null,
    });
    assert.deepEqual(ctx, { url: '/x', viewport: '800x600', devicePixelRatio: 2, online: false, connection: null });
  });

  it('drops nested objects and arrays', () => {
    assert.deepEqual(sanitizeClientContext({ url: '/x', nested: { a: 1 }, list: [1, 2, 3] }), { url: '/x' });
  });

  it('caps the number of keys', () => {
    const huge = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'v']));
    assert.ok(Object.keys(sanitizeClientContext(huge)).length <= DEFAULT_LIMITS.maxContextKeys);
  });

  it('truncates an over-long string value', () => {
    const ctx = sanitizeClientContext({ userAgent: 'x'.repeat(100_000) });
    assert.ok((ctx.userAgent as string).length <= DEFAULT_LIMITS.maxContextValueLength);
  });

  it('drops absurdly long keys', () => {
    assert.deepEqual(sanitizeClientContext({ ['k'.repeat(200)]: 'v' }), {});
  });

  it('returns an empty object for non-object input rather than throwing', () => {
    assert.deepEqual(sanitizeClientContext(null), {});
    assert.deepEqual(sanitizeClientContext('a string'), {});
    assert.deepEqual(sanitizeClientContext([1, 2, 3]), {});
    assert.deepEqual(sanitizeClientContext(undefined), {});
  });
});

describe('readFeedbackForm', () => {
  function post(form: FormData, headers: Record<string, string> = {}) {
    return new Request('https://app.example/api/feedback', { method: 'POST', body: form, headers });
  }

  it('reads the fields the browser half sends', async () => {
    const form = new FormData();
    form.set('kind', 'BUG');
    form.set('message', 'kaputt');
    form.set('clientContext', JSON.stringify({ url: '/companies', viewport: '800x600' }));
    form.set('screenshot', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }), 'screenshot.webp');

    const read = await readFeedbackForm(post(form));
    assert.equal(read.kind, 'BUG');
    assert.equal(read.message, 'kaputt');
    assert.deepEqual(read.clientContext, { url: '/companies', viewport: '800x600' });
    assert.equal(read.screenshot?.contentType, 'image/webp');
    assert.deepEqual(Array.from(read.screenshot!.bytes), [1, 2, 3]);
  });

  it('never reads identity from the body — there is nowhere for it to land', async () => {
    const form = new FormData();
    form.set('kind', 'BUG');
    form.set('message', 'x');
    form.set('role', 'ADMIN');
    form.set('userId', 'someone-else');
    const read = await readFeedbackForm(post(form));
    assert.deepEqual(Object.keys(read).sort(), ['clientContext', 'kind', 'message', 'screenshot']);
  });

  it('tolerates a malformed or oversized client context — it must not cost the report', async () => {
    const broken = new FormData();
    broken.set('message', 'x');
    broken.set('clientContext', '{not json');
    assert.deepEqual((await readFeedbackForm(post(broken))).clientContext, {});

    const huge = new FormData();
    huge.set('message', 'x');
    huge.set('clientContext', JSON.stringify({ a: 'x'.repeat(DEFAULT_LIMITS.maxContextJsonLength) }));
    assert.deepEqual((await readFeedbackForm(post(huge))).clientContext, {});
  });

  it('treats a missing screenshot as none, and missing text fields as empty', async () => {
    const read = await readFeedbackForm(post(new FormData()));
    matches(read, { kind: '', message: '', screenshot: null });
  });

  it('refuses a declared body over the limit with 413, before reading it', async () => {
    const form = new FormData();
    form.set('message', 'x');
    const tooBig = String(DEFAULT_LIMITS.maxScreenshotBytes + DEFAULT_LIMITS.maxBodyOverheadBytes + 1);
    const error = await readFeedbackForm(post(form, { 'content-length': tooBig })).catch((e) => e);
    assert.ok(error instanceof FeedbackInputError);
    assert.equal(error.status, 413);
  });

  it('refuses an oversized screenshot part with 413', async () => {
    const form = new FormData();
    form.set('message', 'x');
    form.set('screenshot', new Blob([new Uint8Array(11)], { type: 'image/png' }), 's.png');
    const error = await readFeedbackForm(post(form), { limits: { maxScreenshotBytes: 10 } }).catch((e) => e);
    assert.equal(error.status, 413);
    assert.match(error.message, /too large/);
  });

  it('answers 400 for a body that is not a form', async () => {
    const req = new Request('https://app.example/api/feedback', {
      method: 'POST',
      body: 'nope',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    const error = await readFeedbackForm(req).catch((e) => e);
    assert.ok(error instanceof FeedbackInputError);
    assert.equal(error.status, 400);
  });
});
