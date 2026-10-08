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
  centre, clampScale, fit, hold, MAX_SCALE, MIN_SCALE, wheelFactor, zoomAt,
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
