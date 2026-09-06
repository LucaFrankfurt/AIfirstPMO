/**
 * Three and a half seconds of nothing but the name.
 *
 * It is the most expensive real estate in the spot and it buys one thing: the
 * viewer knows what they are looking at before the first screenshot arrives.
 * The tagline is the whole product in one sentence and it sets up beat two,
 * which is the only claim here that a competitor cannot also make.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { open } from '../copy';
import { colour, font } from '../../../theme';
import { presence, ramp, span } from '../../../components/anim';
import { Wordmark } from '../../../components/Wordmark';

export const Open: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();

  /* The lockup settles rather than lands: a long, slow scale with no overshoot. */
  const scale = span(frame, 2, 34, 0.92, 1);

  return (
    <AbsoluteFill
      style={{
        opacity: presence(frame, life, 16, 14),
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 46,
          /* The whole lockup lifts on the way out, so beat two arrives underneath it. */
          transform: `scale(${scale}) translateY(${span(frame, life - 26, 26, 0, -34)}px)`,
        }}
      >
        <Wordmark size={128} />
        <div
          style={{
            opacity: ramp(frame, 22, 24),
            transform: `translateY(${span(frame, 22, 24, 16, 0)}px)`,
            maxWidth: 1180,
            textAlign: 'center',
            font: `400 34px/1.4 ${font.sans}`,
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
