/**
 * A task walking its project's workflow, and being stopped at the last door.
 *
 * The states are the seeded project's own — Backlog, Todo, In Progress, In
 * Review, Done — and the colours are the app's state groups. The last step is
 * the one worth animating: the demo site's claim is "per-column rules for who
 * may move work where", and a rule you can see refuse is a different thing from
 * a sentence saying rules exist.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp } from './anim';
import { Dot } from './ui';

const STATES = [
  { name: 'Backlog', tint: colour.fgMuted },
  { name: 'Todo', tint: colour.fgSoft },
  { name: 'In Progress', tint: colour.warn },
  { name: 'In Review', tint: colour.accent },
  { name: 'Done', tint: colour.ok },
] as const;

/** When the card arrives at each state. The pause before the last one is the point. */
const ARRIVES = [10, 40, 66, 92, 140];
/** The refusal, and then the permission. */
export const FLOW = { refused: 108, allowed: 132, done: ARRIVES[4] };

export const StateFlow: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const step = size * 0.42;
  const lane = width - step * 2;
  const at = (i: number) => step + (lane * i) / (STATES.length - 1);

  /* Which state the card is over, interpolated so it slides rather than jumps. */
  let x = at(0);
  let reached = 0;
  for (let i = 1; i < STATES.length; i++) {
    const move = ramp(frame, ARRIVES[i] - 18, 18);
    x = x + (at(i) - at(i - 1)) * move;
    if (move > 0.5) reached = i;
  }

  const refused = ramp(frame, FLOW.refused, 8) * (1 - ramp(frame, FLOW.allowed, 8));
  const allowed = ramp(frame, FLOW.allowed, 10);

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      {/* The card, riding above the track. */}
      <div
        style={{
          position: 'absolute',
          left: x,
          top: 0,
          transform: `translateX(-50%) rotate(${refused * 1.6}deg)`,
          width: size * 11,
          boxSizing: 'border-box',
          padding: `${size * 0.7}px ${size * 0.85}px ${size * 0.8}px`,
          borderRadius: 12,
          background: colour.bgRaised,
          border: `1px solid ${refused > 0.3 ? colour.danger : colour.line}`,
          boxShadow: '0 22px 50px -20px rgba(0,0,0,0.9)',
          opacity: ramp(frame, 2, 14),
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: size * 0.45,
            font: `500 ${size * 0.82}px/1 ${font.mono}`,
            letterSpacing: '0.05em',
            color: colour.fgMuted,
          }}
        >
          <Dot fill={STATES[reached].tint} size={size * 0.5} />
          WEB-6
        </div>
        <div
          style={{
            marginTop: size * 0.5,
            font: `500 ${size * 0.98}px/1.25 ${font.sans}`,
            color: colour.fg,
          }}
        >
          Replace the cookie banner
        </div>
      </div>

      {/* The track. */}
      {/* Through the centre of the dots, not their feet. */}
      <div
        style={{
          position: 'absolute',
          top: size * 5.5 + size * 0.475 - 1,
          left: 0,
          width,
          height: 2,
          background: colour.line,
        }}
      />
      {STATES.map((state, i) => {
        const here = i <= reached;
        return (
          <div
            key={state.name}
            style={{
              position: 'absolute',
              left: at(i),
              top: size * 5.5,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: size * 0.5,
            }}
          >
            <span
              style={{
                width: size * 0.95,
                height: size * 0.95,
                borderRadius: 999,
                boxSizing: 'border-box',
                border: `${Math.max(2, size * 0.16)}px solid ${here ? state.tint : colour.line}`,
                /* Visited states keep their colour at a quarter, so the walk leaves a trail. */
                background:
                  i === reached ? state.tint : here ? `${state.tint}44` : colour.bg,
              }}
            />
            <span
              style={{
                font: `${i === reached ? 600 : 400} ${size * 0.82}px/1 ${font.sans}`,
                color: i === reached ? colour.fg : here ? colour.fgSoft : colour.fgMuted,
                whiteSpace: 'nowrap',
              }}
            >
              {state.name}
            </span>
          </div>
        );
      })}

      {/* The rule on the last column, refusing and then satisfied. */}
      <div
        style={{
          position: 'absolute',
          left: at(4),
          top: size * 9.6,
          transform: 'translateX(-50%)',
          width: size * 13,
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: size * 0.45,
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: size * 0.45,
            padding: `${size * 0.4}px ${size * 0.75}px`,
            borderRadius: 999,
            border: `1px solid ${refused > allowed ? colour.danger : colour.ok}`,
            background: colour.bgRaised,
            font: `500 ${size * 0.85}px/1 ${font.sans}`,
            color: refused > allowed ? colour.danger : colour.ok,
            opacity: Math.max(refused, allowed),
            whiteSpace: 'nowrap',
          }}
        >
          {refused > allowed ? '⨯ only a reviewer may move work here' : '✓ approved by Grace Hopper'}
        </div>
      </div>
    </div>
  );
};
