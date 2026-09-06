/**
 * `WEB-6` coming apart into the two things it is.
 *
 * `Task` carries a `project_id`, a `number` and an `identifier`. The number is
 * the *project's* count, not the workspace's — which is why two projects both
 * have a task 5 and why an identifier is readable out loud without anybody
 * having to ask which workspace it came from.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';

const PAIRS = [
  { key: 'WEB', number: 6, title: 'Replace the cookie banner', at: 22 },
  { key: 'API', number: 5, title: 'Add cursor pagination to /tasks', at: 62 },
] as const;

export const IDENT = { note: 104 };

export const Identifier: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => (
  <div
    style={{
      position: 'absolute',
      width,
      textAlign: 'left',
      display: 'flex',
      flexDirection: 'column',
      gap: size * 1.1,
      ...style,
    }}
  >
    {PAIRS.map((pair) => {
      /* The two chips travel together and fuse; the join is the whole animation. */
      const fused = ramp(frame, pair.at + 22, 16);
      const gap = size * 1.6 * (1 - fused);
      return (
        <div key={pair.key} style={{ display: 'flex', alignItems: 'center', gap: size * 0.9 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap }}>
            <span
              style={{
                padding: `${size * 0.42}px ${size * 0.72}px`,
                borderRadius: fused > 0.5 ? '9px 0 0 9px' : 9,
                background: colour.accentSoft,
                border: `1px solid ${colour.accentDeep}`,
                borderRight: fused > 0.5 ? 'none' : undefined,
                font: `600 ${size * 1.15}px/1 ${font.mono}`,
                letterSpacing: '0.05em',
                color: colour.accentText,
                opacity: ramp(frame, pair.at, 12),
              }}
            >
              {pair.key}
              <span style={{ opacity: fused, color: colour.fgMuted }}>-</span>
            </span>
            <span
              style={{
                padding: `${size * 0.42}px ${size * 0.72}px`,
                borderRadius: fused > 0.5 ? '0 9px 9px 0' : 9,
                background: colour.bg,
                border: `1px solid ${fused > 0.5 ? colour.accentDeep : colour.lineStrong}`,
                borderLeft: fused > 0.5 ? 'none' : undefined,
                font: `600 ${size * 1.15}px/1 ${font.mono}`,
                color: colour.fg,
                opacity: ramp(frame, pair.at + 8, 12),
              }}
            >
              {pair.number}
            </span>
          </span>
          <span
            style={{
              font: `400 ${size}px/1.3 ${font.sans}`,
              color: colour.fgSoft,
              opacity: fused,
              transform: `translateX(${(1 - fused) * -12}px)`,
            }}
          >
            {pair.title}
          </span>
        </div>
      );
    })}

    <div style={{ display: 'flex', flexDirection: 'column', gap: size * 0.45 }}>
      {(
        [
          'The key is the project’s. The number is the project’s count, not the workspace’s.',
          'Which is why two projects both have a task 5, and why an identifier can be read out loud.',
        ] as const
      ).map((line, i) => (
        <div
          key={line}
          style={{
            display: 'flex',
            gap: size * 0.5,
            font: `400 ${size * 0.92}px/1.45 ${font.sans}`,
            color: colour.fgMuted,
            opacity: ramp(frame, stagger(i, 10, IDENT.note), 16),
            transform: `translateY(${span(frame, stagger(i, 10, IDENT.note), 18, 10, 0)}px)`,
          }}
        >
          <span style={{ color: colour.accentText }}>·</span>
          {line}
        </div>
      ))}
    </div>
  </div>
);
