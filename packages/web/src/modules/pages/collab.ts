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
import { agentId, resync } from '../../kernel/sync/sync';

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
  /**
   * A rewrite of the text that did not come from the textarea: ticking a
   * checkbox in the page as it is read.
   *
   * It exists because the alternative was to write `content` straight out, and
   * on this one field that is not a small shortcut. A page's `content` has to
   * keep saying what its CRDT says — the server derives one from the other on
   * every write — so a tick sent as a replacement would be read as *a whole new
   * document*, tombstoning every character of a paragraph somebody else may be
   * halfway through. Sent through `crdt.edit`, a tick is what it looks like:
   * one character, merged like a keystroke.
   */
  rewrite: (next: string) => void;
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

  /**
   * Apply a rewrite to the merged state and send it.
   *
   * `commit` first, which in the reading view is a no-op — nothing is being
   * typed, so the diff against the base is empty and the state comes back
   * unchanged. It is there for the case that is not supposed to happen: called
   * while somebody types, it folds the tail in rather than dropping it.
   *
   * `content` goes alongside the state although the server recomputes it from
   * the state anyway. The two agree character for character, and sending it is
   * what makes the box tick *now* on the device that clicked it — the reading
   * view renders `content`, and waiting for the round trip to come back would
   * be a checkbox that does nothing on a train.
   */
  const rewrite = useCallback((next: string) => {
    const from = commit();
    const state = crdt.edit(from, next, agent);
    if (state === from) return;
    base.current = state;
    put(next);
    update('page', pageId, { body: state, content: next });
  }, [agent, commit, pageId, put]);

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
   * The one check that catches a body this device is holding wrongly.
   *
   * The server never stores a page whose CRDT and whose text disagree — it
   * derives one from the other on every write. So on this screen, with nothing
   * of ours still queued and nothing being typed, a disagreement is not news
   * from anywhere: it is this copy being wrong, and no pull will correct it,
   * because merging the good state into the bad one keeps the bad one. It was
   * reachable — a page rewritten over MCP or the API twice left every device
   * that had seen the first version rendering the second and *editing* the
   * first, silently, for ever (`replacementBody`, server side, is the cause and
   * the fix). `resync` throws this copy away and reads the row back.
   *
   * On opening only, and never mid-edit. Between a save going up and the pull
   * coming back the two halves are briefly allowed to disagree, and that is the
   * ordinary case rather than a fault.
   */
  const examined = useRef('');
  useEffect(() => {
    // Not `[pageId]` alone: on a cold start the row arrives from the pull
    // *after* this screen is on it, and the check would have run against no
    // page at all. The ref is what keeps it to once per page, since reading
    // the whole text out of the CRDT is not free.
    if (!stored || editing || examined.current === pageId) return;
    examined.current = pageId;
    if (crdt.textOf(stored) !== content) void resync('page', pageId);
  }, [pageId, stored, editing, content]);

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

  return { text, setText: put, fieldRef, flush, rewrite, merged };
}
