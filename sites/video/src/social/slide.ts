/**
 * What a slide is, before anything draws one.
 *
 * A carousel here is data: a list of slides, each naming its words and — where
 * it has one — a widget already built at the frame it should be read at. That
 * last part is the whole reason this folder is cheap. Every widget in
 * `components/` takes `frame` as a *prop* rather than calling
 * `useCurrentFrame()`, so a still is one of them handed a number: `frame={140}`
 * is the quick-add line after it has been parsed and filed, and it is the same
 * pixels the spot draws at second 4.7. Nothing had to be rewritten to hold still.
 *
 * Which number is the one thing to tune when a slide looks wrong, so it is
 * written at the call site in the set, never hidden behind a helper.
 */
import type React from 'react';

/** The picture, and how much of the band it is allowed. The words get the rest. */
export interface Visual {
  height: number;
  node: React.ReactNode;
}

/**
 * Three kinds, because a carousel has three jobs.
 *
 * `cover` is the thumbnail and the hook, and is the only one composed inside
 * the square the profile grid crops to. `point` makes one claim. `close` asks
 * for something. A carousel that is all `point` is a document; one with two
 * `close` slides is one somebody stopped reading at the first.
 */
export type Slide =
  | {
      kind: 'cover';
      kicker: string;
      headline: string;
      sub: string;
      chips?: readonly string[];
      /** Sigils and identifiers are code and are set as code, chip or not. */
      mono?: boolean;
    }
  | {
      kind: 'point';
      kicker: string;
      headline: string;
      sub?: string;
      visual?: Visual;
      chips?: readonly string[];
      mono?: boolean;
      /** Mono, under the words — a line of syntax the slide is about. */
      code?: string;
    }
  | {
      kind: 'close';
      kicker: string;
      headline: string;
      sub?: string;
      /**
       * The line to leave somebody with. It is not `command` by default: a
       * carousel about the quick-add syntax that signs off with a Docker
       * invocation is answering a question nobody on it asked.
       */
      code?: string;
    };

export interface Carousel {
  /** The Remotion composition id, and the folder the sequence renders into. */
  id: string;
  /** One line for the README table and for whoever has to post it. */
  about: string;
  slides: readonly Slide[];
  /**
   * Whether these are read in order.
   *
   * A carousel is: it gets a counter, so a reader can decide on slide one
   * whether to spend nine swipes, and a chevron on every slide but the last.
   * `singles` is not — it is a folder of posts that happen to be rendered by
   * one composition, and a "3 / 9" on a post somebody meets on its own is a
   * promise of eight more that do not exist.
   */
  series?: boolean;
}
