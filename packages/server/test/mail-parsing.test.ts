/**
 * Reading what a mail server sends, without a mail library.
 *
 * Everything here is a pure function over bytes, and every case is one that
 * cost something to find. IMAP's literals are the reason the response reader
 * cannot be line-oriented; RFC 2047's fold rule is the reason a German subject
 * stays one word; the disposition's index in `BODYSTRUCTURE` moving by one
 * between a text part and a binary one is the reason every PDF was almost
 * called `part-2`.
 *
 * The end-to-end fetch against a fake IMAP server is at the bottom. It is the
 * only test here that opens a socket, and it exists because the pieces being
 * individually right is not the same as the conversation working: the pass
 * structure — metadata for a whole batch, then bodies grouped by section — is
 * a behaviour of the fetcher rather than of any function in it.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-mail-parsing-${process.pid}`;

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';

/**
 * A throwaway certificate for the servers below.
 *
 * Generated rather than checked in, exactly as `mail.test.ts` does it and for
 * the reason written there: a private key in a repository is a private key in a
 * repository even when it is only good for `127.0.0.1`.
 *
 * It is needed at all because the client refuses to send *any* credential over
 * a plaintext connection, token included — so a fake server that stayed in
 * plaintext could only ever test the refusal, and the sign-in these tests are
 * about would never happen.
 */
const certDir = mkdtempSync(join(tmpdir(), 'kolibri-imap-cert-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
], { stdio: 'ignore' });
const credentials = {
  key: readFileSync(join(certDir, 'key.pem')),
  cert: readFileSync(join(certDir, 'cert.pem')),
};

import { decodeBody, decodeParameter, decodeQuotedPrintable, decodeWords, htmlToText, parseHeaders } from '../src/adapters/imap/mime.ts';
import { asList, asText, chooseParts, filenameParams, flattenStructure, tokenise } from '../src/adapters/imap/protocol.ts';
import { ranges } from '../src/adapters/imap/fetcher.ts';
import { checkMailbox, parseMailboxUrl } from '../src/kernel/mail/mailbox.ts';
import { defaultMailboxPort, isDefaultMailboxPort } from '@kolibri/shared';

