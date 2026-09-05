/**
 * The three sizes of words the spot uses, and the one rule about them: a beat
 * gets a kicker, a headline and at most one sub. The moment a beat wants a
 * second sub it wants to be two beats.
 */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { colour, font } from '../theme';
import { ramp, span } from './anim';

/**
 * Every piece of text arrives the same way: up eighteen pixels and in, over
 * about two-thirds of a second. `at` is when, in frames of the beat.
 */
export const Rise: React.FC<{
  at: number;
  dur?: number;
  y?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ at, dur = 22, y = 18, children, style }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        opacity: ramp(frame, at, dur),
        transform: `translateY(${span(frame, at, dur, y, 0)}px)`,
        willChange: 'transform, opacity',
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** Small, spaced, indigo. It names the claim; the headline makes it. */
export const Kicker: React.FC<{ children: React.ReactNode; size?: number }> = ({
  children,
  size = 22,
}) => (
  <div
    style={{
      font: `600 ${size}px/1 ${font.sans}`,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: colour.accentText,
    }}
  >
    {children}
  </div>
);

export const Headline: React.FC<{ children: React.ReactNode; size?: number }> = ({
  children,
  size = 62,
}) => (
  <h1
    style={{
      margin: 0,
      font: `700 ${size}px/1.08 ${font.sans}`,
      letterSpacing: '-0.028em',
      color: colour.fg,
      textWrap: 'balance',
    }}
  >
    {children}
  </h1>
);

export const Sub: React.FC<{ children: React.ReactNode; width?: number; size?: number }> = ({
  children,
  width,
  size = 25,
}) => (
  <p
    style={{
      margin: 0,
      maxWidth: width,
      font: `400 ${size}px/1.5 ${font.sans}`,
      letterSpacing: '-0.004em',
      color: colour.fgSoft,
      textWrap: 'pretty',
    }}
  >
    {children}
  </p>
);

/** The app's own chip: a rounded pill with an optional coloured dot. */
export const Chip: React.FC<{
  children: React.ReactNode;
  dot?: string;
  tone?: 'plain' | 'accent';
  mono?: boolean;
}> = ({ children, dot, tone = 'plain', mono = false }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      padding: '9px 16px',
      borderRadius: 999,
      border: `1px solid ${tone === 'accent' ? colour.accentDeep : colour.lineStrong}`,
      background: tone === 'accent' ? colour.accentSoft : colour.bgRaised,
      color: tone === 'accent' ? colour.accentText : colour.fgSoft,
      font: `500 22px/1 ${mono ? font.mono : font.sans}`,
      whiteSpace: 'nowrap',
    }}
  >
    {dot ? (
      <span style={{ width: 10, height: 10, borderRadius: 999, background: dot }} />
    ) : null}
    {children}
  </span>
);
