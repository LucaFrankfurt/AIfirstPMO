/**
 * A comment anchored to a passage, and the passage moving out from under it.
 *
 * The hard part of an inline comment is not the comment: it is that the text it
 * points at keeps being edited. `anchor.ts` solves that by storing the *quote*
 * and its surroundings rather than an offset — so the way to show it working is
 * to type a whole new sentence above the quote and let the highlight and the
 * bubble travel down with it, still pointing at the same words.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ease } from '../theme';
import { ramp, span } from './anim';
import { Avatar } from './ui';

const INSERTED = 'Cookies set before consent are the thing auditors ask about. ';
const HEAD = 'The banner goes; ';
const QUOTE = 'nothing is set before somebody says yes';
const TAIL = '. Consent is stored on the device, not in a cookie.';

export const ANNOTATE = { selected: 22, bubble: 38, typeFrom: 78, typeTo: 138 };

export const Annotate: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  /* The selection sweeps across the quote rather than appearing over it. */
  const swept = span(frame, ANNOTATE.selected, 16, 0, 1);
  const bubble = ramp(frame, ANNOTATE.bubble, 14);
  const typed = Math.round(
    span(frame, ANNOTATE.typeFrom, ANNOTATE.typeTo - ANNOTATE.typeFrom, 0, INSERTED.length, ease.linear),
  );

  /*
   * How far the quote has been pushed down. Two lines' worth once the inserted
   * sentence has wrapped, which is what the bubble follows — the bubble is
   * positioned in the same flow, so it follows for free.
   */
  const lead = INSERTED.slice(0, typed);

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      <div
        style={{
          width,
          boxSizing: 'border-box',
          padding: `${size * 1.2}px ${size * 1.2}px ${size * 1.4}px`,
          borderRadius: 14,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          font: `400 ${size * 1.12}px/1.65 ${font.sans}`,
          color: colour.fg,
          opacity: ramp(frame, 2, 16),
          transform: `translateY(${span(frame, 2, 22, 16, 0)}px)`,
        }}
      >
        <span style={{ color: colour.fgSoft }}>{lead}</span>
        {typed > 0 && typed < INSERTED.length ? (
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: size * 1.1,
              marginBottom: -size * 0.14,
              background: colour.accent,
            }}
          />
        ) : null}
        {HEAD}
        <span
          style={{
            /* The sweep is a background that grows from the left, not a fade. */
            background: `linear-gradient(90deg, rgba(217,119,6,0.28) ${swept * 100}%, rgba(217,119,6,0) ${swept * 100}%)`,
            borderBottom: `2px solid ${swept > 0.02 ? colour.warn : 'transparent'}`,
            paddingBottom: 1,
          }}
        >
          {QUOTE}
        </span>
        {TAIL}
      </div>

      {/* The comment, hanging off the quote it is anchored to. */}
      <div
        style={{
          marginTop: size * 0.9,
          marginLeft: size * 2.4,
          width: width * 0.72,
          padding: `${size * 0.85}px ${size}px`,
          borderRadius: 12,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          boxShadow: '0 22px 50px -22px rgba(0,0,0,0.9)',
          opacity: bubble,
          transform: `translateY(${(1 - bubble) * -10}px)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.5 }}>
          <Avatar initials="GH" fill={colour.info} size={size * 1.2} />
          <span style={{ font: `600 ${size * 0.92}px/1 ${font.sans}`, color: colour.fg }}>
            Grace Hopper
          </span>
          <span style={{ font: `400 ${size * 0.85}px/1 ${font.sans}`, color: colour.fgMuted }}>
            on this passage
          </span>
        </div>
        <div
          style={{
            marginTop: size * 0.55,
            font: `400 ${size * 0.98}px/1.5 ${font.sans}`,
            color: colour.fgSoft,
          }}
        >
          Say which yes. Analytics and functional are two answers, not one.
        </div>
      </div>

      <div
        style={{
          marginTop: size * 0.9,
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.55,
          font: `400 ${size * 0.95}px/1.4 ${font.sans}`,
          color: colour.fgMuted,
          opacity: ramp(frame, ANNOTATE.typeTo - 6, 16),
        }}
      >
        <span style={{ color: colour.ok, font: `700 ${size}px/1 ${font.sans}` }}>✓</span>
        A whole sentence arrived above it, and the comment still points at the same words.
      </div>
    </div>
  );
};
