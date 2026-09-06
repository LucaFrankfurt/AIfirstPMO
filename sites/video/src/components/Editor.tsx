/**
 * Markdown typed on the left, rendered on the right, a block at a time.
 *
 * The renderer here understands three things — a heading, a bullet and a wiki
 * link — which is exactly as much as the beat shows and no more. A fuller one
 * would be a worse illustration: what the viewer has to see is that the two
 * panes are the *same document*, and a block appearing on the right the moment
 * its line finishes on the left says that better than any amount of syntax.
 *
 * A block renders when its line is *complete*, not while it is being typed.
 * Rendering half a heading is what a live preview actually does, and it looks
 * like a bug in a thirty-second video.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ease } from '../theme';
import { ramp, span } from './anim';

const SOURCE = [
  '# API design principles',
  '',
  '- Resources are plural nouns.',
  '- Lists paginate by cursor.',
  '',
  'See [[Onboarding]] for the setup.',
];

const TEXT = SOURCE.join('\n');
export const EDITOR = { typeFrom: 16, typeTo: 128 };

/** Where each line ends, in characters of the whole document. */
const ENDS = SOURCE.map((_, i) => SOURCE.slice(0, i + 1).join('\n').length);

/** The frame the typewriter reaches character `n`. Linear, so this is division. */
const frameAt = (n: number) =>
  EDITOR.typeFrom + ((EDITOR.typeTo - EDITOR.typeFrom) * n) / TEXT.length;

const Rendered: React.FC<{ line: string; size: number }> = ({ line, size }) => {
  if (line.startsWith('# ')) {
    return (
      <div
        style={{
          font: `700 ${size * 1.5}px/1.25 ${font.sans}`,
          letterSpacing: '-0.02em',
          color: colour.fg,
          margin: `0 0 ${size * 0.5}px`,
        }}
      >
        {line.slice(2)}
      </div>
    );
  }
  if (line.startsWith('- ')) {
    return (
      <div style={{ display: 'flex', gap: size * 0.6, margin: `${size * 0.28}px 0` }}>
        <span style={{ color: colour.accentText, font: `700 ${size}px/1.5 ${font.sans}` }}>•</span>
        <span style={{ font: `400 ${size}px/1.5 ${font.sans}`, color: colour.fgSoft }}>
          {line.slice(2)}
        </span>
      </div>
    );
  }
  if (!line) return <div style={{ height: size * 0.5 }} />;

  /* `[[Title]]` renders as a link — by title, which is what the author wrote. */
  const parts = line.split(/(\[\[[^\]]+\]\])/);
  return (
    <div
      style={{
        font: `400 ${size}px/1.5 ${font.sans}`,
        color: colour.fgSoft,
        margin: `${size * 0.5}px 0 0`,
      }}
    >
      {parts.map((part, i) =>
        part.startsWith('[[') ? (
          <span
            key={i}
            style={{
              color: colour.accentText,
              borderBottom: `1px solid ${colour.accentDeep}`,
              paddingBottom: 1,
            }}
          >
            {part.slice(2, -2)}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </div>
  );
};

export const Editor: React.FC<{
  frame: number;
  width: number;
  size: number;
  /** Side by side in 16:9; one above the other in 9:16. */
  stacked?: boolean;
  style?: React.CSSProperties;
}> = ({ frame, width, size, stacked = false, style }) => {
  const typed = Math.round(
    span(frame, EDITOR.typeFrom, EDITOR.typeTo - EDITOR.typeFrom, 0, TEXT.length, ease.linear),
  );
  const caretOn =
    frame < EDITOR.typeTo ? 1 : Math.floor((frame - EDITOR.typeTo) / 8) % 2 === 0 ? 1 : 0.15;
  const pane = stacked ? width : (width - size) / 2;

  const Panel: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div
      style={{
        width: pane,
        boxSizing: 'border-box',
        borderRadius: 14,
        background: colour.bgRaised,
        border: `1px solid ${colour.lineStrong}`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: `${size * 0.5}px ${size * 0.9}px`,
          borderBottom: `1px solid ${colour.line}`,
          font: `500 ${size * 0.72}px/1 ${font.sans}`,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: colour.fgMuted,
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        {label}
      </div>
      <div style={{ padding: `${size * 0.9}px ${size * 0.9}px ${size * 1.1}px` }}>{children}</div>
    </div>
  );

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
      <Panel label="Markdown">
        <div
          style={{
            font: `400 ${size * 0.92}px/1.6 ${font.mono}`,
            color: colour.fgSoft,
            whiteSpace: 'pre-wrap',
            minHeight: size * 9,
          }}
        >
          {TEXT.slice(0, typed)}
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: size * 1.05,
              marginBottom: -size * 0.16,
              background: colour.accent,
              opacity: caretOn,
            }}
          />
        </div>
      </Panel>

      <Panel label="Page">
        <div style={{ minHeight: size * 9 }}>
          {SOURCE.map((line, i) => {
            /*
             * A block arrives when its line is finished, and arrives softly —
             * appearing on the exact frame is a pop, and six frames of fade is
             * the difference between "rendered" and "flickered".
             */
            const at = frameAt(ENDS[i]);
            if (frame < at) return null;
            const on = ramp(frame, at, 7);
            return (
              <div
                key={i}
                style={{ opacity: on, transform: `translateY(${span(frame, at, 9, 6, 0)}px)` }}
              >
                <Rendered line={line} size={size} />
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
};
