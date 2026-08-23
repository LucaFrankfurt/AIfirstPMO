/**
 * Email tests against a real (if tiny) SMTP server spoken over a socket, so the
 * client's protocol handling is exercised rather than mocked away.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-mail-${process.pid}`;

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket, createSecureContext } from 'node:tls';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

/**
 * A throwaway certificate for the fake relay, made at test time.
 *
 * The relay below performs a real STARTTLS upgrade rather than pretending to,
 * because the upgrade is the part worth testing: it is where the client decides
 * whether it is safe to say the password, and a fake that answers `220` and
 * stays in plaintext would agree with a client that never encrypted anything.
 *
 * Generated rather than checked in. A private key in a repository is a private
 * key in a repository even when it is only good for `127.0.0.1`, and every
 * scanner that reads this project would be right to say so.
 */
const certDir = mkdtempSync(join(tmpdir(), 'kolibri-smtp-cert-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
], { stdio: 'ignore' });
const credentials = {
  key: readFileSync(join(certDir, 'key.pem')),
  cert: readFileSync(join(certDir, 'cert.pem')),
};

/* ------------------------------------------------------- fake SMTP server */

interface Received {
  from: string;
  to: string[];
  data: string;
  authenticated: boolean;
}

const received: Received[] = [];
let smtpServer: Server;

/**
 * `offerStartTls` false is the attack this suite exists to pin down: a relay
 * that simply does not mention STARTTLS. The client used to shrug and carry on
 * in plaintext, password and all.
 */
