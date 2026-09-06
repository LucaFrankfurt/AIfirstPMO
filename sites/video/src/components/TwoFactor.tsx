/**
 * A six-digit code, and the ten ways back in if the phone is gone.
 *
 * The honest detail is the one at the bottom, and it comes straight out of the
 * login route: a recovery code is removed "whether or not the rest of the
 * sign-in succeeds, because it has been said out loud by then". Products
 * usually leave that unsaid; saying it is the reason to have this beat.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';
import { Panel } from './ui';

const CODE = '408 913';
const RECOVERY = ['7q4m-x82c', 'h3vd-9nk1', 'p05t-ae6r', 'zb17-4wgu', 'm9cx-t3fs', 'r6ka-81dq'];

export const TOTP = { first: 20, every: 9, verified: 92, codes: 106 };

export const TwoFactor: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const digits = CODE.replace(' ', '').split('');
  const verified = ramp(frame, TOTP.verified, 14);

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      <Panel
        label="Two-factor"
        size={size}
        style={{
          width,
          opacity: ramp(frame, 2, 16),
          transform: `translateY(${span(frame, 2, 22, 18, 0)}px)`,
        }}
      >
        <div style={{ display: 'flex', gap: size * 0.45, justifyContent: 'center' }}>
          {digits.map((digit, i) => {
            const at = stagger(i, TOTP.every, TOTP.first);
            const on = ramp(frame, at, 7);
            return (
              <span
                key={i}
                style={{
                  width: size * 2.1,
                  height: size * 2.6,
                  borderRadius: 10,
                  display: 'grid',
                  placeItems: 'center',
                  background: colour.bg,
                  border: `1px solid ${
                    verified > 0.5 ? colour.ok : on > 0.5 ? colour.accentDeep : colour.line
                  }`,
                  font: `600 ${size * 1.4}px/1 ${font.mono}`,
                  color: colour.fg,
                  /* Each digit lands with a small settle, the way a code entered by hand does. */
                  transform: `scale(${0.94 + on * 0.06})`,
                }}
              >
                <span style={{ opacity: on }}>{digit}</span>
              </span>
            );
          })}
        </div>
        <div
          style={{
            marginTop: size * 0.85,
            textAlign: 'center',
            font: `500 ${size * 0.92}px/1 ${font.sans}`,
            color: verified > 0.5 ? colour.ok : colour.fgMuted,
          }}
        >
          {verified > 0.5 ? '✓ signed in' : 'from your authenticator'}
        </div>
      </Panel>

      <Panel
        label="Recovery codes"
        size={size}
        style={{
          width,
          marginTop: size * 0.9,
          opacity: ramp(frame, TOTP.codes, 16),
          transform: `translateY(${span(frame, TOTP.codes, 20, 16, 0)}px)`,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: size * 0.45 }}>
          {RECOVERY.map((code, i) => (
            <span
              key={code}
              style={{
                padding: `${size * 0.36}px ${size * 0.6}px`,
                borderRadius: 8,
                background: colour.bg,
                border: `1px solid ${colour.line}`,
                font: `400 ${size * 0.92}px/1 ${font.mono}`,
                color: colour.fgSoft,
                opacity: ramp(frame, stagger(i, 4, TOTP.codes + 4), 10),
              }}
            >
              {code}
            </span>
          ))}
        </div>
        <div
          style={{
            marginTop: size * 0.75,
            font: `400 ${size * 0.85}px/1.4 ${font.sans}`,
            color: colour.fgMuted,
            opacity: ramp(frame, TOTP.codes + 22, 14),
          }}
        >
          Each one works once, and is spent the moment it is used — whether or not the rest of the
          sign-in succeeds.
        </div>
      </Panel>
    </div>
  );
};
