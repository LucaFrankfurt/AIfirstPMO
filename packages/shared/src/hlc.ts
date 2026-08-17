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

const pad = (n: number, len: number) => n.toString(36).padStart(len, '0');

export class Clock {
  nodeId: string;
  private millis = 0;
  private counter = 0;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  /** Stamp for a locally originated event. */
  now(): HLC {
    const wall = Date.now();
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
    const wall = Date.now();
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
