/**
 * The whole shape of the app, built one level at a time.
 *
 * Six levels and two leaves, and every one of them is a table in
 * `packages/shared/src/kernel/registry/types.ts`: a workspace holds teams, a
 * team holds projects, a project holds its own states, cycles and modules, and
 * a task holds tasks. Pages hang off a project rather than off a task, which is
 * why they are drawn as a sibling of the work and not under it.
 *
 * The rails are computed rather than drawn by hand: for a row at depth *d*, the
 * vertical line at level *k* continues only if a later row is still a child of
 * that ancestor. Hand-placed rails survive exactly one edit to the tree.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span, stagger } from './anim';

interface Node {
  depth: number;
  icon: string;
  text: string;
  badge?: string;
  kind: string;
  tint?: string;
}

const NODES: Node[] = [
  { depth: 0, icon: '◈', text: 'Kolibri', kind: 'workspace', tint: '#7c7cf0' },
  { depth: 1, icon: '▣', text: 'Web', badge: 'WEB', kind: 'team', tint: '#4aa3df' },
  { depth: 2, icon: '●', text: 'Website', badge: 'WEB', kind: 'project', tint: '#26a27c' },
  { depth: 3, icon: '○', text: 'Backlog · Todo · In Progress · Done', kind: 'states' },
  { depth: 3, icon: '↻', text: 'Cycle 2026-8', kind: 'cycle' },
  { depth: 3, icon: '◎', text: 'Website v2', kind: 'module' },
  { depth: 3, icon: '¶', text: 'API design principles', kind: 'page' },
  { depth: 3, icon: '▸', text: 'Replace the cookie banner', badge: 'WEB-6', kind: 'task' },
  { depth: 4, icon: '▸', text: 'Write the consent copy', badge: 'WEB-12', kind: 'sub-task' },
];

/** For each row, whether the rail at each ancestor level keeps going below it. */
const RAILS = NODES.map((node, i) =>
  Array.from({ length: node.depth }, (_, k) => {
    for (let j = i + 1; j < NODES.length; j++) {
      if (NODES[j].depth <= k) return false;
      if (NODES[j].depth === k + 1) return true;
    }
    return false;
  }),
);

export const TREE = { first: 10, every: 13 };

export const HierarchyTree: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const row = size * 2.5;
  const step = size * 1.55;

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      {NODES.map((node, i) => {
        const at = stagger(i, TREE.every, TREE.first);
        const on = ramp(frame, at, 12);
        return (
          <div
            key={node.text}
            style={{
              display: 'flex',
              alignItems: 'center',
              height: row,
              opacity: on,
              transform: `translateX(${span(frame, at, 14, -14, 0)}px)`,
            }}
          >
            {/* The rails, and the elbow into this row. */}
            {RAILS[i].map((keeps, k) => {
              const elbow = k === node.depth - 1;
              return (
                <span key={k} style={{ position: 'relative', width: step, height: row, flex: 'none' }}>
                  {/*
                   * A rail is drawn only where something below still hangs from
                   * it. The first cut drew every ancestor cell full height,
                   * which left two stubs dangling under the last row like a
                   * ladder with nothing on it.
                   */}
                  <span
                    style={{
                      position: 'absolute',
                      left: size * 0.42,
                      top: 0,
                      width: 1,
                      height: keeps ? row : elbow ? row / 2 : 0,
                      background: colour.line,
                    }}
                  />
                  {elbow ? (
                    <span
                      style={{
                        position: 'absolute',
                        left: size * 0.42,
                        top: row / 2,
                        width: size * 0.72,
                        height: 1,
                        background: colour.line,
                      }}
                    />
                  ) : null}
                </span>
              );
            })}

            <span
              style={{
                width: size * 1.5,
                textAlign: 'center',
                font: `400 ${size * 1.05}px/1 ${font.sans}`,
                color: node.tint ?? colour.fgMuted,
                flex: 'none',
              }}
            >
              {node.icon}
            </span>
            <span
              style={{
                font: `${node.depth <= 2 ? 600 : 400} ${size}px/1 ${font.sans}`,
                color: node.depth <= 2 ? colour.fg : colour.fgSoft,
                whiteSpace: 'nowrap',
              }}
            >
              {node.text}
            </span>
            {node.badge ? (
              <span
                style={{
                  marginLeft: size * 0.5,
                  padding: `${size * 0.2}px ${size * 0.45}px`,
                  borderRadius: 6,
                  background: colour.bg,
                  border: `1px solid ${colour.line}`,
                  font: `500 ${size * 0.76}px/1 ${font.mono}`,
                  letterSpacing: '0.05em',
                  color: colour.fgMuted,
                }}
              >
                {node.badge}
              </span>
            ) : null}
            <span
              style={{
                marginLeft: 'auto',
                font: `500 ${size * 0.74}px/1 ${font.sans}`,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: colour.fgMuted,
                opacity: 0.75,
              }}
            >
              {node.kind}
            </span>
          </div>
        );
      })}
    </div>
  );
};
