/**
 * A comment thread, on whatever it hangs off.
 *
 * `comment.page_id` has been in the schema and the sync protocol since the
 * first release; only tasks ever showed one, which made the wiki a shelf
 * rather than a place people talk. The thread is the same thread either way,
 * so it is the same component — the target is one field.
 *
 * A comment can be rewritten by whoever wrote it, which is the same affordance
 * a chat message has had and the same `edited_at` behind it: stamped by the
 * server, never claimed by a client. The thread is where a decision gets
 * recorded, and a typo in the sentence that records it had, until now, exactly
 * two remedies — delete and say it again, or leave it wrong.
 */
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../kernel/i18n/i18n';
import { relativeTime } from '../../kernel/design-system/format';
import { comment as postComment, remove, update } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useCanWrite, useMe, useMemberMap, useRunsWorkspace } from '../../kernel/identity/session';
import { anchorLabel, findAnchor, type Anchor } from '@kolibri/shared';
import { Markdown, MarkdownEditor } from '../pages/Markdown';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Avatar, Icon, useConfirm } from '../../kernel/design-system/ui';
import { Reactions, ReactionPicker } from './reactions';
import { useMinute } from '../../kernel/design-system/minute';

/** Exactly one of the two, which is also how the row is stored. */
export type CommentTarget = { task_id: string; page_id?: never } | { page_id: string; task_id?: never };

