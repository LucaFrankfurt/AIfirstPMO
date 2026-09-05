/**
 * The one beat that is drawn rather than photographed, and why.
 *
 * A screenshot of the timeline cannot show a drag, and compositing a moving bar
 * over the real capture means covering the bar that is already there — over a
 * background that is not flat, because the gantt shades its weekends. Every
 * attempt at that looked like what it was. So the gantt is redrawn here to the
 * app's own measurements and colours, and the drag is real animation.
 *
 * The weekend bands are not decoration: the claim under this beat is that a
 * move is counted in the days the project actually works, and the bar that ends
 * up spanning a shaded pair is the only way to say that without a sentence.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { colour, font } from '../theme';
import { presence, pulse, ramp, span } from '../components/anim';
import { Headline, Kicker, Rise, Sub } from '../components/Type';
import { TextBand } from '../components/Layout';
import { Cursor } from '../components/ui';

const GANTT = { left: 230, top: 200, width: 1460, height: 426 };
const LABEL_W = 480;
const HEAD_H = 58;
const ROW_H = 86;
const DAY = 22;
const BAR_H = 40;

/** Four of the eight rows the real timeline shows, keeping the pair that matters. */
const ROWS = [
  { title: 'Redesign the pricing page', state: colour.warn, id: 'WEB-1', from: 4, to: 13 },
  { title: 'Cut largest-contentful-paint …', state: colour.warn, id: 'WEB-4', from: 10, to: 21 },
  { title: 'Ship dark mode across the …', state: colour.fgMuted, id: '', from: 16, to: 18 },
  { title: 'Replace the cookie banner …', state: colour.fgMuted, id: 'WEB-6', from: 26, to: 36 },
] as const;

const DRAGGED = 1;
const BLOCKED = 3;
/** Four working days, which is what `+4 days` in the chip means. */
const SHIFT = 4 * DAY;

const WEEKENDS = [5, 12, 19, 26, 33, 40];

const GRAB = 34;
const DROP = 62;

