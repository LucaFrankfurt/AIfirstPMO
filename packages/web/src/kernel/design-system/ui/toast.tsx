/** What happened, said once at the bottom of the screen: toasts, and the request helper that raises one on failure. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT, type Translate } from '../../i18n/i18n';
import { cn } from '../cn';

interface Toast {
  id: string;
  message: string;
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<(message: string, action?: Toast['action']) => void>(() => {});
export const useToast = () => useContext(ToastContext);

/**
 * A toast from code that is not a component.
 *
 * `useToast` needs a render to be called from, and an adapter answering a click
 * on the document — the packaged app opening a file — has none. It says what
 * went wrong through the window instead, already in the reader's words, and the
 * host that is mounted shows it.
 */
export const TOAST_EVENT = 'kolibri:toast';

/**
 * The snackbar's surface, on its own so the design catalogue can show the
 * same one at rest rather than a copy of it that drifts.
 */
export const snackbar = 'flex min-h-12 max-w-[min(32rem,calc(100vw-32px))] items-center gap-3 rounded bg-fg py-2.5 ps-4 pe-2 text-body text-bg shadow';

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, action?: Toast['action']) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-2), { id, message, action }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), action ? 7000 : 3200);
  }, []);

  useEffect(() => {
    const onToast = (event: Event) => {
      const message = (event as CustomEvent<unknown>).detail;
      if (typeof message === 'string' && message) push(message);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, [push]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {createPortal(
        // Centred above the bottom bar on a phone, and in the corner of the
        // eye on a desktop. Inverse, so it is the one thing on the screen that
        // is not one of the screen's own surfaces — the Material snackbar.
        <div className="pointer-events-none fixed bottom-[calc(80px+env(safe-area-inset-bottom))] left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2 min-[600px]:bottom-6">
          {toasts.map((toast) => (
            <div
              // `toast` draws nothing; the walkthrough finds an undo by it.
              className={cn(snackbar, 'toast pointer-events-auto animate-in motion-reduce:animate-none')}
              key={toast.id}
              role="status"
            >
              <span className={toast.action ? undefined : 'pe-2'}>{toast.message}</span>
              {toast.action && (
                <button
                  type="button"
                  className="h-9 shrink-0 rounded-full px-3 font-semibold underline-offset-4 hover:underline outline-none focus-visible:ring-2 focus-visible:ring-bg"
                  onClick={() => {
                  toast.action!.run();
                  setToasts((current) => current.filter((t) => t.id !== toast.id));
                }}>
                  {toast.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/** What a failed request says: the server's words, or a generic line. */
export const failure = (error: unknown, t: Translate): string =>
  (error instanceof Error && error.message) || t('common.somethingWentWrong');

/**
 * A button's request, one at a time, and a toast when it fails (UX-08).
 * The ref refuses a second click that lands before `busy` has re-rendered.
 */
export function useAction() {
  const t = useT();
  const toast = useToast();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    try {
      await work();
      return true;
    } catch (error) {
      toast(failure(error, t));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [t, toast]);
  return { busy, run };
}
