/**
 * Every composition this folder renders.
 *
 * Each spot is thirty seconds because thirty seconds is what a social upload
 * cuts at and what a landing-page loop can hold. `plan()` in `src/plan.ts`
 * refuses to return if a spot's beats do not add up to 900 frames, so a beat
 * that grows fails the render with a number rather than three beats later with
 * a truncated ending that nobody notices until it is published.
 */
import React from 'react';
import { Composition } from 'remotion';
import { FPS, TOTAL } from './plan';
import { Spot } from './spots/kolibri/Wide';
import { SpotTall } from './spots/kolibri/Tall';
import { TasksWide, TasksTall } from './spots/tasks/Spot';
import { PagesWide, PagesTall } from './spots/pages/Spot';

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
    <Composition
      id="TasksThirty"
      component={TasksWide}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="TasksThirtyVertical"
      component={TasksTall}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1920}
    />
    <Composition
      id="PagesThirty"
      component={PagesWide}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="PagesThirtyVertical"
      component={PagesTall}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1920}
    />
  </>
);
