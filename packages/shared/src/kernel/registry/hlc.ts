/**
 * Hybrid Logical Clock.
 *
 * Every mutation carries an HLC stamp. The server merges concurrent writes
 * field-by-field with last-writer-wins, ordered by the stamp — so two people
 * editing different fields of the same task while offline both keep their edit.
 *
 * Wire format: `<millis base36, 11 chars>-<counter base36, 4 chars>-<nodeId>`
 * which sorts correctly as a plain string.
 */

export type HLC = string;

/**
 * The header a server's answer carries its own `Date.now()` in.
 *
 * Named here because the two sides have to spell it the same way, and because
 * it is the same problem this file is about from the other end: an HLC keeps
 * *writes* in order across machines that disagree about the time, and this
 * keeps what a person *reads* in order with them. A client that does not
 * measure the difference shows it on every relative timestamp at once.
 */
export const CLOCK_HEADER = 'x-kolibri-now';

const pad = (n: number, len: number) => n.toString(36).padStart(len, '0');

export class Clock {
  nodeId: string;
  private millis = 0;
  private counter = 0;
  private wallClock: () => number;

  /**
   * `wallClock` is how this device reads the shared timeline, and it is a
   * parameter because a browser's own clock is not it. A device five minutes
   * fast stamps every write five minutes into the future, and last-writer-wins
   * then means *that* device always wins — for as long as its clock stays
   * wrong, which `observe` cannot walk back. The client passes the offset one
   * (see `web/src/kernel/sync/clock.ts`); the server is the timeline.
   */
  constructor(nodeId: string, wallClock: () => number = Date.now) {
    this.nodeId = nodeId;
    this.wallClock = wallClock;
  }

  /** Stamp for a locally originated event. */
  now(): HLC {
    const wall = this.wallClock();
    if (wall > this.millis) {
      this.millis = wall;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return `${pad(this.millis, 11)}-${pad(this.counter, 4)}-${this.nodeId}`;
  }

  /** Observe a remote stamp so our clock never falls behind the cluster. */
  observe(remote: HLC): void {
    const parsed = parse(remote);
    if (!parsed) return;
    const wall = this.wallClock();
    if (parsed.millis > this.millis) {
      this.millis = parsed.millis;
      this.counter = parsed.counter;
    } else if (parsed.millis === this.millis) {
      this.counter = Math.max(this.counter, parsed.counter);
    }
    if (wall > this.millis) {
      this.millis = wall;
      this.counter = 0;
    }
  }
}

export function parse(hlc: HLC): { millis: number; counter: number; nodeId: string } | null {
  const parts = hlc.split('-');
  if (parts.length < 3) return null;
  const millis = parseInt(parts[0], 36);
  const counter = parseInt(parts[1], 36);
  if (Number.isNaN(millis) || Number.isNaN(counter)) return null;
  return { millis, counter, nodeId: parts.slice(2).join('-') };
}

/** `a` wins over `b`? Plain lexicographic order is the HLC order. */
export function gt(a: HLC | undefined, b: HLC | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return a > b;
}

export function timestampOf(hlc: HLC): number {
  return parse(hlc)?.millis ?? 0;
}
