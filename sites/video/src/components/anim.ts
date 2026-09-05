/**
 * The four movements everything in the spot is made of.
 *
 * There is no general-purpose animation helper here on purpose. A spot this
 * short holds together because every element arrives the same way and leaves the
 * same way; a per-scene curve is how a thirty-second video ends up feeling like
 * seven five-second videos played in a row.
 */
import { Easing, interpolate } from 'remotion';
import { ease } from '../theme';

type Curve = readonly [number, number, number, number];

const bezier = (curve: Curve) => Easing.bezier(curve[0], curve[1], curve[2], curve[3]);

/** 0 → 1 across `[start, start + dur)`, eased and clamped at both ends. */
export const ramp = (
  frame: number,
  start: number,
  dur: number,
  curve: Curve = ease.enter,
): number =>
  interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: bezier(curve),
  });

/** `ramp`, then mapped onto a range. The shape most of this file's callers want. */
export const span = (
  frame: number,
  start: number,
  dur: number,
  from: number,
  to: number,
  curve: Curve = ease.enter,
): number => from + (to - from) * ramp(frame, start, dur, curve);

/**
 * How present a beat is: up over `inDur` from its own frame 0, down over
 * `outDur` ending at `life`. Every scene wraps itself in this and nothing else
 * decides when a scene is visible.
 *
 * The defaults are short, and shortness is the whole trick. Any cross-dissolve
 * has a middle where both beats are half-there and neither is readable; twelve
 * frames of it looked like a smear, and no amount of curve-fitting on the
 * fade-out fixed that — it only moved which of the two was the murky one. Nine
 * frames is under a third of a second, which is short enough that the eye reads
 * a hand-off instead of an overlap.
 */
export const presence = (
  frame: number,
  life: number,
  inDur = 11,
  outDur = 9,
): number => ramp(frame, 0, inDur) * (1 - ramp(frame, life - outDur, outDur, ease.linear));

/**
 * A held breath: 0 → 1 → 0 across a window, for something that appears, is read
 * and goes again inside one beat — the queue counter, the "+4 days" chip.
 */
export const pulse = (frame: number, start: number, rise: number, hold: number, fall: number): number =>
  ramp(frame, start, rise) * (1 - ramp(frame, start + rise + hold, fall));

/** A staggered index, so a list of things arrives one after another. */
export const stagger = (index: number, every: number, first = 0): number => first + index * every;
