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
import { SpotTall, SpotFeed } from './spots/kolibri/Stacked';
import { TasksWide, TasksTall, TasksFeed } from './spots/tasks/Spot';
import { PagesWide, PagesTall, PagesFeed } from './spots/pages/Spot';
import { SignUpWide, SignUpTall, SignUpFeed } from './spots/signup/Spot';
import { WorkspaceWide, WorkspaceTall, WorkspaceFeed } from './spots/workspace/Spot';
import { HierarchyWide, HierarchyTall, HierarchyFeed } from './spots/hierarchy/Spot';

/**
 * Six spots in three shapes. Each spot's three cuts share one beat table, so a
 * beat that is re-timed is re-timed in all of them — which is the only way they
 * stay one film rather than becoming three films with the same words.
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
      id="KolibriThirtyFeed"
      component={SpotFeed}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1350}
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
      id="TasksThirtyFeed"
      component={TasksFeed}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1350}
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
    <Composition
      id="PagesThirtyFeed"
      component={PagesFeed}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1350}
    />
    <Composition
      id="SignUpThirty"
      component={SignUpWide}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="SignUpThirtyVertical"
      component={SignUpTall}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1920}
    />
    <Composition
      id="SignUpThirtyFeed"
      component={SignUpFeed}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1350}
    />
    <Composition
      id="WorkspaceThirty"
      component={WorkspaceWide}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="WorkspaceThirtyVertical"
      component={WorkspaceTall}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1920}
    />
    <Composition
      id="WorkspaceThirtyFeed"
      component={WorkspaceFeed}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1350}
    />
    <Composition
      id="HierarchyThirty"
      component={HierarchyWide}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="HierarchyThirtyVertical"
      component={HierarchyTall}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1920}
    />
    <Composition
      id="HierarchyThirtyFeed"
      component={HierarchyFeed}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1350}
    />
  </>
);
