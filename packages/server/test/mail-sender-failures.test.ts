/**
 * A refusal that is the sender's fault says so — and says nothing secret.
 *
 * Two bugs, found together, and both were in what a failed delivery reports:
 *
 * **The recipient paid for the sender's mistake.** A delivery failure carried
 * one flag, `permanent`, and the queue read it as "this address is dead". That
 * is right for `RCPT TO` answering 550 and wrong for everything that happens
 * before the recipient is even named: a rejected password, a sender address the
 * relay will not relay for, a Scaleway key without the email permission. Each
 * of those suppressed whoever the message was for — with a wrong key, every
 * recipient the queue touched, one message at a time, and the admin's own
 * address first, because "send a test" is the first thing anybody presses.
 *
 * **The password was in the error.** A command's failure was reported as
 * `SMTP <first word of the line> failed`, and for `AUTH LOGIN` the line *is*
 * the password, base64. A relay answering 535 put it into the queue's
 * `last_error`, the suppression list's `detail`, the test button's answer and
 * the log.
 *
 * Against a real (if tiny) relay that performs a real STARTTLS upgrade,
 * because the client rightly refuses to send credentials any other way.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-mail-sender-${process.pid}`;

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket, createSecureContext } from 'node:tls';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { DeliveryError, suppressesRecipient } from '../src/adapters/mail/delivery.ts';
import { sendMail } from '../src/adapters/mail/smtp.ts';
import { sendViaScaleway } from '../src/adapters/mail/scaleway.ts';

const { run, get, all } = await import('../src/kernel/platform/db/index.ts');
const { releaseSenderSuppressions } = await import('../src/adapters/mail/mail.ts');

/* Generated rather than checked in — see `mail.test.ts` for why. */
const certDir = mkdtempSync(join(tmpdir(), 'kolibri-smtp-sender-cert-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
], { stdio: 'ignore' });
const credentials = { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) };

after(() => {
  rmSync(certDir, { recursive: true, force: true });
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const letter = { from: 'kolibri@localhost', to: 'ada@example.com', subject: 'Hello', text: 'A body.' };
const PASSWORD = 'correct-horse-battery-staple';

/**
 * A relay that upgrades to TLS, offers only `AUTH LOGIN`, and answers each
 * stage the way it is told: `auth` for the password, `from` for `MAIL FROM`,
 * `rcpt` for `RCPT TO`.
 */
function startRelay(answers: { auth?: string; from?: string; rcpt?: string } = {}): Promise<{ port: number; server: Server }> {
  const server = createServer((plain: Socket) => {
    let socket: Socket | TLSSocket = plain;
    let buffer = '';
    let secured = false;
    let loginStep = 0;
    const send = (line: string) => socket.write(`${line}\r\n`);
    send('220 test.local ESMTP ready');
    const read = (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const upper = line.toUpperCase();
        if (loginStep === 1) { loginStep = 2; send('334 UGFzc3dvcmQ6'); continue; }
        if (loginStep === 2) { loginStep = 0; send(answers.auth ?? '235 2.7.0 Authentication successful'); continue; }
        if (upper.startsWith('EHLO')) {
          send('250-test.local');
          if (secured) send('250-AUTH LOGIN');
          else send('250-STARTTLS');
          send('250 SIZE 10240000');
        } else if (upper === 'STARTTLS') {
          send('220 2.0.0 Ready to start TLS');
          plain.removeAllListeners('data');
          buffer = '';
          const upgraded = new TLSSocket(plain, { isServer: true, secureContext: createSecureContext(credentials) });
          socket = upgraded;
          secured = true;
          upgraded.setEncoding('utf8');
          upgraded.on('data', (more: string) => read(more));
          upgraded.on('error', () => undefined);
        } else if (upper === 'AUTH LOGIN') {
          loginStep = 1;
          send('334 VXNlcm5hbWU6');
        } else if (upper.startsWith('MAIL FROM')) {
          send(answers.from ?? '250 2.1.0 Ok');
        } else if (upper.startsWith('RCPT TO')) {
          send(answers.rcpt ?? '250 2.1.5 Ok');
        } else if (upper === 'QUIT') {
          send('221 2.0.0 Bye');
          socket.end();
        } else {
          send('250 2.0.0 Ok');
        }
      }
    };
    plain.setEncoding('utf8');
    plain.on('data', read);
    plain.on('error', () => undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ port: (server.address() as AddressInfo).port, server })));
}

const smtp = (port: number) => ({
  host: '127.0.0.1', port, encryption: 'starttls' as const, user: 'kolibri', pass: PASSWORD, allowInvalidCerts: true,
});

const failureOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

