/**
 * The claim the rest of the product is built on, shown rather than asserted.
 *
 * What is drawn over the board is the outbox — the queue described in
 * `docs/sync.md` — and each row names a *field* rather than a task, because
 * "merges field by field" is the part that is hard to believe and easy to show:
 * two people who edited one task both keep their edit, and this is what that
 * looks like from the outside.
 *
 * The status pill is drawn rather than cropped from the screenshot for the
 * obvious reason: the real one says "Synced", and this beat needs it to stop
 * saying that for eighty frames.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { screen } from '../assets';
import { beats } from '../copy';
import { colour, font } from '../theme';
import { presence, pulse, ramp, span } from '../components/anim';
import { Headline, Kicker, Rise, Sub } from '../components/Type';
import { TextColumn } from '../components/Layout';
import { Screenshot } from '../components/Screenshot';
import { Dot, StatusPill } from '../components/ui';

/** The window, and the crop inside it. Both are the beat's only fixed numbers. */
const BOX = { left: 880, top: 116, width: 1180, height: 848 };
const ASPECT = BOX.width / BOX.height;

/** Three edits to three different fields of three different tasks. */
const QUEUED = [
  { id: 'WEB-3', field: 'state', value: 'In Progress', at: 34, merged: 110 },
  { id: 'WEB-8', field: 'assignee', value: 'Ada', at: 52, merged: 120 },
  { id: 'WEB-6', field: 'due date', value: 'Sep 9', at: 70, merged: 130 },
] as const;

const DROPPED = 26;
const RECONNECTED = 106;

const Row: React.FC<{ row: (typeof QUEUED)[number]; frame: number }> = ({ row, frame }) => {
  const here = ramp(frame, row.at, 16);
  const done = ramp(frame, row.merged, 10);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        opacity: here,
        transform: `translateX(${span(frame, row.at, 16, -18, 0)}px)`,
      }}
    >
      <span
        style={{
          width: 26,
          textAlign: 'center',
          font: `700 20px/1 ${font.sans}`,
          color: done > 0.5 ? colour.ok : colour.accentText,
          /* The tick lands with a small pop; the arrow never moves. */
          transform: `scale(${1 + pulse(frame, row.merged, 6, 2, 8) * 0.28})`,
        }}
      >
        {done > 0.5 ? '✓' : '↑'}
      </span>
      <span
        style={{
          font: `500 20px/1 ${font.mono}`,
          letterSpacing: '0.04em',
          color: colour.fgSoft,
        }}
      >
        {row.id}
      </span>
      <span style={{ font: `400 20px/1 ${font.sans}`, color: colour.fgMuted }}>
        {row.field}
      </span>
      <span style={{ font: `400 20px/1 ${font.sans}`, color: colour.fgMuted }}>→</span>
      <span style={{ font: `500 20px/1 ${font.sans}`, color: colour.fg }}>{row.value}</span>
    </div>
  );
};

const Outbox: React.FC<{ frame: number }> = ({ frame }) => {
  /*
   * Three states, not two. The first cut flipped straight from "3 queued" to
   * "3 merged" at a fixed frame, which put the header on "3 queued" while the
   * first row had already ticked — the panel disagreeing with itself for eight
   * frames. The count is now derived from the rows it is counting.
   */
  const queued = QUEUED.filter((row) => frame >= row.at).length;
  const settled = QUEUED.filter((row) => frame >= row.merged).length;
  const merged = settled === QUEUED.length;
  const merging = frame >= RECONNECTED && !merged;
  return (
    <div
      style={{
        position: 'absolute',
        left: 34,
        bottom: 34,
        width: 566,
        padding: '22px 26px 24px',
        borderRadius: 16,
        /*
         * Frosted rather than merely opaque. At 92% flat, the chips of the card
         * underneath showed through the panel's own header and read as a render
         * bug; the blur turns the same overlap into depth.
         */
        background: 'rgba(11,13,18,0.82)',
        backdropFilter: 'blur(16px)',
        border: `1px solid ${colour.lineStrong}`,
        boxShadow: '0 26px 60px -22px rgba(0,0,0,0.9)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        opacity: ramp(frame, DROPPED, 16),
        transform: `translateY(${span(frame, DROPPED, 20, 22, 0)}px)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          style={{
            font: `600 20px/1 ${font.sans}`,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: colour.fgMuted,
          }}
        >
          Outbox
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Dot fill={merged ? colour.ok : merging ? colour.accent : colour.warn} size={9} />
          <span
            style={{
              font: `500 20px/1 ${font.sans}`,
              color: merged ? colour.ok : colour.fgSoft,
            }}
          >
            {merged ? `${QUEUED.length} merged` : merging ? 'merging…' : `${queued} queued`}
          </span>
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
        {QUEUED.map((row) => (
          <Row key={row.id} row={row} frame={frame} />
        ))}
      </div>
    </div>
  );
};

export const Offline: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();

  /*
   * An eight-per-cent push over the whole beat, anchored to the left edge of the
   * Backlog column rather than to the middle. Centring it looked right in the
   * studio and then ate seventy pixels of the first card as it tightened — a
   * board whose left column reads "-5 / vrite the onboarding copy".
   */
  const w = span(frame, 0, life, 1698, 1560);
  const crop = { x: 480, y: 780 - w / ASPECT / 2, w, h: w / ASPECT };

  const offline = ramp(frame, DROPPED, 8) * (1 - ramp(frame, RECONNECTED, 8));

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <Screenshot
        screen={screen.board}
        crop={crop}
        width={BOX.width}
        height={BOX.height}
        style={{
          left: BOX.left,
          top: BOX.top,
          opacity: ramp(frame, 0, 20),
          transform: `translateX(${span(frame, 0, 26, 42, 0)}px)`,
        }}
      >
        <Outbox frame={frame} />
      </Screenshot>

      <TextColumn width={646}>
        <Rise at={6}>
          <Kicker>{beats.offline.kicker}</Kicker>
        </Rise>
        <Rise at={12}>
          <Headline>{beats.offline.headline}</Headline>
        </Rise>
        <Rise at={22}>
          <Sub width={620}>{beats.offline.sub}</Sub>
        </Rise>
        {/*
         * Two pills in the same place, cross-faded. Swapping the text and the
         * colour of one pill reads as a glitch at 30fps; two that dissolve into
         * each other read as a state change.
         */}
        <Rise at={30} style={{ position: 'relative', height: 52, width: 300, marginTop: 8 }}>
          <div style={{ position: 'absolute', inset: 0, opacity: 1 - offline }}>
            <StatusPill fill={colour.ok}>Synced</StatusPill>
          </div>
          <div style={{ position: 'absolute', inset: 0, opacity: offline }}>
            <StatusPill fill={colour.warn}>Offline — still working</StatusPill>
          </div>
        </Rise>
      </TextColumn>
    </AbsoluteFill>
  );
};
