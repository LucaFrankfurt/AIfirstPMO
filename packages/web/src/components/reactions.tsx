/**
 * Reactions, wherever somebody can leave one.
 *
 * Two entities carry them and both store the same shape —
 * `{ "👍": [userId, …] }` — so this is one implementation rather than the two
 * that had drifted apart. Chat had been moved onto a popover picker; comments
 * were still opening a menu, which is the shape `popover.tsx` exists to avoid.
 * The six emoji came out of it as a tall ladder with the rest of the row empty.
 *
 * What stays per-surface is only *where the picker hangs*. A chat message keeps
 * its trigger in the hover row it already has for reply and edit; a comment has
 * no such row, so the trigger sits inline at the end of the pills, which is why
 * `Reactions` takes it as `children` rather than drawing one itself.
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useT } from '../lib/i18n';
import { update } from '../lib/mutations';
import { useMe, usePeople } from '../session';
import { cn } from '../lib/cn';
import { nextReactions, REACTIONS, type Reacted } from '../lib/reactions';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import type { ID } from '@kolibri/shared';

/** The two things somebody can react to. Both keep `reactions` as one JSON field. */
type Reactable = 'comment' | 'message';

type Maybe = Reacted | null | undefined;

export function toggleReaction(kind: Reactable, id: ID, reactions: Maybe, emoji: string, me: ID): void {
  update(kind, id, { reactions: nextReactions(reactions, emoji, me) });
}

/**
 * The pills, and whatever picker the surface wants after them.
 *
 * Names come from `usePeople` rather than the member map. A reaction outlives
 * the membership that produced it — somebody who has left the workspace, or who
 * was only ever in a direct conversation, is still a name in the synced `user`
 * rows and was coming back as "someone" here.
 */
export function Reactions({ kind, id, reactions, canWrite = true, children }: {
  kind: Reactable;
  id: ID;
  reactions: Maybe;
  canWrite?: boolean;
  /** A picker, for a surface with nowhere else to put one. */
  children?: ReactNode;
}) {
  const t = useT();
  const me = useMe();
  const people = usePeople();
  const used = Object.entries(reactions ?? {}).filter(([, who]) => who?.length);

  // Nothing to show and nothing to hold the row open with.
  if (!used.length && !children) return null;

  const name = (who: ID) => people.get(who)?.name ?? t('common.someone');

  return (
    <div className="flex items-center flex-wrap reactions gap-1">
      {used.map(([emoji, who]) => (
        <button
          key={emoji}
          className={`reaction${who.includes(me) ? ' mine' : ''}`}
          disabled={!canWrite}
          title={who.map(name).join(', ')}
          // Otherwise this announces as the emoji alone, and the count and the
          // names — the entire reason to look at a reaction — are mouse-only.
          aria-label={`${emoji} ${who.length} · ${who.map(name).join(', ')}`}
          onClick={() => toggleReaction(kind, id, reactions, emoji, me)}
        >
          <span aria-hidden>{emoji}</span> {who.length}
        </button>
      ))}
      {children}
    </div>
  );
}

/**
 * Six emoji, in a row, in a popover sized by its contents.
 *
 * The trigger is passed in rather than drawn here: the two surfaces put it in
 * genuinely different places, and that is the only thing they disagree about.
 */
export function ReactionPicker({ kind, id, reactions, align, children }: {
  kind: Reactable;
  id: ID;
  reactions: Maybe;
  /**
   * Which edge to hang the row off. Centred on the trigger by default, which is
   * right for chat, where the trigger sits in an action bar with the message
   * either side of it. A comment's trigger is at the start of an otherwise
   * empty row near the sheet's edge, and centred there put half the popover
   * outside the sheet.
   */
  align?: 'start' | 'center' | 'end';
  children: ReactNode;
}) {
  const t = useT();
  const me = useMe();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="flex gap-0.5" aria-label={t('task.react')}>
        {REACTIONS.map((emoji) => {
          const mine = (reactions?.[emoji] ?? []).includes(me);
          return (
            <button
              key={emoji}
              className={cn('reaction-pick', mine && 'mine')}
              aria-pressed={mine}
              aria-label={emoji}
              onClick={() => {
                toggleReaction(kind, id, reactions, emoji, me);
                setOpen(false);
              }}
            >
              <span aria-hidden>{emoji}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
