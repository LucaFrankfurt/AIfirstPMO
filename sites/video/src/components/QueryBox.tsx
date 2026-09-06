/**
 * A filter you can write down, filtering a list as it is written.
 *
 * The query is quoted from the docblock of
 * `packages/shared/src/modules/work/query.ts` — "the one thing people leaving
 * Jira ask for by name" — and the rows below it are the seeded workspace's own
 * tasks. Which is the point of animating this rather than showing a screenshot:
 * a filter is a *verb*, and a still of a filtered list is indistinguishable from
 * a still of a short list.
 *
 * The typewriter is linear here, unlike the quick-add field's. That is not a
 * style choice: a row disappears when the clause that excludes it finishes
 * typing, and with an eased typewriter working out *when* a given character is
 * reached means inverting a bezier. Linear makes it division.
 */
import React from 'react';
import { query } from '../product';
import { colour, font } from '../theme';
import { ease } from '../theme';
import { ramp, span } from './anim';
import { Avatar, Dot, PriorityBars } from './ui';

/**
 * The query, cut into the pieces that are coloured differently — joined, they
 * are exactly `query.line`, which a test would assert if this folder had one.
 */
const SEGMENTS = [
  { text: 'assignee', kind: 'field' },
  { text: ' = ', kind: 'op' },
  { text: 'me', kind: 'value' },
  { text: ' AND ', kind: 'keyword' },
  { text: 'priority', kind: 'field' },
  { text: ' in ', kind: 'op' },
  { text: '(urgent, high)', kind: 'value' },
  { text: ' AND ', kind: 'keyword' },
  { text: 'state', kind: 'field' },
  { text: ' != ', kind: 'op' },
  { text: 'Done', kind: 'value' },
] as const;

const TINT = {
  field: colour.accentText,
  op: colour.fgMuted,
  keyword: colour.warn,
  value: '#79d4ab',
} as const;

/** Where each clause finishes, in characters. A row dies when the query passes its. */
const CLAUSE = { assignee: 13, priority: 44, state: 62 };

/**
 * Eight of the seeded workspace's tasks, and the clause that removes each. Ada
 * is `me`; three of her tasks survive all three clauses, and every clause takes
 * something away, which is the only way a viewer can tell the clauses apart.
 */
const ROWS = [
  { id: 'WEB-4', title: 'Cut largest-contentful-paint below 1.5s', who: 'AL', tint: '#26a27c', p: 4 as const, dies: Infinity },
  { id: 'WEB-1', title: 'Redesign the pricing page', who: 'AL', tint: '#26a27c', p: 3 as const, dies: Infinity },
  { id: 'WEB-6', title: 'Replace the cookie banner with a consent flow', who: 'AL', tint: '#26a27c', p: 3 as const, dies: Infinity },
  { id: 'WEB-2', title: 'Redraw the empty state', who: 'AL', tint: '#26a27c', p: 2 as const, dies: CLAUSE.priority },
  { id: 'WEB-7', title: 'Fix layout shift on the changelog', who: 'AL', tint: '#26a27c', p: 3 as const, dies: CLAUSE.state },
  { id: 'WEB-3', title: 'Ship dark mode across the marketing site', who: 'GH', tint: '#4aa3df', p: 2 as const, dies: CLAUSE.assignee },
  { id: 'WEB-8', title: 'Add customer logos to the landing page', who: 'AT', tint: '#26a27c', p: 2 as const, dies: CLAUSE.assignee },
  { id: 'WEB-5', title: 'Rewrite the onboarding copy', who: 'MH', tint: '#c98a3e', p: 1 as const, dies: CLAUSE.assignee },
];

export const QUERY = { typeFrom: 14, typeTo: 104 };
const LENGTH = query.line.length;

/** The frame the typewriter reaches character `n`. Linear, so this is division. */
const frameAt = (n: number) =>
  QUERY.typeFrom + ((QUERY.typeTo - QUERY.typeFrom) * n) / LENGTH;

