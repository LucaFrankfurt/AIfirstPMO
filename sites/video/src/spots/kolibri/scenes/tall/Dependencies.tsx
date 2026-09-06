/**
 * The same drag, on a narrower grid.
 *
 * The gantt is rebuilt from `day` and `rowHeight` rather than scaled, which is
 * the whole reason those are props: a 1460px grid squeezed to 1105 would take
 * its 24px row labels down to 18 and its bars down to 30, and the drag — the
 * one thing this beat exists to show — would be four days of eleven pixels
 * each. Here a day is 17px and the move is visible on a phone.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { beats } from '../../copy';
import { presence } from '../../../../components/anim';
import { Slot, TallStack, type Stacked } from '../../../../components/Layout';
import { Gantt } from '../../../../components/Gantt';
import { Words } from './Words';

/*
 * 380 + 44×15 + 15 = 1055, which fits a 1080 frame. The first attempt used a
 * 340px label column, and at that width "Cut largest-contentful-paint …" lost
 * its ellipsis and clipped to "Cut largest-contentful-paint ." — a full stop
 * that looked like a typo rather than a truncation.
 */
const GRID = { labelWidth: 380, day: 15, rowHeight: 118, headHeight: 62, labelSize: 21 };
const SIZE = {
  width: GRID.labelWidth + 44 * GRID.day + GRID.day,
  height: GRID.headHeight + 4 * GRID.rowHeight + GRID.rowHeight * 0.24,
};

export const DependenciesTall: React.FC<{ shape: Stacked; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <TallStack shape={shape} gap={96}>
        <Words shape={shape} {...beats.timeline} />

        <Slot width={SIZE.width} height={SIZE.height}>
          <Gantt frame={frame} {...GRID} style={{ left: 0, top: 0 }} />
        </Slot>
      </TallStack>
    </AbsoluteFill>
  );
};
