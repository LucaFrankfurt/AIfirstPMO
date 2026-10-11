/**
 * Which writes make a selector run again.
 *
 * There used to be one counter for the whole cache, so the answer was "all of
 * them": typing a character into a task title re-scanned the labels, the
 * states, the cycles and the vendors, and handed every caller a freshly
 * allocated array — which invalidated whatever `useMemo` downstream was keyed
 * on it. The counters are per table now, and which tables a selector reads is
 * observed while it runs rather than declared by its caller.
 *
 * `query` is the memo without the hook, which is what these drive. The hook is
 * three lines of React around it, and `sync.test.ts` exercises the whole thing
 * end to end through the real store.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { crdt } from '@kolibri/shared';
import { installBrowser } from './browser.ts';

installBrowser();

const { applyChanges, byId, list, listAll, patchLocal, query, reset, tables } = await import('../src/kernel/sync/store');

/** A selector with a call counter on it, so "did it run again" is a number. */
function counted<T>(select: () => T): (() => T) & { runs: number } {
  const fn = (() => { fn.runs += 1; return select(); }) as (() => T) & { runs: number };
  fn.runs = 0;
  return fn;
}

const task = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, state_id: 's1', workspace_id: 'w', ...extra });

beforeEach(() => {
  reset();
  applyChanges({ task: [task('t1'), task('t2')], state: [{ id: 's1', name: 'Todo', group_key: 'unstarted' }] } as any);
});

describe('a selector runs again only for what it read', () => {
  it('does not run again when nothing has changed', () => {
    const select = counted(() => list('task'));
    query(select);
    query(select);
    assert.equal(select.runs, 1);
  });

  it('hands back the same array, so what is memoised downstream stands down too', () => {
    const select = counted(() => list('task'));
    assert.equal(query(select), query(select));
  });

  it('runs again when its own table changes', () => {
    const select = counted(() => list('task'));
    query(select);
    patchLocal('task', 't1', { title: 'renamed' });
    query(select);
    assert.equal(select.runs, 2);
    assert.equal(query(select).find((row: any) => row.id === 't1')?.title, 'renamed');
  });

  it('ignores a write to a table it never touched', () => {
    const select = counted(() => list('task'));
    query(select);
    patchLocal('label', 'l1', { name: 'bug' });
    patchLocal('vendor', 'v1', { name: 'Acme' });
    patchLocal('cycle', 'c1', { name: 'Sprint 1' });
    query(select);
    assert.equal(select.runs, 1);
  });

  it('follows a read made through a helper rather than directly', () => {
    // The reason the read set is observed and not declared: nothing at this
    // call site mentions `state`, and it depends on it all the same.
    const groupOf = (row: any) => byId('state', row.state_id)?.group_key;
    const select = counted(() => list('task').map(groupOf));
    query(select);
    patchLocal('state', 's1', { group_key: 'started' });
    query(select);
    assert.equal(select.runs, 2);
    assert.deepEqual(query(select), ['started', 'started']);
  });

  it('follows a table it only started reading on the second run', () => {
    let deep = false;
    const select = counted(() => (deep ? list('label').length : list('task').length));
    query(select);
    deep = true;
    patchLocal('task', 't1', { title: 'again' });   // makes it run, and re-read
    query(select);
    patchLocal('label', 'l1', { name: 'bug' });
    query(select);
    assert.equal(select.runs, 3);
  });

  it('sees the tombstones `list` hides, through `listAll`', () => {
    const select = counted(() => listAll('task').length);
    assert.equal(query(select), 2);
    applyChanges({ task: [{ ...task('t3'), deleted_at: Date.now() }] } as any);
    assert.equal(query(select), 3);
    assert.equal(list('task').length, 2);
  });
});

describe('deps still gate it', () => {
  it('runs again when a dep changes, even with the tables untouched', () => {
    const select = counted(() => list('task').length);
    query(select, ['a']);
    query(select, ['b']);
    assert.equal(select.runs, 2);
  });
});

describe('every write marks its table', () => {
  it('counts a changeset, a purge, a patch and a reset', () => {
    const watchTask = counted(() => list('task').length);
    const watchLabel = counted(() => list('label').length);
    const run = () => { query(watchTask); query(watchLabel); };
    run();

    applyChanges({ task: [task('t3')] } as any);
    run();
    assert.deepEqual([watchTask.runs, watchLabel.runs], [2, 1], 'a changeset');

    applyChanges({ purge: [{ entity: 'task', row_id: 't3' }] } as any);
    run();
    assert.deepEqual([watchTask.runs, watchLabel.runs], [3, 1], 'a purge');

    patchLocal('task', 't1', { title: 'x' });
    run();
    assert.deepEqual([watchTask.runs, watchLabel.runs], [4, 1], 'a patch');

    reset();
    run();
    assert.deepEqual([watchTask.runs, watchLabel.runs], [5, 2], 'a reset clears every table');
    assert.equal(tables.task.size, 0);
  });
});

/**
 * A page body is the one field that is merged rather than replaced, and the
 * rule for *when* it is merged is the whole of this.
 *
 * The bug behind it: a page rewritten whole twice over the API or MCP used to
 * leave every device that had seen the first version editing it for ever. The
 * server rebuilt the CRDT with `fromText` each time, which mints the same
 * character identities every call — so the second state named the same
 * characters as the first and gave them different letters, and a merge keeps
 * the identity it already has. The page *rendered* correctly, because
 * everything but the editor reads `content`. Nothing could pull the device out
 * of it, because merging the good state into the bad one keeps the bad one.
 */
describe('a merged field', () => {
  const body = (text: string) => crdt.fromText(text, 'server');
  const page = (text: string, state = body(text)) =>
    ({ id: 'p1', workspace_id: 'w', title: 'Page', content: text, body: state });

  it('keeps what is still queued, because that is what the merge is for', () => {
    reset();
    applyChanges({ page: [page('one\n')] } as any);
    const mine = crdt.edit(byId('page', 'p1')!.body, 'one\nmine\n', 'device-a');
    patchLocal('page', 'p1', { body: mine });

    const theirs = crdt.edit(body('one\n'), 'one\ntheirs\n', 'device-b');
    applyChanges({ page: [page('one\ntheirs\n', theirs)] } as any, () => true);

    const text = crdt.textOf(byId('page', 'p1')!.body);
    assert.match(text, /mine/, 'the unsent paragraph survived the pull');
    assert.match(text, /theirs/, 'and so did the one that arrived');
  });

  it('takes what arrived when nothing is queued, so a bad copy can be corrected', () => {
    reset();
    applyChanges({ page: [page('Stand 09.10.2026\n')] } as any);
    // What a second whole-document write used to look like on the wire: a
    // state minting `server:0…` all over again, which the old unconditional
    // merge could only read as "characters I already have".
    applyChanges({ page: [page('Stand 10.10.2026\n')] } as any);

    assert.equal(
      crdt.textOf(byId('page', 'p1')!.body), 'Stand 10.10.2026\n',
      'the row that arrived is the truth when this device is holding nothing',
    );
  });

  it('is not cleared by a changeset that does not carry it', () => {
    reset();
    applyChanges({ page: [page('text\n')] } as any);
    // A push echo is only the values the server decided — here, the title.
    applyChanges({ page: [{ id: 'p1', title: 'Renamed' }] } as any);

    assert.equal(byId('page', 'p1')!.title, 'Renamed');
    assert.equal(crdt.textOf(byId('page', 'p1')!.body), 'text\n', 'and the body is still there');
  });
});
