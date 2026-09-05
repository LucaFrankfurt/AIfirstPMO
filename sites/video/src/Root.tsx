/**
 * One composition, and one assertion about it.
 *
 * The spot is thirty seconds because thirty seconds is what a social upload
 * cuts at and what a landing-page loop can hold. `total()` adds up the beat
 * table in `timing.ts`; if a beat grows without another shrinking, the render
 * fails here with a number rather than three beats later with a truncated
 * ending that nobody notices until it is published.
 */
import React from 'react';
import { Composition } from 'remotion';
import { FPS, TOTAL, total } from './timing';
import { Spot } from './Video';
import { SpotTall } from './VideoTall';

if (total() !== TOTAL) {
  throw new Error(
    `The beats add up to ${total()} frames, not ${TOTAL}. Take the difference out of another beat in timing.ts.`,
  );
}

/**
 * Two shapes of the same thirty seconds. They share the beat table, so a beat
 * that is re-timed is re-timed in both — which is the only way the two stay the
 * same film rather than becoming two films with the same words.
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="KolibriThirty"
      component={Spot}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="KolibriThirtyVertical"
      component={SpotTall}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1920}
    />
  </>
);
