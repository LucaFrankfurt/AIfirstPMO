/** The five beats of the Hierarchy explainer, and their lengths. See `src/plan.ts`. */
import { plan, type Beat } from '../../plan';

const BEATS = [
  { id: 'open', frames: 96 },
  { id: 'tree', frames: 222 },
  { id: 'identifier', frames: 138 },
  { id: 'nesting', frames: 162 },
  { id: 'spanning', frames: 156 },
  { id: 'close', frames: 126 },
] as const satisfies readonly Beat<string>[];

export const { window, starts } = plan(BEATS, 'hierarchy');
