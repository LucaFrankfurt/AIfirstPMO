/**
 * `[[` opening a picker, and the backlink that appears on the other page.
 *
 * A link lives in the text that spells it — `links.ts` is emphatic that there is
 * no link table, and that the graph is arithmetic over the pages the client
 * already holds. Which is why the backlink can appear on the same frame as the
 * link: nothing was written anywhere for it to appear.
 *
 * The link is by *title*, not by id, so that a line somebody types stays
 * readable in the source and survives being pasted into a chat message. The
 * picker is showing titles for that reason and not as a convenience.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ease } from '../theme';
import { ramp, span, stagger } from './anim';

const BEFORE = 'See ';
const TYPED = '[[On';
const AFTER = 'boarding]] for the setup.';

const MATCHES = ['Onboarding', 'Onboarding — self-hosted', 'On-call rota'];

export const WIKI = { typeFrom: 14, typeTo: 54, picked: 78, resolved: 92, backlink: 112 };

export const WikiLink: React.FC<{
  frame: number;
  width: number;
  size: number;
  style?: React.CSSProperties;
}> = ({ frame, width, size, style }) => {
  const typed = Math.round(
    span(frame, WIKI.typeFrom, WIKI.typeTo - WIKI.typeFrom, 0, TYPED.length, ease.linear),
  );
  const picking = ramp(frame, WIKI.typeFrom + 10, 10) * (1 - ramp(frame, WIKI.picked, 10));
  const resolved = ramp(frame, WIKI.resolved, 12);

  return (
    <div style={{ position: 'absolute', width, textAlign: 'left', ...style }}>
      <div
        style={{
          width,
          boxSizing: 'border-box',
          padding: `${size}px ${size * 1.1}px`,
          borderRadius: 14,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          font: `400 ${size}px/1.5 ${font.sans}`,
          color: colour.fgSoft,
          opacity: ramp(frame, 2, 16),
          transform: `translateY(${span(frame, 2, 22, 16, 0)}px)`,
        }}
      >
        {BEFORE}
        {resolved > 0.5 ? (
          <span
            style={{
              color: colour.accentText,
              borderBottom: `1px solid ${colour.accentDeep}`,
              paddingBottom: 1,
            }}
          >
            Onboarding
          </span>
        ) : (
          <span style={{ font: `400 ${size}px/1.5 ${font.mono}`, color: colour.warn }}>
            {TYPED.slice(0, typed)}
          </span>
        )}
        <span
          style={{
            display: 'inline-block',
            width: 2,
            height: size * 1.05,
            marginBottom: -size * 0.14,
            background: colour.accent,
            opacity: resolved > 0.5 ? 0 : 1,
          }}
        />
        {resolved > 0.5 ? ` ${AFTER.slice(AFTER.indexOf(']]') + 3)}` : ''}
      </div>

      {/* The picker: titles, because a link is by title. */}
      <div
        style={{
          marginTop: size * 0.5,
          marginLeft: size * 2.6,
          width: width * 0.62,
          borderRadius: 12,
          background: colour.bgRaised,
          border: `1px solid ${colour.lineStrong}`,
          boxShadow: '0 26px 60px -24px rgba(0,0,0,0.9)',
          overflow: 'hidden',
          opacity: picking,
          transform: `translateY(${(1 - picking) * -8}px)`,
          height: picking > 0 ? undefined : 0,
        }}
      >
        {MATCHES.map((title, i) => (
          <div
            key={title}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: size * 0.6,
              padding: `${size * 0.55}px ${size * 0.9}px`,
              background: i === 0 ? colour.accentSoft : 'transparent',
              font: `${i === 0 ? 600 : 400} ${size * 0.92}px/1 ${font.sans}`,
              color: i === 0 ? colour.fg : colour.fgSoft,
              opacity: ramp(frame, stagger(i, 4, WIKI.typeFrom + 12), 10),
            }}
          >
            <span style={{ color: colour.fgMuted, font: `400 ${size * 0.85}px/1 ${font.mono}` }}>
              ¶
            </span>
            {title}
          </div>
        ))}
      </div>

      {/* And what the other page now says about this one. */}
      <div
        style={{
          marginTop: size * 1.2,
          padding: `${size * 0.85}px ${size}px`,
          borderRadius: 12,
          border: `1px dashed ${colour.lineStrong}`,
          background: 'rgba(124,124,240,0.05)',
          opacity: ramp(frame, WIKI.backlink, 16),
          transform: `translateY(${span(frame, WIKI.backlink, 18, 12, 0)}px)`,
        }}
      >
        <div
          style={{
            font: `600 ${size * 0.74}px/1 ${font.sans}`,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: colour.fgMuted,
            marginBottom: size * 0.55,
          }}
        >
          On “Onboarding” · backlinks 1
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.55 }}>
          <span style={{ color: colour.accentText, font: `400 ${size * 0.9}px/1 ${font.mono}` }}>
            ←
          </span>
          <span style={{ font: `500 ${size * 0.95}px/1 ${font.sans}`, color: colour.fg }}>
            API design principles
          </span>
          <span style={{ font: `400 ${size * 0.85}px/1 ${font.sans}`, color: colour.fgMuted }}>
            no link table — counted from the text
          </span>
        </div>
      </div>
    </div>
  );
};
