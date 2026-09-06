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
import { screen } from '../../../../assets';
import { beats } from '../../copy';
import { colour } from '../../../../theme';
import { presence, ramp, span } from '../../../../components/anim';
import { Rise } from '../../../../components/Type';
import { Slot, TallStack, type Stacked } from '../../../../components/Layout';
import { Screenshot } from '../../../../components/Screenshot';
import { Outbox, connection } from '../../../../components/Outbox';
import { StatusPill } from '../../../../components/ui';
import { Words } from './Words';

/*
 * Wider than the frame, and pinned to its left edge rather than centred. The
 * board's own right-hand columns then run off the screen instead of ending at a
 * visible border halfway through a card — the same bleed the 16:9 cut gets for
 * free by putting the window at x=880 of 1920.
 */
/*
 * 4:5 has 570 fewer pixels of height than 9:16 and the words, the pill and the
 * gaps take the same room in both, so the window is what gives. The crop
 * follows the box rather than the other way round, which is why the aspect is
 * derived here and not written down twice.
 */
const BOX = { tall: { width: 1240, height: 950 }, feed: { width: 1240, height: 740 } } as const;

export const OfflineTall: React.FC<{ shape: Stacked; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();
  const box = BOX[shape];
  const aspect = box.width / box.height;
  const w = span(frame, 0, life, 1560, 1430);
  /*
   * Anchored at the top-left corner of the columns, not centred on them. A
   * centred crop happens to keep the column headers at 9:16's height and loses
   * them at 4:5's — a board whose first visible row is half a card.
   */
  const crop = { x: 480, y: 190, w, h: w / aspect };
  const offline = connection(frame);

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <TallStack shape={shape} gap={shape === 'feed' ? 34 : 54}>
        <Words shape={shape} {...beats.offline} />

        <Rise at={30} style={{ position: 'relative', height: 56 }}>
          <div style={{ position: 'absolute', inset: 0, opacity: 1 - offline }}>
            <StatusPill fill={colour.ok}>Synced</StatusPill>
          </div>
          <div style={{ position: 'absolute', inset: 0, opacity: offline }}>
            <StatusPill fill={colour.warn}>Offline — still working</StatusPill>
          </div>
        </Rise>

        <Slot width={1080} height={box.height}>
          <Screenshot
            screen={screen.board}
            crop={crop}
            width={box.width}
            height={box.height}
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