export const QueryBox: React.FC<{
  frame: number;
  width: number;
  /** Type size of the query line; the rows follow from it. */
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const typed = Math.round(
    span(frame, QUERY.typeFrom, QUERY.typeTo - QUERY.typeFrom, 0, LENGTH, ease.linear),
  );
  const caretOn =
    frame < QUERY.typeTo ? 1 : Math.floor((frame - QUERY.typeTo) / 8) % 2 === 0 ? 1 : 0.15;

  const rowHeight = size * 2.5;
  const goneAt = (row: (typeof ROWS)[number]) =>
    row.dies === Infinity ? Infinity : frameAt(row.dies) + 5;
  const alive = ROWS.filter((row) => frame < goneAt(row)).length;
  const out = (row: (typeof ROWS)[number]) =>
    row.dies === Infinity ? 0 : ramp(frame, goneAt(row), 14);

  /*
   * The block sinks by half of what it has lost, so a list that starts eight
   * rows tall and ends three stays where the eye left it. Summed from the rows'
   * own progress rather than from the count, because a count is a step and a
   * step here is the whole block twitching downward five times.
   */
  const settle = (ROWS.reduce((n, row) => n + out(row), 0) * rowHeight) / 2;

  return (
    <div
      style={{
        position: 'absolute',
        width,
        textAlign: 'left',
        transform: `translateY(${settle}px)`,
        ...style,
      }}
    >
      <div
        style={{
          width,
          boxSizing: 'border-box',
          padding: `${size * 0.95}px ${size * 1.2}px`,
          borderRadius: 14,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          boxShadow: '0 0 0 4px rgba(124,124,240,0.10), 0 22px 60px -26px rgba(0,0,0,0.9)',
          opacity: ramp(frame, 2, 18),
          transform: `translateY(${span(frame, 2, 22, 18, 0)}px)`,
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.7,
        }}
      >
        {/* The app's own magnifier, drawn rather than shipped as an icon font. */}
        <svg width={size * 1.1} height={size * 1.1} viewBox="0 0 20 20" style={{ flex: 'none' }}>
          <circle cx="8.5" cy="8.5" r="5.6" fill="none" stroke={colour.fgMuted} strokeWidth="1.9" />
          <path d="M12.8 12.8 L17.5 17.5" stroke={colour.fgMuted} strokeWidth="1.9" strokeLinecap="round" />
        </svg>
        {/*
         * Ligatures off. JetBrains Mono draws `!=` as `≠`, which is handsome and
         * wrong for a spot whose job is to teach the two characters somebody has
         * to type.
         */}
        <div
          style={{
            position: 'relative',
            font: `400 ${size}px/1.35 ${font.mono}`,
            fontVariantLigatures: 'none',
            whiteSpace: 'pre',
          }}
        >
          {SEGMENTS.map((segment, i) => {
            const before = SEGMENTS.slice(0, i).reduce((n, s) => n + s.text.length, 0);
            const shown = Math.max(0, Math.min(segment.text.length, typed - before));
            return (
              <span key={segment.text + i} style={{ color: TINT[segment.kind] }}>
                {segment.text.slice(0, shown)}
              </span>
            );
          })}
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: size * 1.15,
              marginBottom: -size * 0.16,
              background: colour.accent,
              opacity: caretOn,
            }}
          />
        </div>
      </div>

      {/* What the filter has done to the list, in one line. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: size * 0.5,
          margin: `${size * 0.9}px 0 ${size * 0.5}px ${size * 0.3}px`,
          font: `500 ${size * 0.86}px/1 ${font.sans}`,
          color: colour.fgMuted,
          opacity: ramp(frame, QUERY.typeFrom, 14),
        }}
      >
        <span style={{ color: colour.fg }}>{alive}</span>
        <span>of {ROWS.length} tasks</span>
        {/*
         * An unresolvable name is an error, not an empty set — `query.ts` is
         * emphatic about that, and a green tick is the only way to say "this
         * query resolved" without a sentence.
         */}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, opacity: ramp(frame, QUERY.typeTo + 4, 12) }}>
          <Dot fill={colour.ok} size={8} />
          <span style={{ color: colour.ok }}>every name resolved</span>
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {ROWS.map((row, i) => {
          const leaving = out(row);
          return (
            <div
              key={row.id}
              style={{
                height: rowHeight * (1 - leaving),
                opacity: ramp(frame, QUERY.typeFrom - 8 + i * 3, 12) * (1 - leaving),
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                gap: size * 0.65,
                padding: `0 ${size * 0.3}px`,
                borderBottom: `1px solid ${colour.line}`,
                transform: `translateX(${leaving * -26}px)`,
              }}
            >
              <span
                style={{
                  width: size * 0.72,
                  height: size * 0.72,
                  borderRadius: 999,
                  border: `2px solid ${row.dies === CLAUSE.state ? colour.ok : colour.fgMuted}`,
                  background: row.dies === CLAUSE.state ? colour.ok : 'transparent',
                  boxSizing: 'border-box',
                  flex: 'none',
                }}
              />
              <span
                style={{
                  font: `500 ${size * 0.86}px/1 ${font.mono}`,
                  letterSpacing: '0.04em',
                  color: colour.fgMuted,
                  flex: 'none',
                }}
              >
                {row.id}
              </span>
              <span
                style={{
                  font: `400 ${size}px/1.2 ${font.sans}`,
                  color: colour.fg,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flex: 1,
                }}
              >
                {row.title}
              </span>
              <PriorityBars level={row.p} height={size * 0.8} />
              <Avatar initials={row.who} fill={row.tint} size={size * 1.3} />
            </div>
          );
        })}
      </div>
    </div>
  );
};
