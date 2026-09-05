/**
 * The storyboard as numbers, in one table, because everything else derives from
 * it — the composition's length, where each `<Sequence>` starts, and the frame
 * a poster still is taken on.
 *
 * Thirty seconds at 30fps is 900 frames and not a frame more: the spot is built
 * to sit in an autoplaying `<video>` on the landing page and to be uploaded to
 * places that cut at :30 without asking. `total()` is asserted against that in
 * `Root.tsx`, so a beat that grows has to take the frames from another beat
 * rather than from the viewer.
 */
export const FPS = 30;
export const TOTAL = 900;

/**
 * A beat lingers `XFADE` frames past its own window so the next one can come up
 * underneath it. Nine frames — see `presence()` in `components/anim.ts` for why
 * this is as short as it is, and for what twelve looked like.
 */
export const XFADE = 9;

export const BEATS = [
  { id: 'open', frames: 105 },
  { id: 'offline', frames: 150 },
  { id: 'layouts', frames: 138 },
  { id: 'quickAdd', frames: 156 },
  { id: 'timeline', frames: 126 },
  { id: 'assistant', frames: 126 },
  { id: 'close', frames: 99 },
] as const;

export type BeatId = (typeof BEATS)[number]['id'];

/** Where each beat starts and how long its `<Sequence>` runs, dissolve included. */
export const window = (() => {
  const out = {} as Record<BeatId, { from: number; durationInFrames: number }>;
  let at = 0;
  BEATS.forEach((beat, i) => {
    const last = i === BEATS.length - 1;
    out[beat.id] = { from: at, durationInFrames: beat.frames + (last ? 0 : XFADE) };
    at += beat.frames;
  });
  return out;
})();

export const total = () => BEATS.reduce((sum, beat) => sum + beat.frames, 0);
