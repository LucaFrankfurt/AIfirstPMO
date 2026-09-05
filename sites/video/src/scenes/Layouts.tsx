/**
 * Three real screens of the same nine tasks, shuffled like a deck.
 *
 * The crop is the *whole* window rather than the interesting part of it, which
 * costs legibility and buys the only thing this beat is about: the sidebar, the
 * tabs and the view switcher stay exactly where they are while the middle turns
 * from rows into columns into bars. Crop into the content and it looks like
 * three products.
 *
 * There is no push-in on the crop, and that is the second half of the same
 * decision. A crop that tightens eats the sidebar's icons and the "Synced" pill
 * a few pixels at a time — precisely the chrome this beat needs whole. The
 * motion comes from scaling the *window*, which crops nothing.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { screen } from '../assets';
import { beats } from '../copy';
import { presence, ramp, span } from '../components/anim';
import { Headline, Kicker, Rise, Sub } from '../components/Type';
import { TextBand } from '../components/Layout';
import { ScreenshotStack } from '../components/Screenshot';

/*
 * 1632 × 612 is 2720 × 1020 divided by five thirds — the timeline capture's exact
 * aspect. Rounding it to a tidier 1620 × 608 leaves half a pixel of panel
 * background along the bottom edge of that one shot, which is invisible in the
 * studio and a hairline in an H.264 encode.
 */
const BOX = { left: 144, top: 122, width: 1632, height: 612 };

/** When each layout takes over. The timeline is last because it is the surprise. */
const SHOTS = [
  { key: 'list', screen: screen.list, at: 0 },
  { key: 'board', screen: screen.board, at: 48 },
  { key: 'timeline', screen: screen.timeline, at: 96 },
] as const;

const CROSS = 15;

export const Layouts: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();

  const crop = { x: 0, y: 0, w: 2720, h: 1020 };

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <ScreenshotStack
        crop={crop}
        width={BOX.width}
        height={BOX.height}
        style={{
          left: BOX.left,
          top: BOX.top,
          opacity: ramp(frame, 0, 18),
          transform: `translateY(${span(frame, 0, 26, 16, 0)}px) scale(${span(
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

      <TextBand top={782}>
        <Rise at={4}>
          <Kicker>{beats.layouts.kicker}</Kicker>
        </Rise>
        <Rise at={9}>
          <Headline>{beats.layouts.headline}</Headline>
        </Rise>
        <Rise at={16}>
          <Sub width={1080}>{beats.layouts.sub}</Sub>
        </Rise>
      </TextBand>
    </AbsoluteFill>
  );
};
