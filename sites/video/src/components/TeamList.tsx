/**
 * Teams: a key, some people, and the projects they answer for.
 *
 * A team is not a permission group — `Project.team_id` says which team a
 * project belongs to, and access is still the project's own business. So the
 * beat shows a team gaining a person and a project rather than a team gaining
 * rights, which is the thing that would be wrong.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';
import { Avatar, Panel } from './ui';

const TEAMS = [
  {
    key: 'WEB',
    name: 'Web',
    people: [
      { initials: 'AL', tint: '#26a27c' },
      { initials: 'GH', tint: colour.info },
    ],
    projects: ['Website', 'Public API'],
  },
  {
    key: 'OPS',
    name: 'Operations',
    people: [
      { initials: 'MH', tint: '#c98a3e' },
      { initials: 'AT', tint: '#26a27c' },
    ],
    projects: ['Mobile app'],
  },
] as const;

export const TEAMS_AT = { joined: 86 };

export const TeamList: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const joined = ramp(frame, TEAMS_AT.joined, 14);

  return (
    <div
      style={{
        position: 'absolute',
        width,
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: size * 0.7,
        opacity: ramp(frame, 2, 16),
        transform: `translateY(${span(frame, 2, 22, 18, 0)}px)`,
        ...style,
      }}
    >
      {TEAMS.map((team, t) => (
        <Panel key={team.key} size={size} style={{ width, opacity: ramp(frame, stagger(t, 10, 8), 14) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.6 }}>
            <span
              style={{
                padding: `${size * 0.28}px ${size * 0.5}px`,
                borderRadius: 7,
                background: colour.bg,
                border: `1px solid ${colour.lineStrong}`,
                font: `600 ${size * 0.85}px/1 ${font.mono}`,
                letterSpacing: '0.06em',
                color: colour.accentText,
              }}
            >
              {team.key}
            </span>
            <span style={{ font: `600 ${size * 1.05}px/1 ${font.sans}`, color: colour.fg, flex: 1 }}>
              {team.name}
            </span>
            <span style={{ display: 'flex', gap: size * 0.25 }}>
              {team.people.map((person) => (
                <Avatar key={person.initials} initials={person.initials} fill={person.tint} size={size * 1.5} />
              ))}
              {/* One person joins the Web team while you watch. */}
              {t === 0 ? (
                <span style={{ opacity: joined, transform: `scale(${0.7 + joined * 0.3})` }}>
                  <Avatar initials="RH" fill="#a06ad6" size={size * 1.5} />
                </span>
              ) : null}
            </span>
          </div>
          <div
            style={{
              marginTop: size * 0.7,
              display: 'flex',
              gap: size * 0.45,
              flexWrap: 'wrap',
            }}
          >
            {team.projects.map((project) => (
              <span
                key={project}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: size * 0.42,
                  padding: `${size * 0.34}px ${size * 0.62}px`,
                  borderRadius: 8,
                  background: colour.bg,
                  border: `1px solid ${colour.line}`,
                  font: `400 ${size * 0.9}px/1 ${font.sans}`,
                  color: colour.fgSoft,
                }}
              >
                <span
                  style={{ width: size * 0.5, height: size * 0.5, borderRadius: 4, background: colour.accent, opacity: 0.7 }}
                />
                {project}
              </span>
            ))}
          </div>
        </Panel>
      ))}

      <div
        style={{
          font: `400 ${size * 0.88}px/1.45 ${font.sans}`,
          color: colour.fgMuted,
          opacity: ramp(frame, TEAMS_AT.joined + 16, 16),
        }}
      >
        A team says who works together. Who may read a project is still the project’s own business.
      </div>
    </div>
  );
};
