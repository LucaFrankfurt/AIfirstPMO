/**
 * The box over everything: what it understands, and what it does with it.
 *
 * Two halves, and they are tested together on purpose. `parseTerms` reads what
 * somebody typed and lives in `@kolibri/shared` so the client can match its own
 * rows with it; `toMatchQuery` compiles the same terms into FTS5. The bug this
 * arrangement exists to prevent is the quiet one — the two drifting apart until
 * the list that appears while typing and the list that arrives from the server
 * are answers to different questions — so the grammar is pinned here, one floor
 * above, against the MATCH it actually produces.
 *
 * The third describe is the one that needed a database. `FEE-1` has to land on
 * FEE-1, and "first" is a claim about an ordering that only exists once there
 * are other rows to be ahead of.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-search-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { asIdentifier, matchesTerms, parseTerms, termsKey } = await import('@kolibri/shared');
const { searchWorkspace, toMatchQuery } = await import('../src/kernel/search/search.ts');

let base = '';
let workspaceId = '';
let cookie = '';
let projectId = '';
const tasks: Record<string, string> = {};

async function as(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${response.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'fee@example.com', name: 'Fee', password: 'correct horse battery' }),
  });
  cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  workspaceId = (await as('/api/session')).workspaces[0].id;

  projectId = (await as(`/api/workspaces/${workspaceId}/projects`, { name: 'Fees', key: 'FEE' })).id;
  const add = async (name: string, title: string, description = '') => {
    tasks[name] = (await as(`/api/workspaces/${workspaceId}/tasks`, { project_id: projectId, title, description })).id;
  };
  // FEE-1 is deliberately *not* the one whose text says the most about the
  // words in it: without the short cut, bm25 would rather have FEE-3.
  await add('one', 'Preise prüfen', 'Ein Design Review steht noch aus.');
  await add('two', 'Design überarbeiten', 'Review durch das Team, intern.');
  await add('three', 'Rechnungen', 'design review design review design review, alles intern');
});

after(() => {
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

/* ------------------------------------------------------------- the grammar */

describe('reading what was typed', () => {
  it('makes each word a term that is still being typed', () => {
    assert.deepEqual(parseTerms('des rev').map((term) => term.words), [['des'], ['rev']]);
    assert.ok(parseTerms('des').every((term) => term.prefix));
  });

  it('makes a quoted run one term, closed', () => {
    const [term] = parseTerms('"design review"');
    assert.deepEqual(term.words, ['design', 'review']);
    assert.equal(term.prefix, false);
  });

  it('keeps a quote that is still open usable', () => {
    // Every keystroke between the two quotes is a search somebody is watching.
    // Waiting for the closing quote would mean the list empties as soon as the
    // first one is typed, which reads as the feature being broken.
    const [term] = parseTerms('"design rev');
    assert.deepEqual(term.words, ['design', 'rev']);
    assert.equal(term.prefix, true);
  });

  it('reads a leading minus as "and not"', () => {
    const [word, not] = parseTerms('design -intern');
    assert.equal(word.negated, false);
    assert.equal(not.negated, true);
    assert.deepEqual(not.words, ['intern']);
    // A bare hyphen is a hyphen. Nothing follows it to exclude.
    assert.deepEqual(parseTerms('-'), []);
  });

  it('reads a task identifier as the two words it is, adjacent', () => {
    const [term] = parseTerms('fee-1');
    assert.equal(term.identifier, 'FEE-1');
    assert.deepEqual(term.words, ['fee', '1']);
    assert.equal(term.prefix, true);
  });

  it('only calls something an identifier if it is shaped like one', () => {
    assert.equal(asIdentifier('FEE-1'), 'FEE-1');
    assert.equal(asIdentifier('fee-1'), 'FEE-1');
    assert.equal(asIdentifier('FEE-1a'), null);
    assert.equal(asIdentifier('rechnung'), null);
    // `COVID-19` is identifier-shaped and is not one. Nothing here can tell —
    // which is why nothing here decides: the lookup does, and a workspace with
    // no `COVID` project simply finds no such task and searches the words.
    assert.equal(asIdentifier('COVID-19'), 'COVID-19');
  });

  it('tells a search from its opposite when it is used as a key', () => {
    assert.notEqual(termsKey(parseTerms('intern')), termsKey(parseTerms('-intern')));
    assert.equal(termsKey(parseTerms('"design review"')), termsKey(parseTerms(' "design review" ')));
  });
});

