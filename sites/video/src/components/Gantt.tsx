/**
 * A timeline close-up, redrawn, with the drag actually happening.
 *
 * This is the one widget in the spot that is drawn rather than photographed,
 * and the reason is worth keeping: a screenshot of the timeline cannot show a
 * drag, and compositing a moving bar over the real capture means covering the
 * bar that is already there — over a background that is not flat, because the
 * gantt shades its weekends. Every attempt at that looked like what it was.
 *
 * The weekend bands are not decoration either: the claim under this beat is
 * that a move is counted in the days the project actually works, and a bar that
 * ends up spanning a shaded pair is the only way to say that without a sentence.
 *
 * Everything is expressed in `day` and `rowHeight`, so the vertical cut gets a
 * narrower grid rather than a scaled-down picture of a wide one.
 */
import React from 'react';
import { colour, font } from '../theme';
import { pulse, ramp, span } from './anim';
import { Cursor } from './ui';

/** Four of the eight rows the real timeline shows, keeping the pair that matters. */
const ROWS = [
  { title: 'Redesign the pricing page', state: colour.warn, id: 'WEB-1', from: 4, to: 13 },
  { title: 'Cut largest-contentful-paint …', state: colour.warn, id: 'WEB-4', from: 10, to: 21 },
  { title: 'Ship dark mode across the …', state: colour.fgMuted, id: '', from: 16, to: 18 },
  { title: 'Replace the cookie banner …', state: colour.fgMuted, id: 'WEB-6', from: 26, to: 36 },
] as const;

const DRAGGED = 1;
const BLOCKED = 3;
const DAYS = 44;
/** Where August gives way to September: the grid starts on the 10th. */
const SEPTEMBER = 22;
const WEEKENDS = [5, 12, 19, 26, 33, 40];

const GRAB = 34;
const DROP = 62;

