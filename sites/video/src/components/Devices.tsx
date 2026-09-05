/**
 * The list of what is signed in, and the button that ends one of them.
 *
 * Two claims sit under it, and both are things `auth.ts` does rather than
 * things a marketing page says. Session tokens are stored hashed — "so a
 * database leak does not hand out sessions" — and sign-in is rate limited in
 * two buckets rather than one, because an address limit is blind to a thousand
 * machines working through a single account, and that is the one that gets
 * accounts taken over.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';
import { Dot, Panel } from './ui';

const SESSIONS = [
  { what: 'MacBook Pro · Frankfurt', when: 'this one', current: true },
  { what: 'iPhone · Frankfurt', when: '2 days ago', current: false },
  { what: 'Firefox · Lisbon', when: '3 weeks ago', current: false },
];

export const DEVICES = { revoked: 74 };

export const DeviceList: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const revoked = ramp(frame, DEVICES.revoked, 14);

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      <Panel
        label="Signed in"
        size={size}
        style={{
          width,
          opacity: ramp(frame, 2, 16),
          transform: `translateY(${span(frame, 2, 22, 18, 0)}px)`,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {SESSIONS.map((session, i) => {
            const last = i === SESSIONS.length - 1;
            const out = last ? revoked : 0;
            return (
              <div
                key={session.what}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: size * 0.6,
                  height: size * 2.6 * (1 - out),
                  overflow: 'hidden',
                  opacity: ramp(frame, stagger(i, 6, 8), 12) * (1 - out),
                  transform: `translateX(${out * -24}px)`,
                  borderBottom: last ? 'none' : `1px solid ${colour.line}`,
                }}
              >
                <Dot fill={session.current ? colour.ok : colour.fgMuted} size={size * 0.5} />
                <span style={{ font: `500 ${size * 0.98}px/1 ${font.sans}`, color: colour.fg, flex: 1 }}>
                  {session.what}
                </span>
                <span style={{ font: `400 ${size * 0.85}px/1 ${font.sans}`, color: colour.fgMuted }}>
                  {session.when}
                </span>
                <span
                  style={{
                    padding: `${size * 0.3}px ${size * 0.62}px`,
                    borderRadius: 999,
                    border: `1px solid ${session.current ? colour.line : colour.danger}`,
                    color: session.current ? colour.fgMuted : colour.danger,
                    font: `500 ${size * 0.82}px/1 ${font.sans}`,
                  }}
                >
                  {session.current ? 'this device' : 'sign out'}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>

      <div style={{ display: 'flex', flexDirection: 'column', gap: size * 0.5, marginTop: size * 0.9 }}>
        {(
          [
            {
              head: 'Tokens are stored hashed',
              body: 'so a copy of the database is not a drawer full of sessions.',
              at: 96,
            },
            {
              head: 'Two rate-limit buckets, not one',
              body: 'one machine through a password list, and a thousand machines through one account.',
              at: 112,
            },
          ] as const
        ).map((note) => (
          <div
            key={note.head}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: size * 0.55,
              padding: `${size * 0.55}px ${size * 0.85}px`,
              borderRadius: 10,
              background: colour.bgRaised,
              border: `1px solid ${colour.line}`,
              opacity: ramp(frame, note.at, 16),
              transform: `translateY(${span(frame, note.at, 18, 12, 0)}px)`,
            }}
          >
            <span style={{ color: colour.ok, font: `700 ${size * 0.95}px/1 ${font.sans}` }}>✓</span>
            <span style={{ font: `600 ${size * 0.92}px/1.4 ${font.sans}`, color: colour.fg }}>
              {note.head}
            </span>
            <span style={{ font: `400 ${size * 0.88}px/1.4 ${font.sans}`, color: colour.fgMuted }}>
              {note.body}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
