/**
 * What changed between two versions of a page, and the way back.
 *
 * A line diff rather than a character one, because that is what `diff.ts`
 * computes: an LCS table, written out rather than pulled in, "read by people
 * looking at their own writing". The rows arrive in document order so the eye
 * reads the change as a change rather than as a list of colours.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';

const VERSIONS = [
  { when: 'now', who: 'Ada Lovelace', current: true },
  { when: '2 hours ago', who: 'Grace Hopper', current: false },
  { when: 'yesterday', who: 'Ada Lovelace', current: false },
] as const;

const LINES = [
  { op: 'same', text: '# Consent' },
  { op: 'same', text: '' },
  { op: 'removed', text: 'The banner goes; nothing is set before consent.' },
  { op: 'added', text: 'The banner goes; nothing is set before somebody says yes.' },
  { op: 'added', text: 'Consent is stored on the device, not in a cookie.' },
  { op: 'same', text: '' },
  { op: 'same', text: 'See [[Onboarding]] for the setup.' },
] as const;

export const DIFF = { first: 24, every: 7, restore: 96 };

const TINT = {
  same: { text: colour.fgMuted, back: 'transparent', mark: ' ' },
  added: { text: '#79d4ab', back: 'rgba(38,162,124,0.12)', mark: '+' },
  removed: { text: colour.danger, back: 'rgba(224,109,110,0.12)', mark: '−' },
} as const;

export const Diff: React.FC<{
  frame: number;
  width: number;
  size: number;
  /** Side by side in 16:9; the version list above the diff in 9:16. */
  stacked?: boolean;
  style?: React.CSSProperties;
}> = ({ frame, width, size, stacked = false, style }) => {
  const listWidth = stacked ? width : width * 0.34;
  const restore = ramp(frame, DIFF.restore, 12);

  return (
    <div
      style={{
        position: 'absolute',
        width,
        textAlign: 'left',
        display: 'flex',
        flexDirection: stacked ? 'column' : 'row',
        gap: size,
        opacity: ramp(frame, 2, 16),
        transform: `translateY(${span(frame, 2, 22, 18, 0)}px)`,
        ...style,
      }}
    >
      <div style={{ width: listWidth, display: 'flex', flexDirection: 'column', gap: size * 0.5 }}>
        {VERSIONS.map((version, i) => (
          <div
            key={version.when}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: size * 0.5,
              padding: `${size * 0.6}px ${size * 0.8}px`,
              borderRadius: 10,
              border: `1px solid ${i === 1 ? colour.accentDeep : colour.line}`,
              background: i === 1 ? colour.accentSoft : colour.bgRaised,
              opacity: ramp(frame, stagger(i, 5, 6), 12),
            }}
          >
            <span
              style={{
                width: size * 0.5,
                height: size * 0.5,
                borderRadius: 999,
                background: version.current ? colour.ok : colour.fgMuted,
                flex: 'none',
              }}
            />
            <span style={{ font: `600 ${size * 0.9}px/1 ${font.sans}`, color: colour.fg }}>
              {version.when}
            </span>
            <span style={{ font: `400 ${size * 0.85}px/1 ${font.sans}`, color: colour.fgMuted }}>
              {version.who}
            </span>
          </div>
        ))}

        <div
          style={{
            marginTop: size * 0.4,
            alignSelf: 'flex-start',
            padding: `${size * 0.55}px ${size * 0.95}px`,
            borderRadius: 999,
            border: `1px solid ${colour.accentDeep}`,
            background: colour.accentSoft,
            font: `600 ${size * 0.9}px/1 ${font.sans}`,
            color: colour.accentText,
            opacity: restore,
            transform: `scale(${0.92 + restore * 0.08})`,
          }}
        >
          Restore this version
        </div>
      </div>

      <div
        style={{
          flex: 1,
          boxSizing: 'border-box',
          borderRadius: 12,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          padding: `${size * 0.7}px 0`,
          overflow: 'hidden',
        }}
      >
        {LINES.map((line, i) => {
          const tint = TINT[line.op];
          const at = stagger(i, DIFF.every, DIFF.first);
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: size * 0.7,
                padding: `${size * 0.14}px ${size * 0.9}px`,
                minHeight: size * 1.5,
                background: tint.back,
                font: `400 ${size * 0.88}px/1.5 ${font.mono}`,
                color: line.op === 'same' ? colour.fgMuted : colour.fg,
                opacity: ramp(frame, at, 10),
                transform: `translateX(${span(frame, at, 12, line.op === 'same' ? 0 : -10, 0)}px)`,
              }}
            >
              <span style={{ color: tint.text, width: size * 0.7, flex: 'none' }}>{tint.mark}</span>
              <span>{line.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
