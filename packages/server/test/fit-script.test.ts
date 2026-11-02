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

const { fitCss, fitScript, intoHead, stripFitScript, withFit } = await import('@kolibri/shared');

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

  it('signs the rules it carries across a reload with the document, so they reach no other', () => {
    const sign = (html: string): string => /, "([^"]*)"\);<\/script>/.exec(withFit(html))![1];
    assert.ok(sign(BOARD).length > 4);
    assert.equal(sign(BOARD), sign(withFit(BOARD)), 'a board fitted twice is not the same board');
    assert.notEqual(sign(BOARD), sign(BOARD.replace('Pipeline</h1>', 'Pipeline!</h1>')));
  });

  it('gives a document with no viewport one — a phone lays it out at 980px otherwise', () => {
    assert.match(withFit(BOARD), /<meta name="viewport" content="width=device-width, initial-scale=1" data-kolibri-fit>/);
    const own = BOARD.replace('<title>', '<meta name="viewport" content="width=1280"><title>');
    assert.doesNotMatch(withFit(own), /data-kolibri-fit>(?!\()/, 'a board\'s own viewport was overridden');
    assert.equal(stripFitScript(withFit(own)), own);
  });
});

/*
 * The rules a board is drawn the second time with. Inside a shared link or a
 * downloaded file they cross a reload in the window's name, which anything
 * that runs in that window can write — so whatever arrives is read as if a
 * stranger wrote it, and only what `fitBoard` itself could have written gets
 * through.
 */
describe('the fitting as a stylesheet', () => {
  it('turns places into selectors from the body down', () => {
    assert.equal(fitCss([['', 'overflow-wrap', 'anywhere']]), 'body{overflow-wrap:anywhere!important}');
    assert.equal(fitCss([['0.3.12', 'grid-template-columns', 'repeat(auto-fill, minmax(min(100%, 140px), 1fr))']]),
      'body>:nth-child(1)>:nth-child(4)>:nth-child(13){grid-template-columns:repeat(auto-fill, minmax(min(100%, 140px), 1fr))!important}');
  });

  it('lets through no property the fitting does not set', () => {
    for (const prop of ['background', 'background-image', 'content', 'behavior', '--x', 'MAX-WIDTH', 'max-width;color']) {
      assert.equal(fitCss([['0', prop, 'auto']]), '', prop);
    }
  });

  it('lets through no value that could leave its declaration', () => {
    for (const value of ['url(x)', 'URL (x)', 'image-set(x)', 'red;background:url(x)', '1px}body{display:none', '"x"', "'x'", 'a:b',
      '</style><script>alert(1)</script>', 'expression(alert(1))', '\\75rl(x)', 'repeat(2, url(x))', '']) {
      assert.equal(fitCss([['0', 'max-width', value]]), '', value);
    }
  });

  it('lets through no place that is not a path of child indices', () => {
    for (const path of ['*', '0 > *', '0,body', '-1', '0..1', '0.', 'a', '0.1.2'.repeat(30)]) assert.equal(fitCss([[path, 'gap', '0']]), '', path);
  });

  it('takes nothing that is not a list of rules', () => {
    for (const rules of [null, 'body{}', { 0: ['0', 'gap', '0'] }, [['0', 'gap']], [[0, 'gap', '0', 'x']]]) assert.equal(fitCss(rules), '');
  });
});
