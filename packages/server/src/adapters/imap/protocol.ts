/**
 * Reading what an IMAP server says, without a mail library.
 *
 * The same argument the SMTP client makes and a harder case, so it is worth
 * making again: pulling in an IMAP library would be the single largest
 * dependency in a server that has none, and it would arrive with a MIME parser,
 * a charset table and a transitive tree nobody here has read. What is needed
 * instead is a read-only subset — sign in, list, select, search, fetch — and
 * that is a grammar of five token kinds.
 *
 * This file is the grammar. `imap.ts` is the conversation.
 *
 * IMAP's syntax is a parenthesised list of atoms, quoted strings and
 * **literals** — `{4021}` followed by exactly that many bytes, which is the one
 * part that stops a line-oriented reader working, because those bytes contain
 * newlines, quotes and unbalanced brackets from somebody's email. So a response
 * is read as a sequence of *segments* — text, literal, text, literal — and
 * tokenised across them, and the literal never touches the character scanner.
 */

export type Segment = { text: string } | { literal: Buffer };

export type Token =
  | { kind: 'atom'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'literal'; value: Buffer }
  | { kind: 'list'; items: Token[] };

/** `NIL` is IMAP's null and is an atom; this is the check every reader needs. */
export const isNil = (token: Token | undefined): boolean =>
  !token || (token.kind === 'atom' && token.value.toUpperCase() === 'NIL');

/** An atom, a quoted string or a literal, as text. `NIL` reads as empty. */
export function asText(token: Token | undefined): string {
  if (!token || isNil(token)) return '';
  if (token.kind === 'literal') return token.value.toString('latin1');
  if (token.kind === 'list') return '';
  return token.value;
}

export const asNumber = (token: Token | undefined): number => {
  const value = Number(asText(token));
  return Number.isFinite(value) ? value : 0;
};

export const asList = (token: Token | undefined): Token[] =>
  (token && token.kind === 'list' ? token.items : []);

/**
 * Segments to tokens.
 *
 * Square brackets are deliberately *not* structural. They appear in response
 * codes — `[UIDVALIDITY 1234]` — and in fetch item names — `BODY[HEADER.FIELDS
 * (REFERENCES)]` — and treating them as a nesting level makes the second one
 * parse as three tokens where the server meant one name. So `BODY[…]` stays a
 * single atom, brackets and all, which is what the fetch reader wants to match
 * on anyway.
 */
export function tokenise(segments: Segment[]): Token[] {
  const root: Token[] = [];
  const stack: Token[][] = [root];

  for (const segment of segments) {
    if ('literal' in segment) {
      stack[stack.length - 1].push({ kind: 'literal', value: segment.literal });
      continue;
    }
    const text = segment.text;
    let i = 0;
    while (i < text.length) {
      const char = text[i];
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
        i += 1;
        continue;
      }
      if (char === '(') {
        const list: Token = { kind: 'list', items: [] };
        stack[stack.length - 1].push(list);
        stack.push(list.items);
        i += 1;
        continue;
      }
      if (char === ')') {
        // A stray close paren is somebody else's bug and must not empty the
        // stack: the next push would then land on the root and the whole
        // response would reparse as garbage rather than as one odd field.
        if (stack.length > 1) stack.pop();
        i += 1;
        continue;
      }
      if (char === '"') {
        let value = '';
        i += 1;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\' && i + 1 < text.length) i += 1;
          value += text[i];
          i += 1;
        }
        i += 1;
        stack[stack.length - 1].push({ kind: 'string', value });
        continue;
      }
      // An atom runs to the next delimiter, except that a `[…]` inside it is
      // part of the name — see above.
      let value = '';
      let brackets = 0;
      while (i < text.length) {
        const c = text[i];
        if (c === '[') brackets += 1;
        else if (c === ']') brackets -= 1;
        else if (!brackets && (c === ' ' || c === '(' || c === ')' || c === '\r' || c === '\n')) break;
        value += c;
        i += 1;
      }
      if (value) stack[stack.length - 1].push({ kind: 'atom', value });
    }
  }
  return root;
}

/* ------------------------------------------------------------- body structure */

/**
 * One part of a message, as `BODYSTRUCTURE` describes it.
 *
 * `part` is the section number IMAP wants back — `1`, `2.1`, `TEXT` — and is
 * the whole reason for walking this: it is what lets the fetcher ask for the
 * text of a message without downloading the eight-megabyte PDF attached to it.
 * Downloading everything and picking the text out afterwards is the shape this
 * deliberately does not have; on a first pass over ten years of `info@` it is
 * the difference between an evening and a fortnight.
 */
