/**
 * An invite: one code, one use, one role, and an expiry.
 *
 * All four come out of `acceptInvite` in
 * `packages/server/src/kernel/identity/routes/workspaces.ts`, which refuses a
 * code that has been used and a code that has expired, and adds the member at
 * the role the invite was made with. The "used" state is worth animating rather
 * than describing: a link that stops working after one person is the difference
 * between an invite and a password everybody knows.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';
import { Avatar, Dot, Panel } from './ui';

const ROLES = ['owner', 'admin', 'member', 'guest'] as const;

export const INVITE = { chosen: 40, copied: 62, accepted: 96 };

export const InviteLink: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const chosen = ramp(frame, INVITE.chosen, 10);
  const copied = ramp(frame, INVITE.copied, 8);
  const used = ramp(frame, INVITE.accepted, 14);

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      <Panel
        label="Invite somebody"
        size={size}
        style={{
          width,
          opacity: ramp(frame, 2, 16),
          transform: `translateY(${span(frame, 2, 22, 18, 0)}px)`,
        }}
      >
        <div style={{ display: 'flex', gap: size * 0.45, marginBottom: size * 0.9 }}>
          {ROLES.map((role, i) => {
            const picked = role === 'member';
            const on = picked ? chosen : 1 - chosen * 0.55;
            return (
              <span
                key={role}
                style={{
                  padding: `${size * 0.42}px ${size * 0.75}px`,
                  borderRadius: 999,
                  border: `1px solid ${picked && chosen > 0.5 ? colour.accentDeep : colour.line}`,
                  background: picked && chosen > 0.5 ? colour.accentSoft : colour.bg,
                  color: picked && chosen > 0.5 ? colour.accentText : colour.fgMuted,
                  font: `500 ${size * 0.88}px/1 ${font.sans}`,
                  opacity: ramp(frame, stagger(i, 4, 12), 10) * on,
                }}
              >
                {role}
              </span>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: size * 0.5, alignItems: 'stretch' }}>
          <div
            style={{
              flex: 1,
              padding: `${size * 0.62}px ${size * 0.8}px`,
              borderRadius: 10,
              background: colour.bg,
              border: `1px solid ${colour.lineStrong}`,
              font: `400 ${size * 0.92}px/1.25 ${font.mono}`,
              color: used > 0.5 ? colour.fgMuted : colour.fgSoft,
              textDecoration: used > 0.5 ? 'line-through' : 'none',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            kolibri.day/join/8f2c-91ad-4e77
          </div>
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              padding: `0 ${size * 0.9}px`,
              borderRadius: 10,
              border: `1px solid ${copied > 0.5 ? colour.ok : colour.lineStrong}`,
              background: colour.bgRaised,
              font: `600 ${size * 0.88}px/1 ${font.sans}`,
              color: copied > 0.5 ? colour.ok : colour.fgSoft,
              whiteSpace: 'nowrap',
            }}
          >
            {copied > 0.5 ? '✓ copied' : 'copy'}
          </div>
        </div>

        <div
          style={{
            marginTop: size * 0.75,
            display: 'flex',
            alignItems: 'center',
            gap: size * 0.5,
            font: `400 ${size * 0.85}px/1 ${font.sans}`,
            color: colour.fgMuted,
          }}
        >
          <Dot fill={used > 0.5 ? colour.fgMuted : colour.warn} size={8} />
          {used > 0.5 ? 'used once, and now it is nothing' : 'one use · expires in 7 days'}
        </div>
      </Panel>

      {/* Who walked through it. */}
      <div
        style={{
          marginTop: size * 0.9,
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.6,
          padding: `${size * 0.6}px ${size * 0.9}px`,
          borderRadius: 12,
          background: colour.bgRaised,
          border: `1px solid ${colour.line}`,
          opacity: used,
          transform: `translateY(${span(frame, INVITE.accepted, 18, 14, 0)}px)`,
        }}
      >
        <Avatar initials="GH" fill={colour.info} size={size * 1.5} />
        <span style={{ font: `600 ${size * 0.98}px/1 ${font.sans}`, color: colour.fg }}>
          Grace Hopper
        </span>
        <span style={{ font: `400 ${size * 0.88}px/1 ${font.sans}`, color: colour.fgMuted }}>
          joined as
        </span>
        <span
          style={{
            padding: `${size * 0.3}px ${size * 0.6}px`,
            borderRadius: 999,
            border: `1px solid ${colour.accentDeep}`,
            background: colour.accentSoft,
            color: colour.accentText,
            font: `500 ${size * 0.85}px/1 ${font.sans}`,
          }}
        >
          member
        </span>
      </div>
    </div>
  );
};
