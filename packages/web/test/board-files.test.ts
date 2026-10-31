/**
 * Pictures in a board: swapped for their bytes on the way into the frame, and
 * swapped back on the way out.
 *
 * The frame cannot fetch `/files/…` — no session, no network — so the app
 * fetches and inlines. What has to hold is the round trip: the board's source
 * must keep saying the path, because a `data:` URL written back into it would
 * be a megabyte of text merged character by character and a hash the trash can
 * no longer see.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const HASH = 'a'.repeat(64);
const PATH = `/files/${HASH}/chart.png`;
const fetched: string[] = [];

// The two browser things the module touches, as small as they can be.
globalThis.fetch = (async (url: string) => {
  fetched.push(String(url));
  if (String(url).includes('missing')) return new Response(null, { status: 404 });
  return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
}) as typeof fetch;
(globalThis as Record<string, unknown>).FileReader = class {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((bytes) => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
      this.onload?.();
    });
  }
};

const { filePaths, hasFiles, inlineFiles, restoreFiles } = await import('../src/modules/pages/board-files.ts');

const BOARD = `<!doctype html><body>
  <img src="${PATH}" alt="Q3">
  <div style="background: url(${PATH})">x</div>
  <a href="https://example.com/files/${HASH}/chart.png">not ours</a>
</body>`;

describe('finding the files a board names', () => {
  it('finds this server\'s, once each, and nothing else', () => {
    assert.ok(hasFiles(BOARD));
    assert.deepEqual(filePaths(BOARD), [PATH]);
    assert.equal(hasFiles('<img src="/files/short/x.png">'), false, 'not a hash');
  });
});

describe('inlining', () => {
  it('swaps every mention of a path for its bytes, and fetches it once', async () => {
    fetched.length = 0;
    const out = await inlineFiles(BOARD);
    assert.doesNotMatch(out, /(["'(=])\/files\//, 'a path of ours was left for the frame to fail on');
    assert.match(out, /<img src="data:image\/png;base64,iVBORw==" alt="Q3">/);
    assert.match(out, /url\(data:image\/png;base64,iVBORw==\)/);
    assert.match(out, new RegExp(`href="https://example.com/files/${HASH}/chart.png"`), 'another site\'s URL was rewritten');
    assert.equal(fetched.length, 1);
    await inlineFiles(BOARD);
    assert.equal(fetched.length, 1, 'the second render fetched the picture again');
  });

  it('leaves a picture it cannot fetch as its path', async () => {
    const missing = `/files/${'b'.repeat(64)}/missing.png`;
    assert.equal(await inlineFiles(`<img src="${missing}">`), `<img src="${missing}">`);
  });
});

describe('what comes back out of the frame', () => {
  it('names the file again, never its bytes', async () => {
    const inlined = await inlineFiles(`<p>Look <img src="${PATH}"> here</p>`);
    const typed = inlined.replace('Look', 'Look at');
    assert.equal(restoreFiles(typed), `<p>Look at <img src="${PATH}"> here</p>`);
  });
});
