/**
 * A ZIP file, written out rather than pulled in.
 *
 * An export that carries the uploaded files has to be one file — nobody emails
 * a directory — and ZIP is the one container every operating system opens by
 * double-clicking. The alternative was a dependency, which for a package with
 * none at all is a poor trade for the two hundred lines below.
 *
 * What it does:
 *
 *   - **Writes as it goes.** Each entry is compressed, written and forgotten,
 *     so a workspace with a gigabyte of attachments costs one attachment of
 *     memory rather than a gigabyte. The central directory is the only thing
 *     held to the end, and that is a name and four numbers per entry.
 *   - **Deflates, unless that makes it bigger.** A JPEG deflates to slightly
 *     more than a JPEG. Both are tried and the smaller kept, which is one
 *     comparison and always right — a table of which types compress is a table
 *     that goes stale.
 *   - **Says the names are UTF-8**, via the general-purpose bit every unpacker
 *     has honoured for fifteen years. Without it a German filename arrives as
 *     mojibake on Windows.
 *
 * What it does not do is **Zip64**: an archive of four gigabytes or more, or
 * one with more than 65 535 entries, is refused by name rather than written as
 * a file that only some unpackers can read. The refusal names the limit; see
 * `docs/export.md` for what to do about it.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Writable } from 'node:stream';

/** Signatures, in the order a reader meets them. */
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

/** Deflate, or stored when deflating did not help. */
const DEFLATED = 8;
const STORED = 0;

/** Bit 11: the name and comment are UTF-8. */
const UTF8_NAMES = 0x800;

