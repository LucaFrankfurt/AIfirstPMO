/**
 * The first account on an instance, being made.
 *
 * Three details are the beat, and all three are in
 * `packages/server/src/kernel/identity/routes/auth.ts`: the first user is the
 * one the instance belongs to (`firstUser ? 1 : 0`), signing up builds a
 * workspace as well as an account, and that workspace arrives with a starter
 * project — key `GET`, icon 👋 — rather than empty.
 *
 * The password field is dots, which is not a nicety: this frame will be paused,
 * screenshotted and posted, and a video that teaches people to demonstrate
 * software with a readable password has taught the wrong thing.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ease } from '../theme';
import { ramp, span } from './anim';
import { Panel, TypedField } from './ui';

const FIELDS = [
  { label: 'Email', value: 'ada@kolibri.dev' },
  { label: 'Name', value: 'Ada Lovelace' },
  { label: 'Password', value: 'correct horse battery', secret: true },
] as const;

export const SIGNUP = { typeFrom: 14, typeTo: 96, submitted: 108, made: 122 };

/** Every character of every field, so one clock fills them in sequence. */
const TOTAL = FIELDS.reduce((n, f) => n + f.value.length, 0);

export const SignUpForm: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const typed = Math.round(
    span(frame, SIGNUP.typeFrom, SIGNUP.typeTo - SIGNUP.typeFrom, 0, TOTAL, ease.linear),
  );
  const pressed = ramp(frame, SIGNUP.submitted - 4, 5) * (1 - ramp(frame, SIGNUP.submitted, 8));
  const made = ramp(frame, SIGNUP.made, 16);

  let before = 0;
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: size * 0.7 }}>
          {FIELDS.map((field) => {
            const start = before;
            before += field.value.length;
            const shown = Math.max(0, Math.min(field.value.length, typed - start));
            return (
              <TypedField
                key={field.label}
                label={field.label}
                value={field.value}
                typed={shown}
                size={size}
                secret={'secret' in field}
                caret={typed > start && typed <= start + field.value.length}
              />
            );
          })}
          <div
            style={{
              marginTop: size * 0.3,
              padding: `${size * 0.7}px`,
              borderRadius: 10,
              textAlign: 'center',
              background: colour.accentDeep,
              color: '#ffffff',
              font: `600 ${size}px/1 ${font.sans}`,
              transform: `scale(${1 - pressed * 0.03})`,
            }}
          >
            Create account
          </div>
          {/*
           * The server's own floor, said where the server says it: eight
           * characters. Shown as a rule rather than as an error, because an
           * error state is a different beat than the one this is.
           */}
          <div
            style={{
              font: `400 ${size * 0.8}px/1 ${font.sans}`,
              color: colour.fgMuted,
              textAlign: 'center',
            }}
          >
            At least eight characters. No other rule.
          </div>
        </div>
      </Panel>

      {/* What that one press actually made. */}
      <div
        style={{
          marginTop: size * 0.9,
          display: 'flex',
          flexDirection: 'column',
          gap: size * 0.45,
          opacity: made,
          transform: `translateY(${span(frame, SIGNUP.made, 20, 16, 0)}px)`,
        }}
      >
        {(
          [
            { mark: '✓', text: 'Ada Lovelace', note: 'owner — the first account owns the instance' },
            { mark: '✓', text: 'Ada’s workspace', note: 'created with the account' },
            { mark: '👋', text: 'Getting started', note: 'a starter project, key GET' },
          ] as const
        ).map((row, i) => (
          <div
            key={row.text}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: size * 0.55,
              padding: `${size * 0.5}px ${size * 0.8}px`,
              borderRadius: 10,
              background: colour.bgRaised,
              border: `1px solid ${colour.line}`,
              opacity: ramp(frame, SIGNUP.made + i * 6, 12),
            }}
          >
            <span style={{ color: colour.ok, font: `700 ${size}px/1 ${font.sans}`, width: size * 1.2 }}>
              {row.mark}
            </span>
            <span style={{ font: `600 ${size * 0.95}px/1 ${font.sans}`, color: colour.fg }}>
              {row.text}
            </span>
            <span style={{ font: `400 ${size * 0.88}px/1 ${font.sans}`, color: colour.fgMuted }}>
              {row.note}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
