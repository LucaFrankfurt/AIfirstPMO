/**
 * Which workspace a token is for, and that the page actually says so.
 *
 * The bug this pins was invisible by construction: two tokens on the same
 * screen, one pinned to a workspace with six projects and one to a workspace
 * with two, told apart by nothing the list rendered. Swapping them changed
 * every number in a report and raised no error anywhere, because a token
 * pinned to a workspace *is* the answer for any call that does not name one.
 *
 * `tokenScope` is the decision; the last case here is the one that made it a
 * function rather than an inline ternary — a token can outlive its owner's
 * membership, and the row still has to say something true about it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { tokenScope } from '../src/modules/operations/tokens.ts';

const KNOWN = [
  { id: 'f52c149b', name: 'Calendoora' },
  { id: '955e7b73', name: 'Getting started' },
];

describe('which workspace a token is for', () => {
  it('names the workspace it is pinned to', () => {
    assert.deepEqual(tokenScope('f52c149b', KNOWN), { kind: 'named', id: 'f52c149b', name: 'Calendoora' });
    assert.deepEqual(tokenScope('955e7b73', KNOWN), { kind: 'named', id: '955e7b73', name: 'Getting started' });
  });

  it('calls an unpinned token what it is: every workspace', () => {
    // The three ways the column arrives empty from the API and the store.
    for (const empty of [null, undefined, '']) {
      assert.deepEqual(tokenScope(empty, KNOWN), { kind: 'all' }, `for ${JSON.stringify(empty)}`);
    }
  });

  it('keeps a token whose workspace it cannot name, and keeps the id', () => {
    // Not a lookup failure to swallow: the row is a live credential its owner
    // may want to revoke, and the id is what they would search for.
    assert.deepEqual(tokenScope('a-workspace-since-left', KNOWN), { kind: 'other', id: 'a-workspace-since-left' });
  });

  it('does not fall back to the first workspace when the list is empty', () => {
    // A session that has not loaded yet must not silently claim the token
    // belongs somewhere. It reports `other`, and the id speaks for itself.
    assert.deepEqual(tokenScope('f52c149b', []), { kind: 'other', id: 'f52c149b' });
  });
});

describe('the settings page says it', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'modules', 'operations', 'routes', 'settings.tsx'),
    'utf8',
  );

  it('renders the scope on every token row', () => {
    // The row used to be prefix and scopes alone; the assertion is that the
    // workspace is in the same block, not merely that the helper is imported.
    const row = source.slice(source.indexOf('{tokens.map((token) => ('));
    assert.ok(row.includes('scopeLabel(token.workspace_id)'), 'the token row names its workspace');
    assert.ok(row.includes('{token.prefix}'), 'and still shows the prefix it is found by');
  });

  it('says where a new token will be bound before it is created', () => {
    assert.ok(source.includes("t('api.tokenBoundTo'"), 'the create form names the workspace');
  });
});
