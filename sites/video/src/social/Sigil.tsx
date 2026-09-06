/**
 * One quick-add sigil, as a reference card.
 *
 * This is the only widget written for the stills rather than borrowed from the
 * spots, and it exists because a carousel can do something thirty seconds
 * cannot: be kept. The syntax beat in the films shows the line being typed and
 * parsed, which is the right way to *sell* it and a useless way to *learn* it —
 * nobody pauses a reel to read a vocabulary. A slide per sigil, saying what it
 * takes and what it does with it, is a thing somebody screenshots and comes
 * back to, and it is the one asset in this repository aimed at the person who
 * has already installed it.
 *
 * Every word on it is quoted from `packages/shared/src/modules/work/quickadd.ts`
 * — the vocabulary tables, not a summary of them. A reference card that has
 * drifted from the parser is worse than none, because somebody will type what
 * it says.
 */
import React from 'react';
import { colour, font } from '../theme';

export const Sigil: React.FC<{
  /** As it is typed. */
  sigil: string;
  /** The field it answers to, in the parser's own word. */
  field: string;
  /** The tint `QuickAddField` gives this token, so the two agree on screen. */
  tint: string;
  /** What the vocabulary actually accepts. */
  accepts: readonly string[];
  /** The one thing about it somebody would otherwise find out by being wrong. */
  note: string;
  width: number;
}> = ({ sigil, field, tint, accepts, note, width }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width,
      boxSizing: 'border-box',
      textAlign: 'left',
      padding: '34px 38px 38px',
      borderRadius: 18,
      background: colour.bgRaised,
      border: `1px solid ${colour.lineStrong}`,
      boxShadow: '0 40px 90px -38px rgba(0,0,0,0.92)',
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 24,
        paddingBottom: 26,
        borderBottom: `1px solid ${colour.line}`,
      }}
    >
      <span
        style={{
          font: `700 52px/1 ${font.mono}`,
          letterSpacing: '-0.02em',
          fontVariantLigatures: 'none',
          color: tint,
        }}
      >
        {sigil}
      </span>
      <span
        style={{
          font: `600 22px/1 ${font.sans}`,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: colour.fgMuted,
        }}
      >
        {field}
      </span>
    </div>

    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '28px 0 26px' }}>
      {accepts.map((word) => (
        <span
          key={word}
          style={{
            padding: '10px 16px',
            borderRadius: 9,
            background: colour.bg,
            border: `1px solid ${colour.line}`,
            font: `400 24px/1 ${font.mono}`,
            fontVariantLigatures: 'none',
            color: colour.fgSoft,
            whiteSpace: 'nowrap',
          }}
        >
          {word}
        </span>
      ))}
    </div>

    <div
      style={{
        font: `400 24px/1.5 ${font.sans}`,
        color: colour.fgSoft,
        textWrap: 'pretty',
      }}
    >
      {note}
    </div>
  </div>
);
