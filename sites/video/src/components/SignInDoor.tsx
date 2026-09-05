/**
 * The two doors into an instance, and the setting that locks one of them.
 *
 * `ssoOnly()` in `routes/auth.ts` is two lines and one comment: on a single
 * sign-on only instance a password is not a way in — "not even for accounts
 * that still carry one from before the switch". That is the whole beat, and it
 * is worth animating because "SSO supported" and "SSO only" are two different
 * promises and most products only make the first.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span } from './anim';
import { Panel, Toggle } from './ui';

export const DOOR = { locked: 74 };

export const SignInDoor: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const locked = ramp(frame, DOOR.locked, 16);

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
        {/* The door that stays open. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: size * 0.6,
            padding: `${size * 0.8}px`,
            borderRadius: 10,
            border: `1px solid ${colour.accentDeep}`,
            background: colour.accentSoft,
            font: `600 ${size * 1.02}px/1 ${font.sans}`,
            color: colour.accentText,
          }}
        >
          <span
            style={{
              width: size * 1.05,
              height: size * 1.05,
              borderRadius: 6,
              background: colour.accentText,
              opacity: 0.85,
            }}
          />
          Continue with Acme SSO
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: size * 0.7,
            margin: `${size * 0.85}px 0`,
            font: `400 ${size * 0.82}px/1 ${font.sans}`,
            color: colour.fgMuted,
          }}
        >
          <span style={{ flex: 1, height: 1, background: colour.line }} />
          or
          <span style={{ flex: 1, height: 1, background: colour.line }} />
        </div>

        {/* The door the setting closes. */}
        <div style={{ position: 'relative', opacity: 1 - locked * 0.62 }}>
          {(['Email', 'Password'] as const).map((label) => (
            <div key={label} style={{ marginBottom: size * 0.55 }}>
              <span
                style={{
                  display: 'block',
                  marginBottom: size * 0.3,
                  font: `500 ${size * 0.78}px/1 ${font.sans}`,
                  color: colour.fgMuted,
                }}
              >
                {label}
              </span>
              <span
                style={{
                  display: 'block',
                  padding: `${size * 0.6}px ${size * 0.8}px`,
                  borderRadius: 10,
                  background: colour.bg,
                  border: `1px solid ${colour.line}`,
                  minHeight: size * 1.2,
                }}
              />
            </div>
          ))}
          {/* Struck through rather than hidden: the door is still there, and shut. */}
          <div
            style={{
              position: 'absolute',
              inset: `-${size * 0.3}px`,
              borderRadius: 12,
              border: `1px dashed ${colour.danger}`,
              background: 'rgba(224,109,110,0.06)',
              display: 'grid',
              placeItems: 'center',
              opacity: locked,
            }}
          >
            <span
              style={{
                padding: `${size * 0.4}px ${size * 0.8}px`,
                borderRadius: 999,
                background: colour.bgRaised,
                border: `1px solid ${colour.danger}`,
                color: colour.danger,
                font: `600 ${size * 0.85}px/1 ${font.sans}`,
                whiteSpace: 'nowrap',
              }}
            >
              This instance signs in through single sign-on
            </span>
          </div>
        </div>
      </Panel>

      {/* The switch that did it. */}
      <div
        style={{
          marginTop: size * 0.9,
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.7,
          padding: `${size * 0.62}px ${size * 0.9}px`,
          borderRadius: 12,
          background: colour.bgRaised,
          border: `1px solid ${colour.line}`,
          opacity: ramp(frame, DOOR.locked - 20, 14),
        }}
      >
        <Toggle on={locked} size={size} />
        <span style={{ font: `500 ${size * 0.95}px/1 ${font.mono}`, color: colour.fgSoft }}>
          OIDC_ONLY
        </span>
        <span style={{ font: `400 ${size * 0.88}px/1 ${font.sans}`, color: colour.fgMuted }}>
          not even for accounts that still carry a password
        </span>
      </div>
    </div>
  );
};
