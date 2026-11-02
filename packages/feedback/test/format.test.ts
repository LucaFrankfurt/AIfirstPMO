// Formatting tests (test plan A.2, A.10).
//
// These used to be SECURITY tests, and it is worth saying why they no longer are.
// Vikunja stored descriptions as HTML, so the reporter's free text was untrusted input
// into an HTML sink and every value had to be escaped here. Kolibri's renderer escapes
// everything itself before it emits markup (verified against the instance, §B8), so
// escaping again would double-escape and the reporter would read `&lt;div&gt;` in their
// own bug report.
//
// What is left is STRUCTURAL: a reporter must not be able to rearrange the ticket with
// a stray `|`, `#` or ``` — the consequence of failure is a report nobody can read
// rather than a script nobody expected. The tests below assert exactly that, and no
// more, because claiming a layout control is a security control is how a real gap gets
// papered over later.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { routeOf, buildTitle, buildDescriptionMarkdown, fenceFor, kindLabel } from '../src/kernel/feedback/format.ts';
import type { FeedbackReport } from '../src/kernel/feedback/types.ts';
import { de, en } from '../src/kernel/feedback/messages.ts';

/** The kinds and labels of the first consumer, which defines its own (German) kind keys. */
const KIND_LABELS = { BUG: 'Bug', IDEE: 'Idee', SONSTIGES: 'Sonstiges' };

function report(over: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    id: 'rep-1',
    kind: 'BUG',
    message: 'Der Speichern-Button reagiert nicht.',
    reporter: { id: 'u-1', name: 'Max Mustermann', role: 'SALES_REP' },
    serverContext: [
      ['Agentur', 'Agentur Nord'],
      ['Aktiver Kontext (Membership)', 'mem-1'],
    ],
    client: {
      url: 'https://setaside.de/companies/abc?tab=visits',
      title: 'Firma ABC',
      viewport: '1440x900',
      userAgent: 'Mozilla/5.0 (X11)',
      timezone: 'Europe/Berlin',
      online: true,
      connection: '4g',
    },
    attachments: [],
    createdAt: new Date('2026-08-12T10:00:00.000Z'),
    ...over,
  };
}

describe("buildDescriptionMarkdown — the reporter's text is data, not markup", () => {
  it("does NOT escape — Kolibri's renderer does that, and doing it twice is visible to the reporter", () => {
    const md = buildDescriptionMarkdown(report({ message: '<img src=x onerror=alert(1)>' }));
    // The exact characters the reporter typed, unmangled. Kolibri renders them as text.
    assert.ok(md.includes('<img src=x onerror=alert(1)>'));
    assert.ok(!md.includes('&lt;'));
  });

  it('wraps the free text in a fence so markdown in it cannot restyle the ticket', () => {
    const md = buildDescriptionMarkdown(report({ message: '# nicht meine Überschrift\n**fett**' }));
    assert.ok(md.includes('```text\n# nicht meine Überschrift\n**fett**\n```'));
  });

  it("preserves newlines in the reporter's text (reproduction steps are lines)", () => {
    const md = buildDescriptionMarkdown(report({ message: '1. öffnen\n2. klicken\n3. nichts' }));
    assert.ok(md.includes('1. öffnen\n2. klicken\n3. nichts'));
  });

  it('lengthens the fence when the reporter pasted a fenced snippet of their own', () => {
    // Otherwise their ``` closes ours and the rest of the report renders as markup.
    const md = buildDescriptionMarkdown(report({ message: 'so:\n```js\nfoo()\n```' }));
    assert.ok(md.includes('````text\nso:\n```js\nfoo()\n```\n````'));
  });

  it('escapes a pipe in a context value so it cannot split a table cell', () => {
    const md = buildDescriptionMarkdown(report({ client: { userAgent: 'Mozilla | evil | row' } }));
    assert.ok(md.includes('Mozilla \\| evil \\| row'));
  });

  it('collapses a newline in a context value — it would end the table row', () => {
    const md = buildDescriptionMarkdown(report({ client: { title: 'Zeile eins\nZeile zwei' } }));
    assert.ok(md.includes('| Page title | Zeile eins Zeile zwei |'));
    // The row must still be exactly one line.
    assert.equal(md.split('\n').filter((line) => line.includes('Zeile eins')).length, 1);
  });
});

