/** The six beats of the Tasks explainer, and their lengths. See `src/plan.ts`. */
import { plan, type Beat } from '../../plan';

const BEATS = [
  { id: 'open', frames: 96 },
  { id: 'quickAdd', frames: 150 },
  { id: 'fields', frames: 138 },
  { id: 'subtasks', frames: 132 },
  { id: 'workflow', frames: 132 },
  { id: 'query', frames: 156 },
  { id: 'close', frames: 96 },
] as const satisfies readonly Beat<string>[];

export const { window, starts } = plan(BEATS, 'tasks');
