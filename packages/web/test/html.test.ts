/**
 * What a page is allowed to be, when it is HTML.
 *
 * The markdown renderer's safety argument is one sentence — everything is
 * escaped, so nothing survives — and it cannot be made about this file. Here
 * markup *does* survive, which means the whole of the argument is the
 * allowlist, and the only way to keep an allowlist honest is to write down the
 * things it must refuse and run them.
 *
 * So the first half of this is attacks. Not exotic ones: the four that are
 * actually tried are a script tag, an event handler, a `javascript:` href and
 * an image whose `onerror` fires — plus the one nobody thinks of, which is a
 * class. The app's own stylesheet is on the same document, so `fixed inset-0`
 * on a div is a page painting over the interface with no script anywhere.
 *
 * The second half is the round trip, because a converter that is safe and
 * lossy is a converter that quietly eats imported documents.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatHtml, htmlText, htmlTitle, htmlToMarkdown, looksLikeHtml, parseHtml, renderMarkdown, sanitizeHtml,
} from '@kolibri/shared';

describe('sanitizeHtml refuses', () => {
  it('drops a script and everything in it', () => {
    const out = sanitizeHtml('<p>before</p><script>alert(document.cookie)</script><p>after</p>');
    assert.equal(out, '<p>before</p><p>after</p>');
  });

  it('drops a style block, which can hide and move things', () => {
    assert.equal(sanitizeHtml('<style>body{display:none}</style><p>x</p>'), '<p>x</p>');
  });

  it('keeps the tag and drops every event handler on it', () => {
    const out = sanitizeHtml('<p onclick="steal()" onmouseover=\'x\' ONERROR="y">text</p>');
    assert.equal(out, '<p>text</p>');
  });

  it('refuses a javascript: link but keeps its words', () => {
    assert.equal(sanitizeHtml('<a href="javascript:alert(1)">click</a>'), '<a>click</a>');
    assert.equal(sanitizeHtml('<a href="JaVaScRiPt:alert(1)">click</a>'), '<a>click</a>');
  });

  it('refuses a data: URL, which is a page of somebody else’s choosing', () => {
    assert.equal(sanitizeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">'), '<img>');
  });

  it('keeps an https image and lazies it', () => {
    assert.equal(
      sanitizeHtml('<img src="https://example.com/a.png" alt="a" onerror="x">'),
      '<img src="https://example.com/a.png" loading="lazy" alt="a">',
    );
  });

  it('drops an iframe with its content', () => {
    assert.equal(sanitizeHtml('<iframe src="https://evil.example"><p>fallback</p></iframe>'), '');
  });

  /*
   * The one that has nothing to do with scripts. Every utility in the app's
   * stylesheet is one class name away from any page that may set one, and
   * `fixed inset-0 z-50` is a full-screen overlay written by a document.
   */
  it('keeps only the two families of class it understands', () => {
    assert.equal(sanitizeHtml('<div class="fixed inset-0 z-50 bg-bg">gotcha</div>'), '<div>gotcha</div>');
    assert.equal(
      sanitizeHtml('<pre><code class="language-ts hidden">x</code></pre>'),
      '<pre><code class="language-ts">x</code></pre>',
    );
  });

  it('allows only an alignment through style', () => {
    assert.equal(sanitizeHtml('<td style="text-align:right">7</td>'), '<td style="text-align:right">7</td>');
    assert.equal(sanitizeHtml('<div style="position:fixed;top:0">x</div>'), '<div>x</div>');
  });

  it('drops an id unless the caller gave it a namespace to live in', () => {
    assert.equal(sanitizeHtml('<h2 id="root">x</h2>'), '<h2>x</h2>');
    assert.equal(sanitizeHtml('<h2 id="root">x</h2>', { idPrefix: 'p-' }), '<h2 id="p-root">x</h2>');
  });

  it('makes every checkbox a picture of a state, never a control', () => {
    assert.equal(
      sanitizeHtml('<input type="checkbox" checked>'),
      '<input type="checkbox" checked disabled>',
    );
    assert.equal(sanitizeHtml('<input type="password" name="p">'), '');
  });

  it('unwraps what it does not know rather than eating the words', () => {
    assert.equal(sanitizeHtml('<html><body><font size="7">hello</font></body></html>'), 'hello');
    assert.equal(sanitizeHtml('<o:p>Word</o:p>'), 'Word');
  });

  it('drops the head, whose content is not prose that lost its wrapper', () => {
    assert.equal(sanitizeHtml('<head><title>Secret</title></head><p>body</p>'), '<p>body</p>');
  });

  it('closes what the author left open', () => {
    assert.equal(sanitizeHtml('<p>one<p>two'), '<p>one</p><p>two</p>');
    assert.equal(sanitizeHtml('<ul><li>a<li>b</ul>'), '<ul><li>a</li><li>b</li></ul>');
  });

  it('ignores a close tag that closes nothing', () => {
    assert.equal(sanitizeHtml('</div><p>still here</p>'), '<p>still here</p>');
  });

  it('treats a lone angle bracket as the character it is', () => {
    assert.equal(sanitizeHtml('<p>a < b and c > d</p>'), '<p>a &lt; b and c &gt; d</p>');
  });

  it('escapes an ampersand once and only once', () => {
    // The naive escape turns `&amp;` into `&amp;amp;` and does it again on
    // every save, which is how an imported document grows ampersands.
    assert.equal(sanitizeHtml('<p>Tools &amp; toys &nbsp; a & b</p>'), '<p>Tools &amp; toys &nbsp; a &amp; b</p>');
    assert.equal(sanitizeHtml(sanitizeHtml('<p>a &amp; b</p>')), '<p>a &amp; b</p>');
  });

  it('is idempotent, which is what lets it run on every keystroke', () => {
    const messy = '<div class="x" onclick="y"><p>one<b>two</b><script>z</script></div>';
    const once = sanitizeHtml(messy);
    assert.equal(sanitizeHtml(once), once);
  });

  /*
   * The same rule as markdown's, and the tab is the spelling only HTML can
   * reach: a markdown link's URL cannot hold whitespace, an attribute's can.
   * A URL parser removes it before it reads anything, so `/<tab>/evil.example`
   * is `//evil.example` by the time the browser has it.
   */
  it('refuses a path a browser would read as another origin', () => {
    assert.equal(sanitizeHtml('<a href="/\\evil.example">x</a>'), '<a>x</a>');
    assert.equal(sanitizeHtml('<a href="/\t/evil.example">x</a>'), '<a>x</a>');
    assert.equal(sanitizeHtml('<img src="/\\evil.example/x.png">'), '<img>');
    assert.equal(sanitizeHtml('<a href="/pages/1">ok</a>'), '<a href="/pages/1">ok</a>');
  });

  it('sends an off-site link to a new tab and a local one nowhere', () => {
    assert.equal(
      sanitizeHtml('<a href="https://example.com">out</a>'),
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">out</a>',
    );
    assert.equal(sanitizeHtml('<a href="/pages/1">in</a>'), '<a href="/pages/1">in</a>');
  });
});

