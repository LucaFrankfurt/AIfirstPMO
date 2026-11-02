/**
 * The app's half of the conversation with an artboard's frame.
 *
 * The frame runs somebody's code, and that code can post messages to the app
 * as easily as our runtime can. So what is pinned here is the part that must
 * not be generous: what a message has to look like to be believed, which links
 * are allowed to leave, and where our script is put into a board — before the
 * board's own scripts, and never ahead of its doctype.
 *
 * And the cache key. The frame is cached for a year under its hash; a frame
 * file changed without a new hash is a frame nobody's browser will fetch again.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FRAME_VERSION, outboundLink, prepare, readMessage, type RuntimeConfig } from '../src/modules/pages/frame.ts';

const config = (mode: RuntimeConfig['mode']): RuntimeConfig => ({
  mode, rev: 3, selected: null, scroll: null, labels: { drag: 'Drag' },
});

describe('the frame file', () => {
  it('is asked for by its current hash', () => {
    const file = readFileSync(new URL('../public/artboard.html', import.meta.url));
    const hash = createHash('sha256').update(file).digest('hex').slice(0, FRAME_VERSION.length);
    assert.equal(FRAME_VERSION, hash, 'artboard.html changed: set FRAME_VERSION to the new hash');
  });
});

describe('what the frame is sent', () => {
  it('puts our script first in the head, after the doctype', () => {
    const out = prepare('<!doctype html><html><head><title>x</title></head><body><p>Hi</p></body></html>', config('view'));
    assert.match(out, /^<!doctype html><html><head><script data-kolibri>\(/);
    assert.ok(out.indexOf('<script') < out.indexOf('<title>'));
  });

  it('gives a fragment a document of its own rather than a quirks-mode one', () => {
    assert.match(prepare('<p>Hi</p>', config('view')), /^<!doctype html><meta charset="utf-8"><script data-kolibri>/);
  });

  it('numbers elements only while editing', () => {
    const source = '<!doctype html><html><head></head><body><p>Hi</p></body></html>';
    assert.doesNotMatch(prepare(source, config('view')), /<p data-k/);
    assert.match(prepare(source, config('edit')), /<p data-k="\d+">Hi<\/p>/);
  });

  it('is a script that parses on its own', () => {
    const out = prepare('<p>Hi</p>', config('edit'));
    const code = /<script data-kolibri>([\s\S]*)<\/script>/.exec(out)![1];
    assert.doesNotThrow(() => new Function(code));
  });

  it('cannot be closed early by what the config says', () => {
    const out = prepare('<p>Hi</p>', { ...config('edit'), labels: { drag: '</script><script>alert(1)</script>' } });
    assert.equal(out.match(/<\/script>/g)!.length, 1);
  });
});

describe('fitting a board to a phone', () => {
  // The adapter goes in beside the config, as source, only on a board page
  // that is being reflowed — never in the editor, the canvas or the designed
  // view, which show the board as written.
  const handed = (out: string): string => out.slice(out.lastIndexOf('}, ') + 3, out.lastIndexOf(');</script>'));

  it('hands the frame the adapter only when asked to fit', () => {
    assert.match(prepare('<p>Hi</p>', { ...config('play'), fit: true, adapt: true }), /function \w*\(\)\s*\{[\s\S]*grid-template-columns/);
    assert.equal(handed(prepare('<p>Hi</p>', { ...config('play'), fit: true })), 'null');
    assert.equal(handed(prepare('<p>Hi</p>', config('edit'))), 'null');
  });

  it('is still one script that parses on its own', () => {
    const out = prepare('<p>Hi</p>', { ...config('play'), fit: true, adapt: true });
    const code = out.slice(out.indexOf('<script data-kolibri>') + 21, out.indexOf('</script>'));
    assert.doesNotThrow(() => new Function(code));
  });

  // A board whose script measured it is drawn a second time with what the
  // fitting changed already in place — as a stylesheet ahead of anything of
  // the board's, and made only of what `fitCss` lets through.
  it('draws a board again with the fitting in place from the start', () => {
    const board = '<!doctype html><html><head><title>x</title><script>draw()</script></head><body><div>Hi</div></body></html>';
    const out = prepare(board, { ...config('play'), fit: true, adapt: true, fitted: [['0', 'max-width', '100%'], ['', 'overflow-wrap', 'anywhere']] });
    assert.match(out, /<style data-kolibri-fit>body>:nth-child\(1\)\{max-width:100%!important\}\nbody\{overflow-wrap:anywhere!important\}<\/style>/);
    assert.ok(out.indexOf('<style data-kolibri-fit>') < out.indexOf('<script>draw()'), 'the board\'s script ran before the fitting was in place');
    assert.doesNotMatch(prepare(board, { ...config('play'), fit: true, adapt: true }), /<style data-kolibri-fit>/);
  });

  it('lets nothing into that stylesheet that the fitting could not have written', () => {
    const out = prepare('<p>Hi</p>', { ...config('play'), fit: true, adapt: true, fitted: [
      ['0', 'max-width', '100%</style><script>alert(1)</script>'],
      ['0', 'background', 'url(https://example.com/x)'],
      ['0', 'max-width', '1px;background:red'],
      ['0 > *', 'max-width', '100%'],
    ] });
    assert.equal(out.match(/<\/script>/g)!.length, 1);
    assert.match(out, /<style data-kolibri-fit><\/style>/);
  });
});

describe('what the frame is believed about', () => {
  it('takes a well-formed message', () => {
    assert.deepEqual(readMessage({ type: 'kolibri:move', rev: 1, k: 4, target: 9, where: 'after' }),
      { type: 'kolibri:move', rev: 1, k: 4, target: 9, where: 'after' });
  });

  it('takes what the fitting changed only as rules of three strings', () => {
    assert.deepEqual(readMessage({ type: 'kolibri:fitted', rev: 2, rules: [['0.1', 'flex-wrap', 'wrap']] }),
      { type: 'kolibri:fitted', rev: 2, rules: [['0.1', 'flex-wrap', 'wrap']] });
    assert.equal(readMessage({ type: 'kolibri:fitted', rev: 2, rules: [] }), null);
    assert.equal(readMessage({ type: 'kolibri:fitted', rev: 2, rules: [['0', 'flex-wrap']] }), null);
    assert.equal(readMessage({ type: 'kolibri:fitted', rev: 2, rules: [['0', 'flex-wrap', 7]] }), null);
    assert.equal(readMessage({ type: 'kolibri:fitted', rev: 2, rules: Array.from({ length: 2001 }, () => ['0', 'gap', '0']) }), null);
  });

  it('drops one it does not know, or one with the wrong shape', () => {
    assert.equal(readMessage({ type: 'kolibri:navigate', href: '/' }), null);
    assert.equal(readMessage({ type: 'kolibri:move', rev: 1, k: -1, target: 9, where: 'after' }), null);
    assert.equal(readMessage({ type: 'kolibri:move', rev: 1, k: 1.5, target: 9, where: 'after' }), null);
    assert.equal(readMessage({ type: 'kolibri:move', rev: 1, k: 1, target: 9, where: 'inside' }), null);
    assert.equal(readMessage({ type: 'kolibri:key', rev: 1, key: 'format-disk' }), null);
    assert.equal(readMessage({ type: 'kolibri:inner', rev: 1, k: 1, html: 42 }), null);
    assert.equal(readMessage('kolibri:ready'), null);
  });

  it('lets only web and mail links out', () => {
    assert.equal(outboundLink('https://example.com/a'), 'https://example.com/a');
    assert.equal(outboundLink('mailto:a@example.com'), 'mailto:a@example.com');
    assert.equal(outboundLink('javascript:alert(1)'), null);
    assert.equal(outboundLink('data:text/html,<p>'), null);
    assert.equal(outboundLink('about:blank'), null);
  });
});
