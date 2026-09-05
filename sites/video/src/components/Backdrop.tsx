/**
 * Everything that is on screen for all thirty seconds, in every spot.
 *
 * Two things live here rather than in a scene, and both for the same reason: a
 * scene owns its own fade, so anything a scene painted would fade with it. The
 * bloom drifts across all thirty seconds and the corner lockup sits above the
 * middle beats — put either inside a `<Sequence>` and the spot starts blinking
 * at every cut.
 *
 * A spot does not give the bloom coordinates. It names a *mood* per beat and
 * the coordinates live here once, because the useful decision is "this beat's
 * picture is on the right, put the light on the left of it" and the useful
 * place for `0.71` is nowhere near that decision.
 */
import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { colour, font } from '../theme';
import { ramp } from './anim';
import { Stage } from './Stage';
import { Mark } from './Wordmark';

export type Mood = 'brand' | 'right' | 'left' | 'high';
export type Shape = 'wide' | 'tall';

/**
 * The vertical cut stacks everything down the middle, so left and right have no
 * meaning there — both collapse onto a bloom sitting above the visual mass.
 */
const MOODS: Record<Shape, Record<Mood, { x: number; y: number; strength: number }>> = {
  wide: {
    brand: { x: 0.5, y: 0.46, strength: 1 },
    right: { x: 0.71, y: 0.42, strength: 0.72 },
    left: { x: 0.31, y: 0.42, strength: 0.72 },
    high: { x: 0.5, y: 0.3, strength: 0.66 },
  },
  tall: {
    brand: { x: 0.5, y: 0.46, strength: 1 },
    right: { x: 0.5, y: 0.26, strength: 0.7 },
    left: { x: 0.5, y: 0.26, strength: 0.7 },
    high: { x: 0.5, y: 0.22, strength: 0.66 },
  },
};

const smooth = {
  easing: Easing.bezier(0.6, 0, 0.4, 1),
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

export const Backdrop: React.FC<{
  shape: Shape;
  /** The frame each beat starts on. */
  starts: readonly number[];
  /** One mood per beat, in the same order. */
  moods: readonly Mood[];
}> = ({ shape, starts, moods }) => {
  const frame = useCurrentFrame();
  const keys = moods.map((mood) => MOODS[shape][mood]);
  return (
    <Stage
      x={interpolate(frame, starts, keys.map((k) => k.x), smooth)}
      y={interpolate(frame, starts, keys.map((k) => k.y), smooth)}
      strength={interpolate(frame, starts, keys.map((k) => k.strength), smooth)}
    />
  );
};

/**
 * The lockup that sits in the corner once the opening title has gone, and goes
 * again before the closing one arrives — two wordmarks on screen at once is the
 * one thing a brand beat cannot survive.
 */
export const Corner: React.FC<{
  from: number;
  until: number;
  top: number;
  left?: number;
  centred?: boolean;
}> = ({ from, until, top, left = 118, centred = false }) => {
  const frame = useCurrentFrame();
  const on = ramp(frame, from, 20) * (1 - ramp(frame, until, 12));
  return (
    <div
      style={{
        position: 'absolute',
        left: centred ? 0 : left,
        right: centred ? 0 : undefined,
        top,
        display: 'flex',
        alignItems: 'center',
        justifyContent: centred ? 'center' : 'flex-start',
        gap: 15,
        opacity: on,
      }}
    >
      <Mark size={40} />
      <span
        style={{ font: `700 32px/1 ${font.sans}`, letterSpacing: '-0.03em', color: colour.fg }}
      >
        Kolibri
      </span>
    </div>
  );
};
