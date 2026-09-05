/**
 * The bird and the name.
 *
 * The mark sits on a white tile here for the same reason it does in the app —
 * `app.css` sets `background: #fff` on `.auth-mark img`, because the black
 * keyline that keeps the bird legible at 16px is invisible on `#0b0d12`. A spot
 * that put the bare mark on this background would be showing a bird with no
 * outline, which is not the mark.
 */
import React from 'react';
import { Img } from 'remotion';
import { mark } from '../assets';
import { colour, font } from '../theme';

export const Mark: React.FC<{ size: number; style?: React.CSSProperties }> = ({
  size,
  style,
}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.24,
      background: '#ffffff',
      display: 'grid',
      placeItems: 'center',
      boxShadow: `0 ${size * 0.16}px ${size * 0.4}px -${size * 0.14}px rgba(0,0,0,0.7)`,
      ...style,
    }}
  >
    <Img src={mark} style={{ width: size * 0.74, height: size * 0.74 }} />
  </div>
);

export const Wordmark: React.FC<{
  size: number;
  gap?: number;
  style?: React.CSSProperties;
}> = ({ size, gap, style }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: gap ?? size * 0.42,
      ...style,
    }}
  >
    <Mark size={size} />
    <span
      style={{
        font: `700 ${size * 0.86}px/1 ${font.sans}`,
        letterSpacing: '-0.035em',
        color: colour.fg,
      }}
    >
      Kolibri
    </span>
  </div>
);
