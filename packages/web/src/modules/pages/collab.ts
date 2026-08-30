/**
 * Editing a page while somebody else is editing it.
 *
 * The CRDT in `@kolibri/shared` does the merging; this is the part that has to
 * be got right around it — what happens to the textarea, and to the caret,
 * when somebody else's paragraph arrives mid-sentence.
 *
 * The order matters and is the whole of the difficulty:
 *
 *  1. What is on screen is a *diff* against a known CRDT state — the `base`.
 *     It is not in the CRDT yet; the last nine hundred milliseconds of typing
 *     never are.
 *  2. When a change arrives from somewhere else, the unsaved tail is folded
 *     into the base **first**, and only then merged with what arrived. Merging
 *     the other way round would compute the diff against a document that
 *     already contains the other person's text, and "delete what they wrote"
 *     is what that diff says.
 *  3. The caret is moved by however much text appeared before it, so a
 *     colleague saving does not send the cursor to the end of the document.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { crdt, type CrdtState } from '@kolibri/shared';
import { update } from '../../kernel/sync/mutations';
import { agentId } from '../../kernel/sync/sync';

/** How long typing rests before it becomes a CRDT state and a synced row. */
const SETTLE_MS = 700;

export interface Collab {
  /** What the textarea shows. */
  text: string;
  /** What the textarea calls when somebody types. */
  setText: (next: string) => void;
  /** Give this to the editor so the caret can be kept where it was. */
  fieldRef: { current: HTMLTextAreaElement | null };
  /** Push whatever is pending now — on closing the editor, say. */
  flush: () => void;
  /** True while somebody else's change is being taken in, for a quiet marker. */
  merged: boolean;
}

/**
 * Two-way editing of one page body.
 *
 * `stored` is the row's CRDT as the local store has it — already merged with
 * everything that has arrived, because the store merges this field rather than
 * overwriting it. `content` is the plain text, used only for a page that has
 * never had a CRDT.
 */
export function useCollaborativeText(
  pageId: string,
  stored: CrdtState | null | undefined,
  content: string,
  editing: boolean,
): Collab {
  const agent = agentId();
  const base = useRef<CrdtState>(crdt.empty());
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [text, setTextState] = useState('');
  const latest = useRef('');
  const [merged, setMerged] = useState(false);

  const put = useCallback((next: string) => {
    latest.current = next;
    setTextState(next);
  }, []);

  /** Fold the unsaved tail into the base and write it. */
  const commit = useCallback((): CrdtState => {
    const next = crdt.edit(base.current, latest.current, agent);
    if (next !== base.current) {
      base.current = next;
      update('page', pageId, { body: next });
    }
    return next;
  }, [agent, pageId]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (editing) commit();
  }, [commit, editing]);

  // Opening the page, or a different one: start from what is stored.
  useEffect(() => {
    const start = stored ?? crdt.fromText(content, 'server');
    base.current = start;
    put(crdt.textOf(start));
    // Only on the page changing — a change to `stored` is the other effect's
    // job, and re-running this one would throw away what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  /**
   * A change from somewhere else.
   *
   * `stored` is the merged row, so it already holds everything anybody has
   * sent — including our own last save coming back. The only thing it cannot
   * hold is what has been typed since, which is why that is folded in first.
   */
  useEffect(() => {
    if (!stored) return;
    const incoming = crdt.textOf(stored);
    if (!editing) {
      base.current = stored;
      if (incoming !== latest.current) put(incoming);
      return;
    }

    const mine = crdt.edit(base.current, latest.current, agent);
    const together = crdt.merge(mine, stored);
    const combined = crdt.textOf(together);
    base.current = together;
    if (combined === latest.current) return;

    // Keep the caret where the writing is: everything before it that did not
    // change stays put, and text inserted above it pushes it down.
    const field = fieldRef.current;
    const caret = field?.selectionStart ?? null;
    const before = latest.current;
    put(combined);
    setMerged(true);
    if (field && caret !== null) {
      let common = 0;
      while (common < before.length && common < combined.length && before[common] === combined[common]) common++;
      const moved = caret <= common ? caret : caret + (combined.length - before.length);
      requestAnimationFrame(() => {
        const at = Math.max(0, Math.min(combined.length, moved));
        field.setSelectionRange(at, at);
      });
    }
    // Our own pending text is now part of `together` but has not been sent.
    if (mine !== base.current || combined !== incoming) update('page', pageId, { body: together });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);

  useEffect(() => {
    const at = setTimeout(() => setMerged(false), 1400);
    return () => clearTimeout(at);
  }, [merged]);

  // Typing settles into a state, which the outbox then sends like any change.
  useEffect(() => {
    if (!editing) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(), SETTLE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text, editing, commit]);

  return { text, setText: put, fieldRef, flush, merged };
}
