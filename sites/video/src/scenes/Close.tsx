/**
 * The four screens the spot never had time for, and the two lines a viewer has
 * to leave with.
 *
 * Pages, chat, insights and my-work drift at the edges at a fifth of their
 * brightness — dim enough to stay behind the type, present enough that "projects,
 * tasks *and pages*" is visibly true rather than merely claimed. The install
 * command is on screen because it is genuinely the whole install, and a viewer
 * who has watched thirty seconds of an offline-first tool is exactly the viewer
 * who will check.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { screen } from '../assets';
import { close, url } from '../copy';
import { colour, font } from '../theme';
import { presence, ramp, span, stagger } from '../components/anim';
import { Chip } from '../components/Type';
import { Screenshot } from '../components/Screenshot';
import { Wordmark } from '../components/Wordmark';

/** Four windows, pushed to the corners, leaving the middle third clear for type. */
const COLLAGE = [
  { key: 'pages', screen: screen.pages, left: -150, top: 26, w: 790, h: 476 },
  { key: 'chat', screen: screen.chat, left: 1298, top: 4, w: 810, h: 488 },
  { key: 'insights', screen: screen.insights, left: -110, top: 596, w: 770, h: 464 },
  { key: 'myWork', screen: screen.myWork, left: 1256, top: 584, w: 830, h: 500 },
] as const;

const CROP = { x: 0, y: 0, w: 2720, h: 1400 };

export const Close: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();
  const drift = span(frame, 0, life, 0, 26);

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life, 18, 1) }}>
      {COLLAGE.map((one, i) => {
        /* Each pushes away from the centre it is nearest, so the middle opens up. */
        const towards = one.left < 500 ? -1 : 1;
        return (
          <Screenshot
            key={one.key}
            screen={one.screen}
            crop={CROP}
            width={one.w}
            height={one.h}
            style={{
              left: one.left,
              top: one.top,
              opacity: ramp(frame, stagger(i, 4), 26) * 0.22,
              /*
               * Out of focus, which is what dimming alone could not do: at any
               * opacity that kept them visible, "API design principles" was
               * still readable in the corner and competed with the wordmark.
               */
              filter: 'blur(3px)',
              transform: `translateX(${drift * towards}px) scale(${1 + drift / 900})`,
            }}
          />
        );
      })}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(46% 52% at 50% 50%, rgba(8,9,13,0.97) 0%, rgba(8,9,13,0.86) 55%, rgba(8,9,13,0) 100%)',
        }}
      />

      <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 30,
          }}
        >
          <div
            style={{
              opacity: ramp(frame, 4, 20),
              transform: `scale(${span(frame, 4, 30, 0.95, 1)})`,
            }}
          >
            <Wordmark size={104} />
          </div>

          <div
            style={{
              opacity: ramp(frame, 14, 18),
              font: `400 31px/1.4 ${font.sans}`,
              letterSpacing: '-0.012em',
              color: colour.fgSoft,
            }}
          >
            {close.headline}
          </div>

          <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
            {close.claims.map((claim, i) => {
              const at = stagger(i, 5, 26);
              return (
                <div
                  key={claim}
                  style={{
                    opacity: ramp(frame, at, 14),
                    transform: `translateY(${span(frame, at, 16, 10, 0)}px)`,
                  }}
                >
                  <Chip tone={claim === 'MIT' ? 'plain' : 'accent'}>{claim}</Chip>
                </div>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 10,
              opacity: ramp(frame, 46, 16),
              transform: `translateY(${span(frame, 46, 18, 10, 0)}px)`,
              padding: '15px 26px',
              borderRadius: 12,
              background: colour.bgRaised,
              border: `1px solid ${colour.line}`,
              font: `400 26px/1 ${font.mono}`,
              color: colour.fgSoft,
            }}
          >
            <span style={{ color: colour.fgMuted }}>$ </span>
            {close.command}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 22,
              marginTop: 6,
              opacity: ramp(frame, 58, 16),
              /*
               * Mono, because this is the one line a viewer might retype. In
               * Inter the repository's capital I is the same stroke as a lower
               * case l and `AIfirstPMO` reads as `AlfirstPMO`.
               */
              font: `500 26px/1 ${font.mono}`,
            }}
          >
            <span style={{ color: colour.accentText }}>{url.demo}</span>
            <span style={{ color: colour.line }}>·</span>
            <span style={{ color: colour.fgMuted }}>{url.repo}</span>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