describe('matching a row that is already here', () => {
  it('wants every word, anywhere', () => {
    assert.ok(matchesTerms('WEB-12 Rechnung prüfen', parseTerms('rechnung web')));
    assert.ok(!matchesTerms('WEB-12 Rechnung prüfen', parseTerms('rechnung angebot')));
  });

  it('is not stopped by an accent or by case', () => {
    assert.ok(matchesTerms('Rechnung prüfen', parseTerms('PRUFEN')));
  });

  it('matches on a prefix, the way typing does', () => {
    assert.ok(matchesTerms('Design review', parseTerms('des rev')));
  });

  it('asks nothing of a search with no words in it', () => {
    assert.ok(matchesTerms('anything', parseTerms('   ')));
  });

  it('holds a single character to the start of a word', () => {
    assert.ok(matchesTerms('WEB-3 Grace notes', parseTerms('g')));
    assert.ok(!matchesTerms('WEB-3 Ship dark mode', parseTerms('g')));
    assert.ok(matchesTerms('WEB-1 Redesign the pricing page', parseTerms('web 1')));
  });

  it('wants a phrase adjacent and in order', () => {
    assert.ok(matchesTerms('Das Design Review ist am Montag', parseTerms('"design review"')));
    assert.ok(!matchesTerms('Review des Designs', parseTerms('"design review"')));
    // The hyphen is a boundary here exactly as it is in the index, so a phrase
    // finds the compound somebody wrote with one.
    assert.ok(matchesTerms('Das Design-Review läuft', parseTerms('"design review"')));
  });

  it('holds a quoted word to the whole word', () => {
    assert.ok(matchesTerms('Rechnungsprüfung offen', parseTerms('rechnung')));
    assert.ok(!matchesTerms('Rechnungsprüfung offen', parseTerms('"rechnung"')));
  });

  it('drops what an exclusion names', () => {
    assert.ok(matchesTerms('Design extern besprechen', parseTerms('design -intern')));
    assert.ok(!matchesTerms('Design intern besprechen', parseTerms('design -intern')));
  });

  it('finds a task by its identifier however it was typed', () => {
    assert.ok(matchesTerms('FEE-1 Preise prüfen', parseTerms('fee-1')));
    // Still a prefix, so the number being typed finds what it is the start of.
    assert.ok(matchesTerms('FEE-12 Preise prüfen', parseTerms('fee-1')));
    assert.ok(!matchesTerms('FEE-2 Preise prüfen', parseTerms('fee-1')));
  });
});

describe('what FTS5 is asked', () => {
  it('turns a word into a prefix term', () => {
    assert.equal(toMatchQuery('des rev'), '"des"* AND "rev"*');
  });

  it('turns a quoted run into a phrase', () => {
    assert.equal(toMatchQuery('"design review"'), '"design review"');
  });

  it('turns an identifier into a phrase that is still open at the end', () => {
    assert.equal(toMatchQuery('FEE-1'), '"fee 1"*');
  });

  it('puts exclusions in a NOT with the rest on the left of it', () => {
    assert.equal(toMatchQuery('design -intern'), '("design"*) NOT ("intern"*)');
    assert.equal(toMatchQuery('design -intern -entwurf'), '("design"*) NOT ("intern"* OR "entwurf"*)');
  });

  it('asks nothing at all for a query that is only exclusions', () => {
    // `NOT ("x"*)` with no left-hand side is an FTS5 syntax error, and
    // "everything except" is not a search anybody meant to run.
    assert.equal(toMatchQuery('-intern'), '');
    assert.equal(toMatchQuery('   '), '');
    assert.equal(toMatchQuery('"" ""'), '');
  });

  it('cannot be escaped out of by a quote in the text', () => {
    // A stray quote *opens* a phrase rather than closing the one being built,
    // and either way every word has been folded and split on non-word
    // characters before it gets here — so nothing that reaches the MATCH can
    // carry a `"` of its own, and an operator typed into the box is a word.
    assert.equal(toMatchQuery('a"b OR c'), '"a"* AND "b or c"*');
    assert.equal(toMatchQuery('x" OR title:y'), '"x"* AND "or title y"*');
  });
});

