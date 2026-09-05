/**
 * Everything a task carries, arriving one field at a time.
 *
 * Modelled on the real task panel in `sites/docs/src/assets/screens/task-dark.webp`
 * — state, priority, assignee, labels, cycle and module on one row, then due,
 * repeats and estimate on the next. Drawn rather than cropped because two of the
 * fields change while you watch, and a screenshot of a field is a screenshot of
 * one of its values.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';
import { Avatar, PriorityBars } from './ui';

const APPEAR = 20;
const EVERY = 7;
/** When the two fields that change, change. */
const MOVED = 96;

const Field: React.FC<{
  at: number;
  frame: number;
  size: number;
  children: React.ReactNode;
}> = ({ at, frame, size, children }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: size * 0.42,
      padding: `${size * 0.36}px ${size * 0.62}px`,
      borderRadius: 9,
      background: colour.bg,
      border: `1px solid ${colour.line}`,
      font: `500 ${size}px/1 ${font.sans}`,
      color: colour.fgSoft,
      whiteSpace: 'nowrap',
      opacity: ramp(frame, at, 12),
      transform: `translateY(${span(frame, at, 14, 8, 0)}px)`,
    }}
  >
    {children}
  </span>
);

/** A ring in a state's own colour — the app's state glyph. */
const Ring: React.FC<{ tint: string; size: number; filled?: number }> = ({ tint, size, filled = 0 }) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: 999,
      border: `${Math.max(2, size * 0.17)}px solid ${tint}`,
      background: filled ? tint : 'transparent',
      boxSizing: 'border-box',
      flex: 'none',
    }}
  />
);

export const FieldRow: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  /* Two fields move while the row is on screen, so the row is visibly live. */
  const moved = ramp(frame, MOVED, 12);

  return (
    <div
      style={{
        position: 'absolute',
        width,
        boxSizing: 'border-box',
        textAlign: 'left',
        padding: `${size * 1.5}px ${size * 1.6}px ${size * 1.7}px`,
        borderRadius: 16,
        background: colour.bgRaised,
        border: `1px solid ${colour.lineStrong}`,
        boxShadow: '0 40px 90px -38px rgba(0,0,0,0.92)',
        opacity: ramp(frame, 2, 18),
        transform: `translateY(${span(frame, 2, 24, 20, 0)}px)`,
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.6,
          font: `500 ${size * 0.92}px/1 ${font.mono}`,
          letterSpacing: '0.05em',
          color: colour.fgMuted,
          opacity: ramp(frame, 6, 12),
        }}
      >
        <Ring tint={colour.fgMuted} size={size * 0.8} />
        WEB-6
        <span style={{ color: colour.line }}>·</span>
        <span style={{ font: `600 ${size * 0.92}px/1 ${font.sans}`, color: colour.fgSoft }}>
          Website
        </span>
      </div>

      <div
        style={{
          margin: `${size * 0.9}px 0 ${size * 1.1}px`,
          font: `700 ${size * 1.62}px/1.18 ${font.sans}`,
          letterSpacing: '-0.02em',
          color: colour.fg,
          opacity: ramp(frame, 10, 14),
          transform: `translateY(${span(frame, 10, 18, 10, 0)}px)`,
        }}
      >
        Replace the cookie banner with a first-party consent flow
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: size * 0.5 }}>
        <Field at={stagger(0, EVERY, APPEAR)} frame={frame} size={size}>
          {/* Backlog until somebody picks it up; then In Progress, in amber. */}
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: size * 0.42 }}>
            <Ring tint={moved > 0.5 ? colour.warn : colour.fgMuted} size={size * 0.78} filled={moved > 0.5 ? 1 : 0} />
            <span style={{ color: moved > 0.5 ? colour.fg : colour.fgSoft }}>
              {moved > 0.5 ? 'In Progress' : 'Backlog'}
            </span>
          </span>
        </Field>
        <Field at={stagger(1, EVERY, APPEAR)} frame={frame} size={size}>
          <PriorityBars level={moved > 0.5 ? 3 : 2} height={size * 0.9} />
          {moved > 0.5 ? 'High' : 'Medium'}
        </Field>
        <Field at={stagger(2, EVERY, APPEAR)} frame={frame} size={size}>
          <Avatar initials="AL" fill="#26a27c" size={size * 1.15} />
          Ada Lovelace
        </Field>
        <Field at={stagger(3, EVERY, APPEAR)} frame={frame} size={size}>
          <span style={{ width: size * 0.6, height: size * 0.6, borderRadius: 3, background: colour.brand }} />
          consent
        </Field>
        <Field at={stagger(4, EVERY, APPEAR)} frame={frame} size={size}>
          <Ring tint={colour.accent} size={size * 0.72} />
          Cycle 2026-8
        </Field>
        <Field at={stagger(5, EVERY, APPEAR)} frame={frame} size={size}>
          <Ring tint={colour.fgMuted} size={size * 0.72} />
          Website v2
        </Field>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.9,
          marginTop: size * 1.1,
          font: `400 ${size}px/1 ${font.sans}`,
          color: colour.fgMuted,
        }}
      >
        {(
          [
            { label: 'Due', value: '09 / 09 / 2026' },
            { label: 'Repeats', value: 'Once' },
            { label: 'Estimate', value: '3' },
          ] as const
        ).map((one, i) => {
          const at = stagger(i, EVERY, APPEAR + 6 * EVERY);
          return (
            <span
              key={one.label}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: size * 0.5,
                opacity: ramp(frame, at, 12),
                transform: `translateY(${span(frame, at, 14, 8, 0)}px)`,
              }}
            >
              {one.label}
              <span
                style={{
                  padding: `${size * 0.36}px ${size * 0.62}px`,
                  borderRadius: 8,
                  border: `1px solid ${colour.line}`,
                  background: colour.bg,
                  color: colour.fg,
                  font: `500 ${size}px/1 ${font.sans}`,
                }}
              >
                {one.value}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
};
