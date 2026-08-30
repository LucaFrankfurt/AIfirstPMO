/**
 * An export as one file.
 *
 * The JSON document is the export; this is the envelope that lets it carry the
 * uploaded files as well. A project whose pages are full of screenshots is not
 * really exported by a document that describes the screenshots, and "download
 * the JSON, then download the attachments separately" is a sentence nobody
 * finishes reading.
 *
 * Inside:
 *
 *     kolibri.json          the document, exactly as the JSON export writes it
 *     files/<hash>.<ext>    the blobs it refers to, named by their own checksum
 *     README.txt            what this is, for whoever opens it in three years
 *
 * The archive is written **as it goes**, one blob at a time, so exporting a
 * workspace with a gigabyte of attachments does not first build a gigabyte in
 * memory. Reading one is the other way round — an upload is bounded by a limit
 * the caller sets, and a ZIP can only be read from its end anyway.
 */
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';
import { get, type Row } from '../../kernel/platform/db/index.ts';
import { badRequest } from '../../kernel/platform/http.ts';
import * as storage from '../../kernel/files/storage.ts';
import { ZipWriter, unzip } from '../../kernel/files/zip.ts';
import type { FileRef } from '../../adapters/transfer/transfer.ts';

/** The document's name inside the archive. */
export const DOCUMENT = 'kolibri.json';

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/svg+xml': '.svg', 'application/pdf': '.pdf',
  'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3',
};

/**
 * The name a blob gets in the archive.
 *
 * The hash, because that is what the document refers to and what proves the
 * bytes on the way back in. The extension is for the person who unpacks it and
 * wants to double-click a picture; nothing reads it.
 */
export const entryFor = (file: FileRef): string => `files/${file.hash}${EXTENSIONS[file.mime] ?? ''}`;

/** `files/<hash>.png` → the hash. Anything else is not a blob entry. */
export function hashOfEntry(name: string): string | null {
  const match = /^files\/([0-9a-f]{64})(\.[a-z0-9]+)?$/i.exec(name);
  return match ? match[1].toLowerCase() : null;
}

const README = (what: string) => `${what}

This is a Kolibri export.

  kolibri.json   the export itself — structure, tasks, pages, comments and the
                 rest, as one readable JSON document.
  files/         everything the document links to. Each file is named by the
                 SHA-256 of its own contents, which is also how the document
                 refers to it.

To read it back, import the .zip in Settings → Data (a workspace) or in
Project → Settings (a project). To read it with your own tools, kolibri.json is
the whole thing and needs nothing from this directory.

This is not a backup. A backup has to be exact and is taken with
"kolibri backup", which copies the database; this is a portable description
that still means something after the schema has moved on.
`;

