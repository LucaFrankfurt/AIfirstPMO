/**
 * Opening an uploaded file, in the packaged app.
 *
 * In a browser a link to `/files/<hash>/<name>` is an ordinary link: same
 * origin, the cookie goes with it, the browser shows or saves the file. In the
 * app every part of that fails. The path addresses the app's own bundle, which
 * answers it with `index.html`; a link with `target="_blank"` leaves the WebView
 * for the system browser, which has no session; and handing the system browser
 * a URL with the session token in it — the only thing that would have made it
 * load — would put that token in the browser's history, its sync and whatever
 * it shares with. So nothing here ever opens a file by URL.
 *
 * The click is taken instead, once, for the whole document: the file is fetched
 * with the token in a header, written to the app's cache directory, and handed
 * to the phone's share sheet — which is where a phone opens a PDF in a viewer,
 * saves a spreadsheet to Files, or sends a photo on. Delegated rather than wired
 * into each place that draws a link, because those places are the markdown
 * renderer, HTML pages, attachments, conversations and the lightbox, and three
 * of them are strings with no component to hand a handler to.
 *
 * Images drawn *inside* the app are not this file's business: those load by URL
 * (`fileSrc`), because the URL never leaves the WebView.
 *
 * Costs, measured nowhere yet because nothing here has run on a phone: the file
 * crosses the bridge as base64, so a large one is held in memory twice over for
 * a moment; and the cache directory is the operating system's to empty, which is
 * the point — a shared file is not this app's to keep.
 */
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { currentLocale, translate } from '../../kernel/i18n/i18n';
import { TOAST_EVENT } from '../../kernel/design-system/ui';
import { authHeaders, filePath, isPackaged, serverUrl } from '../../kernel/sync/server';

let installed = false;

/** Hung off the document by `wiring.ts`; does nothing in a browser. */
export function installNativeFiles(): void {
  if (installed || !isPackaged()) return;
  installed = true;
  // Capture, so this runs before React's own listener at the root — which is
  // where `useInAppLinks` would otherwise have routed `/files/…` as a screen.
  document.addEventListener('click', onClick, true);
}

function onClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  const anchor = (event.target as Element | null)?.closest?.('a[href]');
  const path = filePath(anchor?.getAttribute('href'));
  if (!anchor || !path) return;
  event.preventDefault();
  event.stopPropagation();
  void openFile(path, anchor.getAttribute('download') || nameOf(path)).catch((problem: unknown) => {
    // Dismissing the share sheet is a rejection on both platforms, and it is
    // somebody changing their mind rather than anything going wrong.
    if (/cancel/i.test(problem instanceof Error ? problem.message : String(problem))) return;
    window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: translate(currentLocale(), 'attachment.openFailed') }));
  });
}

/** The last segment of `/files/<hash>/<name>`, as a person would call the file. */
export function nameOf(path: string): string {
  const last = path.split('?')[0].split('/').filter(Boolean).pop() ?? 'file';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * A name that is safe as one path segment in the cache directory.
 *
 * The name came from whoever uploaded the file. Kept readable, because it is
 * what the share sheet shows and what the file is called wherever it is saved
 * to; stripped of separators and of a leading dot, because it is about to be a
 * path on this phone.
 */
export const cacheName = (name: string): string =>
  name.replace(/[/\\\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';

async function openFile(path: string, name: string): Promise<void> {
  const response = await fetch(serverUrl(path), { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await base64(await response.blob());
  // One directory per hash, so two different files both called `report.pdf`
  // do not overwrite each other while one of them is still being shared.
  const hash = path.split('/')[2] ?? 'file';
  const written = await Filesystem.writeFile({
    path: `files/${hash.slice(0, 16)}/${cacheName(name)}`,
    data,
    directory: Directory.Cache,
    recursive: true,
  });
  await Share.share({ title: name, files: [written.uri] });
}

/** A blob as the base64 the bridge carries binary data in. */
function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    // `data:<type>;base64,<payload>` — the payload is everything after the comma.
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.readAsDataURL(blob);
  });
}