describe('fenceFor', () => {
  it('uses three backticks for ordinary text', () => {
    assert.equal(fenceFor('nur text'), '```');
  });

  it('always exceeds the longest run in the text', () => {
    assert.equal(fenceFor('a ``` b'), '````');
    assert.equal(fenceFor('a ````` b'), '``````');
    // A single backtick is not a fence and must not lengthen ours.
    assert.equal(fenceFor('`code`'), '```');
  });
});

describe('buildDescriptionMarkdown — content', () => {
  it('separates server-derived from client-reported context, and labels the latter', () => {
    const md = buildDescriptionMarkdown(report());
    assert.ok(md.includes('Context (determined server-side)'));
    assert.ok(md.includes('Context (reported by the client — not verified)'));
    // Order matters: the reporter's own words come first.
    assert.ok(md.indexOf('Description') < md.indexOf('server-side'));
    assert.ok(md.indexOf('server-side') < md.indexOf('reported by the client'));
  });

  it('emits both context blocks as tables Kolibri actually renders', () => {
    const md = buildDescriptionMarkdown(report());
    // The delimiter row is what makes Kolibri treat it as a table at all.
    assert.equal(md.match(/^\| --- \| --- \|$/gm)?.length, 2);
  });

  it("renders the app's server facts in the TRUSTED table, in the order given", () => {
    const md = buildDescriptionMarkdown(report());
    const trusted = md.slice(md.indexOf('server-side'), md.indexOf('reported by the client'));
    assert.ok(trusted.includes('| Agentur | Agentur Nord |'));
    assert.ok(trusted.includes('| Aktiver Kontext (Membership) | mem-1 |'));
    assert.ok(trusted.indexOf('Agentur') < trusted.indexOf('Membership'));
    // Reporter first, ids last — the app's facts sit between them.
    assert.ok(trusted.indexOf('Reported by') < trusted.indexOf('Agentur'));
    assert.ok(trusted.indexOf('Membership') < trusted.indexOf('Report ID'));
  });

  it("shows a null server fact as '—' rather than omitting the row", () => {
    const md = buildDescriptionMarkdown(report({ serverContext: [['Aktiver Kontext (Membership)', null]] }));
    // "no active membership" is a fact worth seeing, not a forgotten field.
    assert.ok(md.includes('| Aktiver Kontext (Membership) | — |'));
  });

  it('names the reporter with their role, or alone when there is none', () => {
    assert.ok(buildDescriptionMarkdown(report()).includes('| Reported by | Max Mustermann (SALES_REP) |'));
    assert.ok(
      buildDescriptionMarkdown(report({ reporter: { id: 'u-1', name: 'Max' } })).includes('| Reported by | Max |'),
    );
  });

  it('includes the report id and the server timestamp', () => {
    const md = buildDescriptionMarkdown(report());
    assert.ok(md.includes('rep-1'));
    assert.ok(md.includes('2026-08-12T10:00:00.000Z'));
  });

  it('falls back to a placeholder when the message is empty', () => {
    assert.ok(buildDescriptionMarkdown(report({ message: '  ' })).includes('(no description)'));
  });

  it('omits the backlink entirely when the report carries none', () => {
    assert.ok(!buildDescriptionMarkdown(report()).includes(']('));
    assert.ok(!buildDescriptionMarkdown(report({ backlink: null })).includes(']('));
  });

  it("links back to the app with the report's own label", () => {
    const md = buildDescriptionMarkdown(
      report({ backlink: { url: 'https://app.setaside.de/feedback', label: 'Report in SetAside öffnen' } }),
    );
    assert.ok(md.includes('[Report in SetAside öffnen](https://app.setaside.de/feedback)'));
  });

  it('falls back to a generic link text', () => {
    const md = buildDescriptionMarkdown(report({ backlink: { url: 'https://app.example/feedback' } }));
    assert.ok(md.includes('[Open report in the app](https://app.example/feedback)'));
  });
});

