/**
 * Selecting several tasks and doing one thing to all of them.
 *
 * The rule that shapes this: **states and labels belong to a project**. A
 * selection that spans two projects has no shared list of states to offer, so
 * those actions disappear rather than guessing — everything that is workspace-
 * wide (priority, people, dates, archive, delete) stays available.
 *
 * Every action is an ordinary local write, so a bulk change made on a train
 * lands in the outbox with everything else. The server's `/tasks/bulk` route is
 * for API and MCP callers, who have no outbox to put it in.
 *
 * The hook and the checkbox live here and know nothing about tasks; the bar
 * that acts on a selection is in `selection-bar.tsx`, because it needs the task
 * pickers and those need the checkbox.
 */
import { useCallback, useRef, useState } from 'react';
import type React from 'react';

export interface Selection {
  ids: Set<string>;
  count: number;
  has: (id: string) => boolean;
  /** `extend` is a shift-click: everything between the last click and this one. */
  toggle: (id: string, order: string[], extend?: boolean) => void;
  /** Select or clear a whole group in one go. */
  setMany: (ids: string[], selected: boolean) => void;
  clear: () => void;
}

export function useSelection(): Selection {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);

  const toggle = useCallback((id: string, order: string[], extend = false) => {
    setIds((current) => {
      const next = new Set(current);
      const from = anchor.current ? order.indexOf(anchor.current) : -1;
      const to = order.indexOf(id);
      // A shift-click with no anchor, or across a regrouping that moved the
      // anchor out of view, degrades to an ordinary click rather than nothing.
      if (extend && from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from];
        for (const between of order.slice(start, end + 1)) next.add(between);
        return next;
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
      return next;
    });
  }, []);

  const setMany = useCallback((many: string[], selected: boolean) => {
    setIds((current) => {
      const next = new Set(current);
      for (const id of many) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  return {
    ids,
    count: ids.size,
    has: (id) => ids.has(id),
    toggle,
    setMany,
    clear: useCallback(() => setIds(new Set()), []),
  };
}

/**
 * The checkbox in front of a row. Its own click, never the row's.
 *
 * On a pointer device it fades in on hover. There is no hover on a touch
 * screen, and a checkbox on every row turns a list into a form — so there it
 * stays hidden until a selection exists, and a long press starts one.
 */
export function SelectBox({
  id, order, selection, label,
}: { id: string; order: string[]; selection: Selection; label: string }) {
  return (
    <span
      className={`select-box${selection.count === 0 ? ' idle' : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        selection.toggle(id, order, event.shiftKey);
      }}
    >
      {/* The click is handled on the wrapper, where `shiftKey` is available and
          a single `stopPropagation` keeps the row from opening. The input must
          not stop it itself, or a click on the box would reach nothing. */}
      <input type="checkbox" checked={selection.has(id)} aria-label={label} onChange={() => {}} />
    </span>
  );
}

/** A stand-in so a row without selection can still call the hook unconditionally. */
export const EMPTY_SELECTION: Selection = {
  ids: new Set(),
  count: 0,
  has: () => false,
  toggle: () => {},
  setMany: () => {},
  clear: () => {},
};

/**
 * Long press to start selecting, for the screens with no hover.
 *
 * Returns handlers for the row. Once something is selected the checkboxes are
 * visible and an ordinary tap is enough, so the long press only has to cover
 * the first one.
 */
export function useLongPressSelect(id: string, order: string[], selection: Selection) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return {
    onPointerDown: (event: React.PointerEvent) => {
      // Mouse users have the checkbox on hover; holding a mouse button down
      // over a row is not a gesture anybody makes on purpose.
      if (event.pointerType === 'mouse') return;
      fired.current = false;
      timer.current = setTimeout(() => {
        fired.current = true;
        selection.toggle(id, order);
        // A press that became a selection should feel like it did something.
        navigator.vibrate?.(12);
      }, 450);
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerMove: cancel,
    /** True when the click that follows is the tail of a long press. */
    swallowClick: () => {
      if (!fired.current) return false;
      fired.current = false;
      return true;
    },
  };
}
