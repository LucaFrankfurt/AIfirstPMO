/**
 * Support's housekeeping, on the hourly sweep.
 *
 * Here rather than in the support module, and the difference is rule 7: the
 * sweep is a port of the scheduler, a capability, and a capability filling
 * another capability's port is a direct import wearing a costume. The widget
 * adapter leans on both and is further out, so it is the one that hangs the
 * chores on — the shape `installTelegramChores` has.
 */
import { onSweep } from '../../modules/automation/scheduler.ts';
import { forgetOldCalls } from '../../modules/support/assistant.ts';
import { pruneEmptyConversations } from '../../modules/support/support.ts';

/** Hung off the sweep by `wiring.ts`. */
export function installSupportChores(): void {
  onSweep({ name: 'empty conversations', run: (now) => pruneEmptyConversations(now) });
  onSweep({ name: 'assistant days', run: (now) => forgetOldCalls(now) });
}
