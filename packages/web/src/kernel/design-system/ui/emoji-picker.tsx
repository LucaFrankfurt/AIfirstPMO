/**
 * Choosing the icon a project, a page or a template wears.
 *
 * It was a text box that took any four characters, which meant three things at
 * once: an icon nobody else's device could draw, an icon that came apart into
 * three on an older one, and — because a text box takes text — projects called
 * `P`. The set is in `emoji-set.ts` with the reasoning; this is the grid.
 *
 * A popover rather than a menu, for the reason `popover.tsx` exists: sixty
 * emoji in `MenuContent` are a sixty-row ladder with two hundred pixels of
 * empty space beside them. And a popover rather than the inline row a saved
 * view uses, because a dozen shapes fit under a label and sixty do not.
 *
 * **What is already stored is never overruled.** An icon typed into the old box,
 * or set by an import or an assistant over MCP, is somebody's data: it is shown
 * on the trigger as it is, and offered back as the first cell of the grid so
 * that opening the picker to change something else cannot silently swap it.
 */
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { buttonVariants } from './button';
import { cn } from '../cn';
import { useT } from '../../i18n/i18n';
import { ICON_CHOICES } from '../emoji-set';

export function EmojiPicker({ value, onChange, fallback, id }: {
  /** What is stored now — `null` for a thing that has never had one. */
  value: string | null | undefined;
  /** Called with the new icon, or `null` when it is cleared. */
  onChange: (next: string | null) => void;
  /** Drawn on the trigger when nothing is stored: what this kind of thing gets by default. */
  fallback?: string;
  /** For a `<label htmlFor>` beside it. */
  id?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const current = value?.trim() || null;
  /*
   * A stored icon the grid does not contain goes in front of it rather than
   * being lost.
   *
   * The question is "do I offer this one", not "is this one portable", and the
   * difference is not academic: 🌐 and 🚨 are both perfectly old emoji that the
   * seed uses and this set does not list. Asking the portable question left
   * those with a trigger showing one thing, nothing highlighted in the grid, and
   * no way back to it once anything else was pressed.
   */
  const kept = current && !ICON_CHOICES.includes(current) ? [current] : [];

  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-label={t('icon.choose')}
          className={cn(buttonVariants({ variant: 'secondary' }), 'emoji-trigger')}
        >
          <span aria-hidden="true">{current ?? fallback ?? '📄'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="emoji-grid" role="radiogroup" aria-label={t('icon.choose')}>
        {[...kept, ...ICON_CHOICES].map((emoji) => (
          <button
            key={emoji}
            type="button"
            role="radio"
            aria-checked={current === emoji}
            aria-label={emoji}
            className={cn('emoji-cell', current === emoji && 'chosen')}
            onClick={() => pick(emoji)}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
        {/* Last, and across the width: clearing is a different act from choosing,
            and a cell that looked like the others would be pressed by accident. */}
        <button
          type="button"
          className="emoji-clear"
          onClick={() => pick(null)}
        >
          {t('icon.none')}
        </button>
      </PopoverContent>
    </Popover>
  );
}
