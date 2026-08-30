/**
 * Writing a notification, in one place.
 *
 * A notification is not just a row: it is a row plus every channel that has to
 * hear about it. There were four copies of that INSERT and each one had to
 * remember to wake the subscribed devices afterwards — which is a thing that
 * gets forgotten exactly once, quietly, by whoever adds the fifth.
 *
 * So the delivery lives with the write. Add a channel here and every kind of
 * notification gets it, including the ones written next year.
 */
import { nextSeq, run } from '../../kernel/platform/db/index.ts';
import { uid } from '../../kernel/platform/ids.ts';
import { notifyDevices } from '../../adapters/push/push.ts';
import { deliverNotification } from '../../adapters/telegram/telegram.ts';

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

  // The push carries no payload — the service worker reads the notification it
  // has just been told exists. That keeps the contents on this server.
  notifyDevices(input.userId);

  // Telegram arrives immediately rather than in a digest, so it is sent here
  // rather than by a batching worker. Deliberately not awaited: somebody else's
  // chat service must never sit in the path of somebody's edit.
  void deliverNotification(id);

  return id;
}
