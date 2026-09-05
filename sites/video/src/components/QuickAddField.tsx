/**
 * The quick-add input: typed, parsed, and captioned under each sigil.
 *
 * The token offsets are counted out of the string in `product.ts` rather than
 * written down, because the string is quoted verbatim from
 * `packages/shared/src/modules/work/quickadd.ts` and will change when the syntax
 * does. Counting them means a changed example moves its own highlights; a table
 * of hand-written offsets would silently point at the wrong characters.
 *
 * Monospace is not a style choice here — it is what makes a highlight rectangle
 * placeable at all. JetBrains Mono advances exactly 0.6em, so character *n*
 * starts at `n × size × 0.6` and nothing has to be measured at runtime. That is
 * also why `size` is the only thing the two cuts pass differently.
 */
import React from 'react';
import { quickAdd } from '../product';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';

const LINE = quickAdd.line;

/** Typing runs from here to here; everything else hangs off the end of it. */
export const QUICK_ADD = { typeFrom: 12, typeTo: 80, parseFrom: 86, filed: 124 };

/**
 * Each sigil, the field it answers to, and the colour it is given. The colours
 * are the app's own semantic ones: priority is danger, a date is warn, the
 * project is the accent, and a label borrows the mark's teal.
 */
const TOKENS = [
  { text: '!high', field: 'priority', tint: colour.danger },
  { text: '@ada', field: 'assignee', tint: colour.ok },
  { text: '#WEB', field: 'project', tint: colour.accent },
  { text: '*design', field: 'label', tint: colour.brand },
  { text: 'due:friday', field: 'due date', tint: colour.warn },
].map((token) => ({ ...token, start: LINE.indexOf(token.text), len: token.text.length }));

export const QuickAddField: React.FC<{
  frame: number;
  width: number;
  /** Type size of the line itself; the captions and the hint follow from it. */
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const char = size * 0.6;
  const padX = size * 1.25;
  const padY = size;

  const typed = Math.round(
    span(frame, QUICK_ADD.typeFrom, QUICK_ADD.typeTo - QUICK_ADD.typeFrom, 0, LINE.length, [
      0.32, 0, 0.36, 1,
    ]),
  );
  /* Solid while typing, then a 2Hz blink — the two things a caret ever does. */
  const caretOn =
    frame < QUICK_ADD.typeTo ? 1 : Math.floor((frame - QUICK_ADD.typeTo) / 8) % 2 === 0 ? 1 : 0.15;

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      <div
        style={{
          width,
          boxSizing: 'border-box',
          padding: `${padY}px ${padX}px`,
          borderRadius: 14,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          boxShadow: '0 0 0 4px rgba(124,124,240,0.10), 0 22px 60px -26px rgba(0,0,0,0.9)',
          opacity: ramp(frame, 2, 18),
          transform: `translateY(${span(frame, 2, 22, 20, 0)}px)`,
        }}
      >
        <div style={{ position: 'relative', height: size * 1.3 }}>
          {/* Highlights sit behind the glyphs, one per token, staggered. */}
          {TOKENS.map((token, i) => {
            const on = ramp(frame, stagger(i, 8, QUICK_ADD.parseFrom), 12);
            return (
              <div
                key={token.text}
                style={{
                  position: 'absolute',
                  left: token.start * char - 7,
                  top: -4,
                  width: token.len * char + 14,
                  height: size * 1.3 + 8,
                  borderRadius: 8,
                  background: token.tint,
                  border: `1px solid ${token.tint}`,
                  opacity: on * 0.2,
                  transform: `scaleY(${0.7 + on * 0.3})`,
                }}
              />
            );
          })}
          <div
            style={{
              position: 'relative',
              font: `400 ${size}px/1.3 ${font.mono}`,
              color: colour.fg,
              whiteSpace: 'pre',
            }}
          >
            {LINE.slice(0, typed)}
          </div>
          <div
            style={{
              position: 'absolute',
              left: typed * char,
              top: 1,
              width: 2,
              height: size * 1.15,
              background: colour.accent,
              opacity: caretOn,
            }}
          />
        </div>
      </div>

      {/*
       * The field's own hint, in the gap under it, until the parse makes it
       * redundant. It is `QUICK_ADD_SYNTAX` verbatim — the same six tokens the
       * real input offers — which is both the honest thing to show and the
       * thing that stops this half of the frame being empty for three seconds.
       */}
      <div
        style={{
          position: 'absolute',
          left: padX,
          top: padY + size * 1.3 + 20,
          font: `400 ${size * 0.77}px/1 ${font.mono}`,
          color: colour.fgMuted,
          whiteSpace: 'pre',
          opacity: ramp(frame, 8, 16) * (1 - ramp(frame, QUICK_ADD.parseFrom - 16, 12)),
        }}
      >
        {quickAdd.syntax}
      </div>

      {/* What each sigil turned into, under the sigil that turned into it. */}
      {TOKENS.map((token, i) => {
        const at = stagger(i, 8, QUICK_ADD.parseFrom + 4);
        return (
          <div
            key={token.field}
            style={{
              position: 'absolute',
              left: padX + token.start * char - 7,
              top: padY + size * 1.3 + 20,
              width: token.len * char + 14,
              textAlign: 'center',
              font: `500 ${size * 0.62}px/1 ${font.sans}`,
              letterSpacing: '0.04em',
              color: token.tint,
              opacity: ramp(frame, at, 12),
              transform: `translateY(${span(frame, at, 12, -6, 0)}px)`,
            }}
          >
            {token.field}
          </div>
        );
      })}
    </div>
  );
};
