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
import { FileTransfer } from '@capacitor/file-transfer';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { currentLocale, translate, type TranslationKey } from '../../kernel/i18n/i18n';
import { TOAST_EVENT } from '../../kernel/design-system/ui/toast';
import { onSave } from '../../kernel/files/save';
import { authHeaders, filePath, isPackaged, serverUrl } from '../../kernel/sync/server';

let installed = false;

/** Hung off the document by `wiring.ts`; does nothing in a browser. */
export function installNativeFiles(): void {
  if (installed || !isPackaged()) return;
  installed = true;
  // Exports, backups and pages saved as files go the same way as an upload:
  // to the share sheet. See `kernel/files/save.ts` for why the kernel asks.
  onSave({
    fromServer: (path, name) => {
      say('attachment.preparing');
      return handled(downloadAndShare(path, name), 'attachment.saveFailed');
    },
    fromBlob: (blob, name) => handled(writeAndShare(blob, name), 'attachment.saveFailed'),
  });
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
  void handled(openFile(path, anchor.getAttribute('download') || nameOf(path)), 'attachment.openFailed');
}

/** A toast, in the reader's words, from outside any component. */
const say = (key: TranslationKey): void => {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: translate(currentLocale(), key) }));
};

/**
 * Whatever went wrong, said once, and never thrown at whoever pressed the
 * button — except that dismissing the share sheet is a rejection on both
 * platforms, and it is somebody changing their mind rather than a failure.
 */
async function handled(work: Promise<void>, failed: TranslationKey): Promise<void> {
  try {
    await work;
  } catch (problem) {
    if (/cancel/i.test(problem instanceof Error ? problem.message : String(problem))) return;
    say(failed);
  }
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

/**
 * Where a file waits for the share sheet: one directory in the cache, emptied
 * before the next file goes in. A backup is hundreds of megabytes, and the
 * operating system empties a cache when it likes rather than when that would
 * help; one file at a time is the most this app ever needs to be holding.
 */
const SHARED = 'shared';

async function freshSlot(name: string): Promise<string> {
  await Filesystem.rmdir({ path: SHARED, directory: Directory.Cache, recursive: true }).catch(() => undefined);
  await Filesystem.mkdir({ path: SHARED, directory: Directory.Cache, recursive: true }).catch(() => undefined);
  return `${SHARED}/${cacheName(name)}`;
}

const share = (uri: string, name: string): Promise<unknown> => Share.share({ title: name, files: [uri] });

/**
 * An upload, fetched by the page with the token in a header.
 *
 * Through the page rather than `downloadFile` below, because an upload is
 * bounded by the server's upload limit and this is the path `check:packaged`
 * can watch: it sees the request leave with the header, which a native
 * download would keep out of its sight.
 */
async function openFile(path: string, name: string): Promise<void> {
  const response = await fetch(serverUrl(path), { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await writeAndShare(await response.blob(), name);
}

/** A file this page built — or fetched — written to the cache and shared. */
async function writeAndShare(blob: Blob, name: string): Promise<void> {
  const data = await base64(blob);
  const written = await Filesystem.writeFile({ path: await freshSlot(name), data, directory: Directory.Cache });
  await share(written.uri, name);
}

/**
 * A file the server streams, downloaded natively and shared.
 *
 * Natively, because these are the large ones: a workspace archive or a backup
 * can be hundreds of megabytes, and through the page it would be held as a blob
 * and then again as base64 to cross the bridge. `FileTransfer` writes it to disk
 * as it arrives. Its request is the phone's, not the WebView's, so no CORS
 * applies and the session goes in a header like every other request here.
 */
async function downloadAndShare(path: string, name: string): Promise<void> {
  const { uri } = await Filesystem.getUri({ path: await freshSlot(name), directory: Directory.Cache });
  await FileTransfer.downloadFile({ url: serverUrl(path), path: uri, headers: authHeaders() });
  await share(uri, name);
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
