/**
 * Carrying a notification to a browser, or a phone, that asked for one.
 *
 * Neither push carries the notification. A browser's service worker reads the
 * one it has just been told exists; the packaged app is woken through the
 * relay with a sentence that says only that something happened, and reads the
 * rest from here when it is opened. That keeps the contents on this server,
 * which is the whole reason both are bare wakes rather than messages.
 *
 * Registered rather than called from `notify.ts`: which channels exist is not
 * the notification's business.
 */
import { onNotification } from '../../modules/notifications/notify.ts';
import { wakeApp } from './app.ts';
import { notifyDevices } from './push.ts';

/** Hung off notifications by `wiring.ts`. */
export const installPushDelivery = (): void => onNotification(({ userId }) => {
  notifyDevices(userId);
  wakeApp(userId);
});
