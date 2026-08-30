/**
 * Carrying a notification to a chat window.
 *
 * Telegram arrives immediately rather than in a digest, so it goes out as the
 * row is written rather than from a batching worker. Deliberately not awaited:
 * somebody else's chat service must never sit in the path of somebody's edit.
 *
 * Registered rather than called from `notify.ts`: which channels exist is not
 * the notification's business.
 */
import { onNotification } from '../../modules/notifications/notify.ts';
import { deliverNotification } from './telegram.ts';

/** Hung off notifications by `wiring.ts`. */
export const installTelegramDelivery = (): void => onNotification(({ id }) => void deliverNotification(id));