/** Bytes for one stored blob, or null when the store no longer has them. */
async function bytesOf(hash: string): Promise<Buffer | null> {
  const row = get<Row>(`SELECT hash, mime, storage FROM files WHERE hash = ? LIMIT 1`, hash);
  if (!row) return null;
  const found = await storage.read(storage.keyFor(String(row.hash), String(row.mime)), (row.storage ?? 'disk') as storage.StorageKind);
  if (!found) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of found.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export interface ArchiveReport {
  /** Files named in the document whose bytes the store no longer holds. */
  missing: string[];
  bytes: number;
}

/**
 * Stream a document and its blobs to a `.zip`.
 *
 * The sink is normally an HTTP response, and then this writes the headers too,
 * so a caller returns `undefined` afterwards the way the file download route
 * does. Hand it a file stream instead — which is what the CLI does — and it
 * writes the archive and nothing else. One function either way, because an
 * operator's export and somebody's download differing is exactly the bug this
 * whole feature is meant not to have.
 */
export async function sendArchive(
  sink: ServerResponse | Writable,
  filename: string,
  doc: { files?: FileRef[] },
  title = filename,
): Promise<ArchiveReport> {
  const response = sink as ServerResponse;
  if (typeof response.writeHead === 'function') {
    response.writeHead(200, {
      'content-type': 'application/zip',
      // No length: the archive is compressed as it is written, so its size is
      // not known until the last byte. Chunked is the honest answer.
      'content-disposition': `attachment; filename="${filename.replace(/[\r\n"\\]/g, '_')}"`,
      'cache-control': 'no-store',
    });
  }

  const writer = new ZipWriter(sink);
  const at = new Date();
  const missing: string[] = [];
  let bytes = 0;

  await writer.add(DOCUMENT, Buffer.from(`${JSON.stringify(doc, null, 2)}\n`), at);
  await writer.add('README.txt', Buffer.from(README(title)), at);

  for (const file of doc.files ?? []) {
    const body = await bytesOf(file.hash);
    if (!body) { missing.push(file.name); continue; }
    bytes += body.length;
    await writer.add(entryFor(file), body, at);
  }

  await writer.end();
  return { missing, bytes };
}

/**
 * Read an archive: the document, and the bytes that came with it.
 *
 * Nothing is stored and nothing is written — this is the cheap half, so that a
 * caller can look at the document and decide what it is, and who is allowed to
 * import it, before a byte goes anywhere.
 *
 * Every entry is checked against the hash it is filed under. That is not
 * belt-and-braces: the store is content-addressed, so accepting bytes under
 * somebody else's hash would replace *their* file with these — which is why
 * the check is here and not in a comment saying it should be.
 */
export function readArchive(archive: Buffer): { document: unknown; blobs: Map<string, Buffer>; rejected: string[] } {
  const zip = unzip(archive);
  const raw = zip.read(DOCUMENT);
  if (!raw) throw badRequest(`That .zip is not a Kolibri export — it has no ${DOCUMENT} in it`);

  let document: unknown;
  try {
    document = JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest(`The ${DOCUMENT} inside that archive is not valid JSON`);
  }

  const blobs = new Map<string, Buffer>();
  const rejected: string[] = [];
  for (const name of zip.names()) {
    const hash = hashOfEntry(name);
    if (!hash) continue;
    const body = zip.read(name);
    if (!body) continue;
    if (createHash('sha256').update(body).digest('hex') !== hash) { rejected.push(name); continue; }
    blobs.set(hash, body);
  }
  return { document, blobs, rejected };
}

/**
 * Put the bytes in the store, and say which hashes are now there.
 *
 * Before the import rather than inside it, because storing is asynchronous and
 * importing is one transaction — and because a blob that ends up referenced by
 * nothing is harmless (content-addressed, deduplicated, and `kolibri doctor`
 * points at it) while a row referring to bytes that were never written is a
 * broken paperclip. No workspace is named here: which workspaces may read a
 * blob is a row in `files`, written by the import that knows the answer.
 */
export async function storeBlobs(blobs: Map<string, Buffer>, document: unknown): Promise<Set<string>> {
  const stored = new Set<string>();
  for (const [hash, body] of blobs) {
    const mime = mimeOf(document, hash);
    const key = storage.keyFor(hash, mime);
    const held = get<Row>(`SELECT storage FROM files WHERE hash = ? LIMIT 1`, hash);
    if (!held || !(await storage.exists(key, String(held.storage ?? 'disk') as storage.StorageKind))) {
      await storage.put(key, body, mime);
    }
    stored.add(hash);
  }
  return stored;
}

/**
 * What the document says about a blob.
 *
 * Both shapes are searched — a project document has one `files` list, a
 * workspace document has one of its own plus one per project — because this is
 * the only place that has to know, and the alternative is two functions that
 * agree until one of them is changed.
 */
function described(document: unknown, hash: string): FileRef | undefined {
  const doc = document as { files?: FileRef[]; projects?: { files?: FileRef[] }[] } | null;
  if (!doc || typeof doc !== 'object') return undefined;
  const lists = [doc.files ?? [], ...(doc.projects ?? []).map((project) => project.files ?? [])];
  for (const list of lists) {
    const found = list.find((file) => file?.hash === hash);
    if (found) return found;
  }
  return undefined;
}

/** The content type the document claims, since a ZIP entry carries none. */
const mimeOf = (document: unknown, hash: string): string =>
  described(document, hash)?.mime || 'application/octet-stream';
