/**
 * Handing a finished file to the person who asked for it: an export, a backup,
 * a page saved as HTML.
 *
 * A browser does this by itself and was always asked to here — a hidden frame
 * for what the server streams, so a large archive goes straight to disk, and a
 * link with `download` for what the page built. Neither reaches anybody in the
 * packaged app. The frame and a navigation address the app's own bundle, which
 * answers `/api/…` with `index.html` (the project export used to take the whole
 * app there); and a `blob:` download is something neither WebView hands to the
 * system. A phone saves a file through its share sheet — "Save to Files", or
 * straight into another app — and that needs native code, which the kernel does
 * not have. So it asks, through a port, and the app's native adapter answers.
 *
 * Callers say what the file should be called. The browser takes the name from
 * the server's `Content-Disposition`, but the app downloads natively, where the
 * reply's headers are not handed back — and a file called `download` in
 * somebody's Files app is a file they cannot find again.
 */

/** Somewhere a finished file can go other than the browser's downloads. */
export interface Saver {
  /** A file the server produces, at `path` on this client's server. */
  fromServer(path: string, name: string): Promise<void>;
  /** A file this page built. */
  fromBlob(blob: Blob, name: string): Promise<void>;
}

let saver: Saver | null = null;

/** @port where a finished file is handed over, when it is not to the browser */
export function onSave(next: Saver): void {
  saver = next;
}

/**
 * A file the server streams, saved under `name`.
 *
 * In a browser a hidden frame, so the download is the browser's own: streamed
 * to disk however large, with its progress in the browser's downloads, and
 * carrying the session cookie because the frame is same-origin.
 */
export function saveFromServer(path: string, name: string): Promise<void> {
  if (saver) return saver.fromServer(path, name);
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.src = path;
  document.body.appendChild(frame);
  // Long enough for the response headers to arrive and the download to be
  // handed to the browser; the transfer itself carries on without the frame.
  setTimeout(() => frame.remove(), 60_000);
  return Promise.resolve();
}

/** A file this page built, saved under `name`. */
export function saveBlob(blob: Blob, name: string): Promise<void> {
  if (saver) return saver.fromBlob(blob, name);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking immediately can beat the download in
  // some browsers and produce an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return Promise.resolve();
}

/** Today, as file names here spell it: `2026-11-15`. */
export const fileDate = (): string => new Date().toISOString().slice(0, 10);
