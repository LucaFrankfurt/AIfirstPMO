/**
 * How mail leaves, and what it refuses to do on the way out.
 *
 * Two transports, and the questions worth asking are the same for both: does it
 * deliver what it was given, and when it fails, does it say the right thing
 * about whether trying again could help. That second one is not a detail — the
 * queue turns "permanent" into an entry on the suppression list, and an address
 * on that list is one nobody writes to again until a human notices.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-mail-transport-${process.pid}`;

import assert from 'node:assert/strict';
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer as createTcp, type Server, type Socket } from 'node:net';
import { rmSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { DeliveryError, isPermanentFailure } from '../src/lib/delivery.ts';
import { parseSmtpUrl, sendMail } from '../src/lib/smtp.ts';
import { sendViaScaleway } from '../src/lib/scaleway.ts';

const letter = {
  from: 'kolibri@localhost',
  to: 'ada@example.com',
  subject: 'A subject',
  text: 'A body.',
};

/* ------------------------------------------------------------------- SMTP */

/**
 * A relay that says hello and nothing else useful — in particular, one that
 * never mentions STARTTLS.
 *
 * `spoken` records every command it was sent, which is how the tests below can
 * assert on the thing that actually matters: not merely that the client
 * complained, but that it stopped talking before it reached `AUTH`.
 */
function startBareRelay(): Promise<{ port: number; server: Server; spoken: string[] }> {
  const spoken: string[] = [];
  const server = createTcp((socket: Socket) => {
    socket.setEncoding('utf8');
    socket.write('220 test.local ESMTP ready\r\n');
    let buffer = '';
    let inData = false;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          // The body is not a command, and a line inside it that looks like one
          // must not be recorded as though the client had said it.
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
          }
          continue;
        }
        spoken.push(line);
        if (/^EHLO|^HELO/i.test(line)) {
          socket.write('250-test.local\r\n');
          socket.write('250-AUTH PLAIN LOGIN\r\n');
          socket.write('250 SIZE 10240000\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as AddressInfo).port, server, spoken }));
  });
}

describe('smtp encryption', () => {
  it('refuses to continue when STARTTLS was asked for and is not offered', async () => {
    const { port, server, spoken } = await startBareRelay();
    try {
      const failure = await sendMail(
        { host: '127.0.0.1', port, encryption: 'starttls', user: 'kolibri', pass: 'secret' },
        letter,
      ).then(() => null, (error: unknown) => error);

      assert.ok(failure instanceof DeliveryError, 'the refusal must be a DeliveryError');
      assert.match(failure.message, /does not offer STARTTLS/);
      // Misconfiguration, not a bad moment: retrying this every minute for six
      // attempts tells nobody anything.
      assert.equal(failure.permanent, true);

      // The point of the whole exercise. Before this, the client carried on and
      // the next line on the wire was the password in base64.
      assert.ok(!spoken.some((line) => /^AUTH/i.test(line)), 'no credentials may be sent in the clear');
    } finally {
      server.close();
    }
  });

  it('refuses to send credentials over an unencrypted connection at all', async () => {
    const { port, server, spoken } = await startBareRelay();
    try {
      const failure = await sendMail(
        { host: '127.0.0.1', port, encryption: 'none', user: 'kolibri', pass: 'secret' },
        letter,
      ).then(() => null, (error: unknown) => error);

      assert.ok(failure instanceof DeliveryError);
      assert.match(failure.message, /unencrypted/);
      assert.equal(failure.permanent, true);
      // Refused before the socket, so the relay heard nothing whatsoever.
      assert.equal(spoken.length, 0);
    } finally {
      server.close();
    }
  });

  it('still delivers unencrypted when there is no password to lose', async () => {
    // A capture inbox on localhost, which is the one case `none` is for.
    const { port, server, spoken } = await startBareRelay();
    try {
      await sendMail({ host: '127.0.0.1', port, encryption: 'none' }, letter);
      assert.ok(spoken.some((line) => /^MAIL FROM/i.test(line)));
    } finally {
      server.close();
    }
  });

  it('reads the encryption out of the url, and lets a query override the scheme', () => {
    assert.equal(parseSmtpUrl('smtp://host:587')?.encryption, 'starttls');
    assert.equal(parseSmtpUrl('smtps://host:465')?.encryption, 'tls');
    assert.equal(parseSmtpUrl('smtp://mailpit:1025?encryption=none')?.encryption, 'none');
    // The default port follows the scheme rather than the other way round.
    assert.equal(parseSmtpUrl('smtps://host')?.port, 465);
    assert.equal(parseSmtpUrl('smtp://host')?.port, 587);
  });
});

/* --------------------------------------------------------------- Scaleway */

interface Captured {
  path: string;
  token: string | undefined;
  body: any;
}

