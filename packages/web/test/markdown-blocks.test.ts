/**
 * The shapes a page is written in: tables, diagrams, lists, quotes, breaks.
 *
 * Every case here is one somebody reported. A table came out as a paragraph of
 * pipes even though both stylesheets had been carrying `table` rules for
 * months; a nested list produced a `<ul>` beside its parent item rather than
 * inside it; a line ending in two spaces — which is markdown's whole answer to
 * "keep this on its own line" — was joined to the next one and the address, the
 * verse or the list of names collapsed into prose.
 *
 * They are tested as *output* rather than by eye, because the failure mode is
 * silent. Nothing throws when a table renders as a paragraph. The text is all
 * still there, in the wrong shape, and the only thing that notices is a person
 * reading their own page wondering what happened to it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdown, toggleTask } from '@kolibri/shared';

describe('a table', () => {
  const source = '| Name | Role |\n| --- | --- |\n| Ada | Engineer |\n| Grace | Admiral |';

  it('is a table and not a paragraph of pipes', () => {
    const html = renderMarkdown(source);
    assert.match(html, /<table>/);
    assert.match(html, /<thead><tr><th>Name<\/th><th>Role<\/th><\/tr><\/thead>/);
    assert.match(html, /<tr><td>Ada<\/td><td>Engineer<\/td><\/tr>/);
    assert.doesNotMatch(html, /<p>[^<]*\|/, 'no row is left as prose');
  });

  it('carries the alignment the delimiter row asked for', () => {
    const html = renderMarkdown('| L | M | R |\n|:--|:-:|--:|\n| a | b | c |');
    assert.match(html, /<th style="text-align:left">L<\/th>/);
    assert.match(html, /<th style="text-align:center">M<\/th>/);
    assert.match(html, /<th style="text-align:right">R<\/th>/);
    assert.match(html, /<td style="text-align:right">c<\/td>/);
  });

  it('renders what is inside a cell', () => {
    const html = renderMarkdown('| Who | Where |\n| --- | --- |\n| **Ada** | [notes](/pages/x) |');
    assert.match(html, /<td><strong>Ada<\/strong><\/td>/);
    assert.match(html, /<td><a href="\/pages\/x">notes<\/a><\/td>/);
  });

  it('squares up a ragged row instead of dropping it', () => {
    const html = renderMarkdown('| a | b | c |\n| - | - | - |\n| 1 |\n| 1 | 2 | 3 | 4 |');
    assert.match(html, /<tr><td>1<\/td><td><\/td><td><\/td><\/tr>/, 'a short row is padded');
    assert.match(html, /<tr><td>1<\/td><td>2<\/td><td>3<\/td><\/tr>/, 'a long one loses the extra');
  });

  it('lets a pipe be written with a backslash', () => {
    const html = renderMarkdown('| expression |\n| --- |\n| a \\| b |');
    assert.match(html, /<td>a \| b<\/td>/);
  });

  it('can interrupt a paragraph, the way it does on GitHub', () => {
    const html = renderMarkdown('Here is the split:\n| a | b |\n| - | - |\n| 1 | 2 |');
    assert.match(html, /<p>Here is the split:<\/p>/);
    assert.match(html, /<table>/);
  });

  it('ends where the rows do', () => {
    const html = renderMarkdown('| a |\n| - |\n| 1 |\n\nAfter.');
    assert.match(html, /<\/table>/);
    assert.match(html, /<p>After\.<\/p>/);
  });

  it('is not started by a rule, or by a line that underlines a heading', () => {
    assert.match(renderMarkdown('---'), /<hr \/>/);
    assert.match(renderMarkdown('Title\n---'), /<h2>Title<\/h2>/);
  });
});

describe('a mermaid diagram', () => {
  it('is marked for the app to draw and readable where nothing does', () => {
    const html = renderMarkdown('```mermaid\ngraph TD;\n  A-->B;\n```');
    assert.match(html, /<pre class="md-mermaid">/, 'the app finds it by this class');
    assert.match(html, /graph TD;/, 'and a reader with no script still gets the source');
    assert.match(html, /A--&gt;B;/, 'which is escaped like any other code');
  });

  it('leaves every other fence exactly as it was', () => {
    assert.match(renderMarkdown('```js\nconst x = 1;\n```'), /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);
    assert.doesNotMatch(renderMarkdown('```js\nx\n```'), /md-mermaid/);
  });
});

describe('a fence', () => {
  it('can be written with tildes, which used to come out as strikethrough', () => {
    const html = renderMarkdown('~~~js\nconst x = 1;\n~~~');
    assert.match(html, /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);
    assert.doesNotMatch(html, /<del>/);
  });

  it('can hold a shorter fence when opened with a longer one', () => {
    const html = renderMarkdown('````\n```\n````');
    assert.equal(html, '<pre><code>```</code></pre>');
  });

  it('closes only on its own marker', () => {
    const html = renderMarkdown('```\n~~~\n```');
    assert.match(html, /<code>~~~<\/code>/);
  });

  it('sheds the indent it was written at', () => {
    const html = renderMarkdown('  ```\n  const x = 1;\n  ```');
    assert.match(html, /<code>const x = 1;<\/code>/);
  });

  it('runs to the end when nobody closed it', () => {
    assert.match(renderMarkdown('```\nstill code'), /<pre><code>still code<\/code><\/pre>/);
  });
});

describe('a line break', () => {
  it('is kept when the line ends in two spaces', () => {
    assert.match(renderMarkdown('Ada Lovelace  \n12 Acacia Avenue'), /Ada Lovelace<br \/>12 Acacia Avenue/);
  });

  it('is kept when the line ends in a backslash', () => {
    assert.match(renderMarkdown('one\\\ntwo'), /one<br \/>two/);
  });

  it('is not invented for an ordinary wrapped line', () => {
    const html = renderMarkdown('one\ntwo');
    assert.equal(html, '<p>one two</p>');
  });

  it('does not read a backslash inside code as one', () => {
    assert.doesNotMatch(renderMarkdown('a `\\`\nb'), /<br \/>/);
  });
});

describe('emphasis', () => {
  it('survives having emphasis inside it', () => {
    assert.equal(renderMarkdown('**bold *and* italic**'), '<p><strong>bold <em>and</em> italic</strong></p>');
  });

  it('is written with underscores too', () => {
    assert.match(renderMarkdown('__bold__ and _italic_'), /<strong>bold<\/strong> and <em>italic<\/em>/);
  });

  it('keeps two runs apart instead of joining them', () => {
    assert.equal(renderMarkdown('**a** and **b**'), '<p><strong>a</strong> and <strong>b</strong></p>');
  });

  it('leaves a name with underscores in it alone', () => {
    assert.equal(renderMarkdown('call some_long_name here'), '<p>call some_long_name here</p>');
  });

  it('can open on one line and close on the next', () => {
    assert.match(renderMarkdown('**one\ntwo**'), /<strong>one two<\/strong>/);
  });
});

describe('a nested list', () => {
  it('goes inside the item it hangs off', () => {
    const html = renderMarkdown('- one\n  - deep\n- two').replace(/\n/g, '');
    assert.equal(html, '<ul><li>one<ul><li>deep</li></ul></li><li>two</li></ul>');
  });

  it('never puts a list beside its parent item', () => {
    assert.doesNotMatch(renderMarkdown('- one\n  - deep'), /<\/li>\s*<ul>/);
  });

  it('starts a new list when the markers change at one depth', () => {
    const html = renderMarkdown('- bullet\n1. numbered').replace(/\n/g, '');
    assert.equal(html, '<ul><li>bullet</li></ul><ol><li>numbered</li></ol>');
  });

  it('keeps a run of numbers in one list', () => {
    const html = renderMarkdown('1. one\n2. two\n3. three');
    assert.equal(html.match(/<ol/g)?.length, 1);
    assert.equal(html.match(/<li>/g)?.length, 3);
  });

  it('begins where the author began', () => {
    assert.match(renderMarkdown('3. three\n4. four'), /<ol start="3">/);
    assert.doesNotMatch(renderMarkdown('1. one'), /start=/);
  });
});

describe('a quote', () => {
  it('can hold a list', () => {
    const html = renderMarkdown('> - a\n> - b');
    assert.match(html, /<blockquote>\s*<ul>/);
    assert.match(html, /<li>a/);
  });

  it('can hold another quote', () => {
    assert.match(renderMarkdown('> > deep'), /<blockquote>\s*<blockquote>/);
  });

  it('can hold code', () => {
    assert.match(renderMarkdown('> ```\n> x\n> ```'), /<blockquote>\s*<pre><code>x<\/code><\/pre>/);
  });

  it('keeps its wrapped lines in one paragraph', () => {
    assert.match(renderMarkdown('> one\n> two'), /<blockquote>\s*<p>one two<\/p>/);
  });
});

describe('a heading', () => {
  it('drops the hashes some people close it with', () => {
    assert.equal(renderMarkdown('## Title ##'), '<h2>Title</h2>');
  });

  it('does not mistake a tag at the end for one', () => {
    assert.match(renderMarkdown('## Filed under #WEB', { keys: ['WEB'], projectHref: () => '/projects/p1' }), /#WEB<\/a><\/h2>/);
  });

  it('can be underlined instead', () => {
    assert.equal(renderMarkdown('Title\n====='), '<h1>Title</h1>');
    assert.equal(renderMarkdown('Title\n---'), '<h2>Title</h2>');
  });

  it('is not underlined by a rule standing on its own', () => {
    assert.match(renderMarkdown('Text.\n\n---\n\nMore.'), /<hr \/>/);
  });
});

/**
 * The one invariant that spans two files. A rendered checkbox carries an index,
 * a click hands the index back to `toggleTask`, and `toggleTask` counts the
 * source for itself — so the two counts have to agree about every line, or a
 * click lands on somebody else's box.
 */
describe('a checkbox and the text behind it', () => {
  it('agrees about which box is which, past a fence of either kind', () => {
    const source = [
      '- [ ] first',
      '```',
      '- [ ] not a box',
      '```',
      '~~~',
      '- [ ] also not a box',
      '~~~',
      '- [ ] second',
    ].join('\n');

    const html = renderMarkdown(source, { interactiveTasks: true });
    assert.equal(html.match(/data-task=/g)?.length, 2, 'two boxes, not four');
    assert.match(html, /data-task="1"[^>]*\/><span>second/);
    assert.match(toggleTask(source, 1), /- \[x\] second/);
    assert.doesNotMatch(toggleTask(source, 1), /\[x\] not a box/);
  });

  it('does not count one inside a quote, which toggleTask cannot reach', () => {
    const source = '> - [ ] quoted\n\n- [ ] real';
    const html = renderMarkdown(source, { interactiveTasks: true });
    assert.equal(html.match(/data-task=/g)?.length, 1);
    assert.match(html, /data-task="0"[^>]*\/><span>real/);
    assert.match(toggleTask(source, 0), /\n- \[x\] real/);
  });
});
