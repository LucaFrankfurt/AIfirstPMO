/**
 * A project inside a project, and the rule that stops that meaning anything
 * about who may read it.
 *
 * "Nesting is for reading, not for access" is the comment on `Project.parent_id`
 * itself, and it is worth a beat because every tool that nests things gets asked
 * whether the nesting inherits permissions. Here it does not: the padlock lands
 * on the child while the parent stays open, and a guest sees exactly one of them.
 *
 * The container is the other half: `is_container` is a flag rather than a folder
 * entity, so a folder keeps sync, trash, permissions, REST and MCP for free —
 * and can be turned back into an ordinary project at any time.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';
import { Avatar, Panel } from './ui';

const ROWS = [
  { depth: 0, name: 'Portfolio', badge: 'container', private: false },
  { depth: 1, name: 'Website', badge: 'WEB', private: false },
  { depth: 1, name: 'Mobile app', badge: 'MOB', private: true },
  { depth: 1, name: 'Public API', badge: 'API', private: false },
] as const;

export const NESTING = { first: 12, every: 12, locked: 74, guest: 100 };

export const Nesting: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const locked = ramp(frame, NESTING.locked, 14);
  const guest = ramp(frame, NESTING.guest, 14);

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
        {ROWS.map((row, i) => {
          const at = stagger(i, NESTING.every, NESTING.first);
          const hidden = row.private ? locked * guest : 0;
          return (
            <div
              key={row.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: size * 0.55,
                height: size * 2.3,
                paddingLeft: row.depth * size * 1.6,
                opacity: ramp(frame, at, 12) * (1 - hidden * 0.72),
              }}
            >
              <span
                style={{
                  width: size * 0.62,
                  height: size * 0.62,
                  borderRadius: 5,
                  background: row.depth === 0 ? 'transparent' : colour.accent,
                  border: row.depth === 0 ? `1.5px dashed ${colour.fgMuted}` : 'none',
                  opacity: row.depth === 0 ? 1 : 0.75,
                  flex: 'none',
                }}
              />
              <span
                style={{
                  font: `${row.depth === 0 ? 600 : 400} ${size}px/1 ${font.sans}`,
                  color: colour.fg,
                  textDecoration: hidden > 0.5 ? 'line-through' : 'none',
                }}
              >
                {row.name}
              </span>
              <span
                style={{
                  padding: `${size * 0.2}px ${size * 0.45}px`,
                  borderRadius: 6,
                  background: colour.bg,
                  border: `1px solid ${colour.line}`,
                  font: `500 ${size * 0.76}px/1 ${font.mono}`,
                  letterSpacing: '0.05em',
                  color: colour.fgMuted,
                }}
              >
                {row.badge}
              </span>
              {row.private ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: size * 0.35,
                    padding: `${size * 0.22}px ${size * 0.5}px`,
                    borderRadius: 999,
                    border: `1px solid ${colour.warn}`,
                    color: colour.warn,
                    font: `500 ${size * 0.78}px/1 ${font.sans}`,
                    opacity: locked,
                  }}
                >
                  private
                </span>
              ) : null}
              {hidden > 0.5 ? (
                <span
                  style={{
                    marginLeft: 'auto',
                    font: `400 ${size * 0.82}px/1 ${font.sans}`,
                    color: colour.fgMuted,
                  }}
                >
                  not for this guest
                </span>
              ) : null}
            </div>
          );
        })}
      </Panel>

      <div
        style={{
          marginTop: size * 0.85,
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.6,
          padding: `${size * 0.6}px ${size * 0.9}px`,
          borderRadius: 10,
          background: colour.bgRaised,
          border: `1px solid ${colour.line}`,
          opacity: guest,
          transform: `translateY(${span(frame, NESTING.guest, 18, 12, 0)}px)`,
        }}
      >
        <Avatar initials="RH" fill="#a06ad6" size={size * 1.4} />
        <span style={{ font: `500 ${size * 0.95}px/1 ${font.sans}`, color: colour.fg }}>
          Robin · guest
        </span>
        <span style={{ font: `400 ${size * 0.9}px/1.4 ${font.sans}`, color: colour.fgMuted }}>
          sees the parent and not the child. Nesting is for reading, not for access.
        </span>
      </div>
    </div>
  );
};
