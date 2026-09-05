/**
 * The seven beats, in order, over one continuous background.
 *
 * Two things live here rather than in a scene, and both for the same reason: a
 * scene owns its own fade, so anything a scene painted would fade with it. The
 * bloom drifts across all thirty seconds and the corner lockup sits above five
 * of the seven beats — put either inside a `<Sequence>` and the spot starts
 * blinking at every cut.
 */
import React from 'react';
import { AbsoluteFill, Easing, Sequence, interpolate, useCurrentFrame } from 'remotion';

import './fonts';
import { BEATS, window as beatWindow } from './timing';
import { colour, font } from './theme';
import { ramp } from './components/anim';
import { Stage } from './components/Stage';
import { Mark } from './components/Wordmark';
import { Open } from './scenes/Open';
import { Offline } from './scenes/Offline';
import { Layouts } from './scenes/Layouts';
import { QuickAdd } from './scenes/QuickAdd';
import { Dependencies } from './scenes/Dependencies';
import { Assistant } from './scenes/Assistant';
import { Close } from './scenes/Close';

/**
 * Where the bloom sits during each beat, opposite whatever the beat's visual
 * mass is: right of centre when the picture is on the right, high and central
 * when it is in the middle, and full and centred for the two brand beats.
 */
const BLOOM = [
  { x: 0.5, y: 0.44, strength: 0.95 },
  { x: 0.73, y: 0.4, strength: 0.72 },
  { x: 0.5, y: 0.3, strength: 0.66 },
  { x: 0.69, y: 0.46, strength: 0.72 },
  { x: 0.5, y: 0.34, strength: 0.66 },
  { x: 0.71, y: 0.42, strength: 0.72 },
  { x: 0.5, y: 0.5, strength: 1 },
] as const;

const BLOOM_AT = BEATS.map((_, i) =>
  i === 0 ? 0 : BEATS.slice(0, i).reduce((sum, beat) => sum + beat.frames, 0),
);

/** The lockup that sits in the corner once the opening title has gone. */
const Corner: React.FC = () => {
  const frame = useCurrentFrame();
  const on =
    ramp(frame, beatWindow.offline.from + 16, 20) *
    (1 - ramp(frame, beatWindow.close.from - 14, 12));
  return (
    <div
      style={{
        position: 'absolute',
        left: 118,
        top: 62,
        display: 'flex',
        alignItems: 'center',
        gap: 15,
        opacity: on,
      }}
    >
      <Mark size={40} />
      <span
        style={{
          font: `700 32px/1 ${font.sans}`,
          letterSpacing: '-0.03em',
          color: colour.fg,
        }}
      >
        Kolibri
      </span>
    </div>
  );
};

const smooth = { easing: Easing.bezier(0.6, 0, 0.4, 1), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const Spot: React.FC = () => {
  const frame = useCurrentFrame();
  const bloom = {
    x: interpolate(frame, BLOOM_AT, BLOOM.map((b) => b.x), smooth),
    y: interpolate(frame, BLOOM_AT, BLOOM.map((b) => b.y), smooth),
    strength: interpolate(frame, BLOOM_AT, BLOOM.map((b) => b.strength), smooth),
  };

  return (
    <AbsoluteFill>
      <Stage x={bloom.x} y={bloom.y} strength={bloom.strength} />

      <Sequence {...beatWindow.open}>
        <Open life={beatWindow.open.durationInFrames} />
      </Sequence>
      <Sequence {...beatWindow.offline}>
        <Offline life={beatWindow.offline.durationInFrames} />
      </Sequence>
      <Sequence {...beatWindow.layouts}>
        <Layouts life={beatWindow.layouts.durationInFrames} />
      </Sequence>
      <Sequence {...beatWindow.quickAdd}>
        <QuickAdd life={beatWindow.quickAdd.durationInFrames} />
      </Sequence>
      <Sequence {...beatWindow.timeline}>
        <Dependencies life={beatWindow.timeline.durationInFrames} />
      </Sequence>
      <Sequence {...beatWindow.assistant}>
        <Assistant life={beatWindow.assistant.durationInFrames} />
      </Sequence>
      <Sequence {...beatWindow.close}>
        <Close life={beatWindow.close.durationInFrames} />
      </Sequence>

      <Corner />
    </AbsoluteFill>
  );
};
