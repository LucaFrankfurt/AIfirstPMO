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
  excerpt, linkContext, linkGraph, linkableTitle, pageKey, pageResolver, renameLinks, renderMarkdown, wikiLinks,
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
    const html = renderMarkdown('[[Q1_targets_2026]] and [[#done]]', {
      pageHref: (target) => ({ href: `/pages/${target === '#done' ? 'p9' : 'p8'}` }),
    });
    assert.match(html, />Q1_targets_2026</, 'an underscore in a title is not emphasis');
    assert.match(html, />#done</, 'a title starting with # is not a tag');
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
