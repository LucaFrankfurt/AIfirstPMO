/**
 * What the editor does to the text while somebody types.
 *
 * The editor is a plain `<textarea>` on purpose — this app stores markdown, and
 * a rich-text surface would mean the document and the screen were two different
 * things. Every convenience is therefore a rewrite of a string, which is a
 * thing that can be tested without a browser at all: text and a caret in, text
 * and a caret out.
 *
 * The rule under all of it is *do nothing unless the line asks for it*. Most of
 * these tests are about the cases that must come back `null`, because a plain
 * Enter in a paragraph staying a plain Enter is what makes the rest tolerable.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enterInList, indentList, toggleTask } from '@kolibri/shared';

/** `|` marks the caret, so a case reads the way it would be typed. */
const at = (marked: string) => ({ text: marked.replace('|', ''), caret: marked.indexOf('|') });
const show = (edit: { text: string; caret: number } | null) =>
  (edit ? `${edit.text.slice(0, edit.caret)}|${edit.text.slice(edit.caret)}` : null);

const enter = (marked: string) => {
  const { text, caret } = at(marked);
  return show(enterInList(text, caret));
};

describe('Enter, in a list', () => {
  it('continues a bullet', () => {
    assert.equal(enter('- milk|'), '- milk\n- |');
    assert.equal(enter('* milk|'), '* milk\n* |');
  });

  it('continues a checklist with an empty box', () => {
    assert.equal(enter('- [ ] pack|'), '- [ ] pack\n- [ ] |');
    assert.equal(enter('- [x] pack|'), '- [x] pack\n- [ ] |', 'the next one is not done yet');
  });

  it('counts on', () => {
    assert.equal(enter('1. first|'), '1. first\n2. |');
    assert.equal(enter('9) ninth|'), '9) ninth\n10) |');
  });

  it('keeps the indent, so a nested list stays nested', () => {
    assert.equal(enter('  - nested|'), '  - nested\n  - |');
    assert.equal(enter('    - [ ] deep|'), '    - [ ] deep\n    - [ ] |');
  });

  it('continues a quote', () => {
    assert.equal(enter('> said|'), '> said\n> |');
  });

  it('ends the list on an item left empty', () => {
    assert.equal(enter('- milk\n- |'), '- milk\n|', 'Enter twice is how every editor lets you stop');
    assert.equal(enter('- [ ] |'), '|', 'an empty box is empty — the box is not content');
    assert.equal(enter('1. |'), '|');
  });

  it('leaves ordinary text alone', () => {
    assert.equal(enter('a paragraph|'), null);
    assert.equal(enter('|'), null);
    assert.equal(enter('-not a list|'), null, 'a marker needs a space after it');
  });

  it('splits an item where the caret is, rather than at the end of it', () => {
    assert.equal(enter('- mi|lk'), '- mi\n- |lk');
  });
});

describe('Tab, in a list', () => {
  const tab = (marked: string, outdent = false) => {
    const { text, caret } = at(marked);
    return show(indentList(text, caret, caret, outdent));
  };

  it('nests an item, by the two spaces the renderer reads as one level', () => {
    assert.equal(tab('- milk|'), '  - milk|');
  });

  it('takes a level back off', () => {
    assert.equal(tab('  - milk|', true), '- milk|');
  });

  it('does nothing at the left margin, rather than eating the line', () => {
    assert.equal(tab('- milk|', true), null);
  });

  it('leaves ordinary text to the plain indent Tab used to insert', () => {
    assert.equal(tab('a paragraph|'), null);
  });

  it('moves every line the selection touches', () => {
    const text = '- milk\n- eggs\n- bread';
    const edit = indentList(text, 0, text.length, false);
    assert.equal(edit?.text, '  - milk\n  - eggs\n  - bread');
  });
});

describe('ticking a box off', () => {
  const list = '- [ ] one\n- [x] two\n- [ ] three';

  it('flips the one that was clicked, and only that one', () => {
    assert.equal(toggleTask(list, 0), '- [x] one\n- [x] two\n- [ ] three');
    assert.equal(toggleTask(list, 1), '- [ ] one\n- [ ] two\n- [ ] three');
    assert.equal(toggleTask(list, 2), '- [ ] one\n- [x] two\n- [x] three');
  });

  it('keeps everything else on the line', () => {
    assert.equal(toggleTask('  - [ ] **pack** the thing', 0), '  - [x] **pack** the thing');
  });

  it('counts the way the renderer counts, so an example in a code block is not a box', () => {
    // The renderer never turns this into a checkbox, so it must not be numbered
    // as one either — otherwise every index below it points one line too high.
    const withCode = '```\n- [ ] not a box\n```\n- [ ] a box';
    assert.equal(toggleTask(withCode, 0), '```\n- [ ] not a box\n```\n- [x] a box');
  });

  it('changes nothing when the index names no box', () => {
    assert.equal(toggleTask(list, 9), list);
    assert.equal(toggleTask('no boxes here', 0), 'no boxes here');
  });
});
