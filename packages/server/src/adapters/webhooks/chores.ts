/**
 * Outgoing calls, on the hourly sweep.
 *
 * A delivery waiting on its backoff is picked up by an in-process timer, and by
 * this sweep if the process was restarted in the middle of one. Fire-and-forget:
 * somebody else's endpoint being down is not the sweep failing. Pruning the log
 * is a database write and could be counted; it is not, because nobody reads it.
 *
 * Registered rather than called from the scheduler, which has no business
 * knowing this adapter exists.
 */
import { onSweep } from '../../modules/automation/scheduler.ts';
import { flushDeliveries, pruneDeliveries } from './webhooks.ts';

/** Hung off the sweep by `wiring.ts`. */
export function installWebhookChores(): void {
  onSweep({ run: (now) => void flushDeliveries(now) });
  onSweep({ run: (now) => pruneDeliveries(now) });
}
