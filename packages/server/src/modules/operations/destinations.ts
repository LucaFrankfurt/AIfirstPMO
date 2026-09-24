/**
 * Where a snapshot goes once it has been taken and has opened.
 *
 * A directory is the one place `backups.ts` writes to itself, because a path
 * is a path. A bucket is a provider and an inbox is a transport, and choosing
 * either is exactly what a capability may not do: this module used to reach
 * for the S3 client by name, for the one bucket it knew, and for the storage
 * layer after that — which is also why the only bucket it could ever write to
 * was the one the uploads already lived in. It offers this instead, and each
 * adapter says what it can do: `adapters/s3` a bucket of its own, which can be
 * read back from, and `adapters/mail` an address, which cannot.
 *
 * Nothing here opens a database, on purpose. `backends.ts` installs the
 * adapters that fill this, the CLI installs `backends.ts` before it has read
 * its arguments, and `kolibri restore` must find the database closed. The
 * `Manifest` below is a type, and a type is erased.
 */
import type { Manifest } from './maintenance.ts';

export type DestinationKind = 's3' | 'email';

/**
 * Names we are willing to touch: the day a snapshot covers, or the day and the
 * second for one taken on purpose.
 *
 * Here rather than beside `take`, because a destination that lists what it
 * holds has to filter by the same rule — a bucket is shared with whatever else
 * somebody keeps in it, and a name that is not one of ours is not ours to offer
 * as a restore.
 */
export const SAFE_NAME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]{6})?$/;

/** One uploaded file, as the snapshot's own `files` table has it. */
export interface SnapshotFile {
  /** The storage key, which is the same in every backend. */
  key: string;
  mime: string;
  size: number;
  /** Which backend the row says holds the bytes. */
  storage: 'disk' | 's3';
  /** Its copy inside the snapshot directory, when the snapshot carries its uploads. */
  local: string | null;
}

/** A snapshot that has been taken and has opened: what a destination is handed. */
export interface Outgoing {
  /** `2026-08-26`, or `2026-08-26-031502` for one taken on purpose. */
  name: string;
  /** Holds `kolibri.sqlite` and `manifest.json`, and `uploads/` when it carries them. */
  dir: string;
  manifest: Manifest;
  /** Every file the snapshot's rows refer to, whether or not `dir` carries the bytes. */
  files: SnapshotFile[];
}

/** How one delivery went, in a sentence somebody can act on. */
export interface Delivery {
  kind: DestinationKind;
  ok: boolean;
  detail: string;
  bytes?: number;
}

export interface DestinationState {
  /** Enough is set to try. */
  configured: boolean;
  /** Where, in one line — a bucket and its host, an address. Empty when nothing is set. */
  where: string;
  /** Set up halfway, and what is missing. Said, rather than quietly off. */
  problem?: string;
}

export interface Destination {
  kind: DestinationKind;
  state(): DestinationState;
  /**
   * Send it. Returns a sentence when it arrived and throws one when it did not.
   *
   * `earlier` is how the others went tonight, in order. An inbox is the one
   * place somebody reads, so it is where a bucket that refused the night's copy
   * gets mentioned.
   */
  send(snapshot: Outgoing, earlier: Delivery[]): Promise<{ detail: string; bytes: number }>;
  /** Try the configuration without a snapshot, and say where it went. */
  test(): Promise<string>;
  /** Tell whoever is at the other end that tonight's did not happen at all. */
  failed?(problem: string, at: Date): Promise<void>;
  /** The snapshots it holds, newest first — for a destination that can be read back. */
  list?(): Promise<string[]>;
  /**
   * One of those, written into `into` as `kolibri.sqlite` and `manifest.json`.
   * False when it holds no snapshot by that name.
   */
  fetch?(name: string, into: string): Promise<boolean>;
  /** An uploaded file's bytes by storage key, or null when it does not hold them. */
  blob?(key: string): Promise<Buffer | null>;
}

const registered = new Map<DestinationKind, Destination>();

/**
 * Offer a place a snapshot can go. `backends.ts` installs the ones this build has.
 *
 * In the order they are installed, which is the order they are sent to: the
 * bucket before the inbox, so the email can say where the files went.
 */
/** @port a place a snapshot is sent */
export function registerDestination(destination: Destination): void {
  registered.set(destination.kind, destination);
}

/** Every destination this build has, configured or not. */
export const destinations = (): Destination[] => [...registered.values()];

/** The ones with enough configuration to try. */
export const configured = (): Destination[] => destinations().filter((destination) => destination.state().configured);