describe('parseHtml', () => {
  it('does not open an element inside a script', () => {
    const nodes = parseHtml('<script>if (a<b) {}</script><p>after</p>');
    assert.deepEqual(nodes.map((n) => (typeof n === 'string' ? '#text' : n.tag)), ['script', 'p']);
  });

  it('keeps an attribute value containing a bracket', () => {
    const [node] = parseHtml('<a href="/x?a=1&b=2" title="a > b">t</a>');
    assert.equal(typeof node === 'string' ? '' : node.attrs.title, 'a > b');
  });
});

describe('htmlToMarkdown', () => {
  const md = (html: string) => htmlToMarkdown(html);

  it('turns headings, paragraphs and emphasis into markdown', () => {
    assert.equal(
      md('<h2>Title</h2><p>Some <strong>bold</strong> and <em>italic</em>.</p>'),
      '## Title\n\nSome **bold** and _italic_.',
    );
  });

  it('keeps a link and an image', () => {
    assert.equal(md('<p><a href="https://x.example">x</a></p>'), '[x](https://x.example)');
    assert.equal(md('<p><img src="/f/1.png" alt="a"></p>'), '![a](/f/1.png)');
  });

  it('keeps the words of a link it cannot follow', () => {
    assert.equal(md('<a href="javascript:x">important sentence</a>'), 'important sentence');
  });

  it('nests a list', () => {
    assert.equal(
      md('<ul><li>one<ul><li>deeper</li></ul></li><li>two</li></ul>'),
      '- one\n  - deeper\n- two',
    );
  });

  it('numbers an ordered list from where it starts', () => {
    assert.equal(md('<ol start="3"><li>c</li><li>d</li></ol>'), '3. c\n4. d');
  });

  it('reads a checkbox back as a task', () => {
    assert.equal(
      md('<ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox" disabled> open</li></ul>'),
      '- [x] done\n- [ ] open',
    );
  });

  it('makes a fenced block out of a pre, with its language', () => {
    assert.equal(
      md('<pre><code class="language-ts">const a = 1;\n</code></pre>'),
      '```ts\nconst a = 1;\n```',
    );
  });

  it('does not escape inside code', () => {
    assert.equal(md('<p>call <code>a[0] * b</code></p>'), 'call `a[0] * b`');
  });

  it('makes a table', () => {
    assert.equal(
      md('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'),
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
    );
  });

  it('escapes a pipe inside a cell rather than splitting on it', () => {
    assert.ok(md('<table><tr><td>a|b</td></tr></table>').includes('a\\|b'));
  });

  it('quotes a blockquote on every line', () => {
    assert.equal(md('<blockquote><p>one</p><p>two</p></blockquote>'), '> one\n>\n> two');
  });

  it('decodes entities, including the German ones a legacy export carries', () => {
    assert.equal(md('<p>Gr&uuml;&szlig;e &amp; Dank &#8212; ja</p>'), 'Grüße & Dank — ja');
  });

  it('escapes what would be markup once it is markdown again', () => {
    assert.equal(md('<p>2 * 3 [see]</p>'), '2 \\* 3 \\[see\\]');
  });

  it('separates blocks that a div ran together', () => {
    assert.equal(md('<div>loose text<p>a paragraph</p></div>'), 'loose text\n\na paragraph');
  });

  it('survives the trip out of the renderer and back', () => {
    const source = '## Heading\n\nSome **bold** text.\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';
    assert.equal(htmlToMarkdown(renderMarkdown(source)), source);
  });
});

