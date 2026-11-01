/**
 * The script that fits a board to a phone, as it travels: into the app's
 * frame, into a shared board, into a downloaded file — and back out of a
 * download that comes in again through *Import HTML…*.
 *
 * What it does inside a board is measured in a browser (`fitBoard` in
 * `shared`, walked by `check:engines`): a document with no layout cannot
 * say whether a grid ran off a screen. What is pinned here is the carrying —
 * that it lands where a board's own scripts cannot run before it, that it is
 * carried once however often a file is fitted, that it parses as a script on
 * its own, and that taking it out gives back exactly what the author wrote.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { fitScript, intoHead, stripFitScript, withFit } = await import('@kolibri/shared');

const BOARD = '<!doctype html>\n<html lang="de"><head><title>Pipeline</title></head><body><h1>Pipeline</h1></body></html>';

describe('putting a script into a board', () => {
  it('goes first in the head, after the doctype, ahead of the board\'s own', () => {
    assert.equal(intoHead(BOARD, '<x>'), BOARD.replace('<head>', '<head><x>'));
    assert.equal(intoHead('<html><body>Hi</body></html>', '<x>'), '<html><head><x></head><body>Hi</body></html>');
    assert.equal(intoHead('<!doctype html><p>Hi</p>', '<x>'), '<!doctype html><x><p>Hi</p>');
    assert.equal(intoHead('<p>Hi</p>', '<x>'), '<!doctype html><meta charset="utf-8"><x><p>Hi</p>');
  });
});

describe('the fitting script', () => {
  it('parses as a script on its own, and cannot be closed early', () => {
    const script = fitScript();
    const code = script.slice(script.indexOf('>') + 1, script.lastIndexOf('</script>'));
    assert.doesNotMatch(code, /<\/script/i);
    assert.doesNotThrow(() => new Function(code));
  });

  it('is carried once, however often a board is fitted', () => {
    const twice = withFit(withFit(BOARD));
    assert.equal(twice.split('<script data-kolibri-fit>').length - 1, 1, 'the script went in twice');
    assert.equal(twice.split('<meta name="viewport"').length - 1, 1, 'the viewport went in twice');
  });

  it('comes back out exactly, so an imported download is what its author wrote', () => {
    assert.equal(stripFitScript(withFit(BOARD)), BOARD);
  });

  it('gives a document with no viewport one — a phone lays it out at 980px otherwise', () => {
    assert.match(withFit(BOARD), /<meta name="viewport" content="width=device-width, initial-scale=1" data-kolibri-fit>/);
    const own = BOARD.replace('<title>', '<meta name="viewport" content="width=1280"><title>');
    assert.doesNotMatch(withFit(own), /data-kolibri-fit>(?!\()/, 'a board\'s own viewport was overridden');
    assert.equal(stripFitScript(withFit(own)), own);
  });
});
