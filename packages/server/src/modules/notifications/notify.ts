/**
 * Writing a notification, in one place.
 *
 * A notification is not just a row: it is a row plus every channel that has to
 * hear about it. There were four copies of that INSERT and each one had to
 * remember to wake the subscribed devices afterwards — which is a thing that
 * gets forgotten exactly once, quietly, by whoever adds the fifth.
 *
 * So the delivery lives with the write. Register a channel and every kind of
 * notification gets it, including the ones written next year.
 *
 * Registered, not called by name: a browser subscription and a chat bot are two
 * adapters, and *which* channels exist is not this module's business. It knows
 * one row was written, for this person, and says so.
 */
import { nextSeq, run } from '../../kernel/platform/db/index.ts';
import { uid } from '../../kernel/platform/ids.ts';


export interface NewNotification {
  /** Null for something that happened outside any workspace — a direct message. */
  workspaceId: string | null;
  userId: string;
  kind: string;
  /** Already rendered in the recipient's language — see `i18n.ts`. */
  title: string;
  body?: string | null;
  taskId?: string | null;
  pageId?: string | null;
  projectId?: string | null;
  channelId?: string | null;
  actorId?: string | null;
}

/**
 * Somewhere a notification is carried to.
 *
 * Deliberately given the id and the recipient and nothing else: a channel that
 * needs the title reads the row it has just been told about, which keeps one
 * copy of what a notification says.
 */
export type Delivery = (notification: { id: string; userId: string }) => void;

const carriers: Delivery[] = [];

/** @port a channel a notification is carried on */
export function onNotification(deliver: Delivery): void {
  if (!carriers.includes(deliver)) carriers.push(deliver);
}

/** For a test that wants the row written and nothing carried. */
export function clearDeliveries(): void {
  carriers.length = 0;
}

/** Write one, and tell everything that carries it. Returns the row's id. */
export function createNotification(input: NewNotification): string {
  const id = uid();
  const now = Date.now();
  run(
    `INSERT INTO notifications
       (id, workspace_id, user_id, kind, title, body, task_id, page_id, project_id, channel_id, actor_id,
        created_at, updated_at, seq, clocks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    id, input.workspaceId, input.userId, input.kind, input.title, input.body ?? null,
    input.taskId ?? null, input.pageId ?? null, input.projectId ?? null, input.channelId ?? null,
    input.actorId ?? null,
    now, now, nextSeq(),
  );

  // None of them may sit in the path of somebody's edit — see each carrier for
  // how it makes sure of that.
  for (const carry of carriers) carry({ id, userId: input.userId });

  return id;
}
