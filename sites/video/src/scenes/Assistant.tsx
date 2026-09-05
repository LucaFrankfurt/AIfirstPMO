/**
 * A tool call, arriving the way a tool call actually arrives.
 *
 * The arguments are not invented: `project`, `title`, `priority` and `labels`
 * are four of the properties `create_task` declares in
 * `packages/server/src/adapters/mcp/tools/tasks.ts`, and the task it files is
 * WEB-4 — the same WEB-4 that is sitting in the In Progress column two beats
 * earlier. A spot that showed a plausible-looking tool call would be showing a
 * mock-up of an integration; this one can be typed into a real instance.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { colour, font } from '../theme';
import { presence, ramp, span, stagger } from '../components/anim';
import { Headline, Kicker, Rise, Sub } from '../components/Type';
import { TextColumn } from '../components/Layout';
import { TaskCard } from '../components/ui';

const CARD = { left: 806, top: 224, width: 1014 };

/** Light enough to read as a string on `#08090d`; `--ok` itself is too dark for type. */
const STRING = '#79d4ab';

const ARGS = [
  { key: 'project', value: '"WEB"' },
  { key: 'title', value: '"Cut largest-contentful-paint below 1.5s"' },
  { key: 'priority', value: '"high"' },
  { key: 'labels', value: '["performance"]' },
] as const;

const CALL_AT = 12;
const RESULT_AT = 58;
const FILED_AT = 74;

const MONO = `400 22px/1.7 ${font.mono}`;

export const Assistant: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <TextColumn width={620}>
        <Rise at={4}>
          <Kicker>{beats.assistant.kicker}</Kicker>
        </Rise>
        <Rise at={9}>
          <Headline>{beats.assistant.headline}</Headline>
        </Rise>
        <Rise at={18}>
          <Sub width={600}>{beats.assistant.sub}</Sub>
        </Rise>
      </TextColumn>

      <div
        style={{
          position: 'absolute',
          left: CARD.left,
          top: CARD.top,
          width: CARD.width,
          boxSizing: 'border-box',
          borderRadius: 16,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          boxShadow: '0 40px 90px -38px rgba(0,0,0,0.92)',
          overflow: 'hidden',
          opacity: ramp(frame, 2, 18),
          transform: `translateY(${span(frame, 2, 24, 20, 0)}px)`,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '18px 26px',
            borderBottom: `1px solid ${colour.line}`,
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <span style={{ font: `500 20px/1 ${font.mono}`, color: colour.fgSoft }}>
            kolibri · mcp
          </span>
          <span
            style={{
              marginLeft: 'auto',
              font: `400 19px/1 ${font.sans}`,
              color: colour.fgMuted,
            }}
          >
            stdio and http
          </span>
        </div>

        <div style={{ padding: '22px 26px 26px' }}>
          <div style={{ opacity: ramp(frame, CALL_AT, 10), font: MONO }}>
            <span style={{ color: colour.accentText }}>→ </span>
            <span style={{ color: colour.fg, fontWeight: 700 }}>create_task</span>
          </div>
          {ARGS.map((arg, i) => {
            const at = stagger(i, 7, CALL_AT + 9);
            return (
              <div
                key={arg.key}
                style={{
                  font: MONO,
                  paddingLeft: 34,
                  whiteSpace: 'pre',
                  opacity: ramp(frame, at, 10),
                  transform: `translateX(${span(frame, at, 12, -10, 0)}px)`,
                }}
              >
                <span style={{ color: colour.fgMuted }}>{arg.key.padEnd(10)}</span>
                <span style={{ color: STRING }}>{arg.value}</span>
              </div>
            );
          })}
          <div
            style={{
              marginTop: 16,
              paddingTop: 16,
              borderTop: `1px solid ${colour.line}`,
              font: MONO,
              opacity: ramp(frame, RESULT_AT, 12),
            }}
          >
            <span style={{ color: colour.ok, fontWeight: 700 }}>✓ </span>
            <span style={{ color: colour.fg }}>WEB-4</span>
            <span style={{ color: colour.fgMuted }}> created · Backlog</span>
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: CARD.left,
          top: 664,
          opacity: ramp(frame, FILED_AT, 16),
          transform: `translateY(${span(frame, FILED_AT, 22, 24, 0)}px)`,
        }}
      >
        <TaskCard
          id="WEB-4"
          title="Cut largest-contentful-paint below 1.5s"
          priority={4}
          chips={[
            { label: 'performance', dot: colour.accent },
            { label: 'Cycle 2026-8' },
            { label: 'Aug 30' },
          ]}
          width={660}
        />
      </div>
    </AbsoluteFill>
  );
};