describe('reading a document', () => {
  it('says what it is called', () => {
    assert.equal(htmlTitle('<html><head><title> Handbook </title></head><body><h1>Other</h1>'), 'Handbook');
    assert.equal(htmlTitle('<div><h1>Only a heading</h1></div>'), 'Only a heading');
    assert.equal(htmlTitle('<p>nothing</p>'), null);
  });

  it('reads out as text, with the blocks kept apart', () => {
    assert.equal(htmlText('<h1>One</h1><p>Two</p><script>three</script>'), 'One Two');
  });

  it('knows a document from prose that mentions a tag', () => {
    assert.ok(looksLikeHtml('<!doctype html><html><body>x</body></html>'));
    assert.ok(looksLikeHtml('<h1>Title</h1><p>text</p>'));
    assert.equal(looksLikeHtml('a line\nand another<br>with a break'), false);
    assert.equal(looksLikeHtml('# A markdown heading\n\nwith prose.'), false);
  });

  it('lays source out to be read', () => {
    assert.equal(formatHtml('<h1>a</h1><p>b <b>c</b></p>'), '<h1>a</h1>\n<p>b <b>c</b></p>');
  });

  it('does not tidy the blank lines out of a code block', () => {
    // The first version collapsed `\n{2,}` over the finished string, which
    // cannot tell the newlines it added from the ones somebody's code needs.
    const code = '<pre><code>one\n\ntwo</code></pre>';
    assert.match(formatHtml(code), /one\n\ntwo/);
  });
});

describe('input that must not make it stall or lose text', () => {
  it('reads an unquoted value that carries an equals sign', () => {
    assert.equal(sanitizeHtml('<a href=/search?q=1&page=2>go</a>'), '<a href="/search?q=1&amp;page=2">go</a>');
  });

  it('treats a tag nobody closed as the character it starts with', () => {
    // A quote in a text run is a quote; only `&`, `<` and `>` can start markup.
    assert.equal(sanitizeHtml('a < b <p unterminated="x'), 'a &lt; b &lt;p unterminated="x');
  });

  it('gets through a page of unbalanced quotes without going quadratic', () => {
    // The regex this replaced — a quantifier inside a quantifier — took minutes
    // on this input. A sanitiser that can be made to hang the tab it is
    // protecting has a denial of service in it.
    const nasty = `<a ${'" '.repeat(20_000)}>x</a>`;
    const started = Date.now();
    sanitizeHtml(nasty);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
  });
});
