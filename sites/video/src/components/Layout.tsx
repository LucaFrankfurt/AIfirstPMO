/**
 * Two arrangements, alternating.
 *
 * Beats two, four and six put the words on the left and the picture on the
 * right; beats three and five put the picture in the middle and the words under
 * it. That alternation is the only structure a viewer gets in thirty seconds,
 * and it is what stops five middle beats from reading as one long one.
 */
import React from 'react';

/** The left-hand column: fixed gutter, fixed width, vertically centred. */
export const TextColumn: React.FC<{
  children: React.ReactNode;
  width?: number;
  left?: number;
  gap?: number;
}> = ({ children, width = 640, left = 118, gap = 26 }) => (
  <div
    style={{
      position: 'absolute',
      left,
      top: 0,
      bottom: 0,
      width,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'flex-start',
      gap,
    }}
  >
    {children}
  </div>
);

/** The band under a centred picture. */
export const TextBand: React.FC<{
  children: React.ReactNode;
  top: number;
  gap?: number;
}> = ({ children, top, gap = 20 }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      right: 0,
      top,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
      gap,
    }}
  >
    {children}
  </div>
);

/**
 * The two stacked arrangements, and the one number that separates them.
 *
 * 9:16 and 4:5 are the same 1080 pixels across, so every widget written for one
 * fits the other untouched. What differs is the height — 1920 against 1350 — and
 * a stack composed for the taller frame simply does not fit the shorter one. So
 * the difference is expressed as a *budget*: how much room the words may take,
 * how far apart things sit, and where the floor is.
 *
 * `bottom` is not slack in either. In 9:16 it is the strip a phone puts a
 * caption, a handle and three buttons over; in 4:5 the frame is a feed post and
 * the reserve is smaller, but a stack that runs to the last pixel still reads
 * as one that ran out of room.
 */
export const STACKED = {
  tall: {
    top: 200,
    bottom: 280,
    width: 960,
    gap: 78,
    kicker: 26,
    headline: 66,
    sub: 30,
    /** Where the corner lockup sits, and how far a brand beat rides above centre. */
    lockup: 84,
    lift: 150,
  },
  feed: {
    top: 150,
    bottom: 150,
    width: 940,
    gap: 52,
    kicker: 22,
    headline: 54,
    sub: 25,
    lockup: 60,
    lift: 96,
  },
} as const;

export type Stacked = keyof typeof STACKED;

/** The 9:16 numbers, for the few places that were written before 4:5 existed. */
export const TALL = STACKED.tall;

export const TallStack: React.FC<{
  children: React.ReactNode;
  shape?: Stacked;
  gap?: number;
}> = ({ children, shape = 'tall', gap }) => {
  const box = STACKED[shape];
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: box.top,
        bottom: box.bottom,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: gap ?? box.gap,
      }}
    >
      {children}
    </div>
  );
};

/**
 * A hole of a known size in a flex column, for the widgets that place
 * themselves absolutely. They take `{ left: 0, top: 0 }` and fill it.
 */
export const Slot: React.FC<{
  width: number;
  height: number;
  children: React.ReactNode;
}> = ({ width, height, children }) => (
  <div style={{ position: 'relative', width, height, flex: 'none' }}>{children}</div>
);
