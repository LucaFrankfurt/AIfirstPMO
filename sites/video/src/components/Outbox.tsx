/**
 * The outbox from `docs/sync.md`, drawn over whichever screenshot is behind it.
 *
 * Each row names a *field* rather than a task, because "merges field by field"
 * is the part of the offline claim that is hard to believe and easy to show:
 * two people who edited one task both keep their edit, and this is what that
 * looks like from the outside.
 *
 * The whole state machine lives here rather than in the scene, so the wide cut
 * and the vertical one cannot drift into disagreeing about when the wifi came
 * back. The scene gets `connection()` for its own status pill and nothing else.
 */
import React from 'react';
import { colour, font } from '../theme';
import { pulse, ramp, span } from './anim';
import { Dot } from './ui';

/** Three edits to three different fields of three different tasks. */
const QUEUED = [
  { id: 'WEB-3', field: 'state', value: 'In Progress', at: 34, merged: 110 },
  { id: 'WEB-8', field: 'assignee', value: 'Ada', at: 52, merged: 120 },
  { id: 'WEB-6', field: 'due date', value: 'Sep 9', at: 70, merged: 130 },
] as const;

const DROPPED = 26;
const RECONNECTED = 106;

/**
 * How offline the beat is at `frame`, 0 to 1 — the scene's status pill
 * cross-fades on it. Nothing else may decide this.
 */
export const connection = (frame: number): number =>
  ramp(frame, DROPPED, 8) * (1 - ramp(frame, RECONNECTED, 8));

const Row: React.FC<{ row: (typeof QUEUED)[number]; frame: number; scale: number }> = ({
  row,
  frame,
  scale,
}) => {
  const here = ramp(frame, row.at, 16);
  const done = ramp(frame, row.merged, 10);
  const size = 20 * scale;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14 * scale,
        opacity: here,
        transform: `translateX(${span(frame, row.at, 16, -18, 0)}px)`,
      }}
    >
      <span
        style={{
          width: 26 * scale,
          textAlign: 'center',
          font: `700 ${size}px/1 ${font.sans}`,
          color: done > 0.5 ? colour.ok : colour.accentText,
          /* The tick lands with a small pop; the arrow never moves. */
          transform: `scale(${1 + pulse(frame, row.merged, 6, 2, 8) * 0.28})`,
        }}
      >
        {done > 0.5 ? '✓' : '↑'}
      </span>
      <span
        style={{ font: `500 ${size}px/1 ${font.mono}`, letterSpacing: '0.04em', color: colour.fgSoft }}
      >
        {row.id}
      </span>
      <span style={{ font: `400 ${size}px/1 ${font.sans}`, color: colour.fgMuted }}>
        {row.field}
      </span>
      <span style={{ font: `400 ${size}px/1 ${font.sans}`, color: colour.fgMuted }}>→</span>
      <span style={{ font: `500 ${size}px/1 ${font.sans}`, color: colour.fg }}>{row.value}</span>
    </div>
  );
};

export const Outbox: React.FC<{
  frame: number;
  /** 1 is the wide cut's size; the vertical one runs a little smaller. */
  scale?: number;
  style?: React.CSSProperties;
}> = ({ frame, scale = 1, style }) => {
  /*
   * Three states, not two. The first cut flipped straight from "3 queued" to
   * "3 merged" at a fixed frame, which put the header on "3 queued" while the
   * first row had already ticked — the panel disagreeing with itself for eight
   * frames. The count is now derived from the rows it is counting.
   */
  const queued = QUEUED.filter((row) => frame >= row.at).length;
  const settled = QUEUED.filter((row) => frame >= row.merged).length;
  const merged = settled === QUEUED.length;
  const merging = frame >= RECONNECTED && !merged;

  return (
    <div
      style={{
        position: 'absolute',
        textAlign: 'left',
        width: 566 * scale,
        padding: `${22 * scale}px ${26 * scale}px ${24 * scale}px`,
        boxSizing: 'border-box',
        borderRadius: 16,
        /*
         * Frosted rather than merely opaque. At 92% flat, the chips of the card
         * underneath showed through the panel's own header and read as a render
         * bug; the blur turns the same overlap into depth.
         */
        background: 'rgba(11,13,18,0.82)',
        backdropFilter: 'blur(16px)',
        border: `1px solid ${colour.lineStrong}`,
        boxShadow: '0 26px 60px -22px rgba(0,0,0,0.9)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16 * scale,
        opacity: ramp(frame, DROPPED, 16),
        transform: `translateY(${span(frame, DROPPED, 20, 22, 0)}px)`,
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          style={{
            font: `600 ${20 * scale}px/1 ${font.sans}`,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: colour.fgMuted,
          }}
        >
          Outbox
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Dot fill={merged ? colour.ok : merging ? colour.accent : colour.warn} size={9} />
          <span
            style={{
              font: `500 ${20 * scale}px/1 ${font.sans}`,
              color: merged ? colour.ok : colour.fgSoft,
            }}
          >
            {merged ? `${QUEUED.length} merged` : merging ? 'merging…' : `${queued} queued`}
          </span>
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 13 * scale }}>
        {QUEUED.map((row) => (
          <Row key={row.id} row={row} frame={frame} scale={scale} />
        ))}
      </div>
    </div>
  );
};
