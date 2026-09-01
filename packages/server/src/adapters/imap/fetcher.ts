/**
 * The transport `modules/mail` asked for, filled in.
 *
 * `poll.ts` declares a `MailFetcher` and this registers one — the arrangement
 * rule 7 requires, and the reason the capability can be read end to end without
 * knowing that IMAP exists. What it takes to satisfy that interface is three
 * methods, and the interesting one is `fetch`, which has to answer "everything
 * new in this folder" without downloading the attachments.
 *
 * It does that in two passes:
 *
 *   1. `UID SEARCH` for what is new, then a metadata `UID FETCH` — envelope,
 *      structure, flags, size. No bodies. One command for the whole batch.
 *   2. A `UID FETCH` per *distinct text section*, for the messages that have
 *      one. In practice a batch of five hundred messages uses two or three
 *      section numbers, so this is two or three commands rather than five
 *      hundred — and the eight-megabyte PDF is never on the wire at all.
 *
 * The alternative, `BODY.PEEK[]` for everything, is four lines shorter and
 * downloads the whole mailbox. On the ten-year archive this feature is for,
 * that is the difference between a first pass overnight and a first pass over a
 * fortnight.
 */
import { registerMailFetcher, type MailFetcher } from '../../modules/mail/poll.ts';
import type { FetchedMessage } from '../../modules/mail/store.ts';
import { ImapConnection, ImapError, quote } from './imap.ts';
import {
  asList, asText, chooseParts, filenameParams, flattenStructure, isNil, type Token,
} from './protocol.ts';
import { decodeBody, decodeParameter, decodeWords, htmlToText, parseHeaders } from './mime.ts';

/**
 * How much of one body to keep.
 *
 * A mailing list digest is half a megabyte of quoted replies, and storing it
 * whole means the database grows faster than the mailbox it mirrors. A hundred
 * kilobytes is several times longer than any message anybody writes, and the
 * part that gets cut is the quoted history — which is already indexed, on the
 * message it was quoted from.
 */
const MAX_BODY = 100_000;

const imapFetcher: MailFetcher = {
  async fetch(config, folder, options) {
    const connection = await ImapConnection.open(config);
    try {
      // EXAMINE, not SELECT: read-only at the server, so nothing here can mark
      // a message as read or remove one. See the note at the top of `imap.ts`.
      await connection.expect(`EXAMINE ${quote(folder)}`);

      const uids = await search(connection, options.sinceUid, options.sinceDays);
      if (!uids.length) return [];
      // Oldest first, and capped: a first pass over a decade arrives in batches
      // that each commit, so an interruption costs one batch rather than all of
      // it. Ascending order is what makes that work — `highestUid` is then a
      // watermark and not a hole.
      const wanted = uids.sort((a, b) => a - b).slice(0, options.limit);

      const messages = await metadata(connection, wanted);
      await fillBodies(connection, messages);
      return [...messages.values()].sort((a, b) => a.uid - b.uid);
    } finally {
      connection.end();
    }
  },

  async fetchPart(config, folder, uid, part) {
    const connection = await ImapConnection.open(config);
    try {
      await connection.expect(`EXAMINE ${quote(folder)}`);
      const response = await connection.expect(`UID FETCH ${uid} (BODY.PEEK[${part}])`);
      for (const tokens of response.untagged) {
        const items = asList(tokens[2]);
        for (let i = 0; i + 1 < items.length; i += 1) {
          if (!asText(items[i]).toUpperCase().startsWith('BODY[')) continue;
          const value = items[i + 1];
          const raw = value.kind === 'literal' ? value.value : Buffer.from(asText(value), 'latin1');
          // Decoded here rather than by the caller: what is on the wire is
          // base64 and what a browser is handed has to be the file. The
          // encoding is on the part, and the part is what was just asked for.
          const encoding = await encodingOf(connection, uid, part);
          return encoding === 'base64'
            ? Buffer.from(raw.toString('ascii'), 'base64')
            : encoding === 'quoted-printable'
              ? Buffer.from(decodeBody(raw, 'quoted-printable', 'latin1'), 'latin1')
              : raw;
        }
      }
      throw new ImapError('That part is not in the message any more', true);
    } finally {
      connection.end();
    }
  },

  async check(config) {
    const connection = await ImapConnection.open(config);
    try {
      // Signing in proves the credential; selecting INBOX proves the account
      // has one this client can read, which is the other half of what somebody
      // pressing Test wants to know.
      await connection.expect('EXAMINE "INBOX"');
    } finally {
      connection.end();
    }
  },
};

export function installImapFetcher(): void {
  registerMailFetcher(imapFetcher);
}

/* ----------------------------------------------------------------- the passes */

