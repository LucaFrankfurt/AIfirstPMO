/**
 * `[[Onboarding]]` — the other half of a wiki.
 *
 * The tree says where a page sits; a link says what it is about, and the two
 * disagree on purpose. What is worth proving here is not that a link becomes an
 * anchor — that is one regex — but the four ways it has gone wrong in tools
 * that have this feature:
 *
 * - a link inside a code fence, which is somebody *documenting* the syntax;
 * - a title that is spelled with the characters emphasis is spelled with, so
 *   the label comes out italic and the page is called something else;
 * - a rename, which breaks every link to the page unless something rewrites
 *   them, and rewrites the wrong ones if it is careless;
 * - a title two pages share, where the answer has to be the same tomorrow.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  excerpt, headingSlug, linkContext, linkGraph, linkableTitle, outlineOf, pageKey, pageResolver,
  renameLinks, renderMarkdown, wikiLinks,
} from '@kolibri/shared';

const pages = [
  { id: 'p1', title: 'Handbook', content: 'Start at [[Onboarding]], then [[Tools & toys]].', created_at: 1 },
  { id: 'p2', title: 'Onboarding', content: 'Back to [[Handbook|the handbook]]. Also [[Nothing here]].', created_at: 2 },
  { id: 'p3', title: 'Tools & toys', content: 'No links.', created_at: 3 },
];

const linksTo = (id: string) => (target: string) => ({ href: `/pages/${id}`, missing: target === '__none__' });

describe('finding the links in a page', () => {
  it('reads a bare target, an alias and the whitespace around both', () => {
    const found = wikiLinks('See [[ Onboarding ]] and [[Handbook | the handbook ]].');
    assert.deepEqual(found.map((link) => [link.target, link.label]), [
      ['Onboarding', null],
      ['Handbook', 'the handbook'],
    ]);
  });

  it('keeps its hands off code', () => {
    assert.equal(wikiLinks('Write `[[Title]]` to link.').length, 0);
    assert.equal(wikiLinks('```\n[[Title]]\n```').length, 0);
    // ...and a backtick inside the fence must not pair with one after it.
    assert.equal(wikiLinks('```\n`[[A]]\n```\n[[B]] `x`').length, 1);
  });

  it('does not read one across a line break, or an empty one', () => {
    assert.equal(wikiLinks('[[Onboarding\n]]').length, 0);
    assert.equal(wikiLinks('[[  ]]').length, 0);
  });

  it('reports offsets into the source it was given', () => {
    const source = 'x [[A]] y';
    const [link] = wikiLinks(source);
    assert.equal(source.slice(link.at, link.end), '[[A]]');
  });
});

describe('resolving a title', () => {
  const resolve = pageResolver(pages);

  it('ignores case and runs of whitespace', () => {
    assert.equal(resolve('onboarding')?.id, 'p2');
    assert.equal(resolve('  Tools   &   toys ')?.id, 'p3');
  });

  it('says nothing for a page nobody has written', () => {
    assert.equal(resolve('Nothing here'), undefined);
  });

  it('gives the same answer tomorrow when two pages share a title', () => {
    const twice = [...pages, { id: 'p4', title: 'onboarding', content: '', created_at: 9 }];
    // The older page wins, so writing a second `Onboarding` does not silently
    // move every link in the workspace to it.
    assert.equal(pageResolver(twice)('Onboarding')?.id, 'p2');
    // ...and an exact-case match still beats a folded one.
    assert.equal(pageResolver(twice)('onboarding')?.id, 'p4');
  });
});

describe('the web the links make', () => {
  const graph = linkGraph(pages);

  it('points both ways', () => {
    assert.deepEqual(graph.out.get('p1'), ['p2', 'p3']);
    assert.deepEqual(graph.in.get('p2'), ['p1']);
    assert.deepEqual(graph.in.get('p1'), ['p2']);
  });

  it('collects the pages nobody has written yet, and who asked', () => {
    assert.deepEqual(graph.missing.get(pageKey('Nothing here')), ['p2']);
  });

  it('does not draw an edge from a page to itself', () => {
    const self = linkGraph([{ id: 'p1', title: 'Handbook', content: 'See [[Handbook]].' }]);
    assert.equal(self.in.get('p1'), undefined);
    assert.equal(self.out.get('p1'), undefined);
  });

  it('names a page it links to twice only once', () => {
    const twice = linkGraph([...pages.slice(1), { id: 'p0', title: 'Twice', content: '[[Onboarding]] [[onboarding]]' }]);
    assert.deepEqual(twice.out.get('p0'), ['p2']);
  });
});

describe('the sentence a backlink came from', () => {
  it('quotes the paragraph the link sits in, with the link read as its label', () => {
    const source = 'First thought.\n\nStart at [[Onboarding|day one]] before anything else.\n\nLater.';
    assert.equal(linkContext(source, 'onboarding'), 'Start at day one before anything else.');
  });

  it('says nothing when the page does not link there', () => {
    assert.equal(linkContext('Nothing.', 'Onboarding'), null);
  });
});

describe('renaming a page', () => {
  it('rewrites the links to it and leaves the words the author chose', () => {
    const source = 'See [[Onboarding]] and [[onboarding|day one]] and [[Handbook]].';
    assert.equal(
      renameLinks(source, 'Onboarding', 'Getting started'),
      'See [[Getting started]] and [[Getting started|day one]] and [[Handbook]].',
    );
  });

  it('leaves a page with no links to it exactly as it was', () => {
    const source = 'No links at all.';
    assert.equal(renameLinks(source, 'Onboarding', 'Getting started'), source);
  });

  it('does not rewrite the syntax somebody was documenting', () => {
    const source = '```\n[[Onboarding]]\n```';
    assert.equal(renameLinks(source, 'Onboarding', 'Getting started'), source);
  });

  it('refuses a title that cannot be linked to rather than writing a broken link', () => {
    assert.equal(linkableTitle('Q1 | Q2'), false);
    assert.equal(renameLinks('[[A]]', 'A', 'Q1 | Q2'), null);
  });
});

describe('rendering a link', () => {
  it('asks the caller where the page is, and says nothing when it is not told', () => {
    assert.match(
      renderMarkdown('Start at [[Onboarding]].', { pageHref: linksTo('p2') }),
      /<a class="md-page" href="\/pages\/p2">Onboarding<\/a>/,
    );
    assert.equal(renderMarkdown('Start at [[Onboarding]].'), '<p>Start at [[Onboarding]].</p>');
  });

  it('shows the alias and links the title', () => {
    assert.match(
      renderMarkdown('[[Onboarding|day one]]', { pageHref: linksTo('p2') }),
      /href="\/pages\/p2">day one</,
    );
  });

  it('marks a page nobody has written, because that is the invitation to write it', () => {
    const html = renderMarkdown('[[__none__]]', { pageHref: linksTo('new') });
    assert.match(html, /class="md-page md-page-new"/);
  });

  it('hands the caller the title as it was typed, not as it was escaped', () => {
    const seen: string[] = [];
    renderMarkdown('[[Tools & toys]]', {
      pageHref: (target) => {
        seen.push(target);
        return { href: '/pages/p3' };
      },
    });
    assert.deepEqual(seen, ['Tools & toys']);
  });

  it('leaves a title alone that is spelled the way emphasis is', () => {
    const html = renderMarkdown('[[Q1_targets_2026]] and [[Q3 * Q4]]', {
      pageHref: () => ({ href: '/pages/p8' }),
    });
    assert.match(html, />Q1_targets_2026</, 'an underscore in a title is not emphasis');
    assert.match(html, />Q3 \* Q4</, 'a star in a title is not emphasis either');
    assert.doesNotMatch(html, /<em>|md-tag/);
  });

  it('keeps its hands off code, the same way references do', () => {
    const options = { pageHref: linksTo('p2') };
    assert.doesNotMatch(renderMarkdown('`[[Onboarding]]`', options), /md-page/);
    assert.doesNotMatch(renderMarkdown('```\n[[Onboarding]]\n```', options), /md-page/);
  });

  it('does not put a link inside a link', () => {
    const html = renderMarkdown('[[Onboarding|see WEB-42]]', {
      pageHref: linksTo('p2'),
      keys: ['WEB'],
    });
    assert.doesNotMatch(html, /<a[^>]*>[^<]*<a /);
    assert.equal(html.match(/<a /g)?.length, 1);
  });

  it('escapes what it was handed, both halves', () => {
    const html = renderMarkdown('[[x|<script>]]', { pageHref: () => ({ href: '/pages/"onerror="x' }) });
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /onerror="x"/);
  });
});

describe('a link in a preview', () => {
  it('reads as the page is called, not as the syntax is spelled', () => {
    // The card on the wiki index and the row in a search result both go
    // through here, and both used to show the brackets.
    assert.equal(excerpt('Fang bei [[Onboarding]] an.'), 'Fang bei Onboarding an.');
    assert.equal(excerpt('Zurück zum [[Handbuch|Handbuch]].'), 'Zurück zum Handbuch.');
  });
});

describe('a link to a section', () => {
  it('splits the title from the heading, and reads as the heading', () => {
    const [link] = wikiLinks('See [[Onboarding#Day one]].');
    assert.equal(link.target, 'Onboarding');
    assert.equal(link.heading, 'Day one');
    assert.match(
      renderMarkdown('See [[Onboarding#Day one]].', {
        pageHref: (target, heading) => ({ href: `/pages/p2#h-${heading?.toLowerCase().replace(' ', '-')}` }),
      }),
      /href="\/pages\/p2#h-day-one">Day one</,
    );
  });

  it('reads a leading # as a section of the page it is written on', () => {
    const [link] = wikiLinks('Jump to [[#Day one]].');
    assert.equal(link.target, '');
    assert.equal(link.heading, 'Day one');
    // ...and names no other page, so it is not an edge in the graph.
    assert.equal(linkGraph([{ id: 'p1', title: 'A', content: 'Jump to [[#Day one]].' }]).out.size, 0);
  });

  it('keeps the section when the page is renamed', () => {
    assert.equal(
      renameLinks('See [[Onboarding#Day one|day one]].', 'Onboarding', 'Getting started'),
      'See [[Getting started#Day one|day one]].',
    );
  });
});

describe('the id a heading carries', () => {
  it('is the same slug the link has to spell', () => {
    assert.equal(headingSlug('Day one'), 'day-one');
    assert.equal(headingSlug('## Über uns'), 'über-uns', 'an umlaut is not folded away');
    assert.equal(headingSlug('`code` and [a link](/x)'), 'code-and-a-link');
  });

  it('is only emitted when the caller asked for one', () => {
    assert.equal(renderMarkdown('# Day one'), '<h1>Day one</h1>');
    assert.equal(renderMarkdown('# Day one', { headingPrefix: 'h-' }), '<h1 id="h-day-one">Day one</h1>');
  });

  it('numbers a slug two headings want, so a fragment means one section', () => {
    const html = renderMarkdown('## Notes\n\n## Notes\n', { headingPrefix: 'h-' });
    assert.match(html, /id="h-notes"/);
    assert.match(html, /id="h-notes-2"/);
  });

  it('gives a heading with nothing sluggable in it something to be', () => {
    assert.match(renderMarkdown('## ---', { headingPrefix: 'h-' }), /id="h-section"/);
  });
});

describe('a page drawn inside another', () => {
  const body = (pages: Record<string, string>) => (target: string) => {
    const content = pages[target];
    return content === undefined
      ? undefined
      : { id: target, title: target, href: `/pages/${target}`, content };
  };

  it('draws the page where the line was, and says where it came from', () => {
    const html = renderMarkdown('Before.\n\n![[Terms]]\n\nAfter.', {
      pageBody: body({ Terms: '## Terms\n\nPay in thirty days.' }),
    });
    assert.match(html, /<figure class="md-embed">/);
    assert.match(html, /Pay in thirty days\./);
    assert.match(html, /<figcaption><a class="md-page" href="\/pages\/Terms">Terms<\/a><\/figcaption>/);
    assert.match(html, /<p>Before\.<\/p>/);
  });

  it('stays as it was written when the caller cannot say what the page holds', () => {
    assert.equal(renderMarkdown('![[Terms]]'), '<p>![[Terms]]</p>');
    assert.equal(renderMarkdown('![[Nothing]]', { pageBody: body({}) }), '<p>![[Nothing]]</p>');
  });

  it('is a block, so a line with anything else on it is a paragraph', () => {
    const html = renderMarkdown('See ![[Terms]] there.', { pageBody: body({ Terms: 'x' }) });
    assert.doesNotMatch(html, /md-embed/);
  });

  it('refuses to re-enter a page already open above it', () => {
    // A page embedding itself, and two embedding each other: both would recurse
    // forever, and both are things somebody does by accident.
    const self = renderMarkdown('![[A]]', { pageBody: body({ A: 'inside\n\n![[A]]' }) });
    assert.match(self, /md-embed-loop/);
    assert.equal(self.match(/inside/g)?.length, 1);

    const pair = renderMarkdown('![[A]]', { pageBody: body({ A: '![[B]]', B: '![[A]]' }) });
    assert.match(pair, /md-embed-loop/);
  });

  it('does not let an embedded page take ids from the page around it', () => {
    /* The outline is read off the host's own source, so a heading numbered by
       text the host does not contain is a link that lands on the wrong
       paragraph — which is what this did before the embed was given its own
       (absent) prefix. */
    const html = renderMarkdown('![[Terms]]\n\n## Notes\n', {
      headingPrefix: 'h-',
      pageBody: body({ Terms: '## Notes\n\nPay in thirty days.' }),
    });
    assert.match(html, /id="h-notes"/, "the host's own heading keeps the plain slug");
    assert.doesNotMatch(html, /id="h-notes-2"/);
    assert.deepEqual(outlineOf('![[Terms]]\n\n## Notes\n').map((one) => one.slug), ['notes']);
  });

  it('draws the checkboxes of an embedded page inert', () => {
    const html = renderMarkdown('![[List]]', { pageBody: body({ List: '- [ ] one' }) });
    // `toggleTask` counts over the host page's source, which has never seen
    // this line: a box that ticked here would tick something else.
    assert.match(html, /<input type="checkbox" disabled/);
    assert.doesNotMatch(html, /data-task/);
  });
});

