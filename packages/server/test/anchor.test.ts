/**
 * Anchoring a comment to a passage.
 *
 * The whole difficulty is that the text keeps being edited underneath. These
 * are the edits that happen: a paragraph added above, the sentence itself
 * reworded, the same sentence appearing twice, and the passage deleted
 * outright — where the right answer is to admit it rather than guess.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchorLabel, findAnchor, makeAnchor } from '@kolibri/shared';

const TEXT = 'We ship on Friday. The API is frozen until then. Ask Grace if unsure.';

describe('making an anchor', () => {
  it('keeps the quote and enough of its surroundings to be found again', () => {
    const at = TEXT.indexOf('The API is frozen');
    const anchor = makeAnchor(TEXT, at, at + 'The API is frozen'.length)!;
    assert.equal(anchor.quote, 'The API is frozen');
    assert.match(anchor.prefix, /Friday\. $/);
    assert.match(anchor.suffix, /^ until then/);
  });

  it('refuses to anchor to whitespace', () => {
    const space = TEXT.indexOf(' ');
    assert.equal(makeAnchor(TEXT, space, space + 1), null, 'a comment on a space is a mis-click');
    assert.equal(makeAnchor(TEXT, 5, 5), null, 'and one on nothing at all is not a comment');
  });
});

describe('finding it again', () => {
  const at = TEXT.indexOf('The API is frozen');
  const anchor = makeAnchor(TEXT, at, at + 'The API is frozen'.length)!;

  it('follows the passage when something is inserted above it', () => {
    const edited = `A new opening paragraph.\n\n${TEXT}`;
    const found = findAnchor(edited, anchor)!;
    assert.equal(edited.slice(found.start, found.end), 'The API is frozen');
    assert.equal(found.ambiguous, false);
  });

  it('follows it when the words around it are rewritten', () => {
    const edited = 'Completely different opening. The API is frozen for the rest of the quarter.';
    const found = findAnchor(edited, anchor)!;
    assert.equal(edited.slice(found.start, found.end), 'The API is frozen');
  });

  it('picks the copy whose neighbours match when the sentence appears twice', () => {
    const edited = `Notes: The API is frozen somewhere else.\n\n${TEXT}`;
    const found = findAnchor(edited, anchor)!;
    assert.equal(found.ambiguous, true, 'and says that it had to choose');
    // The second copy is the one that still sits after "Friday." — the first is
    // a different sentence that happens to contain the same words.
    assert.ok(edited.slice(0, found.start).endsWith('Friday. '));
  });

  it('says the passage is gone rather than pointing somewhere else', () => {
    const edited = 'We ship on Friday. Ask Grace if unsure.';
    assert.equal(findAnchor(edited, anchor), null, 'an orphan is honest; a wrong attachment is not');
    assert.equal(findAnchor(edited, null), null);
    assert.equal(findAnchor('', anchor), null);
  });
});

describe('the label above a comment', () => {
  it('is one line, and says when it was cut', () => {
    assert.equal(anchorLabel({ quote: '  many   spaces\n here ', prefix: '', suffix: '' }), 'many spaces here');
    const long = anchorLabel({ quote: 'x'.repeat(200), prefix: '', suffix: '' });
    assert.equal(long.length, 90);
    assert.ok(long.endsWith('…'));
    assert.equal(anchorLabel(null), '');
  });
});
