/**
 * Pictures from this server, inside a board.
 *
 * A board's frame cannot fetch `/files/…` itself, for two reasons that are both
 * on purpose. Its origin is opaque, so a request from it carries no session and
 * the files route answers 401; and its policy allows pictures only from `data:`
 * and `blob:`, so it reaches no network at all. So the app — which has the
 * session, and the service worker's copy of every file it has seen, offline
 * included — fetches the picture and hands it in as a `data:` URL, in the
 * document it sends the frame.
 *
 * The board's source keeps saying `/files/<hash>/<name>`. That matters three
 * ways: the source stays small enough to merge as text, the trash still sees
 * the hash in `artboards.content` and keeps the blob, and a board exported or
 * read over MCP names the file rather than carrying a megabyte of base64. The
 * swap is made on the way into the frame and undone on the way out — see
 * `restoreFiles`, for text somebody typed beside a picture.
 */
import { authHeaders, serverUrl } from '../../kernel/sync/server';

/**
 * A stored file's address: a SHA-256 and a name, as `storeFile` writes it —
 * and only where it starts a value, after a quote, a bracket, an `=` or a
 * space. Without that, `https://elsewhere.example/files/<hash>/x.png` would
 * have its tail swapped for this server's picture of the same name.
 */
const FILE_PATH = /(?<=^|["'(=\s])\/files\/[0-9a-f]{64}\/[^"'()\s<>]+/gi;

/**
 * Past this, a picture is left as a broken link rather than posted into the
 * frame on every redraw. Uploads are downscaled to 2000px before they are
 * stored, so a photograph is well under it.
 */
const LARGEST = 8 * 1024 * 1024;

const cache = new Map<string, Promise<string | null>>();
/** `data:` URL → the path it stands for, to put the path back. */
const reverse = new Map<string, string>();

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

function dataUrlFor(path: string): Promise<string | null> {
  const known = cache.get(path);
  if (known) return known;
  const loading = fetch(serverUrl(path), { headers: authHeaders(), credentials: 'include' })
    .then((response) => (response.ok ? response.blob() : null))
    .then((blob) => (blob && blob.size <= LARGEST ? readAsDataUrl(blob) : null))
    .catch(() => null)
    .then((url) => {
      if (url) reverse.set(url, path);
      // A failure is not remembered: offline now is not offline in a minute.
      else cache.delete(path);
      return url;
    });
  cache.set(path, loading);
  return loading;
}

/** Whether a source names any file of this server's. */
export const hasFiles = (source: string): boolean => /\/files\/[0-9a-f]{64}\//i.test(source);

/** The paths of this server's files a source names, each once. */
export const filePaths = (source: string): string[] => [...new Set(source.match(FILE_PATH) ?? [])];

/**
 * The source with every picture of this server's swapped for its bytes.
 *
 * A picture that cannot be fetched keeps its path, which draws as a broken
 * image — the honest answer for a file this device has never seen and cannot
 * reach right now.
 */
export async function inlineFiles(source: string): Promise<string> {
  const paths = filePaths(source);
  if (!paths.length) return source;
  const urls = await Promise.all(paths.map(dataUrlFor));
  const byPath = new Map(paths.map((path, at) => [path, urls[at]]));
  // The same pattern that found them, so a path inside somebody else's URL is
  // left alone here too.
  return source.replace(FILE_PATH, (path) => byPath.get(path) ?? path);
}

/**
 * Put the paths back into markup that came out of the frame.
 *
 * Typing beside a picture sends the paragraph's inner HTML back, picture and
 * all — and the picture inside the frame is a `data:` URL. Saved as it came,
 * that would write the whole image into the board's source as text.
 */
export function restoreFiles(html: string): string {
  if (!html.includes('data:')) return html;
  let out = html;
  for (const [url, path] of reverse) if (out.includes(url)) out = out.split(url).join(path);
  return out;
}