/** Beyond this a ZIP needs the Zip64 extensions, which this does not write. */
const MAX_SIZE = 0xffffffff;
const MAX_ENTRIES = 0xffff;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes: Buffer): number {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * MS-DOS time, which is what a ZIP records and is therefore what every
 * unpacker shows. Two-second resolution, and no year before 1980 — a date
 * that cannot be represented is clamped rather than wrapped into 1994.
 */
const dosTime = (at: Date): number =>
  ((at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1)) & 0xffff;

const dosDate = (at: Date): number => {
  const year = Math.max(1980, at.getFullYear());
  return (((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()) & 0xffff;
};

interface Written {
  name: Buffer;
  crc: number;
  method: number;
  compressed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** Compress, unless the compressed form is not actually smaller. */
function pack(body: Buffer): { method: number; bytes: Buffer } {
  if (!body.length) return { method: STORED, bytes: body };
  const deflated = deflateRawSync(body, { level: 6 });
  return deflated.length < body.length ? { method: DEFLATED, bytes: deflated } : { method: STORED, bytes: body };
}

/**
 * Write a ZIP into a stream, one entry at a time.
 *
 * `add` returns a promise that settles when the sink has taken the bytes, so
 * awaiting it is what keeps a slow client from filling memory with an archive
 * it is not reading fast enough.
 */
export class ZipWriter {
  private entries: Written[] = [];
  private offset = 0;
  private ended = false;
  private readonly sink: Writable;

  constructor(sink: Writable) {
    this.sink = sink;
  }

  private write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (this.offset > MAX_SIZE) {
      throw new Error('This archive would be over 4 GB, which needs Zip64 — export in parts instead');
    }
    if (this.sink.write(chunk)) return Promise.resolve();
    // Both listeners are removed whichever fires. Leaving them attached
    // accumulates one pair per paused write, and an archive of ten thousand
    // files to a slow client would spend the rest of its life warning about
    // a memory leak it had actually caused.
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        this.sink.off('drain', drained);
        this.sink.off('error', failed);
        if (error) reject(error); else resolve();
      };
      const drained = () => done();
      const failed = (error: Error) => done(error);
      this.sink.once('drain', drained);
      this.sink.once('error', failed);
    });
  }

  async add(name: string, body: Buffer, at: Date = new Date()): Promise<void> {
    if (this.ended) throw new Error('The archive has already been closed');
    if (this.entries.length >= MAX_ENTRIES) {
      throw new Error(`This archive would hold more than ${MAX_ENTRIES} files, which needs Zip64 — export in parts instead`);
    }
    // Backslashes are separators on one platform and legal in a name on
    // another; a ZIP says forward slashes, and a leading one makes an
    // unpacker write outside the directory it was pointed at.
    const encoded = Buffer.from(name.replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8');
    const { method, bytes } = pack(body);
    const entry: Written = {
      name: encoded,
      crc: crc32(body),
      method,
      compressed: bytes.length,
      size: body.length,
      offset: this.offset,
      time: dosTime(at),
      date: dosDate(at),
    };

    const header = Buffer.allocUnsafe(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(20, 4); // the version that understands deflate
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(entry.time, 10);
    header.writeUInt16LE(entry.date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compressed, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(encoded.length, 26);
    header.writeUInt16LE(0, 28); // no extra field

    await this.write(header);
    await this.write(encoded);
    if (bytes.length) await this.write(bytes);
    this.entries.push(entry);
  }

  /** Write the central directory and close the stream. */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const start = this.offset;

    for (const entry of this.entries) {
      const header = Buffer.allocUnsafe(46);
      header.writeUInt32LE(CENTRAL, 0);
      header.writeUInt16LE(20, 4); // version made by
      header.writeUInt16LE(20, 6); // version needed
      header.writeUInt16LE(UTF8_NAMES, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk number
      header.writeUInt16LE(0, 36); // internal attributes
      // 0o644 in the high half, where every unpacker on a unix looks for it.
      header.writeUInt32LE(0o644 << 16, 38);
      header.writeUInt32LE(entry.offset, 42);
      await this.write(header);
      await this.write(entry.name);
    }

    const end = Buffer.allocUnsafe(22);
    end.writeUInt32LE(EOCD, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    end.writeUInt16LE(0, 20); // no archive comment
    await this.write(end);

    await new Promise<void>((resolve, reject) => {
      this.sink.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }
}

/** Everything in one buffer, for the callers small enough not to care. */
export async function zip(files: { name: string; body: Buffer }[], at?: Date): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = {
    write(chunk: Buffer) { chunks.push(Buffer.from(chunk)); return true; },
    once() { /* never pauses, so it never drains */ },
    end(done?: (error?: Error | null) => void) { done?.(null); },
  } as unknown as Writable;

  const writer = new ZipWriter(sink);
  for (const file of files) await writer.add(file.name, file.body, at);
  await writer.end();
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ reading */

export interface ZipFile {
  names(): string[];
  has(name: string): boolean;
  /** The bytes, or null for a name that is not in the archive. */
  read(name: string): Buffer | null;
  /** What an entry claims to be, without unpacking it. */
  size(name: string): number | null;
}

/**
 * Read an archive from the central directory backwards, which is the only way
 * a ZIP is meant to be read: the local headers are allowed to lie about sizes
 * (that is what a data descriptor is for), and the directory never does.
 */
export function unzip(archive: Buffer): ZipFile {
  const eocd = findEocd(archive);
  if (eocd < 0) throw new Error('That is not a ZIP file — no end-of-central-directory record');

  const total = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries = new Map<string, { offset: number; method: number; compressed: number; size: number; crc: number }>();

  for (let index = 0; index < total; index++) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL) {
      throw new Error('That ZIP file is damaged — its directory ends early');
    }
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressed = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const offset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    // A directory entry carries no bytes; keeping it would make `names()` list
    // things that cannot be read.
    if (!name.endsWith('/')) entries.set(name, { offset, method, compressed, size, crc });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  const bytesOf = (name: string): Buffer | null => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (archive.readUInt32LE(entry.offset) !== LOCAL) throw new Error(`${name} is not where the ZIP directory says it is`);
    // The local header repeats the name and may carry a different extra field,
    // so where the data starts is read from *it* rather than from the directory.
    const nameLength = archive.readUInt16LE(entry.offset + 26);
    const extraLength = archive.readUInt16LE(entry.offset + 28);
    const start = entry.offset + 30 + nameLength + extraLength;
    const raw = archive.subarray(start, start + entry.compressed);
    const body = entry.method === DEFLATED ? inflateRawSync(raw) : Buffer.from(raw);
    // The checksum is the whole reason a ZIP has one: a truncated download is
    // a file that unpacks into plausible nonsense unless somebody checks.
    if (crc32(body) !== entry.crc) throw new Error(`${name} is corrupt — the checksum does not match`);
    return body;
  };

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read: bytesOf,
    size: (name) => entries.get(name)?.size ?? null,
  };
}

/**
 * The end record is at the end, unless there is an archive comment — so it is
 * searched for backwards over the 64 KB a comment may occupy.
 */
function findEocd(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - 22 - 0xffff);
  for (let at = archive.length - 22; at >= earliest; at--) {
    if (archive.readUInt32LE(at) === EOCD) return at;
  }
  return -1;
}