export const Dependencies: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();

  /* The dragged bar under the pointer, and the one it blocks a third of a second behind. */
  const dragged = span(frame, GRAB, DROP - GRAB, 0, SHIFT, [0.4, 0, 0.2, 1]);
  const blocked = span(frame, GRAB + 10, DROP - GRAB + 12, 0, SHIFT, [0.4, 0, 0.2, 1]);
  const held = ramp(frame, GRAB - 4, 8) * (1 - ramp(frame, DROP, 8));

  const offsetOf = (i: number) => (i === DRAGGED ? dragged : i === BLOCKED ? blocked : 0);

  /* The pointer travels in, grabs, drags, lets go and leaves. */
  const cursorX =
    GANTT.left +
    LABEL_W +
    span(frame, 8, 26, 20 * DAY, 15.4 * DAY) +
    (frame > GRAB ? dragged : 0);
  const cursorY = GANTT.top + span(frame, 8, 26, HEAD_H + 3.1 * ROW_H, HEAD_H + ROW_H + 46);

  const barLeft = (row: (typeof ROWS)[number]) => LABEL_W + row.from * DAY;
  const barWidth = (row: (typeof ROWS)[number]) => (row.to - row.from) * DAY;

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <div
        style={{
          position: 'absolute',
          left: GANTT.left,
          top: GANTT.top,
          width: GANTT.width,
          height: GANTT.height,
          borderRadius: 18,
          background: '#0e1014',
          border: `1px solid ${colour.line}`,
          boxShadow: '0 50px 110px -46px rgba(0,0,0,0.9)',
          overflow: 'hidden',
          opacity: ramp(frame, 0, 18),
          transform: `translateY(${span(frame, 0, 26, 18, 0)}px)`,
        }}
      >
        {/* Saturdays and Sundays, shaded the way the app shades them. */}
        {WEEKENDS.map((day) => (
          <div
            key={day}
            style={{
              position: 'absolute',
              left: LABEL_W + day * DAY,
              top: HEAD_H,
              width: 2 * DAY,
              height: GANTT.height - HEAD_H,
              background: 'rgba(255,255,255,0.028)',
            }}
          />
        ))}

        {/* The month header, and the line where one month becomes the next. */}
        <div
          style={{
            position: 'absolute',
            inset: `0 0 auto 0`,
            height: HEAD_H,
            borderBottom: `1px solid ${colour.line}`,
          }}
        />
        {(
          [
            { label: 'August 2026', day: 0 },
            { label: 'September 2026', day: 22 },
          ] as const
        ).map((month) => (
          <div
            key={month.label}
            style={{
              position: 'absolute',
              left: LABEL_W + month.day * DAY + 16,
              top: 19,
              font: `400 22px/1 ${font.sans}`,
              color: colour.fgMuted,
            }}
          >
            {month.label}
          </div>
        ))}
        <div
          style={{
            position: 'absolute',
            left: LABEL_W + 22 * DAY,
            top: 0,
            width: 1,
            height: GANTT.height,
            background: colour.line,
          }}
        />

        {/* The dependency, drawn under the bars so a bar always wins an overlap. */}
        <svg
          width={GANTT.width}
          height={GANTT.height}
          style={{ position: 'absolute', inset: 0 }}
        >
          <path
            d={(() => {
              const a = ROWS[DRAGGED];
              const b = ROWS[BLOCKED];
              const x1 = barLeft(a) + barWidth(a) + dragged;
              const y1 = HEAD_H + DRAGGED * ROW_H + ROW_H / 2;
              const x2 = barLeft(b) + blocked;
              const y2 = HEAD_H + BLOCKED * ROW_H + ROW_H / 2;
              const mid = Math.max(x1 + 16, x2 - 16);
              return `M${x1} ${y1} H${mid} V${y2} H${x2 - 8}`;
            })()}
            fill="none"
            stroke={colour.lineStrong}
            strokeWidth={2}
          />
          <path
            d={`M${barLeft(ROWS[BLOCKED]) + blocked - 9} ${
              HEAD_H + BLOCKED * ROW_H + ROW_H / 2 - 6
            } l9 6 -9 6 z`}
            fill={colour.lineStrong}
          />
        </svg>

        {ROWS.map((row, i) => (
          <React.Fragment key={row.title}>
            <div
              style={{
                position: 'absolute',
                left: 26,
                top: HEAD_H + i * ROW_H + ROW_H / 2 - 15,
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                width: LABEL_W - 40,
              }}
            >
              <span
                style={{
                  width: 17,
                  height: 17,
                  borderRadius: 999,
                  border: `2.5px solid ${row.state}`,
                  flex: 'none',
                }}
              />
              <span
                style={{
                  font: `400 24px/1.2 ${font.sans}`,
                  color: colour.fgSoft,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                {row.title}
              </span>
            </div>
            <div
              style={{
                position: 'absolute',
                left: barLeft(row),
                top: HEAD_H + i * ROW_H + (ROW_H - BAR_H) / 2,
                width: barWidth(row),
                height: BAR_H,
                borderRadius: 7,
                background: i === DRAGGED ? colour.accent : '#6d6de4',
                display: 'flex',
                alignItems: 'center',
                paddingLeft: 12,
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
                  font: `500 20px/1 ${font.mono}`,
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

      {/* "+4 days", riding just above the pointer while the drag is happening. */}
      <div
        style={{
          position: 'absolute',
          left: cursorX + 34,
          top: cursorY - 68,
          padding: '9px 15px',
          borderRadius: 9,
          background: colour.accentSoft,
          border: `1px solid ${colour.accentDeep}`,
          color: colour.accentText,
          font: `600 21px/1 ${font.sans}`,
          whiteSpace: 'nowrap',
          opacity: pulse(frame, GRAB + 2, 8, 46, 14),
        }}
      >
        + 4 working days
      </div>
      <Cursor
        style={{ left: cursorX, top: cursorY, opacity: ramp(frame, 6, 10) * (1 - ramp(frame, 92, 14)) }}
      />

      <TextBand top={690}>
        <Rise at={4}>
          <Kicker>{beats.timeline.kicker}</Kicker>
        </Rise>
        <Rise at={9}>
          <Headline>{beats.timeline.headline}</Headline>
        </Rise>
        <Rise at={16}>
          <Sub width={980}>{beats.timeline.sub}</Sub>
        </Rise>
      </TextBand>
    </AbsoluteFill>
  );
};
