/**
 * The title card and the end card the two explainer spots share.
 *
 * They are a *series*: same mark, same lockup, same closing chips, and a section
 * name that changes. Writing them once is what makes that true a year from now,
 * when somebody adds a third explainer and copies whichever file was nearest.
 *
 * The flagship spot keeps its own bookends, because its close is a collage of
 * four screens and its open is the only place the brand gets three and a half
 * seconds to itself.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { claims, command, url } from '../product';
import { colour, font } from '../theme';
import { presence, ramp, span, stagger } from './anim';
import { Chip } from './Type';
import { Mark, Wordmark } from './Wordmark';
import { type Shape } from './Beat';

export const Opening: React.FC<{
  shape: Shape;
  life: number;
  /** "Tasks", "Pages" — the thing this spot is about. */
  section: string;
  tagline: string;
}> = ({ shape, life, section, tagline }) => {
  const frame = useCurrentFrame();
  const tall = shape === 'tall';
  const scale = span(frame, 2, 34, 0.92, 1);
  const markSize = tall ? 150 : 112;

  return (
    <AbsoluteFill
      style={{
        opacity: presence(frame, life, 16, 14),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: tall ? 150 : 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tall ? 40 : 34,
          transform: `scale(${scale}) translateY(${span(frame, life - 26, 26, 0, -34)}px)`,
        }}
      >
        {/*
         * Lockup, separator, section — one line in 16:9 and stacked in 9:16, for
         * the same reason the flagship's open is: a horizontal lockup across the
         * middle of a very tall frame is a thin band, not a title.
         */}
        <div
          style={{
            display: 'flex',
            flexDirection: tall ? 'column' : 'row',
            alignItems: 'center',
            gap: tall ? 34 : markSize * 0.42,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: markSize * 0.42 }}>
            <Mark size={markSize} />
            <span
              style={{
                font: `700 ${markSize * 0.86}px/1 ${font.sans}`,
                letterSpacing: '-0.035em',
                color: tall ? colour.fgSoft : colour.fg,
              }}
            >
              Kolibri
            </span>
          </div>
          {tall ? null : (
            <span style={{ font: `300 ${markSize * 0.8}px/1 ${font.sans}`, color: colour.line }}>
              /
            </span>
          )}
          <span
            style={{
              font: `800 ${(tall ? markSize : markSize * 0.86) * 1.02}px/1 ${font.sans}`,
              letterSpacing: '-0.038em',
              color: colour.accentText,
              opacity: ramp(frame, 14, 20),
              transform: `translateY(${span(frame, 14, 22, 14, 0)}px)`,
            }}
          >
            {section}
          </span>
        </div>

        <div
          style={{
            opacity: ramp(frame, 26, 24),
            transform: `translateY(${span(frame, 26, 24, 16, 0)}px)`,
            maxWidth: tall ? 960 : 1180,
            textAlign: 'center',
            font: `400 ${tall ? 36 : 34}px/1.4 ${font.sans}`,
            letterSpacing: '-0.012em',
            color: colour.fgSoft,
          }}
        >
          {tagline}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Closing: React.FC<{
  shape: Shape;
  life: number;
  headline: string;
}> = ({ shape, life, headline }) => {
  const frame = useCurrentFrame();
  const tall = shape === 'tall';

  return (
    <AbsoluteFill
      style={{
        opacity: presence(frame, life, 18, 1),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: tall ? 150 : 0,
      }}
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tall ? 32 : 30 }}
      >
        <div
          style={{
            opacity: ramp(frame, 4, 20),
            transform: `scale(${span(frame, 4, 30, 0.95, 1)})`,
          }}
        >
          <Wordmark size={tall ? 100 : 104} />
        </div>

        <div
          style={{
            opacity: ramp(frame, 14, 18),
            maxWidth: tall ? 960 : 1200,
            textAlign: 'center',
            font: `400 ${tall ? 33 : 31}px/1.4 ${font.sans}`,
            letterSpacing: '-0.012em',
            color: colour.fgSoft,
          }}
        >
          {headline}
        </div>

        <div style={{ display: 'flex', gap: tall ? 13 : 14, marginTop: 4 }}>
          {claims.map((claim, i) => {
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
            marginTop: tall ? 14 : 10,
            opacity: ramp(frame, 46, 16),
            transform: `translateY(${span(frame, 46, 18, 10, 0)}px)`,
            padding: tall ? '16px 26px' : '15px 26px',
            borderRadius: 12,
            background: colour.bgRaised,
            border: `1px solid ${colour.line}`,
            font: `400 ${tall ? 25 : 26}px/1 ${font.mono}`,
            color: colour.fgSoft,
          }}
        >
          <span style={{ color: colour.fgMuted }}>$ </span>
          {command}
        </div>

        {/*
         * Mono, because this is the one line a viewer might retype, and in Inter
         * the repository's capital I is the same stroke as a lower case l —
         * `AIfirstPMO` reads as `AlfirstPMO`.
         */}
        <div
          style={{
            marginTop: tall ? 12 : 6,
            display: 'flex',
            flexDirection: tall ? 'column' : 'row',
            alignItems: 'center',
            gap: tall ? 12 : 22,
            opacity: ramp(frame, 58, 16),
            font: `500 ${tall ? 25 : 26}px/1 ${font.mono}`,
          }}
        >
          <span style={{ color: colour.accentText }}>{url.demo}</span>
          {tall ? null : <span style={{ color: colour.line }}>·</span>}
          <span style={{ color: colour.fgMuted }}>{url.repo}</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
