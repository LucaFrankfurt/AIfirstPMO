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
import { carousel } from './social/Carousel';
import { proof, proofSize } from './social/Proof';
import { carousels } from './social/sets';
import { POST } from './social/sheet';

/**
 * The carousels, built once here rather than inside the JSX below.
 *
 * A composition whose component identity changes between renders is remounted,
 * so an arrow function in the `<Composition>` call would rebuild the deck — and
 * re-decode the fonts — on every frame. `carousel()` is called once, at module
 * scope, and the array it produces is the same array for the life of the process.
 */
const DECKS = carousels.map((set) => ({
  set,
  Deck: carousel(set.slides, set.series ?? true),
  Proof: proof(set.slides, set.series ?? true),
  size: proofSize(set.slides.length),
}));

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
    {/*
     * One composition per carousel, one frame per slide, one frame a second —
     * so `remotion render <id> <dir> --sequence` writes the whole Bilderreihe
     * as numbered PNGs in a single bundle.
     */}
    {DECKS.map(({ set, Deck, Proof, size }) => (
      <React.Fragment key={set.id}>
        <Composition
          id={set.id}
          component={Deck}
          durationInFrames={set.slides.length}
          fps={1}
          width={POST.width}
          height={POST.height}
        />
        {/* The contact sheet. Rendered on demand, never published. */}
        <Composition
          id={`${set.id}Proof`}
          component={Proof}
          durationInFrames={1}
          fps={1}
          width={size.width}
          height={size.height}
        />
      </React.Fragment>
    ))}
  </>
);
