/**
 * A carousel is a filmstrip: frame *n* is slide *n*.
 *
 * Remotion renders frames, so the cheapest true thing to say about a set of
 * stills is that it is a one-frame-per-second film nobody plays. That buys two
 * things for nothing. `npm run social:pitch` is **one** render — one bundle,
 * one browser — that writes the whole Bilderreihe as numbered PNGs, instead of
 * eight `remotion still` invocations each paying for its own bundle. And the
 * studio scrubs it: dragging the playhead across a carousel is exactly the
 * gesture the reader's thumb will make, which is the only way to catch a slide
 * that does not follow the one before it.
 *
 * The composition's frame is the *index*. It is deliberately not the frame the
 * widgets see — each of those is written at its call site in the set, because
 * "the quick-add line at 140" is a fact about that slide and not about where it
 * happens to sit in the deck.
 */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { SlideView } from './Slide';
import type { Slide } from './slide';

/**
 * Built once, at module scope, and never inline in `Root`. Remotion remounts a
 * composition whose component identity changes between renders, which shows up
 * as a studio that flickers and a render that re-decodes the fonts per frame.
 */
export const carousel = (slides: readonly Slide[], series = true): React.FC => {
  const Deck: React.FC = () => {
    const frame = useCurrentFrame();
    const index = Math.min(Math.max(Math.round(frame), 0), slides.length - 1);
    return (
      <SlideView slide={slides[index]} index={index} count={slides.length} series={series} />
    );
  };
  return Deck;
};
