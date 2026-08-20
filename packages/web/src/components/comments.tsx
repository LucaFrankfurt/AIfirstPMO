/**
 * A comment thread, on whatever it hangs off.
 *
 * `comment.page_id` has been in the schema and the sync protocol since the
 * first release; only tasks ever showed one, which made the wiki a shelf
 * rather than a place people talk. The thread is the same thread either way,
 * so it is the same component — the target is one field.
 */
import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';
import { relativeTime } from '../lib/format';
import { comment as postComment, remove, update } from '../lib/mutations';
import { list, useQuery } from '../lib/store';
import { useMe, useMemberMap } from '../session';
import { anchorLabel, findAnchor, type Anchor, type Comment } from '@kolibri/shared';
import { Markdown, MarkdownEditor } from './Markdown';
import { Button } from '../components/ui/button';
import { Chip } from './ui/chip';
import { Avatar, Icon, MenuButton, useConfirm } from './ui';

/** Exactly one of the two, which is also how the row is stored. */
export type CommentTarget = { task_id: string; page_id?: never } | { page_id: string; task_id?: never };

/** The handful worth having on a work tool. A full picker is a different product. */
const REACTIONS = ['👍', '🎉', '👀', '🙏', '😄', '🤔'] as const;

/**
 * Reactions on a comment.
 *
 * `reactions` has been stored and synced since the first release as
 * `{ emoji: [userId, …] }`; nothing displayed it. Counting is the point — who
 * reacted is a tooltip, not a row of avatars.
 */
function Reactions({ comment }: { comment: Comment }) {
  const t = useT();
  const me = useMe();
  const members = useMemberMap();
  const reactions = comment.reactions ?? {};
  const used = Object.entries(reactions).filter(([, people]) => people?.length);

  const toggle = (emoji: string) => {
    const people = reactions[emoji] ?? [];
    const next = { ...reactions, [emoji]: people.includes(me) ? people.filter((id) => id !== me) : [...people, me] };
    // An emoji nobody uses any more is removed rather than left as an empty
    // list, so the row does not slowly fill with invisible entries.
    if (!next[emoji].length) delete next[emoji];
    update('comment', comment.id, { reactions: next });
  };

  return (
    <div className="flex items-center flex-wrap reactions gap-1">
      {used.map(([emoji, people]) => (
        <button
          key={emoji}
          className={`reaction${people.includes(me) ? ' mine' : ''}`}
          title={people.map((id) => members.get(id)?.name ?? t('common.someone')).join(', ')}
          onClick={() => toggle(emoji)}
        >
          <span aria-hidden>{emoji}</span> {people.length}
        </button>
      ))}
      <MenuButton
        className="reaction add"
        label={t('task.react')}
        items={REACTIONS.map((emoji) => ({
          id: emoji,
          label: <span className="text-base">{emoji}</span>,
          hint: (reactions[emoji] ?? []).includes(me) ? '✓' : undefined,
          onSelect: () => toggle(emoji),
        }))}
      >
        <Icon name="plus" size={12} />
      </MenuButton>
    </div>
  );
}

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
  const t = useT();
  const me = useMe();
  const members = useMemberMap();
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState('');
  const editor = useRef<HTMLDivElement>(null);

  // A selection jumps to the composer: the thing somebody does after choosing a
  // sentence is type about it, and hunting for the box is a step in the way.
  useEffect(() => {
    if (!anchor) return;
    editor.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    editor.current?.querySelector('textarea')?.focus();
  }, [anchor]);

  const key = target.task_id ?? target.page_id;
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
                {entry.author_id === me && (
                  <Button variant="ghost" size="sm"
                    style={{ marginInlineStart: 'auto' }}
                    aria-label={t('task.deleteCommentLabel')}
                    onClick={async () => {
                      if (await confirm(t('task.deleteComment'))) remove('comment', entry.id);
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </Button>
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
              <Markdown source={entry.body} />
              <Reactions comment={entry} />
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
