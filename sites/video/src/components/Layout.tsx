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
