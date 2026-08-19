/**
 * References to work, inside prose.
 *
 * `WEB-42` becoming a link is the easy half. The half worth testing is
 * everything that must *not* become one: `UTF-8` is not a task, a URL that
 * happens to end in something identifier-shaped must not grow a second anchor
 * inside the first, and a key this workspace has never heard of is text.
 *
 * That is why the renderer is told which keys exist rather than given a
 * pattern. A pattern cannot tell those cases apart, and a chat about an
 * encoding standard full of dead links is worse than no references at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdown } from '@kolibri/shared';

const refs = {
  keys: ['WEB', 'APP'],
  projectHref: (key: string) => (key === 'WEB' ? '/projects/p1' : undefined),
};

describe('a reference to a task', () => {
  it('links an identifier whose project this workspace has', () => {
    const html = renderMarkdown('Fixed in WEB-42, see also APP-7.', refs);
    assert.match(html, /<a class="md-ref" href="\/t\/WEB-42">WEB-42<\/a>/);
    assert.match(html, /<a class="md-ref" href="\/t\/APP-7">APP-7<\/a>/);
  });

  it('leaves alone what only looks like one', () => {
    const html = renderMarkdown('Encoded as UTF-8 since COVID-19, per ISO-8601.', refs);
    assert.doesNotMatch(html, /md-ref/, 'a standard is not a task');
  });

  it('says nothing when it was not told which keys exist', () => {
    assert.doesNotMatch(renderMarkdown('Fixed in WEB-42.'), /md-ref/);
  });

  it('keeps its hands off code', () => {
    const fenced = renderMarkdown('```\nWEB-42\n```', refs);
    assert.doesNotMatch(fenced, /md-ref/);
    assert.doesNotMatch(renderMarkdown('The string `WEB-42` is a key.', refs), /md-ref/);
  });

  it('does not put a link inside a link', () => {
    const html = renderMarkdown('See https://example.com/issues/WEB-42 for the trail.', refs);
    assert.doesNotMatch(html, /<a[^>]*>[^<]*<a /, 'nested anchors swallow each other');
    assert.equal(html.match(/<a /g)?.length, 1);
  });

  it('leaves an existing markdown link as the author wrote it', () => {
    const html = renderMarkdown('[the WEB-42 thread](/pages/x)', refs);
    assert.match(html, /<a href="\/pages\/x">the WEB-42 thread<\/a>/);
  });
});

describe('a reference to a project', () => {
  it('links a key it can place', () => {
    assert.match(renderMarkdown('Moved to #WEB this week.', refs), /<a class="md-ref" href="\/projects\/p1">#WEB<\/a>/);
  });

  it('leaves an unplaceable key as an ordinary tag', () => {
    const html = renderMarkdown('Filed under #APP for now.', refs);
    assert.doesNotMatch(html, /md-ref/);
  });

  it('does not touch an ordinary hashtag, or a heading', () => {
    assert.doesNotMatch(renderMarkdown('A #design-review thing.', refs), /md-ref/);
    assert.match(renderMarkdown('# WEB', refs), /<h1>WEB<\/h1>/);
  });
});
