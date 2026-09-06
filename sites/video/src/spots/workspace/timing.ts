/** The five beats of the Workspace explainer, and their lengths. See `src/plan.ts`. */
import { plan, type Beat } from '../../plan';

const BEATS = [
  { id: 'open', frames: 96 },
  { id: 'switcher', frames: 132 },
  { id: 'roles', frames: 156 },
  { id: 'features', frames: 228 },
  { id: 'teams', frames: 156 },
  { id: 'close', frames: 132 },
] as const satisfies readonly Beat<string>[];

export const { window, starts } = plan(BEATS, 'workspace');