function startSmtp(offerStartTls = true): Promise<number> {
  smtpServer = createServer((plain: Socket) => {
    let socket: Socket | TLSSocket = plain;
    let state: Received = { from: '', to: [], data: '', authenticated: false };
    let inData = false;
    let buffer = '';
    let secured = false;
    const send = (line: string) => socket.write(`${line}\r\n`);
    send('220 test.local ESMTP ready');

    const read = (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(state);
            state = { from: '', to: [], data: '', authenticated: state.authenticated };
            send('250 2.0.0 Ok: queued');
          } else {
            // Undo dot-stuffing exactly as a real server would.
            state.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          send('250-test.local');
          // AUTH is withheld until the connection is encrypted, which is what a
          // real relay does and what makes the second EHLO worth sending.
          if (secured) send('250-AUTH PLAIN LOGIN');
          if (offerStartTls && !secured) send('250-STARTTLS');
          send('250 SIZE 10240000');
        } else if (upper === 'STARTTLS') {
          send('220 2.0.0 Ready to start TLS');
          plain.removeAllListeners('data');
          buffer = '';
          const upgraded = new TLSSocket(plain, {
            isServer: true,
            secureContext: createSecureContext(credentials),
          });
          socket = upgraded;
          secured = true;
          upgraded.setEncoding('utf8');
          upgraded.on('data', (chunk: string) => read(chunk));
          upgraded.on('error', () => undefined);
          continue;
        } else if (upper.startsWith('AUTH PLAIN')) {
          state.authenticated = true;
          send('235 2.7.0 Authentication successful');
        } else if (upper.startsWith('MAIL FROM')) {
          state.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          send('250 2.1.0 Ok');
        } else if (upper.startsWith('RCPT TO')) {
          state.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          send('250 2.1.5 Ok');
        } else if (upper === 'DATA') {
          inData = true;
          send('354 End data with <CR><LF>.<CR><LF>');
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

  return new Promise((resolve) => {
    smtpServer.listen(0, '127.0.0.1', () => resolve((smtpServer.address() as AddressInfo).port));
  });
}

const port = await startSmtp();
// `insecure=true` for the self-signed certificate above, and nothing else: the
// connection is really encrypted and the password really is sent inside it.
process.env.KOLIBRI_SMTP_URL = `smtp://kolibri:secret@127.0.0.1:${port}?insecure=true`;
// The address the project actually ships as its default, rather than a tidier
// one invented for the test. `kolibri@localhost` has no dot in its domain, and
// a validator that quietly required one passed this whole suite while the
// deployment job could not send a single message.
process.env.KOLIBRI_MAIL_FROM = 'kolibri@localhost';
process.env.KOLIBRI_PUBLIC_URL = 'https://kolibri.example.com';
process.env.KOLIBRI_MAIL_BATCH_SECONDS = '0';

const db = await import('../src/db/index.ts');
const mail = await import('../src/lib/mail.ts');
const { env } = await import('../src/env.ts');

const decodeBody = (raw: string): string => {
  const parts = raw.split(/\r?\n\r?\n/);
  return parts.slice(1).map((part) => {
    const base64 = part.replace(/--[\w-]+.*/g, '').replace(/Content-[^\n]*\n/gi, '').replace(/\s+/g, '');
    try {
      return Buffer.from(base64, 'base64').toString('utf8');
    } catch {
      return part;
    }
  }).join('\n');
};

before(() => {
  db.run(
    `INSERT INTO users (id, email, name, email_prefs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    'u1', 'ada@example.com', 'Ada Lovelace', 'important', Date.now(), Date.now(),
  );
  db.run(
    `INSERT INTO users (id, email, name, email_prefs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    'u2', 'grace@example.com', 'Grace Hopper', 'none', Date.now(), Date.now(),
  );
});

after(() => {
  smtpServer.close();
  db.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
  rmSync(certDir, { recursive: true, force: true });
});

const notify = (userId: string, kind: string, title: string, taskId = 'task-1') =>
  db.run(
    `INSERT INTO notifications (id, workspace_id, user_id, kind, title, body, task_id, actor_id, created_at, updated_at, seq, clocks)
     VALUES (?, 'ws1', ?, ?, ?, 'Have a look at this', ?, 'u2', ?, ?, 0, '{}')`,
    crypto.randomUUID(), userId, kind, title, taskId, Date.now() - 60_000, Date.now(),
  );

describe('email notifications', () => {
  it('is configured from the SMTP url', () => {
    assert.equal(env.mailEnabled, true);
    assert.equal(env.mail.user, 'kolibri');
    assert.equal(env.mail.pass, 'secret');
  });

  it('recognises a local capture inbox for what it is', () => {
    // This test's own relay is on 127.0.0.1 — the same shape as Mailpit in the
    // dev overlay. Reporting it as ordinary delivery is the confusion we avoid.
    assert.equal(env.mailMode, 'test-inbox');
  });

  it('batches several notifications into one message', async () => {
    notify('u1', 'assigned', 'Assigned: WEB-1 Redesign the pricing page');
    notify('u1', 'mention', 'You were mentioned in WEB-2');
    assert.equal(mail.batchNotifications(), 1, 'one email for two notifications');

    const result = await mail.flushQueue();
    assert.equal(result.sent, 1);
    assert.equal(result.failed, 0);

    const message = received.at(-1)!;
    assert.equal(message.from, 'kolibri@localhost');
    assert.deepEqual(message.to, ['ada@example.com']);
    assert.ok(message.authenticated, 'the client must authenticate when credentials are configured');
    assert.match(message.data, /Subject: 2 updates in Kolibri/);
    assert.match(message.data, /List-Unsubscribe: </);

    const body = decodeBody(message.data);
    assert.match(body, /Redesign the pricing page/);
    assert.match(body, /You were mentioned in WEB-2/);
    assert.match(body, /https:\/\/kolibri\.example\.com\/t\/task-1/);
  });

  it('does not send anything twice', async () => {
    const before = received.length;
    assert.equal(mail.batchNotifications(), 0);
    await mail.flushQueue();
    assert.equal(received.length, before);
  });

  it('respects the "none" preference but still clears the backlog', async () => {
    notify('u2', 'assigned', 'Assigned: WEB-9');
    assert.equal(mail.batchNotifications(), 0, 'nothing queued for an opted-out user');
    const remaining = db.get<{ c: number }>(
      `SELECT count(*) c FROM notifications WHERE user_id = 'u2' AND emailed_at IS NULL`,
    );
    assert.equal(Number(remaining?.c), 0, 'notifications are marked so they cannot pile up');
  });

  it('drops unimportant kinds for the "important" preference', async () => {
    const before = received.length;
    notify('u1', 'comment', 'New comment on WEB-3');
    mail.batchNotifications();
    await mail.flushQueue();
    assert.equal(received.length, before, 'a plain comment is not important enough to email');
  });

  it('sends an invite immediately', async () => {
    mail.queueInvite({
      code: 'abc123',
      email: 'newcomer@example.com',
      workspaceName: 'Kolibri',
      inviterName: 'Ada Lovelace',
      workspaceId: 'ws1',
    });
    await mail.flushQueue();
    const message = received.at(-1)!;
    assert.deepEqual(message.to, ['newcomer@example.com']);
    assert.match(decodeBody(message.data), /https:\/\/kolibri\.example\.com\/invite\/abc123/);
  });

  it('encodes non-ASCII subjects', async () => {
    mail.queueMail({ to: 'ada@example.com', subject: 'Übersicht für März', text: 'Grüße' });
    await mail.flushQueue();
    const message = received.at(-1)!;
    assert.match(message.data, /Subject: =\?UTF-8\?B\?/);
    assert.match(decodeBody(message.data), /Grüße/);
  });

  it('signs unsubscribe links and rejects forged ones', () => {
    const token = mail.unsubscribeToken('u1');
    assert.equal(mail.verifyUnsubscribe('u1', token), true);
    assert.equal(mail.verifyUnsubscribe('u2', token), false);
    assert.equal(mail.verifyUnsubscribe('u1', 'x'.repeat(32)), false);
  });

  it('retries with backoff instead of losing a message', async () => {
    smtpServer.close();
    mail.queueMail({ to: 'ada@example.com', subject: 'While the relay is down', text: 'queued' });
    const result = await mail.flushQueue();
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 1);

    const row = db.get<{ attempts: number; send_after: number; sent_at: number | null }>(
      `SELECT attempts, send_after, sent_at FROM email_queue WHERE subject = 'While the relay is down'`,
    );
    assert.equal(row?.attempts, 1);
    assert.equal(row?.sent_at, null, 'the message stays in the queue');
    assert.ok(row!.send_after > Date.now(), 'and is scheduled for a later attempt');
  });
});
