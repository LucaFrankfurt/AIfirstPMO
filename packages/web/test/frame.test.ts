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
    assert.match(out, /^<!doctype html><html><head><script>\(/);
    assert.ok(out.indexOf('<script>') < out.indexOf('<title>'));
  });

  it('gives a fragment a document of its own rather than a quirks-mode one', () => {
    assert.match(prepare('<p>Hi</p>', config('view')), /^<!doctype html><meta charset="utf-8"><script>/);
  });

  it('numbers elements only while editing', () => {
    const source = '<!doctype html><html><head></head><body><p>Hi</p></body></html>';
    assert.doesNotMatch(prepare(source, config('view')), /<p data-k/);
    assert.match(prepare(source, config('edit')), /<p data-k="\d+">Hi<\/p>/);
  });

  it('is a script that parses on its own', () => {
    const out = prepare('<p>Hi</p>', config('edit'));
    const code = /<script>([\s\S]*)<\/script>/.exec(out)![1];
    assert.doesNotThrow(() => new Function(code));
  });

  it('cannot be closed early by what the config says', () => {
    const out = prepare('<p>Hi</p>', { ...config('edit'), labels: { drag: '</script><script>alert(1)</script>' } });
    assert.equal(out.match(/<\/script>/g)!.length, 1);
  });
});

describe('what the frame is believed about', () => {
  it('takes a well-formed message', () => {
    assert.deepEqual(readMessage({ type: 'kolibri:move', rev: 1, k: 4, target: 9, where: 'after' }),
      { type: 'kolibri:move', rev: 1, k: 4, target: 9, where: 'after' });
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
