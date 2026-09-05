/**
 * Everything that is on screen for all thirty seconds, in both cuts.
 *
 * Two things live here rather than in a scene, and both for the same reason: a
 * scene owns its own fade, so anything a scene painted would fade with it. The
 * bloom drifts across all thirty seconds and the corner lockup sits above five
 * of the seven beats — put either inside a `<Sequence>` and the spot starts
 * blinking at every cut.
 */
import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { BEATS, window as beatWindow } from '../timing';
import { colour, font } from '../theme';
import { ramp } from './anim';
import { Stage } from './Stage';
import { Mark } from './Wordmark';

/**
 * Where the bloom sits during each beat, opposite whatever the beat's visual
 * mass is: right of centre when the picture is on the right, high and central
 * when it is in the middle, and full and centred for the two brand beats. The
 * vertical cut stacks everything, so it takes the second column instead.
 */
const BLOOM = {
  wide: [
    { x: 0.5, y: 0.44, strength: 0.95 },
    { x: 0.73, y: 0.4, strength: 0.72 },
    { x: 0.5, y: 0.3, strength: 0.66 },
    { x: 0.69, y: 0.46, strength: 0.72 },
    { x: 0.5, y: 0.34, strength: 0.66 },
    { x: 0.71, y: 0.42, strength: 0.72 },
    { x: 0.5, y: 0.5, strength: 1 },
  ],
  tall: [
    { x: 0.5, y: 0.46, strength: 0.95 },
    { x: 0.5, y: 0.24, strength: 0.7 },
    { x: 0.5, y: 0.22, strength: 0.66 },
    { x: 0.5, y: 0.26, strength: 0.7 },
    { x: 0.5, y: 0.22, strength: 0.66 },
    { x: 0.5, y: 0.26, strength: 0.7 },
    { x: 0.5, y: 0.5, strength: 1 },
  ],
} as const;

const AT = BEATS.map((_, i) =>
  i === 0 ? 0 : BEATS.slice(0, i).reduce((sum, beat) => sum + beat.frames, 0),
);

const smooth = {
  easing: Easing.bezier(0.6, 0, 0.4, 1),
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

/** The lockup that sits in the corner once the opening title has gone. */
export const Corner: React.FC<{ left?: number; top: number; centred?: boolean }> = ({
  left = 118,
  top,
  centred = false,
}) => {
  const frame = useCurrentFrame();
  const on =
    ramp(frame, beatWindow.offline.from + 16, 20) *
    (1 - ramp(frame, beatWindow.close.from - 14, 12));
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

export const Backdrop: React.FC<{ shape: 'wide' | 'tall' }> = ({ shape }) => {
  const frame = useCurrentFrame();
  const keys = BLOOM[shape];
  return (
    <Stage
      x={interpolate(frame, AT, keys.map((k) => k.x), smooth)}
      y={interpolate(frame, AT, keys.map((k) => k.y), smooth)}
      strength={interpolate(frame, AT, keys.map((k) => k.strength), smooth)}
    />
  );
};
