/**
 * Turning what a mail server sends into text somebody can search.
 *
 * The counterpart to `buildMessage` in the SMTP client, and considerably less
 * pleasant, because writing a message means choosing one encoding and reading
 * one means accepting every choice anybody has made since 1992. A German
 * subject line arrives as `=?iso-8859-1?Q?Rechnung_f=FCr_M=E4rz?=`, a body as
 * quoted-printable in Windows-1252, and an invoice as base64 with a filename
 * split across two encoded words. All three are ordinary.
 *
 * The rule throughout is that **a message that cannot be decoded is still
 * indexed**. Every function here degrades rather than throws: an unknown
 * charset falls back to Latin-1, which is wrong for a few characters and right
 * for the shape of the words, and a body that decodes to mojibake is still a
 * body somebody can find by searching for the invoice number in it. Refusing to
 * store a message because its charset was misdeclared would lose exactly the
 * old, badly-formed mail that somebody is digging through their archive for.
 */
import { StringDecoder } from 'node:string_decoder';

/**
 * The charsets Node can decode, and what to do about the rest.
 *
 * Node's `Buffer` knows utf-8, latin1, ascii and the UTF-16 pair, and
 * `TextDecoder` adds the whole WHATWG list — windows-1252, iso-8859-15,
 * koi8-r — when the build has ICU, which the official Node images do and a
 * `--without-intl` build does not. So it is tried and its absence is survived,
 * rather than assumed either way.
 */
export function decodeText(bytes: Buffer, charset?: string): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!label || label === 'utf-8' || label === 'utf8' || label === 'us-ascii' || label === 'ascii') {
    return bytes.toString('utf8');
  }
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    // Latin-1 rather than utf-8 as the fallback: every byte is a character, so
    // nothing becomes a replacement mark, and for the Western European charsets
    // this is standing in for it differs only in the punctuation.
    return bytes.toString('latin1');
  }
}

/**
 * `=?UTF-8?B?…?=` and `=?iso-8859-1?Q?…?=` in a header, decoded.
 *
 * Adjacent encoded words separated only by whitespace are joined *without* it,
 * which is RFC 2047's rule and matters more than it sounds: a long German
 * subject is split into words at arbitrary points, so keeping the separating
 * space turns `Rechnung` into `Rech nung` and the message stops being findable
 * by the word it is about.
 */
export function decodeWords(raw: string): string {
  if (!raw || !raw.includes('=?')) return raw ?? '';
  const pattern = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let out = '';
  let last = 0;
  let previousEnd = -1;
  for (const match of raw.matchAll(pattern)) {
    const start = match.index ?? 0;
    const between = raw.slice(last, start);
    // Whitespace *between two encoded words* is a fold and goes; whitespace
    // anywhere else is a space somebody typed and stays.
    out += previousEnd === last && /^\s*$/.test(between) ? '' : between;
    const [, charset, encoding, text] = match;
    const bytes = encoding.toLowerCase() === 'b'
      ? Buffer.from(text, 'base64')
      : decodeQuotedPrintable(text.replace(/_/g, ' '));
    out += decodeText(bytes, charset);
    last = start + match[0].length;
    previousEnd = last;
  }
  return out + raw.slice(last);
}

/**
 * Quoted-printable, to bytes rather than to a string.
 *
 * Bytes, because `=FC` is one byte whose meaning depends on the charset the
 * header declared, and decoding to a string here would mean guessing it twice.
 * Soft line breaks — `=` at end of line — vanish, which is what makes a
 * decoded body one paragraph rather than seventy-six-character lines.
 */
