/**
 * The board under the words, with the outbox over its bottom-left corner.
 *
 * The crop is tighter and much less wide than the 16:9 one: at 1080 across, two
 * and a half columns of a 2720-wide capture is illegible mush, so the vertical
 * cut shows the Backlog column and most of Todo and lets the rest go. The
 * push-in is still anchored to the column's left edge — a crop that tightens
 * towards the middle eats the first card, which is a mistake this file has
 * already made once in the other aspect.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { screen } from '../../assets';
import { beats } from '../../copy';
import { colour } from '../../theme';
import { presence, ramp, span } from '../../components/anim';
import { Rise } from '../../components/Type';
import { Slot, TallStack } from '../../components/Layout';
import { Screenshot } from '../../components/Screenshot';
import { Outbox, connection } from '../../components/Outbox';
import { StatusPill } from '../../components/ui';
import { Words } from './Words';

/*
 * Wider than the frame, and pinned to its left edge rather than centred. The
 * board's own right-hand columns then run off the screen instead of ending at a
 * visible border halfway through a card — the same bleed the 16:9 cut gets for
 * free by putting the window at x=880 of 1920.
 */
const BOX = { width: 1240, height: 950 };
const ASPECT = BOX.width / BOX.height;

export const OfflineTall: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();
  const w = span(frame, 0, life, 1560, 1430);
  const crop = { x: 480, y: 780 - w / ASPECT / 2, w, h: w / ASPECT };
  const offline = connection(frame);

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <TallStack gap={54}>
        <Words {...beats.offline} />

        <Rise at={30} style={{ position: 'relative', height: 56 }}>
          <div style={{ position: 'absolute', inset: 0, opacity: 1 - offline }}>
            <StatusPill fill={colour.ok}>Synced</StatusPill>
          </div>
          <div style={{ position: 'absolute', inset: 0, opacity: offline }}>
            <StatusPill fill={colour.warn}>Offline — still working</StatusPill>
          </div>
        </Rise>

        <Slot width={1080} height={BOX.height}>
          <Screenshot
            screen={screen.board}
            crop={crop}
            width={BOX.width}
            height={BOX.height}
            style={{
              left: 0,
              top: 0,
              opacity: ramp(frame, 0, 20),
              transform: `translateY(${span(frame, 0, 26, 34, 0)}px)`,
            }}
          >
            <Outbox frame={frame} scale={0.84} style={{ left: 26, bottom: 26 }} />
          </Screenshot>
        </Slot>
      </TallStack>
    </AbsoluteFill>
  );
};
