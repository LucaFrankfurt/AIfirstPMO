/** The six beats of the Pages explainer, and their lengths. See `src/plan.ts`. */
import { plan, type Beat } from '../../plan';

const BEATS = [
  { id: 'open', frames: 96 },
  { id: 'editor', frames: 168 },
  { id: 'links', frames: 126 },
  { id: 'collab', frames: 150 },
  { id: 'comments', frames: 138 },
  { id: 'history', frames: 126 },
  { id: 'close', frames: 96 },
] as const satisfies readonly Beat<string>[];

export const { window, starts } = plan(BEATS, 'pages');
