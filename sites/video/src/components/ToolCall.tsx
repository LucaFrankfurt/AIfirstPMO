/**
 * A tool call, arriving the way a tool call actually arrives.
 *
 * The arguments are not invented: `project`, `title`, `priority` and `labels`
 * are four of the properties `create_task` declares in
 * `packages/server/src/adapters/mcp/tools/tasks.ts`, and the task it files is
 * WEB-4 — the same WEB-4 sitting in the In Progress column two beats earlier.
 * A spot that showed a plausible-looking tool call would be showing a mock-up
 * of an integration; this one can be typed into a real instance.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';

/** Light enough to read as a string on `#08090d`; `--ok` itself is too dark for type. */
const STRING = '#79d4ab';

const ARGS = [
  { key: 'project', value: '"WEB"' },
  { key: 'title', value: '"Cut largest-contentful-paint below 1.5s"' },
  { key: 'priority', value: '"high"' },
  { key: 'labels', value: '["performance"]' },
] as const;

export const TOOL_CALL = { callAt: 12, resultAt: 58, filed: 74 };

export const ToolCall: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const mono = `400 ${size}px/1.7 ${font.mono}`;
  const pad = size * 1.18;

  return (
    <div
      style={{
        position: 'absolute',
        width,
        boxSizing: 'border-box',
        textAlign: 'left',
        borderRadius: 16,
        background: colour.bgRaised,
        border: `1px solid ${colour.lineStrong}`,
        boxShadow: '0 40px 90px -38px rgba(0,0,0,0.92)',
        overflow: 'hidden',
        opacity: ramp(frame, 2, 18),
        transform: `translateY(${span(frame, 2, 24, 20, 0)}px)`,
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: `${size * 0.82}px ${pad}px`,
          borderBottom: `1px solid ${colour.line}`,
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        <span style={{ font: `500 ${size * 0.91}px/1 ${font.mono}`, color: colour.fgSoft }}>
          kolibri · mcp
        </span>
        <span
          style={{ marginLeft: 'auto', font: `400 ${size * 0.86}px/1 ${font.sans}`, color: colour.fgMuted }}
        >
          stdio and http
        </span>
      </div>

      <div style={{ padding: `${size}px ${pad}px ${pad}px` }}>
        <div style={{ opacity: ramp(frame, TOOL_CALL.callAt, 10), font: mono }}>
          <span style={{ color: colour.accentText }}>→ </span>
          <span style={{ color: colour.fg, fontWeight: 700 }}>create_task</span>
        </div>
        {ARGS.map((arg, i) => {
          const at = stagger(i, 7, TOOL_CALL.callAt + 9);
          return (
            <div
              key={arg.key}
              style={{
                font: mono,
                paddingLeft: size * 1.55,
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
            marginTop: size * 0.73,
            paddingTop: size * 0.73,
            borderTop: `1px solid ${colour.line}`,
            font: mono,
            opacity: ramp(frame, TOOL_CALL.resultAt, 12),
          }}
        >
          <span style={{ color: colour.ok, fontWeight: 700 }}>✓ </span>
          <span style={{ color: colour.fg }}>WEB-4</span>
          <span style={{ color: colour.fgMuted }}> created · Backlog</span>
        </div>
      </div>
    </div>
  );
};
