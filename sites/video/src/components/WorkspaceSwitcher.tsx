/**
 * Two workspaces on one account, and the row that belongs to exactly one.
 *
 * Every table in `types.ts` carries a `workspace_id`, and `requireWorkspace`
 * refuses a request whose workspace the account is not a member of. So the
 * switch is not a filter over one pile — it is the pile changing, which is what
 * the content behind the menu is doing while the menu is open.
 *
 * The role beside each name is the account's role *in that workspace*: the same
 * person can own one and be a guest in another, which is the thing a single
 * "you are an admin" badge can never say.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span } from './anim';
import { Dot, Panel } from './ui';

const SPACES = [
  { name: 'Kolibri', slug: 'kolibri', role: 'owner', projects: ['Website', 'Mobile app', 'Public API'] },
  { name: 'Acme GmbH', slug: 'acme', role: 'guest', projects: ['Rollout', 'Support rota'] },
] as const;

export const SWITCH = { opened: 22, picked: 62, closed: 76 };

export const WorkspaceSwitcher: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const open = ramp(frame, SWITCH.opened, 12) * (1 - ramp(frame, SWITCH.closed, 10));
  const moved = ramp(frame, SWITCH.picked, 14);
  const current = SPACES[moved > 0.5 ? 1 : 0];

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      {/* The switcher itself, as it sits at the top of the sidebar. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.6,
          padding: `${size * 0.6}px ${size * 0.8}px`,
          borderRadius: 12,
          background: colour.bgRaised,
          border: `1px solid ${open > 0.3 ? colour.accentDeep : colour.lineStrong}`,
          opacity: ramp(frame, 2, 14),
          transform: `translateY(${span(frame, 2, 20, 14, 0)}px)`,
        }}
      >
        <span
          style={{
            width: size * 1.6,
            height: size * 1.6,
            borderRadius: 8,
            background: colour.accentSoft,
            border: `1px solid ${colour.accentDeep}`,
            display: 'grid',
            placeItems: 'center',
            font: `700 ${size * 0.9}px/1 ${font.sans}`,
            color: colour.accentText,
          }}
        >
          {current.name[0]}
        </span>
        <span style={{ font: `600 ${size * 1.05}px/1 ${font.sans}`, color: colour.fg, flex: 1 }}>
          {current.name}
        </span>
        <span style={{ font: `400 ${size * 0.85}px/1 ${font.sans}`, color: colour.fgMuted }}>
          {current.role}
        </span>
        <span
          style={{
            font: `400 ${size}px/1 ${font.sans}`,
            color: colour.fgMuted,
            transform: `rotate(${open * 180}deg)`,
          }}
        >
          ⌄
        </span>
      </div>

      {/* The menu, and the account's role in each. */}
      <div
        style={{
          marginTop: size * 0.4,
          borderRadius: 12,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          boxShadow: '0 26px 60px -24px rgba(0,0,0,0.9)',
          overflow: 'hidden',
          height: open * size * 4.4,
          opacity: open,
        }}
      >
        {SPACES.map((space, i) => {
          const picked = (i === 1 ? moved : 1 - moved) > 0.5;
          return (
            <div
              key={space.slug}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: size * 0.6,
                padding: `${size * 0.55}px ${size * 0.8}px`,
                background: picked ? colour.accentSoft : 'transparent',
              }}
            >
              <Dot fill={picked ? colour.accent : colour.line} size={size * 0.45} />
              <span style={{ font: `500 ${size * 0.98}px/1 ${font.sans}`, color: colour.fg, flex: 1 }}>
                {space.name}
              </span>
              <span
                style={{
                  font: `500 ${size * 0.82}px/1 ${font.sans}`,
                  color: space.role === 'owner' ? colour.accentText : colour.fgMuted,
                }}
              >
                {space.role}
              </span>
            </div>
          );
        })}
      </div>

      {/* What changed behind it. */}
      <Panel
        label="Projects"
        size={size}
        style={{ width, marginTop: size * 0.8 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: size * 0.45 }}>
          {SPACES.map((space) =>
            space.projects.map((project) => {
              const mine = space === current;
              return (
                <span
                  key={space.slug + project}
                  style={{
                    height: mine ? size * 1.6 : 0,
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    gap: size * 0.5,
                    opacity: mine ? 1 : 0,
                    font: `400 ${size * 0.98}px/1 ${font.sans}`,
                    color: colour.fgSoft,
                  }}
                >
                  <span
                    style={{
                      width: size * 0.55,
                      height: size * 0.55,
                      borderRadius: 4,
                      background: colour.accent,
                      opacity: 0.7,
                    }}
                  />
                  {project}
                </span>
              );
            }),
          )}
          <span
            style={{
              marginTop: size * 0.35,
              font: `400 ${size * 0.85}px/1.4 ${font.mono}`,
              color: colour.fgMuted,
              opacity: ramp(frame, SWITCH.closed + 10, 16),
            }}
          >
            every row carries its own workspace_id
          </span>
        </div>
      </Panel>
    </div>
  );
};
