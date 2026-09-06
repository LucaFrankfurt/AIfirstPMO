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
 * The vertical cut's one arrangement: everything stacked, centred, inside a
 * frame that stops well above the bottom edge.
 *
 * `BOTTOM` is not slack — it is the strip a phone puts a caption, a handle and
 * three buttons over. Reserving it here rather than per beat is what stops the
 * spot from having six different ideas about where its floor is, and is why the
 * beats look like they were composed for 9:16 rather than cropped into it.
 */
export const TALL = { top: 200, bottom: 280, width: 960 } as const;

export const TallStack: React.FC<{ children: React.ReactNode; gap?: number }> = ({
  children,
  gap = 70,
}) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      right: 0,
      top: TALL.top,
      bottom: TALL.bottom,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      gap,
    }}
  >
    {children}
  </div>
);

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
