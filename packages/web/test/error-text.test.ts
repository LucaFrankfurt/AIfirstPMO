// A failed request in the reader's language (WEB-14): the server writes English, fetch writes the browser's.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { before, describe, it } from 'node:test';
import { installBrowser } from './browser.ts';

installBrowser();

const { ApiError, api, errorText, isOffline } = await import('../src/kernel/sync/api.ts');
const { loadLocale, translate } = await import('../src/kernel/i18n/i18n.ts');

let answer: () => Response | Promise<Response> = () => new Response('{}');
Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async () => answer() });

const refused = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

before(async () => {
  assert.ok(await loadLocale('de'));
});

describe('a request that never reached the server', () => {
  it('says the network is unavailable rather than "Failed to fetch"', async () => {
    answer = () => { throw new TypeError('Failed to fetch'); };
    const error = await api.get('/api/session').then(() => null, (caught) => caught);
    assert.ok(error instanceof ApiError);
    assert.equal(error.message, 'Network unavailable');
    assert.equal(error.detail, 'Failed to fetch', 'the browser’s words are kept, not shown');
    assert.ok(isOffline(error));
  });

  it('says so in German too', () => {
    assert.equal(errorText('de', 0, 'offline', 'Failed to fetch'), 'Netzwerk nicht erreichbar');
  });
});

describe('a request the server refused', () => {
  it('keeps the server’s words as detail and its code', async () => {
    answer = () => refused(401, { error: 'unauthorized', message: 'Email or password is incorrect' });
    const error = await api.login('ada@example.com', 'wrong-password').then(() => null, (caught) => caught);
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'unauthorized');
    assert.equal(error.detail, 'Email or password is incorrect');
    assert.equal(error.message, 'Email or password is incorrect', 'an English reader gets the server’s own sentence');
  });

  it('shows a German reader German, by code and status', () => {
    const de = (status: number, code: string, detail: string): string => errorText('de', status, code, detail);
    assert.equal(de(401, 'unauthorized', 'Email or password is incorrect'), translate('de', 'error.unauthorized'));
    assert.equal(de(401, 'totp_required', 'A code from your authenticator is needed'), translate('de', 'error.totpRequired'));
    assert.equal(de(403, 'forbidden', 'Not allowed'), translate('de', 'error.forbidden'));
    assert.equal(de(404, 'not_found', 'Not found'), translate('de', 'error.notFound'));
    assert.equal(de(413, 'too_large', 'That archive unpacks to more than 50 MB'), translate('de', 'error.tooLarge'));
    assert.equal(de(429, 'rate_limited', 'Too many attempts — wait 60 seconds and try again'), translate('de', 'error.rateLimited'));
    assert.equal(de(500, 'internal_error', 'Something went wrong'), 'Da ist etwas schiefgelaufen');
    assert.equal(de(503, 'error', 'Service Unavailable'), translate('de', 'error.unavailable'));
    for (const status of [401, 403, 404, 429, 500, 503]) {
      assert.doesNotMatch(de(status, 'error', 'Some English sentence'), /English/, `${status} leaked the server's words`);
    }
  });

  it('keeps the server’s words where they name the problem', () => {
    assert.equal(errorText('de', 400, 'bad_request', 'Password must be at least 8 characters'), 'Nicht angenommen: Password must be at least 8 characters');
    assert.equal(errorText('de', 409, 'conflict', 'That email is already registered'), 'Nicht angenommen: That email is already registered');
    assert.equal(errorText('de', 502, 'ai_failed', 'quota exceeded'), 'Das Modell hat nicht geantwortet: quota exceeded');
  });

  it('never shows an empty message', () => {
    assert.equal(errorText('en', 400, 'error', ''), 'Something went wrong');
    assert.equal(errorText('de', 418, 'error', ''), 'Da ist etwas schiefgelaufen');
  });
});

describe('dates and numbers in the app’s language', () => {
  // Without a locale, Intl uses the browser's, so a German screen in an English browser read "March 2026".
  it('builds no Intl formatter without the app’s locale', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
    });
    const offenders = walk(src).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/new Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat)\(\s*(?:undefined\b|\))/g)]
        .map((match) => `${relative(src, file)}: ${match[0]}`));
    assert.deepEqual(offenders, []);
  });
});
