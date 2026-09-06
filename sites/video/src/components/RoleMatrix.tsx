/**
 * Four roles, ranked, and what each rank buys.
 *
 * Not a permission list: `auth.ts` ranks them — `guest 0, member 1, admin 2,
 * owner 3` — and every check is `RANK[role] >= RANK[min]`. So the matrix fills
 * in as a staircase rather than as a scatter, which is the shape the code
 * actually has and the shape a viewer can hold in their head.
 *
 * The last row is the one rule that is not a rank: a workspace refuses to let
 * go of its final owner.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';
import { Panel } from './ui';

const ROLES = ['guest', 'member', 'admin', 'owner'] as const;

/** `from` is the rank at which the row starts being true. */
const ROWS = [
  { what: 'See what they are added to', from: 0 },
  { what: 'Create and change work', from: 1 },
  { what: 'Invite people, and set their role', from: 2 },
  { what: 'Switch a feature on', from: 2 },
  { what: 'Be the last one standing', from: 3 },
] as const;

export const ROLE_MATRIX = { first: 18, every: 4, note: 104 };

export const RoleMatrix: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const label = width * 0.44;
  const cell = (width - label) / ROLES.length;

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      <Panel
        size={size}
        style={{
          width,
          opacity: ramp(frame, 2, 16),
          transform: `translateY(${span(frame, 2, 22, 18, 0)}px)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: size * 0.55 }}>
          <span style={{ width: label }} />
          {ROLES.map((role, i) => (
            <span
              key={role}
              style={{
                width: cell,
                textAlign: 'center',
                font: `600 ${size * 0.88}px/1 ${font.sans}`,
                color: i === ROLES.length - 1 ? colour.accentText : colour.fgSoft,
                opacity: ramp(frame, stagger(i, 5, 6), 12),
              }}
            >
              {role}
            </span>
          ))}
        </div>

        {ROWS.map((row, r) => (
          <div
            key={row.what}
            style={{
              display: 'flex',
              alignItems: 'center',
              height: size * 2.1,
              borderTop: `1px solid ${colour.line}`,
              opacity: ramp(frame, stagger(r, 6, 10), 12),
            }}
          >
            <span
              style={{
                width: label,
                font: `400 ${size * 0.95}px/1.3 ${font.sans}`,
                color: colour.fgSoft,
                paddingRight: size * 0.5,
              }}
            >
              {row.what}
            </span>
            {ROLES.map((role, c) => {
              const yes = c >= row.from;
              /* The staircase fills row by row, left to right — the shape of the rank. */
              const at = stagger(r * ROLES.length + c, ROLE_MATRIX.every, ROLE_MATRIX.first);
              const on = ramp(frame, at, 9);
              return (
                <span
                  key={role}
                  style={{
                    width: cell,
                    textAlign: 'center',
                    font: `700 ${size * 1.05}px/1 ${font.sans}`,
                    color: yes ? colour.ok : colour.line,
                    opacity: on,
                    transform: `scale(${0.8 + on * 0.2})`,
                  }}
                >
                  {yes ? '✓' : '·'}
                </span>
              );
            })}
          </div>
        ))}
      </Panel>

      <div
        style={{
          marginTop: size * 0.85,
          padding: `${size * 0.6}px ${size * 0.9}px`,
          borderRadius: 10,
          background: colour.bgRaised,
          border: `1px solid ${colour.line}`,
          font: `400 ${size * 0.9}px/1.45 ${font.sans}`,
          color: colour.fgMuted,
          opacity: ramp(frame, ROLE_MATRIX.note, 16),
          transform: `translateY(${span(frame, ROLE_MATRIX.note, 18, 12, 0)}px)`,
        }}
      >
        <span style={{ color: colour.fg, fontWeight: 600 }}>
          Owning a workspace is not owning the server.
        </span>{' '}
        On an instance where anybody may sign up, everybody is an owner of something.
      </div>
    </div>
  );
};
