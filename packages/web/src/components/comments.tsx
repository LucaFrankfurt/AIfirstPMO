/**
 * A comment thread, on whatever it hangs off.
 *
 * `comment.page_id` has been in the schema and the sync protocol since the
 * first release; only tasks ever showed one, which made the wiki a shelf
 * rather than a place people talk. The thread is the same thread either way,
 * so it is the same component — the target is one field.
 */
import { useState } from 'react';
import { useT } from '../lib/i18n';
import { relativeTime } from '../lib/format';
import { comment as postComment, remove } from '../lib/mutations';
import { list, useQuery } from '../lib/store';
import { useMe, useMemberMap } from '../session';
import { Markdown, MarkdownEditor } from './Markdown';
import { Avatar, Icon, useConfirm } from './ui';

/** Exactly one of the two, which is also how the row is stored. */
export type CommentTarget = { task_id: string; page_id?: never } | { page_id: string; task_id?: never };

export function Comments({ target, empty }: { target: CommentTarget; empty?: string }) {
  const t = useT();
  const me = useMe();
  const members = useMemberMap();
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState('');

  const key = target.task_id ?? target.page_id;
  const comments = useQuery(
    () => list('comment', (entry) => (target.task_id ? entry.task_id === target.task_id : entry.page_id === target.page_id))
      .sort((a, b) => a.created_at - b.created_at),
    [key],
  );

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    postComment(target, body, me);
    setDraft('');
  };

  return (
    <>
      {comments.length === 0 && empty && <p className="muted" style={{ fontSize: 12.5 }}>{empty}</p>}
      {comments.map((entry) => {
        const author = members.get(entry.author_id);
        return (
          <div className="comment" key={entry.id}>
            <Avatar user={author} size={26} />
            <div className="body">
              <div className="row" style={{ gap: 6 }}>
                <span className="who">{author?.name ?? t('common.someone')}</span>
                <span className="when">{relativeTime(entry.created_at)}</span>
                {entry.author_id === me && (
                  <button
                    className="btn ghost sm"
                    style={{ marginInlineStart: 'auto' }}
                    aria-label={t('task.deleteCommentLabel')}
                    onClick={async () => {
                      if (await confirm(t('task.deleteComment'))) remove('comment', entry.id);
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
              <Markdown source={entry.body} />
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 10 }}>
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          minHeight={70}
          placeholder={t('task.commentPlaceholder')}
          attachTo={target}
          onSubmit={send}
        />
        <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
          <button className="btn primary sm" disabled={!draft.trim()} onClick={send}>
            <Icon name="send" size={14} /> {t('task.comment')}
          </button>
        </div>
      </div>
      {dialog}
    </>
  );
}
