/**
 * The line typed, then parsed, then filed.
 *
 * The token offsets below are counted out of the string in `copy.ts` rather
 * than written down, because the string is quoted verbatim from
 * `packages/shared/src/modules/work/quickadd.ts` and will change when the syntax
 * does. Counting them means a changed example moves its own highlights; a table
 * of hand-written offsets would silently point at the wrong characters.
 *
 * Monospace is not a style choice here — it is what makes a highlight rectangle
 * placeable at all. At 26px, JetBrains Mono advances exactly 0.6em, so character
 * *n* starts at `n × 15.6px` and nothing has to be measured at runtime.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { colour, font } from '../theme';
import { presence, ramp, span, stagger } from '../components/anim';
import { Headline, Kicker, Rise, Sub } from '../components/Type';
import { TextColumn } from '../components/Layout';
import { TaskCard } from '../components/ui';

const LINE = beats.quickAdd.line;
const SIZE = 26;
const CHAR = SIZE * 0.6;

const INPUT = { left: 806, top: 372, width: 1000, padX: 32, padY: 26 };

/** Typing runs from here to here; everything else hangs off the end of it. */
const TYPE_FROM = 12;
const TYPE_TO = 80;
const PARSE_FROM = 86;
const FILED = 124;

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

export const QuickAdd: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();

  const typed = Math.round(span(frame, TYPE_FROM, TYPE_TO - TYPE_FROM, 0, LINE.length, [
    0.32, 0, 0.36, 1,
  ]));
  /* Solid while typing, then a 2Hz blink — the two things a caret ever does. */
  const caretOn = frame < TYPE_TO ? 1 : Math.floor((frame - TYPE_TO) / 8) % 2 === 0 ? 1 : 0.15;

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <TextColumn width={620}>
        <Rise at={4}>
          <Kicker>{beats.quickAdd.kicker}</Kicker>
        </Rise>
        <Rise at={9}>
          <Headline>{beats.quickAdd.headline}</Headline>
        </Rise>
        <Rise at={18}>
          <Sub width={600}>{beats.quickAdd.sub}</Sub>
        </Rise>
      </TextColumn>

      {/* The input */}
      <div
        style={{
          position: 'absolute',
          left: INPUT.left,
          top: INPUT.top,
          width: INPUT.width,
          boxSizing: 'border-box',
          padding: `${INPUT.padY}px ${INPUT.padX}px`,
          borderRadius: 14,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          boxShadow: `0 0 0 4px rgba(124,124,240,0.10), 0 22px 60px -26px rgba(0,0,0,0.9)`,
          opacity: ramp(frame, 2, 18),
          transform: `translateY(${span(frame, 2, 22, 20, 0)}px)`,
        }}
      >
        <div style={{ position: 'relative', height: SIZE * 1.3 }}>
          {/* Highlights sit behind the glyphs, one per token, staggered. */}
          {TOKENS.map((token, i) => {
            const on = ramp(frame, stagger(i, 8, PARSE_FROM), 12);
            return (
              <div
                key={token.text}
                style={{
                  position: 'absolute',
                  left: token.start * CHAR - 7,
                  top: -4,
                  width: token.len * CHAR + 14,
                  height: SIZE * 1.3 + 8,
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
              font: `400 ${SIZE}px/1.3 ${font.mono}`,
              color: colour.fg,
              whiteSpace: 'pre',
            }}
          >
            {LINE.slice(0, typed)}
          </div>
          <div
            style={{
              position: 'absolute',
              left: typed * CHAR,
              top: 1,
              width: 2,
              height: SIZE * 1.15,
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
          left: INPUT.left + INPUT.padX,
          top: INPUT.top + INPUT.padY + SIZE * 1.3 + 20,
          font: `400 20px/1 ${font.mono}`,
          color: colour.fgMuted,
          whiteSpace: 'pre',
          opacity: ramp(frame, 8, 16) * (1 - ramp(frame, PARSE_FROM - 16, 12)),
        }}
      >
        {beats.quickAdd.syntax}
      </div>

      {/* What each sigil turned into, under the sigil that turned into it. */}
      {TOKENS.map((token, i) => {
        const on = ramp(frame, stagger(i, 8, PARSE_FROM + 4), 12);
        return (
          <div
            key={token.field}
            style={{
              position: 'absolute',
              left: INPUT.left + INPUT.padX + token.start * CHAR - 7,
              top: INPUT.top + INPUT.padY + SIZE * 1.3 + 20,
              width: token.len * CHAR + 14,
              textAlign: 'center',
              font: `500 16px/1 ${font.sans}`,
              letterSpacing: '0.04em',
              color: token.tint,
              opacity: on,
              transform: `translateY(${span(frame, stagger(i, 8, PARSE_FROM + 4), 12, -6, 0)}px)`,
            }}
          >
            {token.field}
          </div>
        );
      })}

      {/* And the task it files. */}
      <div
        style={{
          position: 'absolute',
          left: INPUT.left,
          top: 540,
          opacity: ramp(frame, FILED, 16),
          transform: `translateY(${span(frame, FILED, 22, 26, 0)}px)`,
        }}
      >
        <TaskCard
          id="WEB-2"
          title="Redraw the empty state"
          priority={3}
          chips={[
            { label: 'High', dot: colour.danger },
            { label: 'Website', dot: colour.accent },
            { label: 'design', dot: colour.brand },
            { label: 'Sep 11' },
          ]}
          avatar={{ initials: 'AL', fill: '#26a27c' }}
          width={700}
        />
      </div>
    </AbsoluteFill>
  );
};
