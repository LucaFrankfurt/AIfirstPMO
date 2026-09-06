/** The six beats of the Sign-up explainer, and their lengths. See `src/plan.ts`. */
import { plan, type Beat } from '../../plan';

const BEATS = [
  { id: 'open', frames: 96 },
  { id: 'account', frames: 150 },
  { id: 'invite', frames: 132 },
  { id: 'sso', frames: 126 },
  { id: 'twoFactor', frames: 144 },
  { id: 'sessions', frames: 156 },
  { id: 'close', frames: 96 },
] as const satisfies readonly Beat<string>[];

export const { window, starts } = plan(BEATS, 'signup');
