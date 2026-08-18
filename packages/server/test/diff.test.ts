/**
 * "What changed" between two versions of a page.
 *
 * The cases worth having are the ones where a naive line-by-line comparison
 * lies: a line inserted near the top (which shifts everything after it), a line
 * moved, and a file that only grew.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collapse, diffLines, diffSummary } from '@kolibri/shared';

const ops = (before: string, after: string) => diffLines(before, after).map((line) => `${line.op[0]}:${line.text}`);

describe('diffing two versions', () => {
  it('reports nothing when nothing moved', () => {
    const lines = diffLines('one\ntwo\nthree', 'one\ntwo\nthree');
    assert.deepEqual(diffSummary(lines), { added: 0, removed: 0 });
    assert.ok(lines.every((line) => line.op === 'same'));
  });

  it('does not call every following line changed when one is inserted', () => {
    // The whole point. A line-by-line comparison would mark three lines
    // changed here; only one was.
    const lines = diffLines('one\ntwo\nthree', 'one\ninserted\ntwo\nthree');
    assert.deepEqual(diffSummary(lines), { added: 1, removed: 0 });
    assert.deepEqual(ops('one\ntwo\nthree', 'one\ninserted\ntwo\nthree'),
      ['s:one', 'a:inserted', 's:two', 's:three']);
  });

  it('shows a rewritten line as one out and one in', () => {
    const lines = diffLines('keep\nold line\nkeep too', 'keep\nnew line\nkeep too');
    assert.deepEqual(diffSummary(lines), { added: 1, removed: 1 });
  });

  it('carries the line numbers of both sides', () => {
    const lines = diffLines('a\nb', 'a\nx\nb');
    const added = lines.find((line) => line.op === 'added')!;
    assert.equal(added.after, 2);
    assert.equal(added.before, undefined, 'an added line has no number in the old text');
    const last = lines[lines.length - 1];
    assert.equal(last.before, 2);
    assert.equal(last.after, 3);
  });

  it('handles an empty side without inventing a line', () => {
    assert.deepEqual(diffSummary(diffLines('', 'first draft')), { added: 1, removed: 0 });
    assert.deepEqual(diffSummary(diffLines('was here', '')), { added: 0, removed: 1 });
    assert.deepEqual(diffSummary(diffLines('', '')), { added: 0, removed: 0 });
  });

  it('treats CRLF as the same text as LF', () => {
    // Otherwise pasting from another editor shows the whole page as rewritten.
    assert.deepEqual(diffSummary(diffLines('one\r\ntwo', 'one\ntwo')), { added: 0, removed: 0 });
  });
});

describe('collapsing the unchanged parts', () => {
  it('hides a long unchanged run and says how much it hid', () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 15', 'line 15 edited');
    const parts = collapse(diffLines(before, after), 3);

    const skipped = parts.filter((part) => part.op === 'skipped') as { count: number }[];
    assert.equal(skipped.length, 2, 'one run before the change and one after');
    assert.ok(skipped.every((part) => part.count > 5));
    assert.ok(parts.some((part) => part.op === 'added'), 'and the change itself survives');
  });

  it('leaves a short diff alone', () => {
    const parts = collapse(diffLines('a\nb', 'a\nc'), 3);
    assert.ok(!parts.some((part) => part.op === 'skipped'));
  });
});
