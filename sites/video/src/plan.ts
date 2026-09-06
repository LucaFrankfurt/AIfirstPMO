/**
 * A spot's storyboard, as numbers.
 *
 * Every spot in this folder is thirty seconds at 30fps, which is 900 frames and
 * not a frame more: they are built to sit in an autoplaying `<video>` and to be
 * uploaded to places that cut at :30 without asking. `plan()` turns a beat table
 * into the three things a spot needs from it — where each `<Sequence>` starts,
 * how long it runs, and the assertion that they add up.
 *
 * A beat lingers `XFADE` frames past its own window so the next one can come up
 * underneath it. Nine frames — see `presence()` in `components/anim.ts` for why
 * this is as short as it is, and for what twelve looked like.
 */
export const FPS = 30;
export const TOTAL = 900;
export const XFADE = 9;

export interface Beat<Id extends string> {
  id: Id;
  frames: number;
}

export interface Plan<Id extends string> {
  /** Where each beat starts and how long its `<Sequence>` runs, dissolve included. */
  window: Record<Id, { from: number; durationInFrames: number }>;
  /** The frame each beat starts on, in order — what the bloom is keyed to. */
  starts: number[];
}

export const plan = <Id extends string>(beats: readonly Beat<Id>[], name: string): Plan<Id> => {
  const total = beats.reduce((sum, beat) => sum + beat.frames, 0);
  if (total !== TOTAL) {
    throw new Error(
      `The beats of "${name}" add up to ${total} frames, not ${TOTAL}. Take the difference out of another beat.`,
    );
  }

  const window = {} as Plan<Id>['window'];
  const starts: number[] = [];
  let at = 0;
  beats.forEach((beat, i) => {
    starts.push(at);
    window[beat.id] = {
      from: at,
      durationInFrames: beat.frames + (i === beats.length - 1 ? 0 : XFADE),
    };
    at += beat.frames;
  });
  return { window, starts };
};
