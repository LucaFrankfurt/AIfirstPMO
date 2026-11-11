/**
 * The page inside a support widget's iframe — a second entry beside the app's.
 *
 * It shares the app's stylesheet and conversation components and nothing
 * else: no catalogue (it carries thirty words of its own, see `words.ts`), no
 * sync, no session, no service worker. It runs on somebody else's site, in a
 * frame that site's visitors did not ask for, so it loads only when they click
 * and holds no more than one conversation.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { widgetLocale } from './words';
import { VisitorChat } from './visitor';
import '../../styles/app.css';

/**
 * Storage that may be refused.
 *
 * A browser blocking third-party storage throws on the first touch of
 * `localStorage` inside this frame, and an anonymous visitor's session is kept
 * there. A memory stand-in keeps the window working; it only means an
 * anonymous visitor starts afresh on their next page.
 */
function guardStorage(): void {
  try {
    window.localStorage.getItem('kolibri.probe');
  } catch {
    const memory = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => void memory.set(key, String(value)),
        removeItem: (key: string) => void memory.delete(key),
        clear: () => memory.clear(),
        key: (index: number) => [...memory.keys()][index] ?? null,
        get length() { return memory.size; },
      },
    });
  }
}

guardStorage();
document.documentElement.lang = widgetLocale();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <VisitorChat />
  </StrictMode>,
);
