/**
 * The claim the rest of the product is built on, shown rather than asserted.
 *
 * The status pill is drawn rather than cropped from the screenshot for the
 * obvious reason: the real one says "Synced", and this beat needs it to stop
 * saying that for eighty frames. What is drawn over the board is the outbox —
 * see `components/Outbox.tsx`, which owns both the panel and the moment the
 * wifi comes back.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { screen } from '../assets';
import { beats } from '../copy';
import { colour } from '../theme';
import { presence, ramp, span } from '../components/anim';
import { Headline, Kicker, Rise, Sub } from '../components/Type';
import { TextColumn } from '../components/Layout';
import { Screenshot } from '../components/Screenshot';
import { Outbox, connection } from '../components/Outbox';
import { StatusPill } from '../components/ui';

/** The window, and the crop inside it. Both are the beat's only fixed numbers. */
const BOX = { left: 880, top: 116, width: 1180, height: 848 };
const ASPECT = BOX.width / BOX.height;

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
  const offline = connection(frame);

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
        <Outbox frame={frame} style={{ left: 34, bottom: 34 }} />
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