after(() => {
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
  rmSync(certDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- MIME */

describe('header words', () => {
  it('decodes base64 and quoted-printable encoded words', () => {
    assert.equal(decodeWords('=?UTF-8?B?UmVjaG51bmc=?='), 'Rechnung');
    assert.equal(decodeWords('=?iso-8859-1?Q?Rechnung_f=FCr_M=E4rz?='), 'Rechnung für März');
  });

  it('joins adjacent encoded words without the space between them', () => {
    // RFC 2047's rule, and the reason it matters: a long German subject is
    // split at arbitrary points, so keeping the fold would turn `Rechnung`
    // into `Rech nung` and the message would stop being findable by its word.
    assert.equal(
      decodeWords('=?UTF-8?Q?Rech?= =?UTF-8?Q?nung?='),
      'Rechnung',
    );
  });

  it('keeps a space somebody actually typed', () => {
    assert.equal(decodeWords('Re: =?UTF-8?B?UmVjaG51bmc=?= 2024'), 'Re: Rechnung 2024');
  });

  it('leaves a plain header alone', () => {
    assert.equal(decodeWords('Invoice 2024-08'), 'Invoice 2024-08');
  });
});

describe('bodies', () => {
  it('undoes quoted-printable soft breaks', () => {
    assert.equal(
      decodeQuotedPrintable('Rechnungs=\r\nnummer =3D 4711').toString('latin1'),
      'Rechnungsnummer = 4711',
    );
  });

  it('decodes base64 in the charset the part declared', () => {
    const bytes = Buffer.from('Grüße', 'latin1').toString('base64');
    assert.equal(decodeBody(Buffer.from(bytes), 'base64', 'iso-8859-1'), 'Grüße');
  });

  it('flattens HTML to the words, keeping paragraphs apart', () => {
    const html = '<style>p{color:red}</style><p>Rechnung</p><p>&euro;1.234,56</p>';
    const text = htmlToText(html);
    assert.match(text, /Rechnung/);
    // The entity resolves, so an amount stays findable as an amount.
    assert.match(text, /€1\.234,56/);
    // And the stylesheet is gone rather than indexed.
    assert.doesNotMatch(text, /color/);
  });

  it('drops link targets but keeps their text', () => {
    // A signed URL is different in every message from a provider, so indexing
    // one means every such message matches every other.
    assert.equal(htmlToText('<a href="https://x.test/abc?sig=99">View invoice</a>'), 'View invoice');
  });
});

describe('parameters', () => {
  it('reads an RFC 2231 extended filename', () => {
    assert.equal(
      decodeParameter({ 'filename*': "UTF-8''Rechnung%20M%C3%A4rz.pdf" }, 'filename'),
      'Rechnung März.pdf',
    );
  });

  it('joins RFC 2231 continuations in order', () => {
    assert.equal(
      decodeParameter({ 'filename*0': 'Rechnung_', 'filename*1': '2024_08.pdf' }, 'filename'),
      'Rechnung_2024_08.pdf',
    );
  });

  it('falls back to the legacy NAME on the content type', () => {
    // The older senders attach a PDF with no `Content-Disposition` at all.
    const part = {
      part: '2', type: 'application', subtype: 'pdf', encoding: 'base64', size: 100,
      params: { name: 'Beleg.pdf' }, disposition: '', dispositionParams: {},
    };
    assert.equal(decodeParameter(filenameParams(part), 'filename'), 'Beleg.pdf');
  });
});

describe('headers', () => {
  it('unfolds continuation lines', () => {
    const raw = Buffer.from('References: <a@x>\r\n <b@x>\r\nSubject: Hi\r\n');
    assert.equal(parseHeaders(raw).references, '<a@x> <b@x>');
  });

  it('joins repeated headers rather than keeping one', () => {
    const raw = Buffer.from('References: <a@x>\r\nReferences: <b@x>\r\n');
    assert.equal(parseHeaders(raw).references, '<a@x>, <b@x>');
  });
});

/* --------------------------------------------------------------- protocol */

describe('the IMAP grammar', () => {
  it('reads atoms, quoted strings and nesting', () => {
    const tokens = tokenise([{ text: '* 1 FETCH (UID 12 FLAGS (\\Seen) ENVELOPE ("date" "Sub ject"))' }]);
    assert.equal(asText(tokens[2]), 'FETCH');
    const items = asList(tokens[3]);
    assert.equal(asText(items[0]), 'UID');
    assert.equal(asText(items[1]), '12');
    assert.equal(asText(asList(items[3])[0]), '\\Seen');
    assert.equal(asText(asList(items[5])[1]), 'Sub ject');
  });

  it('keeps a literal\'s bytes out of the character scanner', () => {
    // The whole reason the reader works in segments: these bytes contain a
    // newline, a quote and an unbalanced bracket from somebody's email, and a
    // tokeniser that saw them as text would lose the rest of the response.
    const tokens = tokenise([
      { text: '* 1 FETCH (BODY[1] ' },
      { literal: Buffer.from('line one\r\n") and (a bracket') },
      { text: ')' },
    ]);
    const items = asList(tokens[3]);
    assert.equal(asText(items[0]), 'BODY[1]');
    assert.match(asText(items[1]), /a bracket$/);
  });

  it('treats a bracketed fetch item as one name', () => {
    const tokens = tokenise([{ text: '* 1 FETCH (BODY[HEADER.FIELDS (REFERENCES)] NIL)' }]);
    assert.equal(asText(asList(tokens[3])[0]), 'BODY[HEADER.FIELDS (REFERENCES)]');
  });

  it('survives a stray closing paren', () => {
    const tokens = tokenise([{ text: '* 1 FETCH (UID 3)) EXTRA' }]);
    assert.equal(asText(tokens[tokens.length - 1]), 'EXTRA');
  });
});

describe('the body structure', () => {
  const simple = '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 400 10 NIL NIL NIL NIL)'
    + '("APPLICATION" "PDF" ("NAME" "Rechnung.pdf") NIL NIL "BASE64" 40000 NIL ("attachment" ("FILENAME" "Rechnung.pdf")) NIL NIL)'
    + ' "MIXED" ("BOUNDARY" "x") NIL NIL NIL)';

  it('numbers the parts the way IMAP numbers them', () => {
    const parts = flattenStructure(tokenise([{ text: simple }])[0]);
    assert.deepEqual(parts.map((one) => one.part), ['1', '2']);
  });

  it('finds the disposition despite it moving by one between text and binary', () => {
    // A text part carries a line count the others do not, so the extension
    // fields sit one later. Getting this wrong is not an error anywhere — every
    // PDF is simply called `part-2`.
    const parts = flattenStructure(tokenise([{ text: simple }])[0]);
    assert.equal(parts[1].disposition, 'attachment');
    assert.equal(decodeParameter(filenameParams(parts[1]), 'filename'), 'Rechnung.pdf');
  });

  it('nests, so an alternative inside a mixed is 1.1', () => {
    const nested = '((("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)'
      + '("TEXT" "HTML" NIL NIL NIL "7BIT" 20 2 NIL NIL NIL NIL)'
      + ' "ALTERNATIVE" NIL NIL NIL NIL)'
      + '("APPLICATION" "PDF" NIL NIL NIL "BASE64" 900 NIL NIL NIL NIL)'
      + ' "MIXED" NIL NIL NIL NIL)';
    const parts = flattenStructure(tokenise([{ text: nested }])[0]);
    assert.deepEqual(parts.map((one) => one.part), ['1.1', '1.2', '2']);
  });

  it('prefers the plain text part and calls the rest attachments', () => {
    const parts = flattenStructure(tokenise([{ text: simple }])[0]);
    const chosen = chooseParts(parts);
    assert.equal(chosen.text?.part, '1');
    assert.deepEqual(chosen.attachments.map((one) => one.part), ['2']);
  });

  it('treats a lone text part as part 1', () => {
    const bare = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 40 2 NIL NIL NIL NIL)';
    assert.deepEqual(flattenStructure(tokenise([{ text: bare }])[0]).map((one) => one.part), ['1']);
  });
});

describe('UID ranges', () => {
  it('collapses runs, so a batch of five hundred is not a long line', () => {
    assert.equal(ranges([1, 2, 3, 7, 8, 20]), '1:3,7:8,20');
    assert.equal(ranges([5]), '5');
  });
});

/* ---------------------------------------------------------------- config */

describe('what a mailbox URL spells', () => {
  it('reads imaps as implicit TLS on 993', () => {
    const config = parseMailboxUrl('imaps://info%40x.de:secret@imap.x.de');
    assert.equal(config?.encryption, 'tls');
    assert.equal(config?.port, 993);
    assert.equal(config?.username, 'info@x.de');
  });

  it('reads imap as STARTTLS required, on 143', () => {
    assert.equal(parseMailboxUrl('imap://imap.x.de')?.encryption, 'starttls');
    assert.equal(parseMailboxUrl('imap://imap.x.de')?.port, 143);
  });

  it('makes turning encryption off say the word', () => {
    assert.equal(parseMailboxUrl('imap://localhost:1143?encryption=none')?.encryption, 'none');
    assert.equal(defaultMailboxPort('none'), 143);
  });

  it('refuses anything that is not an IMAP URL', () => {
    assert.equal(parseMailboxUrl('https://imap.x.de'), null);
    assert.equal(parseMailboxUrl('nonsense'), null);
  });

  /*
   * The question the settings screen asks before it moves anybody's port.
   *
   * A mailbox on 993 under TLS is there because that is what TLS uses, so
   * switching to STARTTLS should take it to 143 — the pairing it would
   * otherwise be left in cannot connect at all, and was reported from a live
   * instance. A mailbox on 10993 is there because a hosting company said so,
   * and that is the one number on the form nobody could have guessed.
   */
  it('knows a port nobody chose from one somebody did', () => {
    assert.equal(isDefaultMailboxPort(993, 'tls'), true);
    assert.equal(isDefaultMailboxPort(143, 'starttls'), true);
    assert.equal(isDefaultMailboxPort(143, 'none'), true);

    // The pairing from the report: 993 is not STARTTLS's, so switching *to*
    // STARTTLS from a default-993 mailbox is exactly the case that moves.
    assert.equal(isDefaultMailboxPort(993, 'starttls'), false);
    assert.equal(isDefaultMailboxPort(143, 'tls'), false);

    // And the one that must never move.
    assert.equal(isDefaultMailboxPort(10_993, 'tls'), false);
    assert.equal(isDefaultMailboxPort(10_993, 'starttls'), false);
  });
});

describe('what a mailbox form will accept', () => {
  it('refuses either kind of credential over an unencrypted connection', () => {
    // A bearer token as much as a password: read off the wire it is a mailbox
    // for as long as it lasts, and the shorter life is the only way it is
    // better.
    for (const credential of [
      { kind: 'password', password: 'hunter2' },
      { kind: 'oauth', accessToken: 'ya29.a0' },
    ] as const) {
      assert.match(checkMailbox({ host: 'localhost', port: 143, encryption: 'none', credential }) ?? '', /unencrypted/);
    }
  });

  it('accepts a capture server with no password', () => {
    assert.equal(checkMailbox({ host: 'localhost', port: 1143, encryption: 'none' }), null);
  });

  it('says what is wrong rather than only that something is', () => {
    assert.match(checkMailbox({ host: 'a b', port: 993, encryption: 'tls' }) ?? '', /host name/);
    assert.match(checkMailbox({ host: 'x.de', port: 0, encryption: 'tls' }) ?? '', /1 to 65535/);
    assert.match(checkMailbox({ address: 'not an address', host: 'x.de', port: 993, encryption: 'tls' }) ?? '', /email address/);
  });
});

/* ------------------------------------------------------------- XOAUTH2 */

/**
 * A server that speaks the SASL half of IMAP, and can be told to refuse.
 *
 * `sasl` says which form it advertises — inline with `SASL-IR`, or the
 * two-step exchange — because both are in the field and the client has to do
 * both. `accept` is the token it will take; anything else gets the refusal,
 * which is the interesting path: a rejected token is answered with a `+`
 * continuation rather than a `NO`, and a client that does not send the empty
 * line back waits for a tagged reply that never comes.
 */
function startSaslImap(options: { sasl: 'inline' | 'twostep'; accept: string }): Promise<{ port: number; server: ReturnType<typeof createTlsServer>; spoken: string[] }> {
  const spoken: string[] = [];
  const capability = options.sasl === 'inline'
    ? '* CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2 AUTH=PLAIN\r\n'
    : '* CAPABILITY IMAP4rev1 AUTH=XOAUTH2 AUTH=PLAIN\r\n';

  const server = createTlsServer(credentials, (socket: TLSSocket) => {
    socket.setEncoding('utf8');
    socket.write('* OK fake IMAP ready\r\n');
    let buffer = '';
    let awaitingBlob = false;
    let refusing = false;
    let authTag = '';

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf('\r\n');
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\r\n');

        if (refusing) {
          // The empty line acknowledging the refusal. Only now does the server
          // finish the sentence.
          socket.write(`${authTag} NO AUTHENTICATE failed.\r\n`);
          refusing = false;
          awaitingBlob = false;
          continue;
        }
        if (awaitingBlob) {
          spoken.push(`BLOB ${line}`);
          awaitingBlob = false;
          const decoded = Buffer.from(line, 'base64').toString();
          if (decoded.includes(`auth=Bearer ${options.accept}`)) socket.write(`${authTag} OK signed in\r\n`);
          else {
            refusing = true;
            socket.write(`+ ${Buffer.from('{"status":"401"}').toString('base64')}\r\n`);
          }
          continue;
        }

        const [tag, ...rest] = line.split(' ');
        const command = rest.join(' ');
        spoken.push(command);
        if (/^CAPABILITY/i.test(command)) {
          socket.write(capability);
          socket.write(`${tag} OK done\r\n`);
        } else if (/^AUTHENTICATE XOAUTH2/i.test(command)) {
          authTag = tag;
          const inline = command.split(' ')[2];
          if (inline) {
            spoken.push(`BLOB ${inline}`);
            const decoded = Buffer.from(inline, 'base64').toString();
            if (decoded.includes(`auth=Bearer ${options.accept}`)) socket.write(`${tag} OK signed in\r\n`);
            else {
              refusing = true;
              socket.write(`+ ${Buffer.from('{"status":"401"}').toString('base64')}\r\n`);
            }
          } else {
            awaitingBlob = true;
            socket.write('+ \r\n');
          }
        } else socket.write(`${tag} OK done\r\n`);
      }
    });
    socket.on('error', () => undefined);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as AddressInfo).port, server, spoken }));
  });
}

