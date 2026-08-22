/**
 * What is being dragged, said in a way the drop target can read.
 *
 * Both a board card and a sidebar project used to hand over `text/plain`, so a
 * project row could not tell one from the other. It accepted the drop either
 * way, called the reparent path, found no project being dragged and returned —
 * which is how dragging a task onto a project looked like it would work and
 * then did nothing at all.
 *
 * The type is the answer. `dataTransfer.getData` is blanked during `dragover`
 * by every browser, deliberately, so a target cannot read what it has not been
 * dropped; `dataTransfer.types` is readable throughout. That is what decides
 * whether to accept the drop, and the payload is only read on `drop` itself.
 */
export const TASK_DRAG = 'application/x-kolibri-task';
export const PROJECT_DRAG = 'application/x-kolibri-project';

type Kind = typeof TASK_DRAG | typeof PROJECT_DRAG;

/**
 * `text/plain` is still written beside it, and on purpose: it is what a drag
 * into any other application receives, and dropping a task id into an editor is
 * a reasonable thing for it to give.
 */
export function startDrag(event: React.DragEvent, kind: Kind, id: string): void {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(kind, id);
  event.dataTransfer.setData('text/plain', id);
}

export const isDrag = (event: React.DragEvent, kind: Kind): boolean =>
  event.dataTransfer.types.includes(kind);

export const idFrom = (event: React.DragEvent, kind: Kind): string => event.dataTransfer.getData(kind);
