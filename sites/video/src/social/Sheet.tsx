/**
 * The ground, the header and the footer every still shares.
 *
 * Three things are on every sheet and none of them is decoration. The **mark
 * and the name** are there because a slide gets screenshotted and reposted
 * without the caption, and a slide that does not say whose it is is a slide
 * that works for somebody else. The **counter** is there because a reader
 * decides whether to swipe on the first slide and "1 / 9" is the only honest
 * way to say how long this is. The **address** is there because the only thing
 * a post can ask for is a visit, and asking once, quietly, on every slide beats
 * asking loudly on the last one somebody never reached.
 */
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { colour, font } from '../theme';
import { Stage } from '../components/Stage';
import { Mark } from '../components/Wordmark';
import { url } from '../product';

export interface Frame {
  width: number;
  height: number;
  margin: number;
  head: number;
  foot: number;
}

/**
 * Where the light sits.
 *
 * The spots drift one bloom across thirty seconds and get most of their
 * continuity from it. A carousel has no time axis to drift along — but it has a
 * reading order, so the light walks down the frame from the first slide to the
 * last. Nobody will notice it; they will notice that the set holds together.
 */
export const bloom = (index: number, count: number, lit: boolean) =>
  lit
    ? { x: 0.5, y: 0.44, strength: 1 }
    : { x: 0.5, y: 0.22 + 0.3 * (index / Math.max(count - 1, 1)), strength: 0.6 };

const Chevrons: React.FC = () => (
  <svg width={46} height={26} viewBox="0 0 46 26" fill="none">
    {[0, 15].map((x, i) => (
      <path
        key={x}
        d={`M${x + 2} 3 L${x + 13} 13 L${x + 2} 23`}
        stroke={colour.accentText}
        strokeWidth={3.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={i === 0 ? 0.45 : 1}
      />
    ))}
  </svg>
);

export const Sheet: React.FC<{
  box: Frame;
  index: number;
  count: number;
  /** The brand slides get the full bloom; the ones that make a point do not. */
  lit?: boolean;
  /** The last slide has nothing to swipe to; a single post never had anything. */
  swipe?: boolean;
  /** Off for a post that is not part of a series. */
  counter?: boolean;
  /**
   * The closing slide draws the wordmark full size and turns this off. Two
   * lockups on one sheet is the one thing a brand slide cannot survive — the
   * same rule `Corner` follows in the spots, for the same reason.
   */
  lockup?: boolean;
  /**
   * The closing slide asks for the address in full, as a chip. Printing it
   * again in the footer of that one slide is the same URL twice on one sheet,
   * which reads as a template nobody looked at.
   */
  address?: boolean;
  children: React.ReactNode;
}> = ({ box, index, count, lit = false, swipe = true, lockup = true, address = true, counter = true, children }) => {
  const light = bloom(index, count, lit);
  return (
    <AbsoluteFill>
      <Stage x={light.x} y={light.y} strength={light.strength} />

      <div
        style={{
          position: 'absolute',
          left: box.margin,
          right: box.margin,
          top: box.head,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, opacity: lockup ? 1 : 0 }}>
          <Mark size={38} />
          <span
            style={{
              font: `700 29px/1 ${font.sans}`,
              letterSpacing: '-0.03em',
              color: colour.fg,
            }}
          >
            Kolibri
          </span>
        </div>
        <span
          style={{
            font: `500 21px/1 ${font.mono}`,
            letterSpacing: '0.08em',
            color: colour.fgMuted,
          }}
        >
          {counter ? `${index + 1} / ${count}` : ''}
        </span>
      </div>

      {children}

      <div
        style={{
          position: 'absolute',
          left: box.margin,
          right: box.margin,
          top: box.foot,
          height: 30,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            font: `500 21px/1 ${font.mono}`,
            letterSpacing: '0.02em',
            color: colour.fgMuted,
          }}
        >
          {address ? url.demo : ''}
        </span>
        {swipe ? <Chevrons /> : null}
      </div>
    </AbsoluteFill>
  );
};
