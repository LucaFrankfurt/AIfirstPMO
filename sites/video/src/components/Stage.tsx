/**
 * The ground everything else sits on: near-black, one indigo bloom, one vignette.
 *
 * The bloom drifts across the whole thirty seconds rather than resetting per
 * beat, which is the only continuous thing in the spot and does most of the work
 * of making seven cuts feel like one film. It is also why the background lives
 * here and not inside the scenes — a scene that painted its own would take the
 * drift with it when it faded out.
 */
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { colour } from '../theme';

export const Stage: React.FC<{
  /** Where the bloom sits, in fractions of the frame. */
  x: number;
  y: number;
  /** 0 is off, 1 is the brightest the spot ever goes. */
  strength: number;
  children?: React.ReactNode;
}> = ({ x, y, strength, children }) => (
  <AbsoluteFill style={{ background: colour.bg }}>
    <AbsoluteFill
      style={{
        background: `radial-gradient(58% 62% at ${x * 100}% ${y * 100}%, rgba(124,124,240,${
          0.3 * strength
        }) 0%, rgba(91,91,214,${0.11 * strength}) 38%, rgba(8,9,13,0) 72%)`,
      }}
    />
    {/*
     * A second, much tighter and cooler bloom on the opposite diagonal. One
     * gradient alone reads as a spotlight; two at different sizes read as depth,
     * and cost nothing to encode because both are smooth.
     */}
    <AbsoluteFill
      style={{
        background: `radial-gradient(40% 46% at ${(1 - x) * 100}% ${(1 - y) * 100}%, rgba(38,162,124,${
          0.09 * strength
        }) 0%, rgba(8,9,13,0) 70%)`,
      }}
    />
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(120% 120% at 50% 50%, rgba(0,0,0,0) 52%, rgba(0,0,0,0.55) 100%)',
      }}
    />
    {children}
  </AbsoluteFill>
);
