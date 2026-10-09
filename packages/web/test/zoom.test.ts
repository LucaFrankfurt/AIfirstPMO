/**
 * The four ways a zoom goes wrong, pinned without a browser.
 *
 * Reported as "komplexe mermaid Diagramme kaum lesbar und keine Zoom
 * funktion": the diagram behind that report is 2968×1185 natural and was drawn
 * at 818×327 — a scale of 0.28, which turns 16px labels into 4.4px. The viewer
 * is the answer, and these are the parts of it that look fine in a screenshot
 * and are wrong in the hand.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  centre, clampScale, fit, grip, hold, MAX_SCALE, MIN_SCALE, pinch, wheelFactor, zoomAt,
} from '../src/modules/pages/zoom.ts';

/** The diagram from the report, and an ordinary laptop window. */
const PICTURE = { width: 2968, height: 1185 };
const FRAME = { width: 1512, height: 850 };

describe('what you see when it opens', () => {
  it('shows the whole diagram', () => {
    const view = fit(PICTURE, FRAME);
    assert.ok(view.scale * PICTURE.width <= FRAME.width, 'wider than the window');
    assert.ok(view.scale * PICTURE.height <= FRAME.height, 'taller than the window');
  });

  /**
   * The point of the whole change. On the page this diagram is drawn at 0.28;
   * anything at or below that would be the same unreadable picture in a larger
   * window.
   */
  it('is bigger than the 0.28 the page squeezes it to', () => {
    assert.ok(fit(PICTURE, FRAME).scale > 0.4, `fit came out at ${fit(PICTURE, FRAME).scale}`);
  });

  it('does not blow a small diagram up past its own size', () => {
    assert.equal(fit({ width: 200, height: 100 }, FRAME).scale, 1);
  });

  it('puts it in the middle', () => {
    const view = fit(PICTURE, FRAME);
    const right = FRAME.width - (view.x + PICTURE.width * view.scale);
    assert.ok(Math.abs(view.x - right) < 1, `${view.x} left, ${right} right`);
  });
});

describe('zooming towards a point', () => {
  /** A magnifier, not a slider: what is under the cursor stays under it. */
  it('holds the point the cursor is on', () => {
    const view = centre({ scale: 1, x: 0, y: 0 }, PICTURE, FRAME);
    const at = { x: 400, y: 300 };
    const before = { x: (at.x - view.x) / view.scale, y: (at.y - view.y) / view.scale };
    const after = zoomAt(view, at, 2.5);
    const now = { x: (at.x - after.x) / after.scale, y: (at.y - after.y) / after.scale };
    assert.ok(Math.abs(before.x - now.x) < 0.01 && Math.abs(before.y - now.y) < 0.01,
      `the picture moved under the cursor: ${JSON.stringify(before)} → ${JSON.stringify(now)}`);
  });

  /**
   * At the ends of the range the step is cut short, and a zoom that assumed it
   * got the factor it asked for would walk the picture sideways every notch
   * somebody keeps scrolling after it has stopped growing.
   */
  it('does not drift once it cannot zoom any further', () => {
    const at = { x: 700, y: 400 };
    let view: ReturnType<typeof zoomAt> = { scale: MAX_SCALE, x: 120, y: 80 };
    for (let i = 0; i < 20; i++) view = zoomAt(view, at, 2);
    assert.equal(view.scale, MAX_SCALE);
    assert.deepEqual([view.x, view.y], [120, 80]);
  });

  it('stays inside the range it is allowed', () => {
    assert.equal(clampScale(1e6), MAX_SCALE);
    assert.equal(clampScale(0), MIN_SCALE);
  });

  /** Trackpads and mice disagree about what one notch is; both go the right way. */
  it('reads a wheel in both directions', () => {
    assert.ok(wheelFactor(-100) > 1, 'scrolling up should magnify');
    assert.ok(wheelFactor(100) < 1, 'scrolling down should shrink');
    assert.equal(wheelFactor(0), 1);
  });
});

