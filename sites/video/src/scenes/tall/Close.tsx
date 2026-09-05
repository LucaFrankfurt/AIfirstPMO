/**
 * The four screens the spot never had time for, stacked down the sides.
 *
 * In 16:9 the collage sits in the four corners; a 9:16 frame has no useful
 * corners, so the windows run down the left and right edges instead, each
 * bleeding off the side it is nearest and drifting away from the middle as it
 * goes. Blurred and at a fifth of their brightness they are texture, not
 * content — but visibly *product* texture, which is what makes "projects, tasks
 * and pages" read as a description rather than a claim.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { screen } from '../../assets';
import { close, url } from '../../copy';
import { colour, font } from '../../theme';
import { presence, ramp, span, stagger } from '../../components/anim';
import { Chip } from '../../components/Type';
import { Screenshot } from '../../components/Screenshot';
import { Wordmark } from '../../components/Wordmark';
import { TALL } from '../../components/Layout';

const COLLAGE = [
  { key: 'pages', screen: screen.pages, left: -230, top: 110, w: 830, h: 500, away: -1 },
  { key: 'chat', screen: screen.chat, left: 520, top: 470, w: 810, h: 488, away: 1 },
  { key: 'insights', screen: screen.insights, left: -200, top: 1090, w: 800, h: 482, away: -1 },
  { key: 'myWork', screen: screen.myWork, left: 490, top: 1430, w: 830, h: 500, away: 1 },
] as const;

const CROP = { x: 0, y: 0, w: 2720, h: 1400 };

export const CloseTall: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();
  const drift = span(frame, 0, life, 0, 26);

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life, 18, 1) }}>
      {COLLAGE.map((one, i) => (
        <Screenshot
          key={one.key}
          screen={one.screen}
          crop={CROP}
          width={one.w}
          height={one.h}
          style={{
            left: one.left,
            top: one.top,
            opacity: ramp(frame, stagger(i, 4), 26) * 0.2,
            /*
             * Out of focus, which is what dimming alone could not do: at any
             * opacity that kept them visible, "API design principles" was still
             * readable in the corner and competed with the wordmark.
             */
            filter: 'blur(3px)',
            transform: `translateX(${drift * one.away}px) scale(${1 + drift / 900})`,
          }}
        />
      ))}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(62% 34% at 50% 46%, rgba(8,9,13,0.97) 0%, rgba(8,9,13,0.88) 58%, rgba(8,9,13,0) 100%)',
        }}
      />

      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          /* A touch above centre: a lockup sitting dead centre reads as low. */
        paddingBottom: 150,
        }}
      >
        <div
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 }}
        >
          <div
            style={{
              opacity: ramp(frame, 4, 20),
              transform: `scale(${span(frame, 4, 30, 0.95, 1)})`,
            }}
          >
            <Wordmark size={100} />
          </div>

          <div
            style={{
              opacity: ramp(frame, 14, 18),
              width: TALL.width,
              textAlign: 'center',
              font: `400 33px/1.4 ${font.sans}`,
              letterSpacing: '-0.012em',
              color: colour.fgSoft,
            }}
          >
            {close.headline}
          </div>

          <div style={{ display: 'flex', gap: 13, marginTop: 6 }}>
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
              marginTop: 14,
              opacity: ramp(frame, 46, 16),
              transform: `translateY(${span(frame, 46, 18, 10, 0)}px)`,
              padding: '16px 26px',
              borderRadius: 12,
              background: colour.bgRaised,
              border: `1px solid ${colour.line}`,
              font: `400 25px/1 ${font.mono}`,
              color: colour.fgSoft,
            }}
          >
            <span style={{ color: colour.fgMuted }}>$ </span>
            {close.command}
          </div>

          {/*
           * Two lines rather than one, and in mono. A 1080-wide frame does not
           * have room for both addresses side by side, and in Inter the
           * repository's capital I is the same stroke as a lower case l —
           * `AIfirstPMO` reads as `AlfirstPMO`, which is the one line here a
           * viewer might actually retype.
           */}
          <div
            style={{
              marginTop: 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              opacity: ramp(frame, 58, 16),
              font: `500 25px/1 ${font.mono}`,
            }}
          >
            <span style={{ color: colour.accentText }}>{url.demo}</span>
            <span style={{ color: colour.fgMuted }}>{url.repo}</span>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