export interface BodyPart {
  part: string;
  type: string;
  subtype: string;
  params: Record<string, string>;
  encoding: string;
  size: number;
  disposition: string;
  dispositionParams: Record<string, string>;
}

/**
 * Flatten a `BODYSTRUCTURE` into its leaves, numbered as IMAP numbers them.
 *
 * A multipart is a list whose first element is itself a list; a leaf is a list
 * whose first element is a string. That one check is the whole recursion.
 *
 * The numbering rule has one trap in it, and it is the reason a message with a
 * single text part is `1` while the text of a `multipart/alternative` inside a
 * `multipart/mixed` is `1.1`: children of a multipart at path *P* are *P.n*,
 * but the top level is not itself a part, so its children are bare `1`, `2`.
 * Getting that wrong produces a fetch that succeeds and returns the wrong
 * section, which is not an error anywhere — just a body that is somebody's
 * signature.
 */
export function flattenStructure(structure: Token | undefined, prefix = ''): BodyPart[] {
  const items = asList(structure);
  if (!items.length) return [];

  if (items[0]?.kind === 'list') {
    const out: BodyPart[] = [];
    let index = 0;
    for (const child of items) {
      if (child.kind !== 'list') break;
      index += 1;
      out.push(...flattenStructure(child, prefix ? `${prefix}.${index}` : String(index)));
    }
    return out;
  }

  const type = asText(items[0]).toLowerCase();
  const subtype = asText(items[1]).toLowerCase();
  const params = pairs(items[2]);
  const encoding = asText(items[5]).toLowerCase();
  const size = asNumber(items[6]);
  // The extension fields sit after the basic ones, and a text part has one more
  // basic field than anything else — the line count. So the disposition is at
  // index 9 for text and 8 for the rest, which is the kind of off-by-one that
  // produces "every PDF is called undefined" rather than an error.
  const dispositionAt = type === 'text' ? 9 : 8;
  const disposition = asList(items[dispositionAt]);

  return [{
    part: prefix || '1',
    type,
    subtype,
    params,
    encoding,
    size,
    disposition: asText(disposition[0]).toLowerCase(),
    dispositionParams: pairs(disposition[1]),
  }];
}

/** `("CHARSET" "UTF-8" "NAME" "x.pdf")` -> `{ charset: 'UTF-8', name: 'x.pdf' }`. */
function pairs(token: Token | undefined): Record<string, string> {
  const items = asList(token);
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < items.length; i += 2) out[asText(items[i]).toLowerCase()] = asText(items[i + 1]);
  return out;
}

/**
 * Which part holds the text, and which parts are files.
 *
 * `text/plain` wins over `text/html`, and both lose to nothing: a message with
 * no text part at all — a bare PDF from a scanner, which is most of what an
 * accountant is sent — is indexed on its subject and filename alone, and that
 * is enough to find it.
 *
 * A part counts as an attachment when it says so or when it has a filename.
 * The second half is what catches the older senders, which attach a PDF with no
 * `Content-Disposition` at all and only a `NAME` parameter on the type.
 */
export function chooseParts(parts: BodyPart[]): { text?: BodyPart; html?: BodyPart; attachments: BodyPart[] } {
  const named = (part: BodyPart): boolean => !!(part.dispositionParams.filename || part.params.name);
  const inline = parts.filter((part) => part.type === 'text' && part.disposition !== 'attachment' && !named(part));
  const text = inline.find((part) => part.subtype === 'plain');
  const html = inline.find((part) => part.subtype === 'html');
  const chosen = new Set([text?.part, html?.part].filter(Boolean));
  return {
    text,
    html,
    attachments: parts.filter((part) =>
      !chosen.has(part.part) && (part.disposition === 'attachment' || named(part) || part.type !== 'text')),
  };
}

/**
 * Every parameter that could name the file, in one map.
 *
 * The disposition's win over the content type's, which is the order the RFCs
 * intend and also the order that is right in practice: a sender that supplies
 * both usually has the useful name in the disposition and a legacy `NAME` on
 * the type. Merged rather than picked between, so that RFC 2231 continuations
 * spread across both survive to `decodeParameter`.
 */
export const filenameParams = (part: BodyPart): Record<string, string> => ({
  ...renameKey(part.params, 'name', 'filename'),
  ...part.dispositionParams,
});

/** `name*0*` -> `filename*0*`, so both spellings reach one decoder. */
const renameKey = (params: Record<string, string>, from: string, to: string): Record<string, string> =>
  Object.fromEntries(Object.entries(params).map(([key, value]) =>
    [key === from || key.startsWith(`${from}*`) ? `${to}${key.slice(from.length)}` : key, value]));
