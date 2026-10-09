/**
 * The arithmetic behind looking closely at a diagram.
 *
 * Separated from the viewer because it is the part that is wrong in ways a
 * screenshot does not show: a zoom that drifts off the point you aimed at, a
 * pan that lets the picture leave the window and never come back, a reset that
 * resets to something other than what you first saw. None of that needs a
 * browser to find, and all of it needs saying exactly once.
 *
 * The frame is: `scale` with the picture's own pixels as the unit, and `x`/`y`
 * the offset of the picture's top-left corner from the viewport's, in viewport
 * pixels. So a point `p` in the picture is drawn at `p * scale + offset`.
 */

export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * How far in and out it goes.
 *
 * The floor is below "fit" on purpose — a diagram wider than the window fits at
 * well under 1, and refusing to go below 1 would mean refusing to show the
 * whole of the thing somebody opened. The ceiling is where a vector stops
 * adding detail and starts only adding pixels.
 */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

export const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/**
 * The whole picture, centred, with a margin.
 *
 * Never above 1: a small diagram blown up to fill a large window is not a
 * better view of it, it is a blurry one — mermaid's text is laid out at a size
 * meant to be read at 1.
 */
export function fit(picture: Size, frame: Size, margin = 24): View {
  const room = {
    width: Math.max(1, frame.width - margin * 2),
    height: Math.max(1, frame.height - margin * 2),
  };
  const scale = Math.min(1, room.width / picture.width, room.height / picture.height);
  return centre({ scale, x: 0, y: 0 }, picture, frame);
}

/** Puts the picture in the middle of the frame at whatever scale it is on. */
export function centre(view: View, picture: Size, frame: Size): View {
  return {
    scale: view.scale,
    x: (frame.width - picture.width * view.scale) / 2,
    y: (frame.height - picture.height * view.scale) / 2,
  };
}

/**
 * Zoom so that the point under the cursor stays under the cursor.
 *
 * This is the whole of what makes a wheel feel like a magnifier rather than a
 * slider: the picture point `at` resolves to `(at - offset) / scale`, and it is
 * held still by solving the same equation for the new offset.
 */
export function zoomAt(view: View, at: { x: number; y: number }, factor: number): View {
  const scale = clampScale(view.scale * factor);
  // Clamping can make the step smaller than asked, so the ratio is read back
  // rather than assumed — otherwise the point drifts at the ends of the range.
  const ratio = scale / view.scale;
  return {
    scale,
    x: at.x - (at.x - view.x) * ratio,
    y: at.y - (at.y - view.y) * ratio,
  };
}

/**
 * Keep a corner of the picture reachable from inside the frame.
 *
 * Not "keep it fully inside": a diagram zoomed past the window has to be
 * draggable past the edges or its corners are unreachable. What this refuses is
 * losing it — dragging until nothing is on screen and there is no way back,
 * which is the failure people report as "it disappeared". Whatever the scale,
 * `KEEP` pixels of it stay in view on each axis.
 */
const KEEP = 48;

export function hold(view: View, picture: Size, frame: Size): View {
  const drawn = { width: picture.width * view.scale, height: picture.height * view.scale };
  const limit = (offset: number, size: number, frameSize: number): number => {
    // Smaller than the frame: it may sit anywhere that keeps it overlapping.
    if (size <= frameSize) return Math.min(frameSize - KEEP, Math.max(KEEP - size, offset));
    return Math.min(KEEP, Math.max(frameSize - size - KEEP, offset));
  };
  return {
    scale: view.scale,
    x: limit(view.x, drawn.width, frame.width),
    y: limit(view.y, drawn.height, frame.height),
  };
}

/**
 * Two fingers, as one thing: where they are between them, and how far apart.
 *
 * Spread is the distance; the midpoint is what the gesture is *about*, because
 * a pinch is not only a zoom — fingers that move together across the glass
 * also drag, and a viewer that only read the distance would zoom correctly and
 * refuse to follow the hand.
 */
export interface Grip {
  x: number;
  y: number;
  spread: number;
}

export const grip = (a: { x: number; y: number }, b: { x: number; y: number }): Grip => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  spread: Math.hypot(a.x - b.x, a.y - b.y),
});

/**
 * From one two-finger pose to another, in one step.
 *
 * Both halves at once: the picture point that was under the midpoint when the
 * fingers landed is still under the midpoint wherever it has moved to. Zoom
 * about where they started, then carry the result by how far the middle went.
 *
 * Applied from the pose at the start of the gesture rather than from the last
 * frame. Two fingers on glass jitter, and chaining a hundred small corrections
 * accumulates every rounding — pinching in and back out would not return to
 * where it began, which is the thing a hand notices and cannot describe.
 *
 * A spread of zero is two fingers in one place: a real reading, and no scale
 * to be had from it, so it only carries.
 */
export function pinch(view: View, from: Grip, to: Grip): View {
  const zoomed = zoomAt(view, from, from.spread > 0 ? to.spread / from.spread : 1);
  return { scale: zoomed.scale, x: zoomed.x + (to.x - from.x), y: zoomed.y + (to.y - from.y) };
}

/** One notch of a wheel or a key, as a multiplier. */
export const STEP = 1.2;

/** A wheel's delta, which differs by device and by browser, as a multiplier. */
export const wheelFactor = (deltaY: number): number => Math.exp(-deltaY / 400);
