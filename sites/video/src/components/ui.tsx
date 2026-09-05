/**
 * The product's own furniture, redrawn at video scale.
 *
 * Three of the seven beats show something the screenshots cannot: a change
 * queueing, a bar being dragged, a tool call arriving. Those are drawn — but
 * drawn to the same measurements as the real UI, because they sit next to real
 * screenshots and the join has to be invisible. Every colour here comes from
 * `theme.ts`, which comes from the app's stylesheet; nothing is picked by eye.
 */
import React from 'react';
import { colour, font } from '../theme';

export const Dot: React.FC<{ fill: string; size?: number; glow?: boolean }> = ({
  fill,
  size = 12,
  glow = false,
}) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: 999,
      background: fill,
      boxShadow: glow ? `0 0 ${size * 1.6}px ${fill}` : undefined,
      flex: 'none',
    }}
  />
);

/** The pill in the app's top-right corner that says whether the mirror is current. */
export const StatusPill: React.FC<{ fill: string; children: React.ReactNode }> = ({
  fill,
  children,
}) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 12,
      padding: '12px 22px',
      borderRadius: 999,
      background: colour.bgRaised,
      border: `1px solid ${colour.lineStrong}`,
      font: `500 24px/1 ${font.sans}`,
      color: colour.fgSoft,
      whiteSpace: 'nowrap',
    }}
  >
    <Dot fill={fill} glow />
    {children}
  </div>
);

/** The four-bar priority glyph, drawn at whatever height the caller wants. */
export const PriorityBars: React.FC<{ level: 1 | 2 | 3 | 4; height?: number }> = ({
  level,
  height = 18,
}) => {
  const tint = level >= 4 ? colour.danger : level === 3 ? colour.warn : colour.fgMuted;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 3, height }}>
      {[0.42, 0.62, 0.82, 1].map((share, i) => (
        <span
          key={share}
          style={{
            width: height * 0.2,
            height: height * share,
            borderRadius: 2,
            background: i < level ? tint : colour.line,
          }}
        />
      ))}
    </span>
  );
};

export const Avatar: React.FC<{ initials: string; fill: string; size?: number }> = ({
  initials,
  fill,
  size = 34,
}) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: 999,
      background: fill,
      color: '#04120d',
      display: 'grid',
      placeItems: 'center',
      font: `700 ${size * 0.38}px/1 ${font.sans}`,
      letterSpacing: '0.02em',
      flex: 'none',
    }}
  >
    {initials}
  </span>
);

/** A chip as it appears *inside* a card — smaller and quieter than `Type.Chip`. */
export const CardChip: React.FC<{ children: React.ReactNode; dot?: string }> = ({
  children,
  dot,
}) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 13px',
      borderRadius: 8,
      background: colour.bg,
      border: `1px solid ${colour.line}`,
      color: colour.fgSoft,
      font: `500 18px/1 ${font.sans}`,
      whiteSpace: 'nowrap',
    }}
  >
    {dot ? <Dot fill={dot} size={8} /> : null}
    {children}
  </span>
);

export const TaskCard: React.FC<{
  id: string;
  title: string;
  priority?: 1 | 2 | 3 | 4;
  chips?: { label: string; dot?: string }[];
  avatar?: { initials: string; fill: string };
  width: number;
  style?: React.CSSProperties;
}> = ({ id, title, priority = 2, chips = [], avatar, width, style }) => (
  <div
    style={{
      width,
      boxSizing: 'border-box',
      textAlign: 'left',
      padding: '20px 22px 22px',
      borderRadius: 14,
      background: colour.bgRaised,
      border: `1px solid ${colour.line}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      ...style,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span
        style={{
          font: `500 19px/1 ${font.mono}`,
          letterSpacing: '0.06em',
          color: colour.fgMuted,
        }}
      >
        {id}
      </span>
      <PriorityBars level={priority} />
    </div>
    <div
      style={{
        font: `600 25px/1.28 ${font.sans}`,
        letterSpacing: '-0.012em',
        color: colour.fg,
      }}
    >
      {title}
    </div>
    {chips.length || avatar ? (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {chips.map((chip) => (
          <CardChip key={chip.label} dot={chip.dot}>
            {chip.label}
          </CardChip>
        ))}
        {avatar ? (
          <span style={{ marginLeft: 'auto' }}>
            <Avatar initials={avatar.initials} fill={avatar.fill} />
          </span>
        ) : null}
      </div>
    ) : null}
  </div>
);

/**
 * The pointer. Drawn rather than a glyph, because every platform's arrow is a
 * different shape and a viewer reads "somebody is doing this" from the shape
 * they know — a plain filled arrow with a light keyline is the one they all know.
 */
export const Cursor: React.FC<{ style?: React.CSSProperties; size?: number }> = ({
  style,
  size = 34,
}) => (
  <svg
    width={size}
    height={size * 1.42}
    viewBox="0 0 24 34"
    style={{ position: 'absolute', filter: 'drop-shadow(0 6px 12px rgba(0,0,0,0.6))', ...style }}
  >
    <path
      d="M2 1.6 21 18.2h-8.6l-4.2 9.9z"
      fill="#ffffff"
      stroke="#0b0d12"
      strokeWidth={1.8}
      strokeLinejoin="round"
    />
  </svg>
);