/** Scaleway's API, in as much detail as this client actually depends on. */
function startApi(reply: (captured: Captured) => { status: number; body: unknown }): Promise<{
  url: string; server: HttpServer; calls: Captured[];
}> {
  const calls: Captured[] = [];
  const server = createHttp((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const captured: Captured = {
        path: request.url ?? '',
        token: request.headers['x-auth-token'] as string | undefined,
        body: JSON.parse(raw || '{}'),
      };
      calls.push(captured);
      const { status, body } = reply(captured);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/emails`, server, calls });
    });
  });
}

const config = (url: string) => ({ url, secretKey: 'scw-secret', projectId: 'project-1' });

describe('scaleway transport', () => {
  it('sends the body the API documents, and returns the message id', async () => {
    const { url, server, calls } = await startApi(() => ({
      status: 200,
      body: { emails: [{ id: 'scw-1', message_id: '<abc@kolibri>', status: 'new' }] },
    }));
    try {
      const id = await sendViaScaleway(config(url), {
        ...letter,
        fromName: 'Kolibri',
        html: '<p>A body.</p>',
        replyTo: 'team@example.com',
        headers: { 'List-Unsubscribe': '<https://kolibri.example.com/u/1>' },
      });

      assert.equal(id, '<abc@kolibri>');
      const [call] = calls;
      assert.equal(call.token, 'scw-secret');
      assert.deepEqual(call.body.from, { email: 'kolibri@localhost', name: 'Kolibri' });
      // An array of one: the API takes a list, and Kolibri sends per person so
      // that one bounce is one address rather than a batch nobody can untangle.
      assert.deepEqual(call.body.to, [{ email: 'ada@example.com' }]);
      assert.equal(call.body.project_id, 'project-1');
      assert.equal(call.body.html, '<p>A body.</p>');
      // Reply-To has no field of its own in this API and travels as a header.
      assert.deepEqual(call.body.additional_headers, [
        { key: 'Reply-To', value: 'team@example.com' },
        { key: 'List-Unsubscribe', value: '<https://kolibri.example.com/u/1>' },
      ]);
    } finally {
      server.close();
    }
  });

  it('treats a rejected request as final and an outage as temporary', async () => {
    /*
     * The inversion that makes this worth a test of its own.
     *
     * Over SMTP, 5xx is the final word and 4xx means try later. Over HTTP it is
     * the other way round, and the queue reads the same flag from both. Get it
     * backwards and an afternoon of HTTP 500 at the provider walks the entire
     * user list onto the suppression table one address at a time.
     */
    const cases: [number, boolean][] = [
      [400, true],   // a malformed message — it will not get better
      [401, true],   // a bad key
      [403, true],   // a sender domain that is not verified
      [429, false],  // slow down, not stop
      [500, false],  // Scaleway
      [503, false],
    ];

    for (const [status, permanent] of cases) {
      const { url, server } = await startApi(() => ({ status, body: { message: 'nope' } }));
      try {
        const failure = await sendViaScaleway(config(url), letter)
          .then(() => null, (error: unknown) => error);
        assert.ok(failure instanceof DeliveryError, `HTTP ${status} must fail`);
        assert.equal(failure.permanent, permanent, `HTTP ${status} permanence`);
        assert.equal(isPermanentFailure(failure), permanent);
      } finally {
        server.close();
      }
    }
  });

  it('does not count an empty success as delivered', async () => {
    const { url, server } = await startApi(() => ({ status: 200, body: { emails: [] } }));
    try {
      const failure = await sendViaScaleway(config(url), letter)
        .then(() => null, (error: unknown) => error);
      assert.ok(failure instanceof DeliveryError);
      // Retryable: a response nobody has read is not evidence about the address.
      assert.equal(failure.permanent, false);
    } finally {
      server.close();
    }
  });

  it('refuses an address that would smuggle a header', async () => {
    const { url, server, calls } = await startApi(() => ({ status: 200, body: { emails: [{ id: 'x' }] } }));
    try {
      await assert.rejects(sendViaScaleway(config(url), { ...letter, to: 'ada@example.com\r\nBcc: mallory@example.com' }));
      assert.equal(calls.length, 0, 'nothing may reach the provider');
    } finally {
      server.close();
    }
  });
});

/* -------------------------------------------------------------- permanence */

describe('failure permanence', () => {
  it('believes a transport that says so, and reads SMTP codes otherwise', () => {
    assert.equal(isPermanentFailure(new DeliveryError('anything', true)), true);
    assert.equal(isPermanentFailure(new DeliveryError('SMTP 550 no such user', false)), false);
    // Not a DeliveryError — a socket threw, or something older did. Falls back
    // to the SMTP reading, which is the right guess for that case.
    assert.equal(isPermanentFailure(new Error('550 5.1.1 unknown recipient')), true);
    assert.equal(isPermanentFailure(new Error('451 4.7.1 try again later')), false);
    assert.equal(isPermanentFailure(new Error('socket hang up')), false);
  });
});

after(() => {
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});
