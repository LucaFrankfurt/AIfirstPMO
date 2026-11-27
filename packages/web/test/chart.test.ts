/**
 * A chart in a message: a `chart` fence drawn as HTML, and the support chat's
 * rule that a stranger's text brings no images and no links.
 *
 * What matters most is what must *not* happen. A block that is not a chart this
 * understands stays code — a chart guessed from a half-written spec would be a
 * picture of numbers nobody wrote. And every word in the spec is somebody
 * else's text, so it is escaped wherever it lands: the title, the legend, the
 * hover, the table.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHART_LABELS_MAX, CHART_SERIES_MAX, chartsAsText, parseChart, renderMarkdown } from '@kolibri/shared';

const fence = (spec: unknown) => `\`\`\`chart\n${typeof spec === 'string' ? spec : JSON.stringify(spec)}\n\`\`\``;
const bookings = { type: 'bar', title: 'Bookings', labels: ['Sep', 'Oct', 'Nov'], series: [{ name: '2026', values: [12, 19, 25] }] };

describe('a chart block', () => {
  it('draws bars, with the numbers on them and the same numbers as a table', () => {
    const html = renderMarkdown(fence(bookings));
    assert.match(html, /<figure class="md-chart" data-chart="bar" aria-label="Bookings">/);
    assert.equal(html.match(/class="md-chart-bar md-s1"/g)?.length, 3);
    assert.match(html, /<b>25<\/b>/, 'three bars are few enough to label');
    assert.match(html, /<details class="md-chart-table"><summary>Table<\/summary>/);
    assert.match(html, /<tr><th>Nov<\/th><td>25<\/td><\/tr>/);
    assert.doesNotMatch(html, /md-chart-legend/, 'one series is named by the title, not a legend');
  });

  it('scales to a round number, and draws a bar to scale', () => {
    // 25 rounds up to 25 (2.5 × 10): the tallest bar fills the plot.
    const html = renderMarkdown(fence(bookings));
    assert.match(html, /style="bottom:0%;height:100%"/);
    assert.match(html, /<span style="bottom:100%">25<\/span>/);
  });

  it('draws a line, with a legend for two series', () => {
    const html = renderMarkdown(fence({
      type: 'line', labels: ['Q1', 'Q2'], series: [{ name: 'Shop A', values: [1, 4] }, { name: 'Shop B', values: [2, 3] }],
    }));
    assert.match(html, /<div class="md-chart-legend"><span><i class="md-s1"><\/i>Shop A<\/span><span><i class="md-s2"><\/i>Shop B<\/span><\/div>/);
    assert.equal(html.match(/<polyline /g)?.length, 2);
    assert.match(html, /vector-effect="non-scaling-stroke"/);
    assert.equal(html.match(/<b>/g), null, 'two ends would crowd into each other: the legend and the table carry them');
    const one = renderMarkdown(fence({ type: 'line', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Shop A', values: [1, 4, 6] }] }));
    assert.equal(one.match(/<b>/g)?.length, 1, 'one line wears its last value, not every point');
  });

  it('crosses zero with a zero line, and a negative bar hangs from it', () => {
    const html = renderMarkdown(fence({ labels: ['a', 'b'], series: [{ name: 'net', values: [10, -5] }] }));
    assert.match(html, /md-chart-zero/);
    assert.match(html, /md-chart-bar md-s1 md-neg/);
  });

  it('writes numbers the way the reader does, with the unit', () => {
    const html = renderMarkdown(fence({ labels: ['a'], series: [{ name: 'x', values: [1250.5] }], unit: '€' }), { locale: 'de' });
    assert.match(html, /<td>1\.250,5 €<\/td>/);
  });

  it('names the table in the reader\'s language', () => {
    assert.match(renderMarkdown(fence(bookings), { chartTableLabel: 'Als Tabelle' }), /<summary>Als Tabelle<\/summary>/);
  });

  it('escapes every word it was given', () => {
    const html = renderMarkdown(fence({
      title: '<img src=x onerror=alert(1)>', labels: ['"><script>'], series: [{ name: '<b>x</b>', values: [1] }],
    }));
    assert.doesNotMatch(html, /<img|<script|<b>x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /title="&quot;&gt;&lt;script&gt;: 1"/);
  });

  it('stays code when it is not a chart this understands', () => {
    const refused = [
      '{not json',
      { labels: [], series: [{ name: 'x', values: [] }] },
      { labels: ['a'], series: [{ name: 'x', values: [1, 2] }] },
      { labels: ['a'], series: [{ name: 'x', values: ['1'] }] },
      { type: 'pie', labels: ['a'], series: [{ name: 'x', values: [1] }] },
      { labels: ['a'], series: Array.from({ length: CHART_SERIES_MAX + 1 }, (_, n) => ({ name: `${n}`, values: [n] })) },
      { labels: Array.from({ length: CHART_LABELS_MAX + 1 }, (_, n) => `${n}`), series: [{ name: 'x', values: Array(CHART_LABELS_MAX + 1).fill(1) }] },
    ];
    for (const spec of refused) {
      const html = renderMarkdown(fence(spec));
      assert.match(html, /<pre><code class="language-chart">/, JSON.stringify(spec).slice(0, 60));
      assert.doesNotMatch(html, /md-chart/);
    }
    assert.equal(parseChart('{"labels":["a"],"series":[{"name":"x","values":[1]}]}')?.type, 'bar', 'bars unless said otherwise');
  });
});

describe('text from outside the workspace', () => {
  const line = 'See [the offer](https://example.com/offer) ![pic](https://example.com/p.png) or https://example.com';

  it('keeps links and images as the text they were written as', () => {
    const html = renderMarkdown(line, { untrusted: true });
    assert.doesNotMatch(html, /<a |<img /);
    assert.match(html, /\[the offer\]\(https:\/\/example\.com\/offer\)/);
  });

  it('still draws tables, charts and emphasis', () => {
    const html = renderMarkdown(`**Plans**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${fence(bookings)}`, { untrusted: true });
    assert.match(html, /<strong>Plans<\/strong>/);
    assert.match(html, /<table>/);
    assert.match(html, /md-chart-bar/);
  });

  it('changes nothing for the workspace\'s own text', () => {
    const html = renderMarkdown(line);
    assert.match(html, /<a href="https:\/\/example\.com\/offer"/);
    assert.match(html, /<img src="https:\/\/example\.com\/p\.png"/);
  });
});

describe('a chart where nothing draws', () => {
  it('is its numbers, line by line, and anything else stays as written', () => {
    const text = chartsAsText(`Here:\n\n${fence({ ...bookings, unit: '€' })}\n\n\`\`\`chart\n{broken\n\`\`\``, 'de');
    assert.match(text, /^Here:\n\nBookings\nSep: 12\u202f€\nOct: 19\u202f€\nNov: 25\u202f€\n/);
    assert.match(text, /```chart\n\{broken\n```$/);
  });
});

describe('a chat line', () => {
  it('keeps its line breaks when asked to, as a chat always did', () => {
    assert.equal(renderMarkdown('Hi,\nthanks', { breaks: true }), '<p>Hi,<br />thanks</p>');
    assert.equal(renderMarkdown('Hi,\nthanks'), '<p>Hi, thanks</p>', 'a page wraps as it always has');
  });
});