export function decodeQuotedPrintable(text: string): Buffer {
  const out: number[] = [];
  const clean = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < clean.length; i += 1) {
    if (clean[i] === '=' && /^[0-9a-f]{2}$/i.test(clean.slice(i + 1, i + 3))) {
      out.push(parseInt(clean.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    // A character above 255 in what is supposed to be 7-bit text: some senders
    // put raw UTF-8 in a part they labelled quoted-printable. Its own bytes are
    // the honest answer.
    const code = clean.charCodeAt(i);
    if (code > 255) out.push(...Buffer.from(clean[i], 'utf8'));
    else out.push(code);
  }
  return Buffer.from(out);
}

/** A part's bytes, given what its `Content-Transfer-Encoding` claimed. */
export function decodeBody(raw: Buffer, encoding: string | undefined, charset?: string): string {
  const how = (encoding ?? '7bit').trim().toLowerCase();
  if (how === 'base64') {
    // `Buffer.from(…, 'base64')` ignores whatever is not base64, which is
    // exactly right here: the payload arrives wrapped at 76 characters.
    return decodeText(Buffer.from(raw.toString('ascii'), 'base64'), charset);
  }
  if (how === 'quoted-printable') return decodeText(decodeQuotedPrintable(raw.toString('latin1')), charset);
  return decodeText(raw, charset);
}

/**
 * HTML to something worth indexing.
 *
 * Not a renderer and not trying to be. What it has to get right is that the
 * words survive and the markup does not: a marketing mail is 40 kB of table
 * layout around two sentences, and indexing the raw HTML means every message
 * matches a search for `padding`. Scripts and styles go entirely, block-level
 * tags become line breaks so paragraphs stay apart, and entities are resolved
 * so that `&euro;1.234,56` is findable as an amount.
 *
 * Links keep their text and lose their href. An invoice mail is mostly a button
 * saying "View invoice" pointing at a signed URL nobody can search for, and
 * indexing those URLs means every message from a provider matches every other.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity[0] === '#') {
        const code = entity[1]?.toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return NAMED[entity.toLowerCase()] ?? whole;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The named entities worth having, and no more.
 *
 * The full list is two thousand names and none of the rest appear in mail. What
 * does appear is currency and punctuation, which is why they are here: an
 * amount written `&euro;99` has to be findable as `€99`.
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  euro: '€', pound: '£', dollar: '$', cent: '¢', yen: '¥',
  auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  bdquo: '„', ldquo: '“', rdquo: '”', sbquo: '‚', lsquo: '‘', rsquo: '’',
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•',
};

/**
 * A `Content-Type` or `Content-Disposition` parameter, decoded.
 *
 * Handles RFC 2231 continuations — `filename*0`, `filename*1` — and its
 * percent-encoded charset form, `filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf`,
 * because that is how anything sent from a modern client names a file with a
 * space or an umlaut in it. A filename is the single most useful thing about an
 * attachment in this feature, so it is worth decoding properly rather than
 * showing `=?utf-8?B?…?=` in a list of documents.
 */
export function decodeParameter(params: Record<string, string>, name: string): string {
  const direct = params[name];
  const extended = params[`${name}*`];
  if (extended) return decodeExtended(extended);

  // Continuations, in order, until one is missing.
  const parts: string[] = [];
  for (let index = 0; ; index += 1) {
    const plain = params[`${name}*${index}`];
    const encoded = params[`${name}*${index}*`];
    if (plain === undefined && encoded === undefined) break;
    parts.push(encoded !== undefined ? decodeExtended(encoded, index > 0) : plain!);
  }
  if (parts.length) return parts.join('');
  return direct ? decodeWords(direct) : '';
}

/** `UTF-8''Rechnung%20M%C3%A4rz.pdf` — the charset is only on the first section. */
function decodeExtended(value: string, continuation = false): string {
  const match = /^([^']*)'([^']*)'(.*)$/.exec(value);
  const charset = continuation || !match ? undefined : match[1];
  const text = match ? match[3] : value;
  const bytes = Buffer.from(text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))), 'latin1');
  return decodeText(bytes, charset);
}

/**
 * Split raw header bytes into a name-to-value map, unfolding as it goes.
 *
 * Repeated headers are joined with a comma, which is right for `Received` and
 * `References` and harmless for the rest — and better than keeping only one,
 * because `References` arriving in two lines is how a long thread looks.
 *
 * A `StringDecoder` rather than `toString`: header bytes are 7-bit by the RFC
 * and are not always, and cutting a multi-byte character in half is how a
 * subject ends in a replacement mark.
 */
export function parseHeaders(raw: Buffer): Record<string, string> {
  const decoder = new StringDecoder('latin1');
  const text = decoder.write(raw) + decoder.end();
  const out: Record<string, string> = {};
  // A continuation line starts with whitespace and belongs to the line above.
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    out[name] = out[name] ? `${out[name]}, ${value}` : value;
  }
  return out;
}
