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
import { anchorLabel, findAnchor, makeAnchor, sameQuote } from '@kolibri/shared';

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

/**
 * The two halves of a page, which say the same thing differently.
 *
 * Both bugs these pin down were reported as one sentence each, and both came
 * from the same place: the source and the page on screen were compared
 * character for character, and they are never quite equal.
 */
describe('a passage across the source and the page', () => {
  // A paragraph written over two lines, which is how every imported document
  // and half of the hand-typed ones arrive.
  const SOURCE = [
    '# Release notes',
    '',
    'We ship on Friday and the API is frozen until then.',
    'Ask Grace if you are unsure about anything at all.',
    '',
    'Ask Grace if you are unsure about anything at all.',
  ].join('\n');

  /**
   * The page as the browser holds it: every text node end to end. The renderer
   * joins a paragraph's lines with a space and puts a newline between blocks,
   * so this is the source with its markup gone and its whitespace moved.
   */
  const PAGE = 'Release notes\nWe ship on Friday and the API is frozen until then.'
    + ' Ask Grace if you are unsure about anything at all.\n'
    + 'Ask Grace if you are unsure about anything at all.';

  it('anchors a selection that runs over a line break in the source', () => {
    // The bug: this reads as one sentence on screen, is two lines in the
    // source, and used to be refused — which looked like a limit on how many
    // characters one is allowed to select.
    const quote = 'until then. Ask Grace';
    const found = sameQuote({ text: PAGE, at: PAGE.indexOf(quote) }, SOURCE, quote)!;
    assert.ok(found, 'the selection is offered a comment at all');
    assert.equal(SOURCE.slice(found.start, found.end), 'until then.\nAsk Grace');

    // And the anchor made from it finds its way back, both to the source and
    // to the page, which is what the comment and its highlight each need.
    const anchor = makeAnchor(SOURCE, found.start, found.end)!;
    assert.ok(findAnchor(SOURCE, anchor), 'the comment is not orphaned by its own newline');
    assert.ok(findAnchor(PAGE, anchor), 'and the highlight finds it on screen');
  });

  it('follows a quote whose paragraph is later rewrapped', () => {
    const at = SOURCE.indexOf('the API is frozen');
    const anchor = makeAnchor(SOURCE, at, at + 'the API is frozen'.length)!;
    const rewrapped = SOURCE.replace('until then.\nAsk Grace', 'until then. Ask Grace');
    const found = findAnchor(rewrapped, anchor)!;
    assert.equal(rewrapped.slice(found.start, found.end), 'the API is frozen');
  });

  it('paints the copy that was commented on, not the first one that reads the same', () => {
    // The bug: the page says the same sentence twice, the comment is on the
    // second, and the highlight landed on the first.
    const second = SOURCE.lastIndexOf('Ask Grace');
    const anchor = makeAnchor(SOURCE, second, second + 'Ask Grace if you are unsure about anything at all.'.length)!;

    const meant = findAnchor(SOURCE, anchor)!;
    assert.equal(meant.start, second, 'the source knows which copy, from the neighbours it kept');

    const here = sameQuote({ text: SOURCE, at: meant.start }, PAGE, anchor.quote)!;
    assert.equal(here.start, PAGE.lastIndexOf('Ask Grace'), 'and the page underlines that one');
  });

  it('goes the other way too: the second copy selected is the second copy anchored', () => {
    const quote = 'Ask Grace if you are unsure';
    const found = sameQuote({ text: PAGE, at: PAGE.lastIndexOf(quote) }, SOURCE, quote)!;
    assert.equal(found.start, SOURCE.lastIndexOf(quote));
  });

  it('still refuses a passage that is not on the page at all', () => {
    assert.equal(sameQuote({ text: PAGE, at: 0 }, SOURCE, 'a sentence nobody wrote'), null);
    assert.equal(sameQuote({ text: PAGE, at: 0 }, SOURCE, '   '), null);
  });
});
