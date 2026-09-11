/**
 * One clock tick a minute, for everything on screen that says "3 minutes ago".
 *
 * A relative time is worked out once, while the component renders, and then
 * never again — so a screen left open goes on saying "gerade eben" about
 * something an hour old, and a notification list read after lunch is a column
 * of confident lies. The conversation view had this fixed for its own messages;
 * every other screen in the app had the same bug and no ticker, which is the
 * half of "zuletzt geändert" that measuring the server's clock did not touch.
 *
 * This is that ticker, moved down to where all of them can reach it. One
 * interval for the whole app rather than one per screen or one per label, and
 * it only exists while something is subscribed — a workspace with no ages on
 * screen has no timer running.
 *
 * Whoever renders an age calls `useMinute()` once, at the top of the component,
 * and ignores the value; the subscription is the point. `packages/web/test/
 * stale-labels.test.ts` holds every such file to it, because the failure is
 * invisible — the label is not wrong when it is drawn, only afterwards, and
 * nobody reviews a screen by leaving it open for an hour.
 */
import { useSyncExternalStore } from 'react';
import { now } from '../sync/clock';

const minute = {
  at: 0,
  listeners: new Set<() => void>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
};

function tick(): void {
  minute.at = now();
  for (const each of minute.listeners) each();
}

function subscribeMinute(listener: () => void): () => void {
  minute.listeners.add(listener);
  minute.timer ??= setInterval(tick, 60_000);
  return () => {
    minute.listeners.delete(listener);
    if (!minute.listeners.size) {
      clearInterval(minute.timer);
      minute.timer = undefined;
    }
  };
}

/*
 * A backgrounded tab is the case where this matters most and works least: every
 * browser throttles timers in one, so the interval that should have fired
 * twenty times over lunch fired once or not at all. Coming back to the tab is
 * the moment the ages on it are furthest out of date and the moment somebody is
 * about to read them, so that is a tick of its own.
 */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && minute.listeners.size) tick();
  });
}

/**
 * Re-render this component once a minute, so the ages in it stay true.
 *
 * The number is this device's reading of the server's clock at the last tick —
 * usable where a component wants a "now", and ignorable where it only wanted
 * the re-render.
 */
export const useMinute = (): number => useSyncExternalStore(subscribeMinute, () => minute.at, () => 0);