describe('dragging it about', () => {
  /** Zoomed in past the window, the corners have to be reachable. */
  it('lets a picture larger than the window be dragged past its edges', () => {
    const view = hold({ scale: 4, x: -3000, y: -1200 }, PICTURE, FRAME);
    assert.ok(view.x < 0 && view.y < 0, 'refused to show the far corner');
  });

  /** And never so far that there is nothing left to grab. */
  it('always keeps some of it on screen', () => {
    for (const thrown of [
      { scale: 4, x: -99999, y: -99999 },
      { scale: 4, x: 99999, y: 99999 },
      { scale: 0.2, x: -99999, y: 50 },
      { scale: 0.2, x: 99999, y: -99999 },
    ]) {
      const view = hold(thrown, PICTURE, FRAME);
      const drawn = { width: PICTURE.width * view.scale, height: PICTURE.height * view.scale };
      assert.ok(view.x < FRAME.width && view.x + drawn.width > 0, `off sideways: ${JSON.stringify(view)}`);
      assert.ok(view.y < FRAME.height && view.y + drawn.height > 0, `off vertically: ${JSON.stringify(view)}`);
    }
  });

  it('leaves a view that is already in the window alone', () => {
    const view = fit(PICTURE, FRAME);
    assert.deepEqual(hold(view, PICTURE, FRAME), view);
  });
});

describe('two fingers', () => {
  const view = centre({ scale: 1, x: 0, y: 0 }, PICTURE, FRAME);
  /** Where a picture point ends up on the glass, which is what a hand judges. */
  const on = (v: typeof view, point: { x: number; y: number }) => ({
    x: point.x * v.scale + v.x,
    y: point.y * v.scale + v.y,
  });
  /** ...and the reverse: what is under a point on the glass. */
  const under = (v: typeof view, at: { x: number; y: number }) => ({
    x: (at.x - v.x) / v.scale,
    y: (at.y - v.y) / v.scale,
  });

  it('reads a pose off two points', () => {
    const pose = grip({ x: 100, y: 100 }, { x: 400, y: 500 });
    assert.deepEqual([pose.x, pose.y], [250, 300]);
    assert.equal(pose.spread, 500);
  });

  it('magnifies as the fingers go apart and shrinks as they come together', () => {
    const from = grip({ x: 500, y: 400 }, { x: 700, y: 400 });
    assert.ok(pinch(view, from, grip({ x: 400, y: 400 }, { x: 800, y: 400 })).scale > view.scale);
    assert.ok(pinch(view, from, grip({ x: 580, y: 400 }, { x: 620, y: 400 })).scale < view.scale);
  });

  /**
   * The whole of what makes it feel like paper: whatever was between the
   * fingers when they landed is still between them wherever they end up.
   */
  it('keeps what is between the fingers between the fingers', () => {
    const from = grip({ x: 500, y: 400 }, { x: 700, y: 400 });
    const held = under(view, from);
    // Spread apart and walked across the glass at the same time.
    const to = grip({ x: 250, y: 250 }, { x: 750, y: 350 });
    const after = pinch(view, from, to);
    const where = on(after, held);
    assert.ok(Math.abs(where.x - to.x) < 0.01 && Math.abs(where.y - to.y) < 0.01,
      `it slipped: wanted ${JSON.stringify(to)}, got ${JSON.stringify(where)}`);
  });

  /** Two fingers that keep their distance are a drag, not a zoom. */
  it('carries without zooming when the spread does not change', () => {
    const from = grip({ x: 500, y: 400 }, { x: 700, y: 400 });
    const to = grip({ x: 540, y: 460 }, { x: 740, y: 460 });
    const after = pinch(view, from, to);
    assert.equal(after.scale, view.scale);
    assert.deepEqual([after.x - view.x, after.y - view.y], [40, 60]);
  });

  /**
   * Both fingers in one place. A real reading off real glass, and a divisor
   * this would otherwise hand `Infinity` and a diagram that vanishes.
   */
  it('survives two fingers landing on the same spot', () => {
    const from = grip({ x: 600, y: 400 }, { x: 600, y: 400 });
    const after = pinch(view, from, grip({ x: 650, y: 420 }, { x: 650, y: 420 }));
    assert.equal(after.scale, view.scale);
    assert.ok(Number.isFinite(after.x) && Number.isFinite(after.y));
  });

  /** Pinched in and back out, the picture is where it started. */
  it('comes back to where it was', () => {
    const from = grip({ x: 500, y: 400 }, { x: 700, y: 400 });
    const out = grip({ x: 300, y: 400 }, { x: 900, y: 400 });
    const back = pinch(pinch(view, from, out), out, from);
    assert.ok(Math.abs(back.scale - view.scale) < 1e-9, `scale drifted to ${back.scale}`);
    assert.ok(Math.abs(back.x - view.x) < 1e-9 && Math.abs(back.y - view.y) < 1e-9);
  });
});