describe('buildTitle', () => {
  it('front-loads kind and route so a ticket list is scannable', () => {
    assert.equal(
      buildTitle(report(), { kindLabels: KIND_LABELS }),
      '[Bug] /companies/abc?tab=visits — Der Speichern-Button reagiert nicht.',
    );
  });

  it("uses the app's label for each of its kinds", () => {
    assert.ok(buildTitle(report({ kind: 'IDEE' }), { kindLabels: KIND_LABELS }).includes('[Idee]'));
    assert.ok(buildTitle(report({ kind: 'SONSTIGES' }), { kindLabels: KIND_LABELS }).includes('[Sonstiges]'));
  });

  it("falls back to the default kinds' labels, then to the raw kind", () => {
    assert.ok(buildTitle(report({ kind: 'IDEA' })).includes('[Idea]'));
    assert.ok(buildTitle(report({ kind: 'IDEA' }), { messages: de }).includes('[Idee]'));
    assert.ok(buildTitle(report({ kind: 'URGENT' })).includes('[URGENT]'));
  });

  it('collapses newlines, so a multi-line message cannot break the title', () => {
    const title = buildTitle(report({ message: 'kaputt\n\nsehr kaputt' }));
    assert.ok(!title.includes('\n'));
    assert.ok(title.includes('kaputt sehr kaputt'));
  });

  it('truncates a very long message and stays within the length cap', () => {
    const title = buildTitle(report({ message: 'x'.repeat(500) }));
    assert.ok(title.length <= 200);
    assert.ok(title.includes('…'));
  });

  it('falls back to a placeholder when the message is empty', () => {
    assert.ok(buildTitle(report({ message: '   ' })).includes('(no description)'));
  });

  it('drops the route when the client reported no usable URL', () => {
    assert.equal(buildTitle(report({ client: {} })), '[Bug] Der Speichern-Button reagiert nicht.');
  });

  it('uses the configured language for the placeholder', () => {
    assert.ok(buildTitle(report({ message: '' }), { messages: de }).includes('(ohne Beschreibung)'));
  });
});

describe('routeOf', () => {
  it('keeps path and query — they are the filter/id state a bug needs to reproduce', () => {
    assert.equal(routeOf('https://setaside.de/companies?status=LEAD&page=2'), '/companies?status=LEAD&page=2');
  });

  it('drops the origin, so the route reads the same from any environment', () => {
    assert.equal(routeOf('http://localhost:3000/kanban'), '/kanban');
  });

  it('accepts a bare path (a relative report)', () => {
    assert.equal(routeOf('/tasks'), '/tasks');
  });

  it('returns empty for junk rather than guessing', () => {
    assert.equal(routeOf('not a url'), '');
    assert.equal(routeOf(undefined), '');
  });
});

describe('kindLabel', () => {
  it("prefers the app's label, then the messages, then the raw value", () => {
    assert.equal(kindLabel('IDEE', { kindLabels: KIND_LABELS }), 'Idee');
    assert.equal(kindLabel('OTHER', { messages: de }), 'Sonstiges');
    assert.equal(kindLabel('CUSTOM'), 'CUSTOM');
  });
});

describe('buildDescriptionMarkdown — German', () => {
  it('labels every block and row in German when asked', () => {
    const md = buildDescriptionMarkdown(report(), { messages: de });
    assert.ok(md.includes('**Beschreibung**'));
    assert.ok(md.includes('Kontext (serverseitig ermittelt)'));
    assert.ok(md.includes('Kontext (clientseitig gemeldet — nicht verifiziert)'));
    assert.ok(md.includes('| Feld | Wert |'));
    assert.ok(md.includes('| Gemeldet von | Max Mustermann (SALES_REP) |'));
    assert.ok(md.includes('| Online | ja |'));
    assert.ok(!md.includes('Reported by'));
  });

  it('defaults to English', () => {
    assert.equal(buildDescriptionMarkdown(report()), buildDescriptionMarkdown(report(), { messages: en }));
  });
});
