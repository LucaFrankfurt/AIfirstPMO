/**
 * The lockup, stacked rather than side by side.
 *
 * In 16:9 the mark sits left of the name because the frame is wider than it is
 * tall and a horizontal lockup uses that; in 9:16 the same lockup would be a
 * thin band across the middle of a very tall picture. Stacking it is not a
 * compromise, it is the shape the frame asks for.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { open } from '../../copy';
import { colour, font } from '../../../../theme';
import { presence, ramp, span } from '../../../../components/anim';
import { Mark } from '../../../../components/Wordmark';
import { STACKED, type Stacked } from '../../../../components/Layout';

export const OpenTall: React.FC<{ shape: Stacked; life: number }> = ({ shape, life }) => {
  const box = STACKED[shape];
  const feed = shape === 'feed';
  const frame = useCurrentFrame();
  const scale = span(frame, 2, 34, 0.92, 1);

  return (
    <AbsoluteFill
      style={{
        opacity: presence(frame, life, 16, 14),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        /* A touch above centre: a lockup sitting dead centre reads as low. */
        paddingBottom: box.lift,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: feed ? 32 : 44,
          transform: `scale(${scale}) translateY(${span(frame, life - 26, 26, 0, -34)}px)`,
        }}
      >
        <Mark size={feed ? 150 : 190} />
        <span
          style={{
            font: `700 ${feed ? 98 : 124}px/1 ${font.sans}`,
            letterSpacing: '-0.035em',
            color: colour.fg,
          }}
        >
          {open.wordmark}
        </span>
        <div
          style={{
            opacity: ramp(frame, 24, 24),
            transform: `translateY(${span(frame, 24, 24, 16, 0)}px)`,
            width: box.width,
            textAlign: 'center',
            font: `400 ${feed ? 30 : 36}px/1.4 ${font.sans}`,
            letterSpacing: '-0.012em',
            color: colour.fgSoft,
          }}
        >
          {open.tagline}
        </div>
      </div>
    </AbsoluteFill>
  );
};
