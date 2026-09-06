/**
 * Two people typing into one sentence, and both sentences surviving.
 *
 * This is the beat the text CRDT exists for. Per-field last-writer-wins picks
 * one body and files the other in history — nothing is lost, but somebody's
 * paragraph disappears from the page they were looking at, which is not a merge.
 * So both insertions are typed *at the same time*, into different places in the
 * same paragraph, and the paragraph ends up containing both.
 *
 * Ada is offline while she types, which is the harder half of the claim and
 * costs one badge to say.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ease } from '../theme';
import { ramp, span } from './anim';
import { Avatar } from './ui';

const BASE = ['The consent flow ships in Cycle 2026-8', '.'];
const ADA = { at: 3, text: ' first-party', tint: '#26a27c', who: 'AL', name: 'Ada' };
const GRACE = { at: 1, text: ' behind a flag', tint: colour.info, who: 'GH', name: 'Grace' };

export const COLLAB = { typeFrom: 20, typeTo: 96, merged: 116 };

/** Ada's insertion lands after "The"; Grace's before the full stop. */
const HEAD = 'The';
const TAIL = BASE[0].slice(HEAD.length);

export const Collab: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const progress = span(frame, COLLAB.typeFrom, COLLAB.typeTo - COLLAB.typeFrom, 0, 1, ease.linear);
  const ada = ADA.text.slice(0, Math.round(progress * ADA.text.length));
  const grace = GRACE.text.slice(0, Math.round(progress * GRACE.text.length));
  const merged = ramp(frame, COLLAB.merged, 14);
  const typing = frame < COLLAB.typeTo;

  const Caret: React.FC<{ tint: string }> = ({ tint }) => (
    <span
      style={{
        display: 'inline-block',
        width: 2,
        height: size * 1.1,
        marginBottom: -size * 0.16,
        background: tint,
        opacity: typing ? 1 : 0,
      }}
    />
  );

  const Who: React.FC<{ one: typeof ADA; offline: boolean }> = ({ one, offline }) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: size * 0.4,
        padding: `${size * 0.3}px ${size * 0.55}px`,
        borderRadius: 999,
        background: colour.bgRaised,
        border: `1px solid ${one.tint}`,
        font: `500 ${size * 0.78}px/1 ${font.sans}`,
        color: colour.fgSoft,
        whiteSpace: 'nowrap',
      }}
    >
      <Avatar initials={one.who} fill={one.tint} size={size * 1.05} />
      {one.name}
      <span style={{ color: merged > 0.5 ? colour.ok : colour.warn }}>
        {merged > 0.5 ? 'merged' : offline ? 'offline' : 'online'}
      </span>
    </span>
  );

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      <div style={{ display: 'flex', gap: size * 0.6, marginBottom: size * 0.9, opacity: ramp(frame, 4, 14) }}>
        {/*
         * Both offline, because that is what the line under this beat claims and
         * it is the harder half of the claim: two people merging while connected
         * is a websocket, two people merging after a tunnel is a CRDT.
         */}
        <Who one={ADA} offline />
        <Who one={GRACE} offline />
      </div>

      <div
        style={{
          width,
          boxSizing: 'border-box',
          padding: `${size * 1.2}px ${size * 1.2}px ${size * 1.4}px`,
          borderRadius: 14,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          font: `400 ${size * 1.15}px/1.6 ${font.sans}`,
          color: colour.fg,
          opacity: ramp(frame, 2, 16),
          transform: `translateY(${span(frame, 2, 22, 16, 0)}px)`,
        }}
      >
        {HEAD}
        <span style={{ background: `${ADA.tint}2e`, borderRadius: 4, padding: '2px 0' }}>{ada}</span>
        <Caret tint={ADA.tint} />
        {TAIL}
        <span style={{ background: `${GRACE.tint}2e`, borderRadius: 4, padding: '2px 0' }}>
          {grace}
        </span>
        <Caret tint={GRACE.tint} />
        {BASE[1]}
      </div>

      <div
        style={{
          marginTop: size,
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.55,
          font: `400 ${size * 0.95}px/1.4 ${font.sans}`,
          color: colour.fgMuted,
          opacity: merged,
          transform: `translateY(${span(frame, COLLAB.merged, 16, 10, 0)}px)`,
        }}
      >
        <span style={{ color: colour.ok, font: `700 ${size}px/1 ${font.sans}` }}>✓</span>
        Merged character by character. Nothing was picked over anything else.
      </div>
    </div>
  );
};
