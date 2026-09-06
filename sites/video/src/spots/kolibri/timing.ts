/**
 * The seven beats of the flagship spot, and their lengths.
 *
 * This is the only place the lengths are written down; `plan()` refuses to
 * return if they do not add up to 900 frames, so a beat that grows has to take
 * the frames from another beat rather than from the viewer.
 */
import { plan, type Beat } from '../../plan';

const BEATS = [
  { id: 'open', frames: 105 },
  { id: 'offline', frames: 150 },
  { id: 'layouts', frames: 138 },
  { id: 'quickAdd', frames: 156 },
  { id: 'timeline', frames: 126 },
  { id: 'assistant', frames: 126 },
  { id: 'close', frames: 99 },
] as const satisfies readonly Beat<string>[];

export const { window, starts } = plan(BEATS, 'kolibri');
