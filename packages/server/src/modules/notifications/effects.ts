/**
 * What is worth telling somebody about, once — decided here, not in the write
 * path.
 *
 * This used to be a function `repo.ts` called by name, which is how a write
 * path came to hold the rule about who hears when a comment lands on a task
 * they are subscribed to, and the one about a page autosaving while somebody
 * types. `repo` offers the moment now and knows nothing about who takes it.
 *
 * It registers on `onCommitted` rather than `onWrite` because a notification
 * reaches a phone and a rollback cannot take that back: inside a wrapped
 * transaction it waits for the commit. See `onCommitted` for the whole of that
 * argument.
 */
import { excerpt, type EntityName } from '@kolibri/shared';
import { all, get, type Row } from '../../kernel/platform/db/index.ts';
import { translatorFor } from '../../kernel/i18n/i18n.ts';

type Translator = ReturnType<typeof translatorFor>;
import {
  canSeeProject, displayName, findMentions, onCommitted, parseIds, writeEntity, type WriteOpts,
} from '../../kernel/write-path/repo.ts';
import { createNotification } from './notify.ts';

/**
 * Notification titles are written in the recipient's language, not the actor's:
 * a row belongs to exactly one person, so it can be rendered once, at the
 * moment it is created, and never needs translating again.
 */
