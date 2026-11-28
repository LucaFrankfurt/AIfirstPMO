/** The app's modal surface, and the confirmation that asks before anything is destroyed. They live together because each needs the other: a sheet with unsaved input confirms before it closes, and a confirmation is a sheet. */
import { useCallback, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/i18n';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { Button } from './button';

/**
 * A sheet: the app's one modal surface, now a real dialog underneath.
 *
 * The call site is unchanged — render it when it should be open, give it an
 * `onClose` — because forty screens do exactly that and this change is about
 * behaviour, not about churning them. What is new is everything a dialog is
 * supposed to do and this one could not: focus is trapped inside it, Tab cannot
 * wander onto the screen behind, focus returns to whatever opened it, the rest
 * of the page is hidden from a screen reader, and the page underneath keeps its
 * scroll position instead of jumping to the top on close.
 */
export function Sheet({
  title, children, onClose, footer, wide, dirty,
}: { title?: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean; dirty?: boolean }) {
  const t = useT();
  const discard = useConfirm();
  // Escape, the backdrop and the X ask first when something typed would be lost (UX-13).
  const dismiss = () => {
    if (!dirty) return onClose();
    void discard.confirm(t('sheet.discardChanges'), t('sheet.discard')).then((ok) => { if (ok) onClose(); });
  };
  return (
    <Dialog open onOpenChange={(next) => { if (!next) dismiss(); }}>
      {/* `sheet` is kept as a hook, not a style — the CSS that used to draw it
          is gone, and this is what tests and the odd screen-specific rule use
          to find the surface. */}
      <DialogContent className="sheet" wide={wide} closeLabel={t('action.close')} aria-describedby={undefined}>
        {title
          ? <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
          : <VisuallyHiddenTitle>{t('action.close')}</VisuallyHiddenTitle>}
        <DialogBody>{children}</DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
        {discard.dialog}
      </DialogContent>
    </Dialog>
  );
}

/** Whether a form's state has moved from what it opened with — for `Sheet`'s `dirty`. */
export function useDirty(value: unknown): boolean {
  const [start] = useState(() => JSON.stringify(value));
  return JSON.stringify(value) !== start;
}

/** A dialog must have a title even when the design shows none. */
const VisuallyHiddenTitle = ({ children }: { children: ReactNode }) => (
  <DialogTitle className="sr-only">{children}</DialogTitle>
);

/** Small confirm dialog — used before anything destructive. The button says the verb, "Delete" only by default (UX-04). */
export function useConfirm() {
  const t = useT();
  const [request, setRequest] = useState<{ message: string; confirmLabel?: string; title?: string; resolve: (ok: boolean) => void } | null>(null);

  const confirm = useCallback(
    (message: string, confirmLabel?: string, title?: string) =>
      new Promise<boolean>((resolve) => setRequest({ message, confirmLabel, title, resolve })),
    [],
  );

  const dialog = request ? (
    <Sheet
      title={request.title ?? t('action.confirmTitle')}
      onClose={() => {
        request.resolve(false);
        setRequest(null);
      }}
      footer={
        <>
          <Button onClick={() => { request.resolve(false); setRequest(null); }}>{t('action.cancel')}</Button>
          <Button variant="danger" onClick={() => { request.resolve(true); setRequest(null); }}>{request.confirmLabel ?? t('action.delete')}</Button>
        </>
      }
    >
      {request.message}
    </Sheet>
  ) : null;

  return { confirm, dialog };
}
