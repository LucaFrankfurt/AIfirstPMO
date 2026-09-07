/**
 * The two text rules an import leans on.
 *
 * `splitByHeadings` is the one that decides whether importing somebody's wiki
 * gives them their wiki back or gives them a scroll. Nobody exports forty
 * chapters as forty files; they export one file, and a tool that cannot cut it
 * up is a tool people paste into by hand instead.
 *
 * The case that matters is the one that is not a heading. A `# comment` inside
 * a shell block is not a chapter, and cutting a runbook in half at the middle
 * of its own example is the kind of bug that is only found by the person whose
 * runbook it was.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { outlineOf, pageExcerpt, splitByHeadings } from '@kolibri/shared';

describe('splitByHeadings', () => {
  it('cuts a document at its top-level headings', () => {
    const parts = splitByHeadings('# One\n\nfirst\n\n# Two\n\nsecond\n');
    assert.deepEqual(parts.map((one) => one.title), ['One', 'Two']);
    assert.match(parts[0].content, /first/);
    assert.match(parts[1].content, /second/);
  });

  it('keeps the heading in the piece it opens', () => {
    // The page's title and its first line then say the same thing, which reads
    // as a repeat — and losing it would flatten everything nested under it.
    assert.match(splitByHeadings('# One\n\ntext').at(0)!.content, /^# One/);
  });

  it('gives whatever came before the first heading no title of its own', () => {
    const parts = splitByHeadings('a preface\n\n# One\n\ntext');
    assert.equal(parts.length, 2);
    assert.equal(parts[0].title, null);
    assert.match(parts[0].content, /preface/);
  });

  it('does not cut inside fenced code', () => {
    const parts = splitByHeadings('# Runbook\n\n```sh\n# rebuild the index\nkolibri reindex\n```\n\nDone.\n');
    assert.equal(parts.length, 1);
    assert.match(parts[0].content, /kolibri reindex/);
  });

  it('leaves a document with no headings whole', () => {
    const parts = splitByHeadings('Just some prose.\n\nAnd more of it.');
    assert.equal(parts.length, 1);
    assert.equal(parts[0].title, null);
  });

  it('ignores a deeper heading than the one it was asked to cut at', () => {
    const parts = splitByHeadings('# One\n\n## Under one\n\n# Two');
    assert.deepEqual(parts.map((one) => one.title), ['One', 'Two']);
  });

  it('drops a section that is nothing but whitespace', () => {
    assert.deepEqual(splitByHeadings('\n\n   \n').length, 0);
  });

  /*
   * The underlined form, which `outlineOf` read all along and this did not — so
   * a document written that way drew a full outline and imported as one page.
   * Both ask `headingAt` now, which is the only way two functions stay agreed
   * about what a heading is.
   */
  it('cuts at an underlined heading too', () => {
    const parts = splitByHeadings('One\n===\n\nfirst\n\nTwo\n===\n\nsecond\n');
    assert.deepEqual(parts.map((one) => one.title), ['One', 'Two']);
    assert.match(parts[0].content, /^One\n===/, 'and keeps both of its lines');
    assert.match(parts[1].content, /second/);
  });

  it('does not mistake a rule or a list item for one', () => {
    // `---` under a blank line is a horizontal rule; under a list item it is
    // that item. Only a paragraph gets underlined.
    assert.equal(splitByHeadings('text\n\n---\n\nmore', 2).length, 1);
    assert.equal(splitByHeadings('- an item\n---\n\nmore', 2).length, 1);
  });

  it('agrees with outlineOf about what is a heading', () => {
    for (const source of [
      '# Hash\n\ntext\n\n# Second\n',
      'Setext\n======\n\ntext\n\nAnother\n=======\n',
      '# One\n\n```\n# not a chapter\n```\n\n# Two\n',
    ]) {
      const outlined = outlineOf(source).filter((one) => one.level === 1).map((one) => one.text);
      const split = splitByHeadings(source).map((one) => one.title).filter(Boolean);
      assert.deepEqual(split, outlined, JSON.stringify(source));
    }
  });
});

describe('pageExcerpt', () => {
  it('reads a markdown page as its words', () => {
    assert.equal(pageExcerpt('# Title\n\nSome **bold** prose.', 'markdown'), 'Title Some bold prose.');
  });

  it('reads an HTML page as its words too, rather than as its tags', () => {
    // The card under a page used to show `<p class="lead">Willkommen` for an
    // imported page and the sentence for the one beside it, which is the card
    // telling the reader about the database.
    assert.equal(pageExcerpt('<div class="lead"><p>Willkommen im Team</p></div>', 'html'), 'Willkommen im Team');
  });

  it('cuts at the length it was given', () => {
    assert.equal(pageExcerpt('x'.repeat(50), 'markdown', 10), `${'x'.repeat(10)}…`);
  });
});