function notify(entity: EntityName, row: Row, before: Row | undefined, changed: Record<string, unknown>, opts: WriteOpts): void {
  const targets = new Map<string, { kind: string; title: (t: Translator) => string; body: string | null; channelId?: string }>();

  if (entity === 'task' && changed.assignees !== undefined) {
    const now = parseIds(row.assignees);
    const previous = new Set(parseIds(before?.assignees));
    for (const userId of now) {
      if (previous.has(userId) || userId === opts.actorId) continue;
      targets.set(userId, {
        kind: 'assigned',
        title: (t) => t('notify.assigned', { identifier: row.identifier, title: row.title }),
        body: null,
      });
    }
  }

  // Where a mention can be written: a comment, a task's description, a page's
  // body. Anything else is a field nobody writes prose into.
  const mentionField = entity === 'comment' ? 'body' : entity === 'task' ? 'description' : entity === 'page' ? 'content' : null;
  const mentionSource = mentionField ? changed[mentionField] : undefined;
  if (mentionField && mentionSource !== undefined) {
    const context = entity === 'comment' ? commentContext(row) : row;
    // Only handles that were not there before. A page autosaves while you type,
    // so notifying on every write would ping the same person once a second for
    // a name they were already told about.
    const already = new Set(before ? findMentions(opts.workspaceId, String(before[mentionField] ?? '')) : []);
    for (const userId of findMentions(opts.workspaceId, String(mentionSource ?? ''))) {
      if (userId === opts.actorId || already.has(userId)) continue;
      targets.set(userId, {
        kind: 'mention',
        title: (t) => t('notify.mentionedIn', { context: context?.identifier ?? context?.title ?? 'Kolibri' }),
        body: String(mentionSource ?? '').slice(0, 280),
      });
    }
  }

  if (entity === 'comment' && !before && row.task_id) {
    const task = get<Row>(`SELECT * FROM tasks WHERE id = ?`, row.task_id);
    if (task) {
      const audience = new Set([...parseIds(task.assignees), ...parseIds(task.subscribers), task.created_by]);
      for (const userId of audience) {
        if (!userId || userId === opts.actorId) continue;
        if (targets.get(userId)?.kind === 'mention') continue; // a mention is the stronger signal
        targets.set(userId, {
          kind: 'comment',
          title: (t) => t('notify.newComment', { identifier: task.identifier }),
          body: String(row.body ?? '').slice(0, 280),
        });
      }
    }
  }

  // Somebody watching a page hears about a change to its body. Not about every
  // field: renaming a page or moving it between projects is bookkeeping, and a
  // notification for it teaches people to ignore the bell.
  if (entity === 'page' && before && changed.content !== undefined && String(before.content ?? '') !== String(row.content ?? '')) {
    for (const userId of parseIds(row.watchers)) {
      if (!userId || userId === opts.actorId) continue;
      if (targets.has(userId)) continue; // a mention in the same edit is the stronger signal
      targets.set(userId, {
        kind: 'page_changed',
        title: (t) => t('notify.pageChanged', { title: row.title }),
        body: null,
      });
    }
  }

  // A page has no assignees to fall back on, so its audience is the people who
  // have shown up: whoever wrote it, and whoever has said something on it.
  // Everybody who *can* see a page is the whole workspace, and notifying them
  // would teach people to ignore the bell.
  if (entity === 'comment' && !before && row.page_id) {
    const page = get<Row>(`SELECT id, title, created_by FROM pages WHERE id = ?`, row.page_id);
    if (page) {
      const talkers = all<Row>(
        `SELECT DISTINCT author_id FROM comments WHERE page_id = ? AND deleted_at IS NULL`,
        row.page_id,
      ).map((entry) => entry.author_id);
      for (const userId of new Set([page.created_by, ...talkers, ...parseIds(page.watchers)])) {
        if (!userId || userId === opts.actorId) continue;
        if (targets.get(userId)?.kind === 'mention') continue;
        targets.set(userId, {
          kind: 'comment',
          title: (t) => t('notify.newPageComment', { title: page.title }),
          body: String(row.body ?? '').slice(0, 280),
        });
      }
    }
  }

  // A message. The default is deliberately not "tell everyone about every
  // line": a channel that pings its whole membership on every message is a
  // channel people mute, and a muted channel tells nobody anything. So a
  // channel notifies whoever was *named*, plus whoever asked for all of it;
  // a direct message notifies the other person, because being written to
  // directly is exactly the case where silence would be wrong.
  if (entity === 'message' && !before && !row.deleted_at) {
    const channel = get<Row>(`SELECT * FROM channels WHERE id = ?`, row.channel_id);
    if (channel && !channel.deleted_at) {
      const direct = String(channel.kind) === 'direct';
      const named = new Set(findMentions(opts.workspaceId, String(row.body ?? '')));
      const audience = direct
        ? parseIds(channel.members)
        : [...new Set([...named, ...subscribersOf(String(channel.id))])];

      for (const userId of audience) {
        if (!userId || userId === opts.actorId) continue;
        if (notifyLevel(String(channel.id), userId, direct) === 'none') continue;
        if (!direct && !named.has(userId) && notifyLevel(String(channel.id), userId, direct) !== 'all') continue;
        targets.set(userId, {
          kind: 'message',
          title: (t) => (direct
            ? t('notify.directMessage', { name: displayName(opts.actorId) })
            : t('notify.message', { name: displayName(opts.actorId), channel: `#${channel.name}` })),
          // Through `excerpt` rather than sliced raw: a push notification
          // renders no markdown, and a phone buzzing with `**` and `](` reads
          // as a bug in exactly the moment the message was urgent enough to
          // buzz for.
          body: excerpt(String(row.body ?? ''), 280),
          // Without this the notification says something happened and then has
          // nowhere to take you, which is worse than not sending it.
          channelId: String(channel.id),
        });
      }
    }
  }

  if (entity === 'task' && !before && parseIds(row.assignees).length) {
    for (const userId of parseIds(row.assignees)) {
      if (userId === opts.actorId) continue;
      targets.set(userId, {
        kind: 'assigned',
        title: (t) => t('notify.assigned', { identifier: row.identifier, title: row.title }),
        body: null,
      });
    }
  }

  // A ballot is the one thing here that tells the whole workspace, and it is
  // written apart from the rest for that reason — see `announce`.
  if (entity === 'decision' || entity === 'decisionOption') {
    announce(String(entity === 'decision' ? row.id : row.decision_id), opts);
  }

  for (const [userId, payload] of targets) {
    createNotification({
      // A notification about a direct message has to reach somebody who may
      // not be in this workspace, so it belongs outside one exactly as the
      // conversation does. Everything else belongs where it happened.
      // `??` would be wrong here: null is the *answer* for a direct message,
      // not a missing value, and coalescing it would file the notification in
      // the sender's workspace where the other person cannot reach it.
      workspaceId: (row.workspace_id === undefined ? opts.workspaceId : row.workspace_id) as string | null,
      userId,
      kind: payload.kind,
      title: payload.title(translatorFor(userId)),
      body: payload.body,
      taskId: entity === 'task' ? row.id : row.task_id ?? null,
      pageId: entity === 'page' ? row.id : row.page_id ?? null,
      channelId: payload.channelId ?? null,
      actorId: opts.actorId,
    });
  }
}

