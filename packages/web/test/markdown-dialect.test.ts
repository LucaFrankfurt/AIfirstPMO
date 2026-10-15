/**
 * The dialect `docs/markdown.md` promises.
 *
 * `markdown.test.ts` covers references and `markdown-blocks.test.ts` covers the
 * block grammar. This is the third thing: the claims the documentation makes
 * that nothing else pins down — the URL allowlist, and the list of syntax that
 * is *deliberately* not supported.
 *
 * The omissions are worth a test precisely because they are decisions rather
 * than gaps. Nothing fails when four-space indented code quietly starts being a
 * code block: it just breaks the checkbox counter three files away, months
 * later. Written down here, the decision has to be changed on purpose.
 *
 * Every assertion below has a sentence in `docs/markdown.md` behind it. If one
 * of these changes, that document is wrong until it is changed too.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { excerpt, renderMarkdown } from '@kolibri/shared';

/** Rendered with no options — a public share link renders exactly this way. */
const md = (source: string) => renderMarkdown(source);

describe('what may become a link', () => {
  it('takes the four schemes the renderer will follow', () => {
    assert.match(md('[x](https://e.com)'), /<a href="https:\/\/e\.com"/);
    assert.match(md('[x](http://e.com)'), /<a href="http:\/\/e\.com"/);
    assert.match(md('[x](mailto:a@b.com)'), /<a href="mailto:a@b\.com"/);
    assert.match(md('[x](/pages/abc)'), /<a href="\/pages\/abc"/);
    assert.match(md('[x](#section)'), /<a href="#section"/);
  });

  it('refuses everything else, and leaves it as text rather than as an attribute', () => {
    // The second half matters more than the first: a refused URL that still
    // reached an `href` would be a refusal on paper only.
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>x</script>', '//evil.example', 'vbscript:x']) {
      const html = md(`[x](${href})`);
      assert.doesNotMatch(html, /<a /, `${href} became a link`);
      assert.doesNotMatch(html, /href=/, `${href} reached an attribute`);
    }
  });

  /*
   * The same refusal, spelled the way a URL parser reads it rather than the way
   * it is written. `new URL('/\\evil.example', 'https://kolibri.test/p')` is
   * `https://evil.example/`: for a special scheme the WHATWG parser reads `\`
   * as `/`, and it strips every tab and newline before it looks at anything.
   *
   * These got through for a long time, and they are worse than a plain external
   * link because they wear an internal one's clothes — no `target="_blank"`, no
   * `rel="noopener"`, and on a share page or in an exported file no router to
   * intercept the click. `//evil.example` was refused all along, which is the
   * proof the intent was there and the spelling was the gap.
   */
  it('refuses a path that a browser would read as another origin', () => {
    for (const href of ['/\\evil.example', '/\\/evil.example', '/\\\\evil.example']) {
      const html = md(`[x](${href})`);
      assert.doesNotMatch(html, /href=/, `${JSON.stringify(href)} reached an attribute`);
    }
  });

  it('still takes an ordinary path', () => {
    assert.match(md('[x](/pages/abc)'), /href="\/pages\/abc"/);
    assert.match(md('[x](/files/a%20b.png)'), /href="\/files\/a%20b\.png"/);
  });

  it('applies the same rule to an image source', () => {
    assert.doesNotMatch(md('![x](javascript:alert(1))'), /<img/);
    assert.doesNotMatch(md('![x](data:image/svg+xml,<svg onload=alert(1)>)'), /<img/);
    assert.match(md('![x](/files/a.png)'), /<img src="\/files\/a\.png"/);
  });

  it('sends an external link to a new tab and keeps an internal one in this one', () => {
    assert.match(md('[x](https://e.com)'), /target="_blank" rel="noopener noreferrer"/);
    assert.equal(md('[x](/pages/abc)'), '<p><a href="/pages/abc">x</a></p>');
  });

  it('links a bare URL but not a bare www', () => {
    assert.match(md('see https://e.com/a'), /<a href="https:\/\/e\.com\/a"/);
    // `www.` on its own is as often prose as it is an address.
    assert.equal(md('see www.e.com'), '<p>see www.e.com</p>');
  });
});

