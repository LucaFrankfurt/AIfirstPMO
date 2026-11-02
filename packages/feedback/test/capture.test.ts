// Capture arithmetic and the encoder's format decision.
//
// The renderers themselves are not unit-testable in node — they need a real layout
// engine — so what is tested here is deliberately the part that does NOT: the
// downscale math, the encoder's choice of format and quality, and the blank-canvas
// detector. Those are also the parts that decide the payload size, i.e. whether
// someone on mobile data can file a report at all.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fitWithin,
  isRequestedType,
  encodeWithinBudget,
  looksUsable,
  MAX_EDGE_PX,
} from '../src/adapters/capture/capture.ts';

describe('fitWithin', () => {
  it('caps the long edge at MAX_EDGE_PX and preserves the aspect ratio', () => {
    const r = fitWithin(3200, 1800);
    assert.equal(Math.max(r.width, r.height), MAX_EDGE_PX);
    assert.ok(Math.abs(r.width / r.height - 3200 / 1800) < 0.005);
  });

  it('caps on HEIGHT when the image is portrait (a phone screenshot)', () => {
    const r = fitWithin(800, 3000);
    assert.equal(r.height, MAX_EDGE_PX);
    assert.ok(r.width < MAX_EDGE_PX);
  });

  it('NEVER upscales — a small viewport is already the size it is', () => {
    // Enlarging would inflate the payload while adding exactly zero detail.
    assert.deepEqual(fitWithin(390, 844), { width: 390, height: 844 });
    assert.deepEqual(fitWithin(100, 100), { width: 100, height: 100 });
  });

  it('leaves an image exactly at the limit untouched', () => {
    assert.deepEqual(fitWithin(MAX_EDGE_PX, 900), { width: MAX_EDGE_PX, height: 900 });
  });

  it('floors rather than rounds, so the result can never exceed the cap', () => {
    // Derived from the constant, not a literal: a hardcoded size silently stops
    // exercising the scaling path the moment the cap moves.
    const r = fitWithin(MAX_EDGE_PX + 1, MAX_EDGE_PX + 1);
    assert.ok(r.width <= MAX_EDGE_PX);
    assert.ok(r.height <= MAX_EDGE_PX);
  });

  it('captures a 2560-wide desktop viewport 1:1 (regression: the smeared-badge bug)', () => {
    // The defect this guards: at a 1600 cap a 2560 desktop was resampled by 0.625,
    // shrinking 12px badge text to 7.5px and smearing white-on-dark labels into
    // unreadable blocks. Confirmed to be the RESIZE, not the encoder — lossless PNG
    // at 1600 smeared just as badly. Any future cap below 2560 reintroduces it.
    assert.deepEqual(fitWithin(2560, 1440), { width: 2560, height: 1440 });
    assert.deepEqual(fitWithin(1920, 1080), { width: 1920, height: 1080 });
  });

  it('never produces a zero dimension (a zero-size canvas throws)', () => {
    const r = fitWithin(10_000, 3);
    assert.ok(r.height >= 1);
    assert.equal(r.width, MAX_EDGE_PX);
  });

  it('handles a degenerate zero-size input without dividing by zero', () => {
    assert.deepEqual(fitWithin(0, 0), { width: 0, height: 0 });
  });
});

describe('isRequestedType', () => {
  it('trusts the produced type, not the requested one', () => {
    // A canvas asked for an unsupported type silently returns PNG.
    assert.equal(isRequestedType('image/png', 'image/webp'), false);
    assert.equal(isRequestedType('image/webp', 'image/webp'), true);
  });

  it('takes an empty produced type at its word', () => {
    assert.equal(isRequestedType('', 'image/jpeg'), true);
  });
});

/**
 * A canvas stand-in whose encoder behaves like a given browser: `supported` lists the
 * types it can encode; anything else comes back as PNG, as real canvases do. Sizes
 * shrink with quality so the ladder has something to step down.
 */
function fakeCanvas(supported: string[], sizeAt: (type: string, quality: number) => number) {
  const calls: Array<[string, number]> = [];
  const canvas = {
    toBlob(callback: (blob: Blob | null) => void, type: string, quality: number) {
      calls.push([type, quality]);
      const produced = supported.includes(type) ? type : 'image/png';
      const size = produced === 'image/png' ? sizeAt('image/png', 1) : sizeAt(type, quality);
      callback(new Blob([new Uint8Array(size)], { type: produced }));
    },
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, calls };
}

