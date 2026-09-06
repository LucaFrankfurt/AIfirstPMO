/**
 * A sub-task being typed, and getting an identifier of its own.
 *
 * "Sub-tasks are whole tasks with their own identifiers, not checklist items" is
 * the demo site's claim, and the identifier appearing a few frames *after* the
 * row does most of the arguing: a checklist item is a string in a field, and a
 * string in a field is not something the workspace numbers.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ease } from '../theme';
import { ramp, span } from './anim';
import { Avatar, PriorityBars } from './ui';

const TITLE = 'Write the consent copy';
export const SUBTASK = { typeFrom: 22, typeTo: 76, filed: 86, numbered: 104, board: 122 };

export const SubTasks: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const typed = Math.round(
    span(frame, SUBTASK.typeFrom, SUBTASK.typeTo - SUBTASK.typeFrom, 0, TITLE.length, ease.linear),
  );
  const filed = ramp(frame, SUBTASK.filed, 14);
  const numbered = ramp(frame, SUBTASK.numbered, 12);
  const caretOn =
    frame < SUBTASK.typeTo ? 1 : Math.floor((frame - SUBTASK.typeTo) / 8) % 2 === 0 ? 1 : 0.15;

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: size * 0.6,
          marginBottom: size * 0.8,
          opacity: ramp(frame, 4, 12),
        }}
      >
        <span style={{ font: `700 ${size * 1.1}px/1 ${font.sans}`, color: colour.fg }}>
          Sub-tasks
        </span>
        <span style={{ font: `500 ${size}px/1 ${font.mono}`, color: colour.fgMuted }}>
          {filed > 0.5 ? '0/1' : '0/0'}
        </span>
      </div>

      {/* The field, and the button that files it. */}
      <div style={{ display: 'flex', gap: size * 0.6, opacity: ramp(frame, 8, 14) }}>
        <div
          style={{
            flex: 1,
            boxSizing: 'border-box',
            padding: `${size * 0.85}px ${size}px`,
            borderRadius: 12,
            background: colour.bgRaised,
            border: `1px solid ${colour.lineStrong}`,
            font: `400 ${size}px/1.3 ${font.sans}`,
            color: typed ? colour.fg : colour.fgMuted,
            whiteSpace: 'pre',
          }}
        >
          {typed ? TITLE.slice(0, typed) : 'Add a sub-task'}
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: size * 1.1,
              marginBottom: -size * 0.16,
              background: colour.accent,
              opacity: typed ? caretOn : 0,
            }}
          />
        </div>
        <div
          style={{
            width: size * 3,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 12,
            border: `1px solid ${colour.lineStrong}`,
            background: colour.bgRaised,
            font: `400 ${size * 1.5}px/1 ${font.sans}`,
            color: colour.fgSoft,
            /* One press, on the frame the row is filed. */
            transform: `scale(${1 - ramp(frame, SUBTASK.filed - 4, 4) * 0.06 + ramp(frame, SUBTASK.filed, 8) * 0.06})`,
          }}
        >
          +
        </div>
      </div>

      {/* The row it becomes: a task, with everything a task has. */}
      <div
        style={{
          marginTop: size * 0.9 * filed,
          height: filed * size * 3.1,
          overflow: 'hidden',
          opacity: filed,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: size * 0.65,
            padding: `${size * 0.75}px ${size}px`,
            borderRadius: 12,
            background: colour.bgRaised,
            border: `1px solid ${colour.line}`,
            transform: `translateY(${span(frame, SUBTASK.filed, 16, 14, 0)}px)`,
          }}
        >
          <span
            style={{
              width: size * 0.78,
              height: size * 0.78,
              borderRadius: 999,
              border: `2px solid ${colour.fgMuted}`,
              boxSizing: 'border-box',
              flex: 'none',
            }}
          />
          <span
            style={{
              font: `500 ${size * 0.9}px/1 ${font.mono}`,
              letterSpacing: '0.05em',
              color: colour.accentText,
              opacity: numbered,
              /* The identifier lands a beat after the row: the workspace numbered it. */
              transform: `scale(${0.86 + numbered * 0.14})`,
              flex: 'none',
            }}
          >
            WEB-12
          </span>
          <span style={{ font: `400 ${size}px/1 ${font.sans}`, color: colour.fg, flex: 1 }}>
            {TITLE}
          </span>
          <PriorityBars level={2} height={size * 0.8} />
          <Avatar initials="AL" fill="#26a27c" size={size * 1.25} />
        </div>
      </div>

      {/* And the same row, over on the board, because that is what "whole task" means. */}
      <div
        style={{
          marginTop: size * 1.1,
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.55,
          font: `400 ${size * 0.92}px/1.4 ${font.sans}`,
          color: colour.fgMuted,
          opacity: ramp(frame, SUBTASK.board, 16),
          transform: `translateY(${span(frame, SUBTASK.board, 18, 10, 0)}px)`,
        }}
      >
        <span style={{ color: colour.ok, font: `700 ${size}px/1 ${font.sans}` }}>✓</span>
        <span>
          <span style={{ color: colour.fgSoft, font: `500 ${size * 0.92}px/1.4 ${font.mono}` }}>
            WEB-12
          </span>{' '}
          now has its own card on the board, its own assignee and its own due date.
        </span>
      </div>
    </div>
  );
};