/**
 * A new ballot tells everybody who may see it — once, and only once it can be
 * answered.
 *
 * This is the one rule in this file that notifies a whole workspace, and the
 * two paragraphs above arguing *against* exactly that are not being ignored.
 * They are about a page and a chat channel: things that change many times a
 * day, where telling everybody about each change is what teaches people to
 * ignore the bell. A ballot is the opposite shape. It happens once, it is a
 * question addressed to the room by construction, and a vote nobody was told
 * about collects no votes — which makes silence here not restraint but a
 * broken feature.
 *
 * **Once it can be answered**, not once it exists. A decision is created and
 * its options are written immediately afterwards, in separate writes: the web
 * form does it, and so does `create_decision` over MCP. Announcing on creation
 * would therefore send people to a question with nothing under it. So the test
 * is the state rather than the event — open, and with at least two options —
 * and `announced_at` is what keeps a third option from announcing it again.
 *
 * **Who** is every member who could open it, which is not the same as every
 * member: a decision taken in a private project would otherwise put its
 * question in the inbox of people who cannot see what it is about. Guests are
 * left out because they cannot vote at all, and a request for an answer
 * somebody is not allowed to give is worse than no notification.
 */
function announce(decisionId: string, opts: WriteOpts): void {
  if (!decisionId) return;
  const decision = get<Row>(`SELECT * FROM decisions WHERE id = ?`, decisionId);
  if (!decision || decision.deleted_at || decision.announced_at) return;
  // The status alone, not `isOpen`: a ballot with a deadline already behind it
  // is somebody typing dates rather than asking a question, and the people who
  // could not have answered it should not be told they failed to.
  if (String(decision.status) !== 'open') return;
  if (decision.closes_at !== null && Number(decision.closes_at) <= Date.now()) return;

  const options = all<Row>(
    `SELECT id FROM decision_options WHERE decision_id = ? AND deleted_at IS NULL`, decisionId,
  );
  if (options.length < 2) return;

  const audience = all<Row>(
    `SELECT user_id FROM workspace_members
      WHERE workspace_id = ? AND role <> 'guest' AND deleted_at IS NULL`,
    decision.workspace_id,
  );
  for (const member of audience) {
    const userId = String(member.user_id);
    if (userId === opts.actorId) continue;
    if (decision.project_id && !canSeeProject(userId, String(decision.project_id))) continue;
    createNotification({
      workspaceId: String(decision.workspace_id),
      userId,
      kind: 'decision',
      title: translatorFor(userId)('notify.decision', { question: String(decision.question) }),
      body: (decision.description as string | null) ?? null,
      projectId: (decision.project_id as string | null) ?? null,
      decisionId,
      actorId: opts.actorId,
    });
  }

  /*
   * Stamped even when the audience was empty — a workspace of one, or a private
   * project nobody else is on. "Nobody was told" is an answer, and leaving it
   * null would re-ask the question on every subsequent write to the ballot.
   *
   * Through the write path rather than an UPDATE, so the column reaches every
   * device the way anything else does. It re-enters this function once, finds
   * the stamp, and stops.
   */
  writeEntity('decision', decisionId, { announced_at: Date.now() }, {
    ...opts, op: undefined, system: true, silent: true,
  });
}

/** People who asked to hear about everything in this channel. */
const subscribersOf = (channelId: string): string[] =>
  all<Row>(
    `SELECT user_id FROM channel_reads WHERE channel_id = ? AND notify = 'all' AND deleted_at IS NULL`,
    channelId,
  ).map((row) => String(row.user_id));

/**
 * What one person wants from one conversation.
 *
 * No row means they have never opened it, which is not the same as having
 * opted out — so the answer is the default for that kind rather than silence.
 */
function notifyLevel(channelId: string, userId: string, direct: boolean): string {
  const row = get<Row>(
    `SELECT notify FROM channel_reads WHERE channel_id = ? AND user_id = ? AND deleted_at IS NULL`,
    channelId, userId,
  );
  return String(row?.notify ?? (direct ? 'all' : 'mentions'));
}

/** What a comment is about — a task or a page — for a notification title. */
function commentContext(row: Row): Row | undefined {
  if (row.task_id) return get<Row>(`SELECT identifier, title FROM tasks WHERE id = ?`, row.task_id);
  if (row.page_id) return get<Row>(`SELECT title FROM pages WHERE id = ?`, row.page_id);
  return undefined;
}

/** Hung off the write path by `wiring.ts`. */
export const installNotifications = (): void => onCommitted(notify);
