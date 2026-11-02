// Client-context collection.
//
// The collector runs on whatever browser a reporter happens to have, so the property
// under test is mostly DEGRADATION: a missing API must yield a null field, never an
// exception that costs the whole report.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectClientContext } from '../src/adapters/capture/client-context.ts';

/** A minimal window stand-in; each test removes the piece it wants to see degrade. */
function fakeWindow(over: Record<string, unknown> = {}): Window & typeof globalThis {
  return {
    location: { href: 'https://setaside.de/companies/abc?tab=visits' },
    document: { title: 'Firma ABC' },
    innerWidth: 1440,
    innerHeight: 900,
    screen: { width: 2560, height: 1440 },
    devicePixelRatio: 2,
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone)',
      language: 'de-DE',
      onLine: true,
      connection: { effectiveType: '4g' },
    },
    ...over,
  } as unknown as Window & typeof globalThis;
}

describe('collectClientContext', () => {
  it('collects the fields that make a bug reproducible', () => {
    const ctx = collectClientContext(fakeWindow());
    assert.equal(ctx.url, 'https://setaside.de/companies/abc?tab=visits');
    assert.equal(ctx.title, 'Firma ABC');
    assert.equal(ctx.viewport, '1440x900');
    assert.equal(ctx.screen, '2560x1440');
    assert.equal(ctx.devicePixelRatio, 2);
    assert.equal(ctx.userAgent, 'Mozilla/5.0 (iPhone)');
    assert.equal(ctx.language, 'de-DE');
    assert.equal(ctx.online, true);
    assert.equal(ctx.connection, '4g');
    assert.match(ctx.clientTime ?? '', /^\d{4}-\d{2}-\d{2}T/);
    // The timezone comes from Intl, which is present in node too.
    assert.equal(typeof ctx.timezone, 'string');
  });

  it('degrades to null when the Network Information API is absent (Safari)', () => {
    const ctx = collectClientContext(fakeWindow({ navigator: { userAgent: 'Safari', language: 'de', onLine: true } }));
    assert.equal(ctx.connection, null);
    assert.equal(ctx.userAgent, 'Safari');
  });

  it('never throws when a getter blows up mid-collection', () => {
    // A locked-down or instrumented browser can make any of these throw; losing the
    // report over a diagnostic field would be absurd.
    //
    // defineProperty rather than a getter in the literal: an object spread READS the
    // getter, so a throwing one in the helper would blow up before the function under
    // test was ever called.
    const hostile = fakeWindow();
    Object.defineProperty(hostile, 'screen', {
      get() {
        throw new Error('blocked');
      },
    });

    assert.doesNotThrow(() => collectClientContext(hostile));
    const ctx = collectClientContext(hostile);
    assert.equal(ctx.screen, ''); // the one field degrades...
    assert.equal(ctx.viewport, '1440x900'); // ...and everything after it still collects
  });

  it('survives an almost-empty window object', () => {
    const ctx = collectClientContext({} as Window & typeof globalThis);
    assert.equal(ctx.url, '');
    assert.equal(ctx.connection, null);
    assert.equal(ctx.online, true);
  });

  it('collects NOTHING from storage or cookies', () => {
    // A deliberate absence, asserted so it stays absent: storage is a second,
    // unbounded data surface with its own consent story and a plausible route for
    // session material to end up in a ticket.
    const ctx = collectClientContext(
      fakeWindow({
        localStorage: { token: 'secret' },
        sessionStorage: { token: 'secret' },
        document: { title: 'X', cookie: 'session=secret' },
      }),
    );
    const serialized = JSON.stringify(ctx);
    assert.ok(!serialized.includes('secret'));
    assert.ok(!Object.keys(ctx).includes('cookie'));
    assert.ok(!Object.keys(ctx).includes('localStorage'));
  });
});