/**
 * Which UIDs are new.
 *
 * `UID SEARCH UID n:*` is the incremental case and it has a quirk worth naming:
 * `n:*` always matches at least one message — the highest — even when that is
 * below `n`, because the range is normalised rather than empty. So the result
 * is filtered again here, and a mailbox with nothing new returns nothing rather
 * than re-fetching its newest message every five minutes forever.
 *
 * On a first pass there is no watermark, so the bound is a date instead. `SINCE`
 * takes IMAP's own date form — `1-Jan-2024` — which is not any ISO format and
 * is not the locale's either.
 */
async function search(connection: ImapConnection, sinceUid: number, sinceDays: number): Promise<number[]> {
  const criteria = sinceUid > 0
    ? `UID ${sinceUid + 1}:*`
    : sinceDays > 0
      ? `SINCE ${imapDate(new Date(Date.now() - sinceDays * 86_400_000))}`
      : 'ALL';
  const response = await connection.expect(`UID SEARCH ${criteria}`);
  const found: number[] = [];
  for (const tokens of response.untagged) {
    if (asText(tokens[1]).toUpperCase() !== 'SEARCH') continue;
    for (const token of tokens.slice(2)) {
      const value = Number(asText(token));
      if (Number.isFinite(value) && value > sinceUid) found.push(value);
    }
  }
  return found;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (date: Date): string =>
  `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;

interface Pending extends FetchedMessage {
  /** Which section holds the text, and whether it needs flattening from HTML. */
  textPart?: string;
  textEncoding?: string;
  textCharset?: string;
  textIsHtml?: boolean;
}

/** Everything except the bodies, for a whole batch, in one command. */
async function metadata(connection: ImapConnection, uids: number[]): Promise<Map<number, Pending>> {
  const response = await connection.expect(
    `UID FETCH ${ranges(uids)} (UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (REFERENCES IN-REPLY-TO)])`,
  );
  const out = new Map<number, Pending>();
  for (const tokens of response.untagged) {
    if (asText(tokens[2]).toUpperCase() !== 'FETCH') continue;
    const message = readOne(asList(tokens[3]));
    if (message) out.set(message.uid, message);
  }
  return out;
}

/** `(UID 12 FLAGS (\Seen) ENVELOPE (…) …)` -> one message, or nothing usable. */
function readOne(items: Token[]): Pending | null {
  const fields = new Map<string, Token>();
  for (let i = 0; i + 1 < items.length; i += 2) fields.set(asText(items[i]).toUpperCase(), items[i + 1]);

  const uid = Number(asText(fields.get('UID')));
  if (!Number.isFinite(uid) || uid <= 0) return null;

  const envelope = asList(fields.get('ENVELOPE'));
  const parts = flattenStructure(fields.get('BODYSTRUCTURE'));
  const { text, html, attachments } = chooseParts(parts);
  const headerToken = [...fields.entries()].find(([key]) => key.startsWith('BODY['))?.[1];
  const headers = parseHeaders(headerToken?.kind === 'literal' ? headerToken.value : Buffer.alloc(0));

  // `References` is a chain and the first entry is the message that started the
  // conversation — the one key every client agrees on. Falling back to
  // `In-Reply-To` gives a thread of two rather than none.
  const references = [...(headers.references ?? headers['in-reply-to'] ?? '').matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  const chosen = text ?? html;

  return {
    uid,
    messageId: stripAngles(asText(envelope[9])),
    references,
    subject: decodeWords(asText(envelope[1])),
    ...sender(envelope[2]),
    to: addresses(envelope[5]),
    cc: addresses(envelope[6]),
    sentAt: sentAt(asText(envelope[0]), asText(fields.get('INTERNALDATE'))),
    seen: flagged(fields.get('FLAGS'), '\\SEEN'),
    size: Number(asText(fields.get('RFC822.SIZE'))) || 0,
    body: '',
    attachments: attachments.map((part) => ({
      filename: decodeParameter(filenameParams(part), 'filename') || `part-${part.part}`,
      mime: `${part.type}/${part.subtype}`,
      // base64 inflates by a third, and the number in `BODYSTRUCTURE` is the
      // encoded size. Reporting that would make every PDF a third larger than
      // the one that lands in somebody's downloads folder.
      size: part.encoding === 'base64' ? Math.round(part.size * 0.75) : part.size,
      part: part.part,
    })),
    textPart: chosen?.part,
    textEncoding: chosen?.encoding,
    textCharset: chosen?.params.charset,
    textIsHtml: !!chosen && chosen === html,
  };
}

/**
 * The bodies, grouped by section number.
 *
 * The grouping is what makes this two commands rather than five hundred: almost
 * every message in a batch has its text at `1` or at `1.1`, so there are two or
 * three distinct sections across the whole batch and each is one `UID FETCH`
 * over the messages that use it.
 */
async function fillBodies(connection: ImapConnection, messages: Map<number, Pending>): Promise<void> {
  const bySection = new Map<string, number[]>();
  for (const message of messages.values()) {
    if (!message.textPart) continue;
    const list = bySection.get(message.textPart) ?? [];
    list.push(message.uid);
    bySection.set(message.textPart, list);
  }

  for (const [section, uids] of bySection) {
    const response = await connection.command(`UID FETCH ${ranges(uids)} (UID BODY.PEEK[${section}]<0.${MAX_BODY}>)`);
    // A section a server will not hand over is a message indexed on its subject
    // and its attachment names, which is worth more than a failed batch — so
    // this does not throw. The scanned-PDF case has no body at all and is
    // already handled the same way.
    if (response.status !== 'OK') continue;
    for (const tokens of response.untagged) {
      if (asText(tokens[2]).toUpperCase() !== 'FETCH') continue;
      const items = asList(tokens[3]);
      const fields = new Map<string, Token>();
      for (let i = 0; i + 1 < items.length; i += 2) fields.set(asText(items[i]).toUpperCase(), items[i + 1]);
      const message = messages.get(Number(asText(fields.get('UID'))));
      if (!message) continue;
      const value = [...fields.entries()].find(([key]) => key.startsWith('BODY['))?.[1];
      if (!value || isNil(value)) continue;
      const raw = value.kind === 'literal' ? value.value : Buffer.from(asText(value), 'latin1');
      const decoded = decodeBody(raw, message.textEncoding, message.textCharset);
      message.body = (message.textIsHtml ? htmlToText(decoded) : decoded).slice(0, MAX_BODY);
    }
  }
}

/** What encoding a part declared, asked of the structure rather than remembered. */
async function encodingOf(connection: ImapConnection, uid: number, part: string): Promise<string> {
  const response = await connection.command(`UID FETCH ${uid} (BODYSTRUCTURE)`);
  for (const tokens of response.untagged) {
    if (asText(tokens[2]).toUpperCase() !== 'FETCH') continue;
    const items = asList(tokens[3]);
    for (let i = 0; i + 1 < items.length; i += 2) {
      if (asText(items[i]).toUpperCase() !== 'BODYSTRUCTURE') continue;
      const found = flattenStructure(items[i + 1]).find((one) => one.part === part);
      if (found) return found.encoding;
    }
  }
  return 'base64';
}

/* -------------------------------------------------------------------- bits */

/** `[1,2,3,7,8]` -> `1:3,7:8`. A batch of five hundred is otherwise a long line. */
export function ranges(uids: number[]): string {
  const sorted = [...uids].sort((a, b) => a - b);
  const out: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (const uid of sorted.slice(1)) {
    if (uid === end + 1) {
      end = uid;
      continue;
    }
    out.push(start === end ? String(start) : `${start}:${end}`);
    start = uid;
    end = uid;
  }
  if (sorted.length) out.push(start === end ? String(start) : `${start}:${end}`);
  return out.join(',');
}

/** An envelope address list: `((name adl mailbox host) …)`. */
function addresses(token: Token | undefined): string[] {
  return asList(token)
    .map((entry) => {
      const parts = asList(entry);
      const mailbox = asText(parts[2]);
      const host = asText(parts[3]);
      return mailbox && host ? `${mailbox}@${host}`.toLowerCase() : '';
    })
    .filter(Boolean);
}

/** The sender's name and address, from the envelope's `From`. */
function sender(token: Token | undefined): { fromName: string; fromAddress: string } {
  const first = asList(asList(token)[0]);
  const mailbox = asText(first[2]);
  const host = asText(first[3]);
  return {
    fromName: decodeWords(asText(first[0])),
    fromAddress: mailbox && host ? `${mailbox}@${host}`.toLowerCase() : '',
  };
}

/**
 * When it was sent.
 *
 * The `Date` header first, because that is what the sender said and what a
 * mail client shows. `INTERNALDATE` — when this server received it — is the
 * fallback, and it is the *right* fallback rather than "now": a message with no
 * parseable date would otherwise sort to today and land in the wrong tax year,
 * which is the one mistake this feature really cannot make.
 */
function sentAt(header: string, internal: string): number {
  const declared = Date.parse(header);
  if (Number.isFinite(declared)) return declared;
  // `"17-Aug-2024 09:14:02 +0200"` — not a format `Date.parse` knows, so the
  // day and the month swap places before it is asked.
  const match = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+([\d:]+)\s*([+-]\d{4})?/.exec(internal);
  if (match) {
    const parsed = Date.parse(`${match[2]} ${match[1]}, ${match[3]} ${match[4]} ${match[5] ?? 'Z'}`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

const flagged = (token: Token | undefined, flag: string): boolean =>
  asList(token).some((one) => asText(one).toUpperCase() === flag);

const stripAngles = (value: string): string => value.replace(/^<|>$/g, '');