const linear = (base: number) => (type: string, quality: number) =>
  type === 'image/png' ? base * 3 : Math.round(base * quality);

describe('encodeWithinBudget', () => {
  it('returns WebP at the first rung when it fits — the normal path', async () => {
    const { canvas, calls } = fakeCanvas(['image/webp', 'image/jpeg'], linear(30_000));
    const blob = await encodeWithinBudget(canvas, 1_000_000);
    assert.equal(blob?.type, 'image/webp');
    assert.deepEqual(calls, [['image/webp', 0.92]]);
  });

  it('steps quality down for a heavy page', async () => {
    const { canvas, calls } = fakeCanvas(['image/webp', 'image/jpeg'], linear(1_400_000));
    const blob = await encodeWithinBudget(canvas, 1_000_000);
    assert.equal(blob?.type, 'image/webp');
    assert.ok(blob!.size <= 1_000_000);
    assert.deepEqual(
      calls.map(([, q]) => q),
      [0.92, 0.8, 0.65],
    );
  });

  it('returns the SMALLEST WebP when even the last rung misses the target', async () => {
    const { canvas } = fakeCanvas(['image/webp', 'image/jpeg'], linear(5_000_000));
    const blob = await encodeWithinBudget(canvas, 1_000_000);
    assert.equal(blob?.type, 'image/webp');
    assert.equal(blob!.size, Math.round(5_000_000 * 0.65));
  });

  it('falls through to JPEG when the browser substitutes PNG for WebP (Safari)', async () => {
    // REGRESSION. The old encoder treated the substituted PNG as "WebP done" and never
    // tried JPEG — so such a browser always uploaded an uncompressible PNG, and the
    // quality ladder did nothing. A dense page could then exceed the hard cap and the
    // report went out without its screenshot.
    const { canvas, calls } = fakeCanvas(['image/jpeg'], linear(800_000));
    const blob = await encodeWithinBudget(canvas, 1_000_000);
    assert.equal(blob?.type, 'image/jpeg');
    assert.deepEqual(calls[0], ['image/webp', 0.92]); // one probe, not the whole ladder
    assert.deepEqual(calls[1], ['image/jpeg', 0.92]);
  });

  it('keeps the substituted PNG only when neither lossy format is available', async () => {
    const { canvas } = fakeCanvas([], linear(100_000));
    const blob = await encodeWithinBudget(canvas, 1_000_000);
    assert.equal(blob?.type, 'image/png');
  });

  it('returns null when the canvas cannot encode anything', async () => {
    const canvas = { toBlob: (cb: (b: Blob | null) => void) => cb(null) } as unknown as HTMLCanvasElement;
    assert.equal(await encodeWithinBudget(canvas), null);
  });
});

function pixelCanvas(width: number, height: number, pixel: (i: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = pixel(i);
    data.set([r, g, b, 255], i * 4);
  }
  return {
    width,
    height,
    getContext: () => ({ getImageData: () => ({ data }) }),
  } as unknown as HTMLCanvasElement;
}

describe('looksUsable', () => {
  it('accepts a canvas with real content', () => {
    assert.equal(looksUsable(pixelCanvas(100, 100, (i) => (i % 7 === 0 ? [0, 0, 0] : [255, 255, 255]))), true);
  });

  it('rejects a uniform canvas — the quiet way foreignObject fails', () => {
    assert.equal(looksUsable(pixelCanvas(100, 100, () => [255, 255, 255])), false);
  });

  it('rejects a degenerate size', () => {
    assert.equal(looksUsable(pixelCanvas(1, 100, () => [0, 0, 0])), false);
  });

  it('rejects a tainted canvas instead of throwing', () => {
    const tainted = {
      width: 10,
      height: 10,
      getContext: () => ({
        getImageData: () => {
          throw new Error('SecurityError');
        },
      }),
    } as unknown as HTMLCanvasElement;
    assert.equal(looksUsable(tainted), false);
  });
});