describe('signing in with a token', () => {
  const connect = async (port: number, token: string) => {
    const { ImapConnection } = await import('../src/adapters/imap/imap.ts');
    return ImapConnection.open({
      host: '127.0.0.1', port, encryption: 'tls', allowInvalidCerts: true,
      username: 'support@calendoora.de',
      credential: { kind: 'oauth', accessToken: token },
    });
  };

  it('sends the SASL blob on the command line when the server offers SASL-IR', async () => {
    const { port, server, spoken } = await startSaslImap({ sasl: 'inline', accept: 'good-token' });
    try {
      (await connect(port, 'good-token')).end();
      const blob = spoken.find((one) => one.startsWith('BLOB '))!.slice(5);
      assert.equal(
        Buffer.from(blob, 'base64').toString(),
        'user=support@calendoora.de\x01auth=Bearer good-token\x01\x01',
      );
      // One command, not two: the initial response went with it.
      assert.equal(spoken.filter((one) => /^AUTHENTICATE/i.test(one)).length, 1);
    } finally {
      server.close();
    }
  });

  it('waits for the continuation when the server does not', async () => {
    const { port, server, spoken } = await startSaslImap({ sasl: 'twostep', accept: 'good-token' });
    try {
      (await connect(port, 'good-token')).end();
      // The command carried no blob; the blob arrived as its own line.
      assert.ok(spoken.includes('AUTHENTICATE XOAUTH2'));
      assert.ok(spoken.some((one) => one.startsWith('BLOB ')));
    } finally {
      server.close();
    }
  });

  it('answers the refusal continuation rather than hanging on it', async () => {
    // The failure worth a test of its own. A rejected token is answered with a
    // `+` and nothing else until the client sends an empty line — so a client
    // that treats it as noise blocks until the socket times out, and the
    // mailbox is recorded as unreachable rather than as signed out. That sends
    // whoever is debugging it to the firewall instead of the consent screen.
    const { port, server } = await startSaslImap({ sasl: 'inline', accept: 'good-token' });
    try {
      const started = Date.now();
      await assert.rejects(() => connect(port, 'stale-token'), /OAuth sign-in refused/);
      assert.ok(Date.now() - started < 5_000, 'it waited for a timeout instead of answering');
    } finally {
      server.close();
    }
  });

  it('refuses outright when the server does not offer XOAUTH2 at all', async () => {
    const server = createTlsServer(credentials, (socket: TLSSocket) => {
      socket.setEncoding('utf8');
      socket.write('* OK plain only\r\n');
      socket.on('data', (chunk: string) => {
        for (const line of chunk.split('\r\n').filter(Boolean)) {
          const tag = line.split(' ')[0];
          socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n');
          socket.write(`${tag} OK done\r\n`);
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((done) => { server.listen(0, '127.0.0.1', () => done()); });
    try {
      await assert.rejects(
        () => connect((server.address() as AddressInfo).port, 'good-token'),
        /does not accept OAuth sign-in/,
      );
    } finally {
      server.close();
    }
  });
});

/* ------------------------------------------------------- the conversation */

/**
 * A mail server that speaks just enough IMAP to be fetched from.
 *
 * It answers the four commands the fetcher sends and records them, which is
 * what lets the test assert on the *shape* of the conversation rather than only
 * on its result: the point of the two-pass design is that the eight-megabyte
 * PDF is never requested, and only the recorded commands can show that.
 */
function startFakeImap(): Promise<{ port: number; server: Server; spoken: string[] }> {
  const spoken: string[] = [];
  const structure = '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 40 2 NIL NIL NIL NIL)'
    + '("APPLICATION" "PDF" ("NAME" "Rechnung_2024_08.pdf") NIL NIL "BASE64" 8000000 NIL'
    + ' ("attachment" ("FILENAME" "Rechnung_2024_08.pdf")) NIL NIL)'
    + ' "MIXED" ("BOUNDARY" "x") NIL NIL NIL)';

  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    socket.write('* OK fake IMAP ready\r\n');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf('\r\n');
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag, ...rest] = line.split(' ');
        const command = rest.join(' ');
        spoken.push(command);

        if (/^LOGIN/i.test(command)) socket.write(`${tag} OK signed in\r\n`);
        else if (/^EXAMINE/i.test(command)) {
          socket.write('* 2 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n');
          socket.write(`${tag} OK [READ-ONLY] done\r\n`);
        } else if (/^UID SEARCH/i.test(command)) {
          socket.write('* SEARCH 101 102\r\n');
          socket.write(`${tag} OK done\r\n`);
        } else if (/^UID FETCH .*ENVELOPE/i.test(command)) {
          for (const [uid, subject] of [[101, '=?UTF-8?Q?Rechnung_M=C3=A4rz?='], [102, 'Newsletter']] as const) {
            const references = `References: <thread-${uid === 101 ? 'a' : 'b'}@x>\r\n`;
            socket.write(
              `* ${uid - 100} FETCH (UID ${uid} FLAGS (\\Seen) RFC822.SIZE 8000500`
              + ` INTERNALDATE "17-Aug-2024 09:14:02 +0200"`
              + ` ENVELOPE ("Sat, 17 Aug 2024 09:14:02 +0200" "${subject}"`
              + ` (("Anna Weber" NIL "anna" "steuer.de")) NIL NIL`
              + ` (("Support" NIL "support" "calendoora.de")) NIL NIL NIL "<msg-${uid}@x>")`
              + ` BODYSTRUCTURE ${structure}`
              + ` BODY[HEADER.FIELDS (REFERENCES IN-REPLY-TO)] {${references.length}}\r\n${references})\r\n`,
            );
          }
          socket.write(`${tag} OK done\r\n`);
        } else if (/^UID FETCH .*BODY\.PEEK\[1\]/i.test(command)) {
          for (const uid of [101, 102]) {
            const body = uid === 101 ? 'Rechnungsnummer 4711, Betrag 1.234,56 EUR' : 'Unsubscribe here';
            socket.write(`* ${uid - 100} FETCH (UID ${uid} BODY[1] {${body.length}}\r\n${body})\r\n`);
          }
          socket.write(`${tag} OK done\r\n`);
        } else socket.write(`${tag} OK done\r\n`);
        end = buffer.indexOf('\r\n');
      }
    });
    socket.on('error', () => undefined);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as AddressInfo).port, server, spoken }));
  });
}

