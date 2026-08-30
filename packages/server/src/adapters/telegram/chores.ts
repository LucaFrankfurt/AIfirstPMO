/**
 * The bot's housekeeping, on the hourly sweep.
 *
 * Messages that failed on the way out get another go, and link codes nobody
 * used are dropped. The retry is fire-and-forget on purpose: an unreachable
 * chat service is not a reason for the sweep to report a failure. Expiring
 * codes is a database write and is counted.
 *
 * Registered rather than called from the scheduler, which has no business
 * knowing this adapter exists.
 */
import { onSweep } from '../../modules/automation/scheduler.ts';
import { expireLinks, retryPending } from './telegram.ts';

/** Hung off the sweep by `wiring.ts`. */
export function installTelegramChores(): void {
  onSweep({ run: (now) => void retryPending(now) });
  onSweep({ name: 'codes', run: (now) => expireLinks(now) });
}
