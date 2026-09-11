/**
 * What time it is, in the workspace's terms rather than this device's.
 *
 * Every instant Kolibri stores is stamped by the server — `updated_at`,
 * `created_at`, an activity line, a notification — and the browser was reading
 * them against its own clock. So a task saved one second ago read "geändert vor
 * 5 Minuten", and so did everything else on the screen: the two machines
 * disagreed by five minutes, and every relative time in the app inherited the
 * difference at once. It looks like a formatting bug and is not one; it is two
 * clocks, and no amount of rounding in `relativeTime` can fix it.
 *
 * Which of the two is *wrong* cannot be known from here and does not matter. A
 * container whose host suspended, a laptop nobody has pointed at NTP, a phone
 * that came back from a flight — any of them produces the same reading. What
 * matters is that one of the clocks is the one every row is stamped on, and it
 * is the server's: it is the only one all the devices in a workspace share.
 *
 * So this measures the difference rather than assuming it away. Every JSON
 * response carries the server's own `Date.now()` in `x-kolibri-now`, and
 * `api.ts` hands it here along with the two moments the request left and its
 * answer arrived. The server sampled its clock somewhere between those two, so
 * the midpoint is the best guess available and the error is at most half the
 * round trip — milliseconds, against labels that speak in minutes.
 *
 * Everything that asks "how long ago was that?" or stamps a row this device
 * invented goes through `now()`. Absolute times deliberately do not: "14:32"
 * and "Tuesday" are read off the wall behind the person reading them, and that
 * wall is this device's clock.
 */

const KEY = 'kolibri.clock';

export interface Sample {
  /** Milliseconds to add to this device's clock to get the server's. */
  offset: number;
  /** The round trip it was measured over — the bound on how wrong it can be. */
  rtt: number;
  /** When it was taken, on this device's clock. */
  at: number;
}

/*
 * Reading storage can throw outright — Safari in private mode, a container with
 * site data blocked — and this module is imported by the formatter, so a throw
 * here would be a blank page rather than a wrong timestamp.
 */
const remembered = (): number => {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
};

/**
 * The offset survives a restart on purpose.
 *
 * An app that starts offline — the case this whole package is built for — has
 * no response to measure and would otherwise fall back to the device clock,
 * which is exactly the clock in question. The remembered offset is a guess
 * about a machine that is not answering; the first response corrects it.
 */
let offset = remembered();
let sample: Sample | null = null;

/** Now, on the clock the rows are stamped on. */
export const now = (): number => Date.now() + offset;

/** How far this device's clock is from the server's, in milliseconds. */
export const clockOffset = (): number => offset;

/**
 * The difference at which it is worth telling somebody, in milliseconds.
 *
 * Not a tolerance: the offset is applied however small it is, and a hundred
 * milliseconds is corrected as surely as five minutes. It is the point below
 * which a difference cannot change a word on screen — the coarsest thing any
 * label says is "vor 1 Minute" — so under it there is nothing to report, and
 * over it is precisely what somebody used to report as a bug. The sync pill's
 * tooltip in `design-system/chrome.tsx` is where it is said.
 */
export const NOTICEABLE = 60_000;

/** The last measurement, or null if nothing has been measured this session. */
export const lastSample = (): Sample | null => sample;

/**
 * Take a reading from one request/response pair.
 *
 * The newest reading wins rather than the most precise one: a server that
 * corrects its own clock mid-session has to be followed, and a best-ever sample
 * kept from an hour ago would pin the app to a time that has been abandoned.
 * The requests that carry a file are the only ones whose round trip is long
 * enough for the midpoint to be a poor guess, and `api.ts` leaves those out.
 */
export function observeServerTime(serverNow: number, sentAt: number, receivedAt: number): void {
  if (!Number.isFinite(serverNow) || serverNow <= 0 || receivedAt < sentAt) return;
  offset = Math.round(serverNow - (sentAt + receivedAt) / 2);
  sample = { offset, rtt: receivedAt - sentAt, at: receivedAt };
  try {
    localStorage.setItem(KEY, String(offset));
  } catch {
    /* Nothing to do about it, and nothing that should stop a request. */
  }
}
