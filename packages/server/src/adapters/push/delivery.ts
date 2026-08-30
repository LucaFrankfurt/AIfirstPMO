/**
 * Carrying a notification to a browser that asked for one.
 *
 * The push carries no payload — the service worker reads the notification it
 * has just been told exists. That keeps the contents on this server, which is
 * the whole reason it is a bare wake rather than a message.
 *
 * Registered rather than called from `notify.ts`: which channels exist is not
 * the notification's business.
 */
import { onNotification } from '../../modules/notifications/notify.ts';
import { notifyDevices } from './push.ts';

/** Hung off notifications by `wiring.ts`. */
export const installPushDelivery = (): void => onNotification(({ userId }) => notifyDevices(userId));