describe('fetching from a mailbox', () => {
  it('reads a batch and never asks for the attachment', async () => {
    const { port, server, spoken } = await startFakeImap();
    // Imported here rather than at the top: registering the fetcher is a side
    // effect of loading the module, and it should not happen for the pure
    // tests above.
    const { installImapFetcher } = await import('../src/adapters/imap/fetcher.ts');
    const { mailFetcher } = await import('../src/modules/mail/poll.ts');
    installImapFetcher();

    try {
      const messages = await mailFetcher().fetch(
        {
          host: '127.0.0.1', port, encryption: 'none', username: 'support@calendoora.de',
          credential: { kind: 'password', password: '' },
        },
        'INBOX',
        { sinceUid: 0, sinceDays: 365, limit: 500 },
      );

      assert.equal(messages.length, 2);
      const invoice = messages[0];
      // The subject came back through RFC 2047.
      assert.equal(invoice.subject, 'Rechnung März');
      assert.equal(invoice.fromName, 'Anna Weber');
      assert.equal(invoice.fromAddress, 'anna@steuer.de');
      assert.deepEqual(invoice.to, ['support@calendoora.de']);
      assert.match(invoice.body, /Rechnungsnummer 4711/);
      // The reference chain, which is what threads a reply to what it answers.
      assert.deepEqual(invoice.references, ['thread-a@x']);
      // The attachment is known by name and size, decoded from base64's
      // inflation, without a byte of it having been fetched.
      assert.equal(invoice.attachments.length, 1);
      assert.equal(invoice.attachments[0].filename, 'Rechnung_2024_08.pdf');
      assert.equal(invoice.attachments[0].part, '2');
      assert.ok(invoice.attachments[0].size < 8_000_000, 'base64 inflation was not undone');

      // The shape of the conversation, which is the point of the two passes.
      assert.ok(spoken.some((one) => /^EXAMINE/i.test(one)), 'the folder was not selected read-only');
      assert.ok(!spoken.some((one) => /BODY\.PEEK\[2\]/i.test(one)), 'the 8 MB attachment was fetched');
      assert.ok(!spoken.some((one) => /BODY\.PEEK\[\]/i.test(one)), 'the whole message was fetched');
      // Two bodies, one command: both messages have their text at section 1.
      assert.equal(spoken.filter((one) => /BODY\.PEEK\[1\]/i.test(one)).length, 1);
    } finally {
      server.close();
    }
  });
});
