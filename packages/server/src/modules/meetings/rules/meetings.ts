/**
 * The rules a meeting and its agenda live by.
 *
 * Most of a meeting is ordinary rows written by whoever is in the room, and
 * the write path's last-writer-wins is right for all of it but one column. The
 * four things here are the ones a client cannot be trusted to get right for
 * everybody:
 *
 * **The notes are a merge.** An agenda point's `notes_body` is a text CRDT and
 * `notes` is what it reads as — derived here, never taken from the client,
 * through the same function a page's body goes through. Two people typing the
 * minutes of one point at once both keep their sentences.
 *
 * **A point belongs to a meeting that is there.** Adding a topic to a meeting
 * that has been deleted is refused rather than stored: the sync filter would
 * send the row to nobody, and the person who added it would be told it was
 * saved.
 *
 * **What a point names is in this workspace.** `projects`, `attendees` and
 * `assignees` are lists, which the write path's reference check does not read,
 * so they are narrowed here to rows that exist where the meeting is. The two
 * lists of people take members and not guests: a guest is never sent a
 * meeting, so expecting one at it, or making one responsible for a point on
 * it, names somebody who cannot open the screen their name is on.
 *
 * **Deleting a meeting takes its agenda, and restoring it brings it back.**
 * The second half is the one a decision does not have yet, and the reason it
 * is here: a meeting restored from the trash with an empty agenda is a meeting
 * whose minutes are gone, which is the opposite of what the restore button
 * promised.
 */

import { AGENDA_STATUS, MEETING_STATUS } from '@kolibri/shared';
import { all, get, type Row } from '../../../kernel/platform/db/index.ts';
import { badRequest } from '../../../kernel/platform/http.ts';
import { type EntityRule, writeEntity, type WriteOpts } from '../../../kernel/write-path/repo.ts';
import { settleCrdtText } from '../../pages/rules/pages.ts';

const NOTES = { state: 'notes_body', text: 'notes' } as const;

const meetingRow = (id: unknown): Row | undefined =>
  (id ? get<Row>(`SELECT id, workspace_id, deleted_at FROM meetings WHERE id = ?`, String(id)) : undefined);

/** A JSON list column as it arrives at an invariant: already a string, or not yet. */
function idsIn(raw: unknown): string[] | null {
  if (raw === undefined) return null;
  if (raw === null) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? [...new Set(parsed.map(String).filter(Boolean))] : [];
  } catch {
    return [];
  }
}

/**
 * Keep only the ids that name a live row of `table` in this workspace.
 *
 * Narrowed rather than refused, because these lists arrive in sync batches
 * from devices that have been away: a project deleted since somebody tagged a
 * point with it is not a reason to lose the rest of their edit.
 */
function narrow(
  values: Record<string, unknown>,
  forced: Record<string, unknown>,
  field: string,
  ids: string[] | null,
  exists: (id: string) => boolean,
): void {
  if (ids === null) return;
  const kept = ids.filter(exists);
  values[field] = JSON.stringify(kept);
  forced[field] = kept;
}

/** Somebody who is sent meetings at all: in the workspace, and not as a guest. */
const isMember = (workspaceId: string, userId: string): boolean => !!get(
  `SELECT 1 FROM workspace_members
    WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL AND role IN ('owner', 'admin', 'member')`,
  workspaceId, userId,
);

