/**
 * Three real screens of the same nine tasks, dissolving inside one window.
 *
 * The window is 1240 wide in a 1080 frame — it bleeds eighty pixels off each
 * edge on purpose. A desktop UI letterboxed politely inside a vertical frame
 * reads as a screenshot of a screenshot; one that runs off both sides reads as
 * a screen. The crop still holds the whole toolbar, because the point of the
 * beat is that the chrome does not move while the middle turns from rows into
 * columns into bars.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { screen } from '../../../../assets';
import { beats } from '../../copy';
import { presence, ramp, span } from '../../../../components/anim';
import { Slot, TallStack, type Stacked } from '../../../../components/Layout';
import { ScreenshotStack } from '../../../../components/Screenshot';
import { Words } from './Words';

/**
 * Cropped to the sidebar's edge and the toolbar's far corner, and no further —
 * and then hung off the *right* of the frame rather than centred, because the
 * view switcher lives in that corner and the beat's point is that its
 * highlighted icon walks from the first position to the fifth. Centred, the
 * fifth was off screen and the walk stopped being visible three shots in.
 */
const CROP = { x: 420, y: 0, w: 1600, h: 1020 };
/* Narrower in 4:5, because the height it would need is height 4:5 does not have. */
const WIDTH = { tall: 1240, feed: 1120 } as const;

/** When each layout takes over. The timeline is last because it is the surprise. */
const SHOTS = [
  { key: 'list', screen: screen.list, at: 0 },
  { key: 'board', screen: screen.board, at: 48 },
  { key: 'timeline', screen: screen.timeline, at: 96 },
] as const;

const CROSS = 15;

export const LayoutsTall: React.FC<{ shape: Stacked; life: number }> = ({ shape, life }) => {
  const width = WIDTH[shape];
  const height = Math.round((width * CROP.h) / CROP.w);
  const bleed = width - 1080;
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <TallStack shape={shape} gap={shape === 'feed' ? 56 : 86}>
        <Words shape={shape} {...beats.layouts} />

        <Slot width={1080} height={height}>
          <ScreenshotStack
            crop={CROP}
            width={width}
            height={height}
            style={{
              left: -bleed,
              top: 0,
              opacity: ramp(frame, 0, 18),
              transform: `translateY(${span(frame, 0, 26, 20, 0)}px) scale(${span(
                frame,
                0,
                life,
                1,
                1.022,
              )})`,
            }}
            layers={SHOTS.map((shot, i) => {
              const next = SHOTS[i + 1];
              const inward = i === 0 ? 1 : ramp(frame, shot.at, CROSS);
              const outward = next ? ramp(frame, next.at, CROSS) : 0;
              return {
                key: shot.key,
                screen: shot.screen,
                opacity: inward * (1 - outward),
                /* A hair of scale on the way in, so a dissolve still has a direction. */
                scale: 1 + (1 - inward) * 0.012,
              };
            })}
          />
        </Slot>
      </TallStack>
    </AbsoluteFill>
  );
};