describe('an SMTP refusal before the recipient is named', () => {
  it('blames the sender for a rejected password, and does not repeat it', async () => {
    const { port, server } = await startRelay({ auth: '535 5.7.8 Authentication credentials invalid' });
    try {
      const failure = await failureOf(sendMail(smtp(port), letter));
      assert.ok(failure instanceof DeliveryError, String(failure));
      assert.equal(failure.permanent, true, 'a wrong password will not get better by itself');
      assert.equal(failure.about, 'sender');
      assert.equal(suppressesRecipient(failure), false);
      // The leak: the AUTH LOGIN password line, base64, was the "command".
      assert.ok(!failure.message.includes(Buffer.from(PASSWORD).toString('base64')), failure.message);
      assert.ok(!failure.message.includes(Buffer.from('kolibri').toString('base64')), failure.message);
      assert.ok(!failure.message.includes(PASSWORD), failure.message);
      assert.match(failure.message, /^SMTP AUTH failed: 535/);
    } finally {
      server.close();
    }
  });

  it('blames the sender when the relay will not relay for the From address', async () => {
    const { port, server } = await startRelay({ from: '550 5.7.1 Sender address rejected: not owned by user' });
    try {
      const failure = await failureOf(sendMail(smtp(port), letter));
      assert.ok(failure instanceof DeliveryError);
      assert.equal(failure.about, 'sender');
      assert.equal(suppressesRecipient(failure), false);
    } finally {
      server.close();
    }
  });

  it('still blames the address when RCPT TO says it does not exist', async () => {
    const { port, server } = await startRelay({ rcpt: '550 5.1.1 User unknown' });
    try {
      const failure = await failureOf(sendMail(smtp(port), letter));
      assert.ok(failure instanceof DeliveryError);
      assert.equal(failure.about, 'recipient');
      assert.equal(suppressesRecipient(failure), true, 'a hard bounce is what the list is for');
    } finally {
      server.close();
    }
  });
});

describe('a Scaleway refusal of the key', () => {
  async function refusing(status: number) {
    const api = createHttp((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'nope' }));
      });
    });
    await new Promise<void>((done) => api.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}/emails`;
    const failure = await failureOf(sendViaScaleway({ url, secretKey: 'k', projectId: 'p' }, letter));
    api.close();
    return failure;
  }

  it('blames the sender for 401, 403 and 404, and the address for the rest of 4xx', async () => {
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      for (const status of [401, 403, 404]) {
        const failure = await refusing(status);
        assert.ok(failure instanceof DeliveryError);
        assert.equal(failure.about, 'sender', `HTTP ${status}`);
        assert.equal(suppressesRecipient(failure), false, `HTTP ${status} suppressed the recipient`);
      }
      const malformed = await refusing(400);
      assert.ok(malformed instanceof DeliveryError);
      assert.equal(suppressesRecipient(malformed), true);
    } finally {
      console.warn = warn;
    }
  });
});

describe('the addresses the old rule suppressed', () => {
  it('are released, and a password left in an old error is scrubbed', () => {
    const now = Date.now();
    const leaked = `SMTP ${Buffer.from(PASSWORD).toString('base64')} failed: 535 5.7.8 Authentication credentials invalid`;
    for (const [email, detail] of [
      ['wrong-key@example.com', 'Scaleway refused the message (HTTP 403): {"message":"insufficient permissions"}'],
      ['bad-login@example.com', leaked],
      ['bad-from@example.com', 'SMTP MAIL failed: 550 5.7.1 Sender address rejected'],
      ['gone@example.com', 'SMTP RCPT failed: 550 5.1.1 User unknown'],
      ['spam@example.com', null],
    ] as const) {
      run(`INSERT INTO email_suppressions (email, reason, detail, created_at) VALUES (?, ?, ?, ?)`,
        email, email.startsWith('spam') ? 'complaint' : 'bounce', detail, now);
    }
    run(
      `INSERT INTO email_queue (id, to_email, subject, body_text, headers, kind, send_after, created_at, attempts, last_error, failed_at)
       VALUES ('q1', 'bad-login@example.com', 's', 'b', '{}', 'test', ?, ?, 1, ?, ?)`,
      now, now, leaked, now,
    );

    const released = releaseSenderSuppressions();
    assert.equal(released, 3);
    const left = all<{ email: string }>(`SELECT email FROM email_suppressions ORDER BY email`).map((row) => row.email);
    assert.deepEqual(left, ['gone@example.com', 'spam@example.com'], 'a real bounce or a complaint was released');

    const error = String(get<{ last_error: string }>(`SELECT last_error FROM email_queue WHERE id = 'q1'`)?.last_error);
    assert.ok(!error.includes(Buffer.from(PASSWORD).toString('base64')), error);
    assert.match(error, /^SMTP AUTH failed: 535/);

    // Idempotent: a second boot finds nothing to do.
    assert.equal(releaseSenderSuppressions(), 0);
  });
});