describe('the outline of a page', () => {
  it('reads the headings the renderer would draw, and slugs them the same way', () => {
    const source = '# Handbuch\n\ntext\n\n## Über uns\n\n### Team\n\nUnterstrichen\n---\n';
    assert.deepEqual(outlineOf(source), [
      { level: 1, text: 'Handbuch', slug: 'handbuch' },
      { level: 2, text: 'Über uns', slug: 'über-uns' },
      { level: 3, text: 'Team', slug: 'team' },
      { level: 2, text: 'Unterstrichen', slug: 'unterstrichen' },
    ]);
    // The whole point of sharing the slug maker: these two must agree.
    const html = renderMarkdown(source, { headingPrefix: 'h-' });
    for (const heading of outlineOf(source)) assert.match(html, new RegExp(`id="h-${heading.slug}"`));
  });

  it('numbers a repeated heading the way the ids are numbered', () => {
    const source = '## Notes\n\n## Notes\n';
    assert.deepEqual(outlineOf(source).map((h) => h.slug), ['notes', 'notes-2']);
    assert.match(renderMarkdown(source, { headingPrefix: 'h-' }), /id="h-notes-2"/);
  });

  it('is not fooled by a comment in a shell block or a rule under nothing', () => {
    assert.deepEqual(outlineOf('```sh\n# not a heading\n```\n\n---\n'), []);
  });
});