describe('nothing but escaped text ever gets in', () => {
  it('escapes raw HTML rather than passing or stripping it', () => {
    // Not stripped: the author typed it, and showing what they typed is the
    // honest outcome. `<script>` cannot exist either way.
    assert.equal(md('<b>x</b>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
    assert.doesNotMatch(md('<script>alert(1)</script>'), /<script/);
    assert.doesNotMatch(md('<img src=x onerror=alert(1)>'), /<img src=x/);
  });

  it('cannot be broken out of through a link label or an image alt', () => {
    // The words survive as *text* — `a"onmouseover="alert(1)` is what the author
    // typed and is what they see. What must not survive is the quote that would
    // end the attribute and start a new one, so that is what is asserted: no
    // `"` anywhere in the output is followed by a handler.
    const breakout = /"\s*on\w+\s*=/;
    const link = md('[a"onmouseover="alert(1)](/x)');
    assert.doesNotMatch(link, breakout);
    assert.match(link, /&quot;onmouseover=&quot;/, 'and the text itself is still shown');

    const image = md('![a"onerror="alert(1)](/x.png)');
    assert.doesNotMatch(image, breakout);
    assert.match(image, /alt="a&quot;onerror=&quot;alert\(1\)"/);
  });

  it('writes an entity as the characters that were typed', () => {
    // A consequence of escaping first, and the alternative is a second decoder
    // to keep safe.
    assert.equal(md('&copy;'), '<p>&amp;copy;</p>');
  });
});

describe('syntax that is deliberately not supported', () => {
  it('does not read four-space indentation as a code block', () => {
    // `toggleTask` counts checkboxes over the same source and cannot tell
    // indented code from a nested list without becoming a second parser.
    assert.equal(md('    const x = 1;'), '<p>const x = 1;</p>');
  });

  it('does not resolve reference-style links', () => {
    assert.equal(md('[a][ref]'), '<p>[a][ref]</p>');
  });

  it('does not read footnotes', () => {
    assert.equal(md('text[^1]'), '<p>text[^1]</p>');
  });

  it('does not expand emoji shortcodes', () => {
    assert.equal(md(':tada: done'), '<p>:tada: done</p>');
  });

  it('needs a space after a heading’s hashes, because a tag is the commoner case', () => {
    assert.match(md('#NoSpace'), /md-tag/);
    assert.match(md('# With space'), /<h1>With space<\/h1>/);
  });
});

describe('the rules a writer will actually trip over', () => {
  it('treats a single newline as a space, so source can be hard-wrapped', () => {
    assert.equal(md('one\ntwo'), '<p>one two</p>');
  });

  it('breaks the line for two trailing spaces or a backslash', () => {
    assert.match(md('one  \ntwo'), /one<br \/>two/);
    assert.match(md('one\\\ntwo'), /one<br \/>two/);
  });

  it('leaves an underscore inside a word alone', () => {
    assert.equal(md('snake_case_name'), '<p>snake_case_name</p>');
    assert.match(md('_this_'), /<em>this<\/em>/);
  });

  it('lets a code span hold characters every other rule would claim', () => {
    assert.match(md('a `*not bold*` b'), /<code>\*not bold\*<\/code>/);
    assert.doesNotMatch(md('a `*not bold*` b'), /<em>/);
  });

  it('reads a rule and a heading underline from the same three dashes', () => {
    assert.equal(md('---'), '<hr />');
    assert.equal(md('Title\n---'), '<h2>Title</h2>');
  });
});

/**
 * The bar, which exists because the obvious workaround is blocked.
 *
 * A page wanting a progress bar used to reach for `geps.dev/progress/48` as an
 * image, and the browser refused it: `img-src` is `'self' data: blob:` and is
 * not going to grow an exception for a service that would learn the numbers it
 * draws. So the dialect draws it, and these are the claims
 * `docs/markdown.md` makes about how.
 */
describe('a progress bar', () => {
  it('draws a percentage as a track, a fill and the number', () => {
    assert.equal(
      md('{48%}'),
      '<p><span class="md-bar"><span class="md-bar-track">'
      + '<span class="md-bar-fill" style="width:48%"></span></span>'
      + '<span class="md-bar-value">48%</span></span></p>',
    );
  });

  it('reads a fraction as the share it is', () => {
    assert.match(md('{3/8}'), /style="width:37\.5%"/);
    assert.match(md('{3/8}'), /<span class="md-bar-value">3\/8<\/span>/);
  });

  it('takes a decimal comma, because the documents here are German', () => {
    assert.match(md('{48,5%}'), /style="width:48\.5%"/);
    // The label keeps the author's spelling; only the attribute is normalised.
    assert.match(md('{48,5%}'), />48,5%</);
  });

  it('colours only on a word, never on the number', () => {
    assert.match(md('{92% ok}'), /class="md-bar md-bar-ok"/);
    assert.match(md('{60% warn}'), /class="md-bar md-bar-warn"/);
    assert.match(md('{12% danger}'), /class="md-bar md-bar-danger"/);
    // 12% of a long project is not bad news, and nothing in the renderer says
    // it is: with no word, the bar is the accent colour at any value.
    assert.equal(md('{12%}').includes('md-bar-danger'), false);
  });

  it('fills the bar past full and still says what the number was', () => {
    assert.match(md('{120%}'), /style="width:100%"/);
    assert.match(md('{120%}'), />120%</);
    assert.match(md('{9/4}'), /style="width:100%"/);
  });

  it('draws an empty track at nothing, rather than a sliver', () => {
    assert.match(md('{0%}'), /style="width:0%"/);
    assert.match(md('{0/8}'), /style="width:0%"/);
  });

  it('leaves alone what is not one', () => {
    // No unit is a number in braces, which is what a template or a formula
    // looks like; a fraction of nothing has no bar to draw; and a code span
    // wins here as it does everywhere.
    assert.equal(md('{48}'), '<p>{48}</p>');
    assert.equal(md('{todo}'), '<p>{todo}</p>');
    assert.equal(md('{3/0}'), '<p>{3/0}</p>');
    assert.match(md('`{48%}`'), /<code>\{48%\}<\/code>/);
  });

  /*
   * Found while reading the diff, and worth keeping: a URL is allowed to hold
   * braces, and with the rule applied to the whole string the bar was drawn
   * inside the `href` — markup in an attribute, which breaks the attribute and
   * the link with it. Anchors and images are held aside now, as `references`
   * has always held them.
   */
  it('leaves a URL that happens to contain braces alone', () => {
    assert.equal(
      md('https://e.com/a{1/2}b'),
      '<p><a href="https://e.com/a{1/2}b" target="_blank" rel="noopener noreferrer">https://e.com/a{1/2}b</a></p>',
    );
    assert.match(md('![x](/f/{1/2}.png)'), /<img src="\/f\/\{1\/2\}\.png"/);
    assert.doesNotMatch(md('https://e.com/a{1/2}b'), /md-bar/);
  });

  it('puts nothing but its own computed width in an attribute', () => {
    // The whole safety argument of this file is that the document never
    // reaches an attribute. A bar is the one rule here that writes a `style`.
    const html = md('{48% ok} and {1/3 warn}');
    assert.deepEqual(
      [...html.matchAll(/style="([^"]*)"/g)].map((match) => match[1]),
      ['width:48%', 'width:33.3%'],
    );
  });

  it('works where a status actually gets written', () => {
    // In a table cell, which is the reason this is an inline rule rather than a
    // block: a status column is where somebody wants eight of these.
    assert.match(md('| Ziel | Stand |\n| --- | --- |\n| Rollout | {48%} |'), /<td><span class="md-bar"/);
    assert.match(md('- Rollout {48%}'), /<li>Rollout <span class="md-bar"/);
  });
});

/**
 * The other half of the rule: rendered where there is room, stripped where
 * there is not.
 *
 * `excerpt` is what does the stripping, and it is load-bearing in three places
 * — the card on the pages list, the card on the projects list, and a search
 * result's snippet. All three are one truncated line, and a heading or a list
 * dropped into one breaks the row rather than saying anything. It had no test
 * until descriptions became markdown and it started deciding what people see.
 */
describe('the one-line summary a card shows', () => {
  it('takes the markup out and leaves the sentence', () => {
    assert.equal(excerpt('## Heading\n\nSome **bold** text'), 'Heading Some bold text');
    assert.equal(excerpt('- one\n- two'), 'one two');
    assert.equal(excerpt('> quoted'), 'quoted');
  });

  it('keeps a link’s words and drops its URL', () => {
    // The label is what the sentence was about; the address is not readable
    // prose and would eat the whole line.
    assert.equal(excerpt('A [link](/pages/x) inside'), 'A link inside');
  });

  it('drops an image and a fenced block entirely', () => {
    assert.equal(excerpt('An ![image](/f.png) and text'), 'An and text');
    assert.equal(excerpt('```js\nconst x = 1;\n```\nAfter the code'), 'After the code');
  });

  it('reads a progress bar as its number', () => {
    // `{48%}` left whole would put braces on a card; stripped by the
    // punctuation sweep it would have left them standing and taken the dash
    // out of the fraction.
    assert.equal(excerpt('Rollout {48%} und Umzug {3/8}'), 'Rollout 48% und Umzug 3/8');
  });

  it('truncates with an ellipsis, and says nothing about nothing', () => {
    assert.equal(excerpt('x'.repeat(50), 10), `${'x'.repeat(10)}\u2026`);
    assert.equal(excerpt(''), '');
    assert.equal(excerpt(null as unknown as string), '');
  });
});