export const Gantt: React.FC<{
  frame: number;
  /** Width of the whole panel; the grid is what is left after `labelWidth`. */
  labelWidth: number;
  day: number;
  rowHeight: number;
  headHeight: number;
  labelSize: number;
  style?: React.CSSProperties;
}> = ({ frame, labelWidth, day, rowHeight, headHeight, labelSize, style }) => {
  const width = labelWidth + DAYS * day + day;
  const height = headHeight + ROWS.length * rowHeight + rowHeight * 0.24;
  const barHeight = rowHeight * 0.47;
  /* Four working days, which is what the chip says. */
  const shift = 4 * day;

  /* The dragged bar under the pointer, and the one it blocks a third of a second behind. */
  const dragged = span(frame, GRAB, DROP - GRAB, 0, shift, [0.4, 0, 0.2, 1]);
  const blocked = span(frame, GRAB + 10, DROP - GRAB + 12, 0, shift, [0.4, 0, 0.2, 1]);
  const held = ramp(frame, GRAB - 4, 8) * (1 - ramp(frame, DROP, 8));

  const offsetOf = (i: number) => (i === DRAGGED ? dragged : i === BLOCKED ? blocked : 0);
  const barLeft = (row: (typeof ROWS)[number]) => labelWidth + row.from * day;
  const barWidth = (row: (typeof ROWS)[number]) => (row.to - row.from) * day;

  /* The pointer travels in, grabs, drags, lets go and leaves. */
  const cursorX =
    labelWidth + span(frame, 8, 26, 20 * day, 15.4 * day) + (frame > GRAB ? dragged : 0);
  const cursorY = span(frame, 8, 26, headHeight + 3.1 * rowHeight, headHeight + rowHeight * 1.55);

  return (
    <div style={{ position: 'absolute', width, height, textAlign: 'left', ...style }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 18,
          background: '#0e1014',
          border: `1px solid ${colour.line}`,
          boxShadow: '0 50px 110px -46px rgba(0,0,0,0.9)',
          overflow: 'hidden',
          opacity: ramp(frame, 0, 18),
        }}
      >
        {/* Saturdays and Sundays, shaded the way the app shades them. */}
        {WEEKENDS.map((d) => (
          <div
            key={d}
            style={{
              position: 'absolute',
              left: labelWidth + d * day,
              top: headHeight,
              width: 2 * day,
              height: height - headHeight,
              background: 'rgba(255,255,255,0.028)',
            }}
          />
        ))}

        {/* The month header, and the line where one month becomes the next. */}
        <div
          style={{
            position: 'absolute',
            inset: '0 0 auto 0',
            height: headHeight,
            borderBottom: `1px solid ${colour.line}`,
          }}
        />
        {(
          [
            { label: 'August 2026', day: 0 },
            { label: 'September 2026', day: SEPTEMBER },
          ] as const
        ).map((month) => (
          <div
            key={month.label}
            style={{
              position: 'absolute',
              left: labelWidth + month.day * day + 16,
              top: (headHeight - labelSize) / 2,
              font: `400 ${labelSize * 0.92}px/1 ${font.sans}`,
              color: colour.fgMuted,
            }}
          >
            {month.label}
          </div>
        ))}
        <div
          style={{
            position: 'absolute',
            left: labelWidth + SEPTEMBER * day,
            top: 0,
            width: 1,
            height,
            background: colour.line,
          }}
        />

        {/* The dependency, drawn under the bars so a bar always wins an overlap. */}
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
          <path
            d={(() => {
              const a = ROWS[DRAGGED];
              const b = ROWS[BLOCKED];
              const x1 = barLeft(a) + barWidth(a) + dragged;
              const y1 = headHeight + DRAGGED * rowHeight + rowHeight / 2;
              const x2 = barLeft(b) + blocked;
              const y2 = headHeight + BLOCKED * rowHeight + rowHeight / 2;
              const mid = Math.max(x1 + 16, x2 - 16);
              return `M${x1} ${y1} H${mid} V${y2} H${x2 - 8}`;
            })()}
            fill="none"
            stroke={colour.lineStrong}
            strokeWidth={2}
          />
          <path
            d={`M${barLeft(ROWS[BLOCKED]) + blocked - 9} ${
              headHeight + BLOCKED * rowHeight + rowHeight / 2 - 6
            } l9 6 -9 6 z`}
            fill={colour.lineStrong}
          />
        </svg>

        {ROWS.map((row, i) => (
          <React.Fragment key={row.title}>
            <div
              style={{
                position: 'absolute',
                left: labelWidth * 0.055,
                top: headHeight + i * rowHeight + rowHeight / 2 - labelSize * 0.62,
                display: 'flex',
                alignItems: 'center',
                gap: labelSize * 0.58,
                width: labelWidth * 0.92,
              }}
            >
              <span
                style={{
                  width: labelSize * 0.71,
                  height: labelSize * 0.71,
                  borderRadius: 999,
                  border: `${Math.max(2, labelSize * 0.1)}px solid ${row.state}`,
                  boxSizing: 'border-box',
                  flex: 'none',
                }}
              />
              <span
                style={{
                  font: `400 ${labelSize}px/1.2 ${font.sans}`,
                  color: colour.fgSoft,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  /* Narrow enough to clip in 9:16, so clip on a word rather than mid-glyph. */
                  textOverflow: 'ellipsis',
                }}
              >
                {row.title}
              </span>
            </div>
            <div
              style={{
                position: 'absolute',
                left: barLeft(row),
                top: headHeight + i * rowHeight + (rowHeight - barHeight) / 2,
                width: barWidth(row),
                height: barHeight,
                borderRadius: 7,
                background: i === DRAGGED ? colour.accent : '#6d6de4',
                display: 'flex',
                alignItems: 'center',
                paddingLeft: barHeight * 0.3,
                boxSizing: 'border-box',
                transform: `translateX(${offsetOf(i)}px) scale(${
                  i === DRAGGED ? 1 + held * 0.035 : 1
                })`,
                boxShadow:
                  i === DRAGGED
                    ? `0 ${8 * held}px ${26 * held}px -${6 * held}px rgba(0,0,0,${0.75 * held})`
                    : undefined,
              }}
            >
              <span
                style={{
                  font: `500 ${barHeight * 0.5}px/1 ${font.mono}`,
                  letterSpacing: '0.03em',
                  /* White, as on the real bars — dark-on-indigo is a different product. */
                  color: '#ffffff',
                }}
              >
                {row.id}
              </span>
            </div>
          </React.Fragment>
        ))}
      </div>

      {/* "+4 working days", riding just above the pointer while the drag happens. */}
      <div
        style={{
          position: 'absolute',
          left: cursorX + 34,
          top: cursorY - 68,
          padding: `${labelSize * 0.38}px ${labelSize * 0.63}px`,
          borderRadius: 9,
          background: colour.accentSoft,
          border: `1px solid ${colour.accentDeep}`,
          color: colour.accentText,
          font: `600 ${labelSize * 0.88}px/1 ${font.sans}`,
          whiteSpace: 'nowrap',
          opacity: pulse(frame, GRAB + 2, 8, 46, 14),
        }}
      >
        + 4 working days
      </div>
      <Cursor
        size={labelSize * 1.42}
        style={{
          left: cursorX,
          top: cursorY,
          opacity: ramp(frame, 6, 10) * (1 - ramp(frame, 92, 14)),
        }}
      />
    </div>
  );
};