/* --------------------------------------------------------------- the index */

describe('searching a workspace', () => {
  let meId = '';

  before(async () => {
    meId = (await as('/api/session')).user.id;
  });

  it('finds a task by the words in it', () => {
    const hits = searchWorkspace(workspaceId, meId, 'preise');
    assert.ok(hits.some((hit) => hit.id === tasks.one), 'FEE-1 should be found by its title');
  });

  it('puts the task somebody named outright first', () => {
    const hits = searchWorkspace(workspaceId, meId, 'FEE-1');
    assert.equal(hits[0]?.id, tasks.one);
    // Once, not twice: the phrase the identifier compiles to matches that
    // task's own title, so it is earned as well as pinned.
    assert.equal(hits.filter((hit) => hit.id === tasks.one).length, 1);
  });

  it('does not care how the identifier was typed', () => {
    assert.equal(searchWorkspace(workspaceId, meId, 'fee-1')[0]?.id, tasks.one);
  });

  it('still searches the words beside it', () => {
    const hits = searchWorkspace(workspaceId, meId, 'FEE-1');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]?.id, tasks.one);
  });

  it('leaves an identifier nothing answers to as words', () => {
    // No task is called COVID-19, so nothing is pinned — and nothing says
    // COVID either, so nothing is found. The point is that it does not throw
    // and does not invent a hit.
    assert.deepEqual(searchWorkspace(workspaceId, meId, 'COVID-19'), []);
  });

  it('honours a phrase', () => {
    const loose = searchWorkspace(workspaceId, meId, 'design review').map((hit) => hit.id);
    const exact = searchWorkspace(workspaceId, meId, '"design review"').map((hit) => hit.id);
    // "Design überarbeiten / Review durch das Team" has both words and not the
    // phrase, so quoting is what tells the two searches apart.
    assert.ok(loose.includes(tasks.two), 'both words appear in FEE-2');
    assert.ok(!exact.includes(tasks.two), 'but never next to each other');
    assert.ok(exact.includes(tasks.one), 'FEE-1 says it as a phrase');
  });

  it('honours an exclusion', () => {
    const all = searchWorkspace(workspaceId, meId, 'review').map((hit) => hit.id);
    const some = searchWorkspace(workspaceId, meId, 'review -intern').map((hit) => hit.id);
    assert.ok(all.includes(tasks.three));
    assert.ok(!some.includes(tasks.three));
    assert.ok(some.includes(tasks.one));
  });

  it('weighs a word in a title above the same word in a body', () => {
    // FEE-3 says "design review" three times in its description; FEE-2 says
    // "Design" once, in its name. Ranked by body alone the repetition wins,
    // which is never what one typed word is after.
    const hits = searchWorkspace(workspaceId, meId, 'design').map((hit) => hit.id);
    assert.ok(hits.indexOf(tasks.two) < hits.indexOf(tasks.three), `expected FEE-2 above FEE-3, got ${hits.join(', ')}`);
  });

  it('answers nothing rather than everything when asked only what to leave out', () => {
    assert.deepEqual(searchWorkspace(workspaceId, meId, '-intern'), []);
  });
});
