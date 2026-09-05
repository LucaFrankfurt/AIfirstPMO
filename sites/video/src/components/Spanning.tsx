/**
 * A cycle that crosses projects, and the empty list that means all of them.
 *
 * `Cycle.projects` and `Module.projects` both carry the same comment in
 * `types.ts`: "Empty means *every* project, not none." That is the kind of
 * decision a viewer will not believe from a sentence and will believe from a
 * bar growing — so the bar covers two projects, the list is emptied, and it
 * covers the lot.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span } from './anim';

const PROJECTS = ['Website', 'Mobile app', 'Public API'] as const;

export const SPANNING = { drawn: 20, widened: 76, note: 100 };

export const Spanning: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const drawn = ramp(frame, SPANNING.drawn, 16);
  const all = ramp(frame, SPANNING.widened, 18);
  const lane = width / PROJECTS.length;
  /* Two projects wide, then three. The bar is the sentence. */
  const covered = 2 + all;

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      <div style={{ display: 'flex' }}>
        {PROJECTS.map((project, i) => (
          <div
            key={project}
            style={{
              width: lane,
              boxSizing: 'border-box',
              padding: `${size * 0.7}px ${size * 0.6}px`,
              marginRight: i === PROJECTS.length - 1 ? 0 : size * 0.4,
              borderRadius: 12,
              background: colour.bgRaised,
              border: `1px solid ${colour.line}`,
              opacity: ramp(frame, 2 + i * 5, 14),
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.45 }}>
              <span
                style={{ width: size * 0.55, height: size * 0.55, borderRadius: 4, background: colour.accent, opacity: 0.75 }}
              />
              <span style={{ font: `600 ${size * 0.95}px/1 ${font.sans}`, color: colour.fg }}>
                {project}
              </span>
            </div>
            <div style={{ marginTop: size * 0.6, display: 'flex', flexDirection: 'column', gap: size * 0.35 }}>
              {[0, 1, 2].map((n) => (
                <span
                  key={n}
                  style={{
                    height: size * 0.62,
                    borderRadius: 4,
                    background: colour.bg,
                    border: `1px solid ${colour.line}`,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* The cycle, laid across whichever projects run it. */}
      <div
        style={{
          marginTop: size * 0.9,
          position: 'relative',
          height: size * 2.4,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: size * 2.4,
            width: lane * covered + size * 0.4 * (Math.ceil(covered) - 1),
            borderRadius: 10,
            background: colour.accentSoft,
            border: `1px solid ${colour.accentDeep}`,
            display: 'flex',
            alignItems: 'center',
            gap: size * 0.5,
            padding: `0 ${size * 0.8}px`,
            boxSizing: 'border-box',
            opacity: drawn,
          }}
        >
          <span style={{ font: `400 ${size}px/1 ${font.sans}`, color: colour.accentText }}>↻</span>
          <span style={{ font: `600 ${size * 0.98}px/1 ${font.sans}`, color: colour.accentText }}>
            Cycle 2026-8
          </span>
        </div>
      </div>

      {/* The field that did it. */}
      <div
        style={{
          marginTop: size * 0.9,
          padding: `${size * 0.62}px ${size * 0.9}px`,
          borderRadius: 10,
          background: colour.bgRaised,
          border: `1px solid ${colour.line}`,
          font: `400 ${size * 0.95}px/1 ${font.mono}`,
          color: colour.fgSoft,
          opacity: drawn,
        }}
      >
        <span style={{ color: colour.fgMuted }}>projects: </span>
        {all > 0.5 ? '[]' : '["Website", "Mobile app"]'}
      </div>

      <div
        style={{
          marginTop: size * 0.7,
          font: `400 ${size * 0.92}px/1.45 ${font.sans}`,
          color: colour.fgMuted,
          opacity: ramp(frame, SPANNING.note, 16),
          transform: `translateY(${span(frame, SPANNING.note, 18, 10, 0)}px)`,
        }}
      >
        <span style={{ color: colour.fg, fontWeight: 600 }}>Empty means every project, not none.</span>{' '}
        The same rule holds for a module, which is a milestone that outlives the cycle it started in.
      </div>
    </div>
  );
};