function applyMeetingInvariants(
  entity: string,
  values: Record<string, unknown>,
  existing: Row | undefined,
  forced: Record<string, unknown>,
  workspaceId: string,
): void {
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };
  const oneOf = (field: string, allowed: readonly string[], fallback: string) => {
    if (values[field] === undefined) return;
    if (!allowed.includes(String(values[field] ?? ''))) settle(field, fallback);
  };

  if (entity === 'meeting') {
    oneOf('status', MEETING_STATUS, 'planned');
    if (values.starts_at !== undefined && values.starts_at !== null) {
      const at = Math.round(Number(values.starts_at));
      // Null rather than zero for a time that is not a number: zero is a real
      // instant in 1970, and a meeting there sorts first on every list.
      settle('starts_at', Number.isFinite(at) && at > 0 ? at : null);
    }
    narrow(values, forced, 'attendees', idsIn(values.attendees), (id) => isMember(workspaceId, id));
  }

  if (entity === 'agendaItem') {
    oneOf('status', AGENDA_STATUS, 'open');
    narrow(values, forced, 'projects', idsIn(values.projects), (id) => !!get(
      `SELECT 1 FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, id, workspaceId,
    ));
    narrow(values, forced, 'assignees', idsIn(values.assignees), (id) => isMember(workspaceId, id));
    settleCrdtText(values, existing, forced, NOTES);
  }
}

/** A point is added to a meeting that exists, or it is not added. */
function guardAgendaItem(values: Record<string, unknown>, existing: Row | undefined): void {
  if (values.meeting_id === undefined && existing) return;
  const meeting = meetingRow(values.meeting_id ?? existing?.meeting_id);
  if (!meeting || meeting.deleted_at) throw badRequest('That meeting is not here');
}

const system = (opts: WriteOpts): WriteOpts => ({ ...opts, op: undefined, system: true, silent: true });

/** Deleting a meeting takes every point on its agenda. */
function tombstoneAgenda(meeting: Row, opts: WriteOpts): void {
  for (const row of all<Row>(`SELECT id FROM agenda_items WHERE meeting_id = ? AND deleted_at IS NULL`, String(meeting.id))) {
    writeEntity('agendaItem', String(row.id), {}, { ...system(opts), op: 'delete' });
  }
}

/**
 * Restoring a meeting brings back the points that went with it — and only
 * those.
 *
 * "Went with it" is every point deleted at or after the moment the meeting
 * was. A point somebody removed from the agenda the week before is not part of
 * the meeting being restored, and putting it back would undo a decision that
 * had nothing to do with the trash.
 */
function restoreAgenda(meeting: Row, deletedAt: number, opts: WriteOpts): void {
  for (const row of all<Row>(
    `SELECT id FROM agenda_items WHERE meeting_id = ? AND deleted_at IS NOT NULL AND deleted_at >= ?`,
    String(meeting.id), deletedAt,
  )) {
    writeEntity('agendaItem', String(row.id), {}, system(opts));
  }
}

export const meetingRules = {
  entities: ['meeting', 'agendaItem'],
  defaults(entity, id, values, opts, setForced) {
    // Who called the meeting, and who brought the topic. Neither is the
    // client's to claim — "everybody can add a topic" is only worth having if
    // the agenda says truthfully who did.
    if (!values.created_by) setForced('created_by', opts.actorId);
    if (entity === 'meeting') {
      if (!values.title) setForced('title', 'Meeting');
      if (!values.status) setForced('status', 'planned');
    }
    if (entity === 'agendaItem') {
      if (!values.title) setForced('title', 'Untitled topic');
      if (!values.status) setForced('status', 'open');
      // A topic carried forward was still brought by whoever raised it, not by
      // whoever pressed the button at the end of the meeting.
      const source = values.carried_from
        ? get<Row>(`SELECT created_by FROM agenda_items WHERE id = ? AND workspace_id = ?`, String(values.carried_from), opts.workspaceId)
        : undefined;
      if (source?.created_by) setForced('created_by', source.created_by);
    }
  },
  guards(entity, id, values, existing) {
    if (entity === 'agendaItem') guardAgendaItem(values, existing);
  },
  invariants(entity, id, values, existing, forced, opts) {
    applyMeetingInvariants(entity, values, existing, forced, opts.workspaceId);
  },
  effects(entity, row, before, changed, opts) {
    if (entity !== 'meeting') return;
    if (row.deleted_at && !before?.deleted_at) tombstoneAgenda(row, opts);
    if (!row.deleted_at && before?.deleted_at) restoreAgenda(row, Number(before.deleted_at), opts);
  },
} satisfies EntityRule;