export function Comments({ target, empty, anchor, onAnchorDone, source, active, onPick }: {
  target: CommentTarget;
  empty?: string;
  /** A passage the next comment is about, set by selecting text on the page. */
  anchor?: Anchor | null;
  onAnchorDone?: () => void;
  /** The text the anchors are expressed against, for showing what is orphaned. */
  source?: string;
  active?: string | null;
  onPick?: (id: string) => void;
}) {
  useMinute(); // re-reads the ages below once a minute — `design-system/minute.ts`
  const t = useT();
  const me = useMe();
  const canWrite = useCanWrite();
  const members = useMemberMap();
  /**
   * Whether this person may take down a note left from outside.
   *
   * A note through a public share link has no account behind it, so "your own"
   * names nobody — and the server's answer is not "then anybody": it may be
   * rewritten by no one and deleted by an admin or owner, who can also revoke
   * the link it came through. That rule needs a button, or it is a rule only
   * reachable with `curl`.
   *
   * Asked through the hook rather than re-spelled as `role === …`, which is
   * what `useRunsWorkspace`'s own note is about.
   */
  const runsThis = useRunsWorkspace();
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState('');
  /** Which comment is open for editing, and the text as it stands. */
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const editor = useRef<HTMLDivElement>(null);

  // A selection jumps to the composer: the thing somebody does after choosing a
  // sentence is type about it, and hunting for the box is a step in the way.
  useEffect(() => {
    if (!anchor) return;
    editor.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    editor.current?.querySelector('textarea')?.focus();
  }, [anchor]);

  const key = target.task_id ?? target.page_id;

  // An open editor belongs to the thread it was opened in. The draft below
  // deliberately survives a trip to another page — somebody who typed it meant
  // to — but an edit box pointing at a comment that is no longer on screen is
  // just a box that reopens on the way back.
  useEffect(() => setEditing(null), [key]);

  const comments = useQuery(
    () => list('comment', (entry) => (target.task_id ? entry.task_id === target.task_id : entry.page_id === target.page_id))
      .sort((a, b) => a.created_at - b.created_at),
    [key],
  );

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    postComment(target, body, me, anchor ?? null);
    setDraft('');
    onAnchorDone?.();
  };

  /**
   * Commit an edit, or quietly drop one that changed nothing.
   *
   * An emptied body is *not* a delete. Deleting is a confirmed action one
   * button along, and clearing a field by accident — select all, type, undo
   * badly — should not be the unconfirmed way to reach it.
   */
  const saveEdit = () => {
    if (!editing) return;
    const body = editing.body.trim();
    const before = comments.find((entry) => entry.id === editing.id)?.body ?? '';
    if (body && body !== before) update('comment', editing.id, { body });
    setEditing(null);
  };

  return (
    <>
      {comments.length === 0 && empty && <p className="text-muted text-[12.5px]">{empty}</p>}
      {comments.map((entry) => {
        const author = members.get(entry.author_id);
        // A note left through a public link has no account behind it. The name
        // is whatever was typed into a box, so it is shown as exactly that
        // rather than sitting in the row looking like a colleague.
        const guest = !entry.author_id && entry.guest_name !== undefined;
        return (
          <div className="comment" key={entry.id}>
            <Avatar user={guest ? undefined : author} size={26} />
            <div className="body">
              <div className="flex items-center gap-1.5">
                <span className="who">
                  {guest ? (entry.guest_name || t('comment.anonymous')) : (author?.name ?? t('common.someone'))}
                </span>
                {guest && <Chip>{t('comment.fromOutside')}</Chip>}
                <span className="when">{relativeTime(entry.created_at)}</span>
                {/* Only that it was, not when: a second timestamp beside the
                    first reads as two comments, and what anybody actually
                    wants to know is whether these are still the words that
                    were replied to. */}
                {entry.edited_at && <span className="when">· {t('comment.edited')}</span>}
                {(entry.author_id === me || (guest && runsThis)) && (
                  <span className="flex items-center gap-0.5" style={{ marginInlineStart: 'auto' }}>
                    {/* No pencil on a guest's note, whoever is looking: there is
                        no author to be, and putting words in a stranger's mouth
                        under the name they typed is worse than leaving it. */}
                    {entry.author_id === me && (
                      <Button variant="ghost" size="sm"
                        aria-label={t('comment.edit')}
                        title={t('comment.edit')}
                        onClick={() => setEditing({ id: entry.id, body: entry.body })}
                      >
                        <Icon name="pencil" size={13} />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm"
                      aria-label={t('task.deleteCommentLabel')}
                      onClick={async () => {
                        if (await confirm(t('task.deleteComment'))) remove('comment', entry.id);
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </Button>
                  </span>
                )}
              </div>
              {entry.anchor?.quote && (
                <button
                  className={`quoted${findAnchor(source ?? '', entry.anchor) ? '' : ' orphan'}`}
                  onClick={() => onPick?.(entry.id)}
                  title={findAnchor(source ?? '', entry.anchor) ? t('annotate.jump') : t('annotate.orphanHint')}
                >
                  <Icon name="link" size={11} /> {anchorLabel(entry.anchor)}
                  {source !== undefined && !findAnchor(source, entry.anchor) && (
                    <em> · {t('annotate.orphan')}</em>
                  )}
                </button>
              )}
              {editing?.id === entry.id ? (
                <div className="mt-1.5">
                  {/* The same editor the composer uses, so an edit is typed
                      the way the comment was — `@` menus, attachments and all. */}
                  <MarkdownEditor
                    value={editing.body}
                    onChange={(body) => setEditing({ id: entry.id, body })}
                    minHeight={70}
                    autoFocus
                    attachTo={target}
                    onSubmit={saveEdit}
                  />
                  <div className="flex items-center gap-2 mt-2" style={{ justifyContent: 'flex-end' }}>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>{t('action.cancel')}</Button>
                    <Button variant="primary" size="sm" disabled={!editing.body.trim()} onClick={saveEdit}>
                      <Icon name="check" size={14} /> {t('action.save')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Markdown source={entry.body} />
              )}
              <Reactions kind="comment" id={entry.id} reactions={entry.reactions} canWrite={canWrite}>
                {canWrite && (
                  <ReactionPicker kind="comment" id={entry.id} reactions={entry.reactions} align="start">
                    <button className="reaction add" aria-label={t('task.react')} title={t('task.react')}>
                      <Icon name="plus" size={12} />
                    </button>
                  </ReactionPicker>
                )}
              </Reactions>
            </div>
          </div>
        );
      })}
      <div className="mt-2.5" ref={editor}>
        {anchor && (
          <div className="flex items-center gap-2 quoted-draft">
            <Icon name="link" size={12} />
            <span className="flex-1 min-w-0 truncate">{anchorLabel(anchor)}</span>
            <Button variant="ghost" size="iconSm" aria-label={t('annotate.clear')} onClick={() => onAnchorDone?.()}>
              <Icon name="close" size={12} />
            </Button>
          </div>
        )}
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          minHeight={70}
          placeholder={t('task.commentPlaceholder')}
          attachTo={target}
          onSubmit={send}
        />
        <div className="flex items-center gap-2 mt-2" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={send}>
            <Icon name="send" size={14} /> {t('task.comment')}
          </Button>
        </div>
      </div>
      {dialog}
    </>
  );
}
