/**
 * A minimal SMTP client.
 *
 * Sending mail is a small, stable protocol; pulling in a mail library would be
 * the single largest dependency in the server. This speaks enough of RFC 5321
 * to deliver to any normal relay: EHLO, STARTTLS, AUTH PLAIN/LOGIN, and DATA
 * with dot-stuffing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (port 465). Otherwise STARTTLS is used when offered. */
  secure: boolean;
  user?: string;
  pass?: string;
  /** Accept self-signed certificates — for an internal relay on a private network. */
  allowInvalidCerts?: boolean;
  timeoutMs?: number;
}

export interface Mail {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

class Connection {
  private socket: Socket | TLSSocket;
  private timeoutMs: number;
  private buffer = '';
  private waiting: { resolve: (value: Reply) => void; reject: (error: Error) => void } | null = null;
  private closed = false;

  constructor(socket: Socket | TLSSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.attach();
  }

  private attach(): void {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', () => {
      this.closed = true;
      this.fail(new Error('SMTP connection closed'));
    });
  }

  /** A reply ends with `NNN<space>` on its last line; `NNN-` continues it. */
  private drain(): void {
    if (!this.waiting) return;
    const lines = this.buffer.split(/\r?\n/);
    const end = lines.findIndex((line) => /^\d{3}(?: |$)/.test(line));
    if (end < 0) return;

    const consumed = lines.slice(0, end + 1);
    this.buffer = lines.slice(end + 1).join('\r\n');
    const resolve = this.waiting.resolve;
    this.waiting = null;
    resolve({ code: Number(consumed[end].slice(0, 3)), lines: consumed });
  }

  private fail(error: Error): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
  }

  read(): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error('SMTP connection closed'));
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('SMTP timeout')), this.timeoutMs);
      this.waiting = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.drain();
    });
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  async command(line: string, expected: number[]): Promise<Reply> {
    this.write(line);
    const reply = await this.read();
    if (!expected.includes(reply.code)) {
      throw new Error(`SMTP ${line.split(' ')[0]} failed: ${reply.lines.join(' ')}`);
    }
    return reply;
  }

  async upgrade(host: string, allowInvalidCerts: boolean): Promise<void> {
    const plain = this.socket as Socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    this.socket = await new Promise<TLSSocket>((resolve, reject) => {
      const upgraded = tlsConnect(
        { socket: plain, servername: host, rejectUnauthorized: !allowInvalidCerts },
        () => resolve(upgraded),
      );
      upgraded.once('error', reject);
    });
    this.buffer = '';
    this.attach();
  }

  end(): void {
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
  }
}

interface Reply {
  code: number;
  lines: string[];
}

export async function sendMail(config: SmtpConfig, mail: Mail): Promise<string> {
  const timeoutMs = config.timeoutMs ?? 20_000;
  const socket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: !config.allowInvalidCerts })
    : netConnect({ host: config.host, port: config.port });

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off('secureConnect', onReady);
      socket.off('connect', onReady);
      reject(error);
    };
    socket.once(config.secure ? 'secureConnect' : 'connect', onReady);
    socket.once('error', onError);
    socket.setTimeout(timeoutMs, () => onError(new Error(`Cannot reach ${config.host}:${config.port}`)));
  });
  socket.setTimeout(0);

  const connection = new Connection(socket, timeoutMs);
  const messageId = `<${randomUUID()}@${config.host}>`;

  try {
    const greeting = await connection.read();
    if (greeting.code !== 220) throw new Error(`Unexpected SMTP greeting: ${greeting.lines.join(' ')}`);

    const hostname = 'kolibri';
    let capabilities = (await connection.command(`EHLO ${hostname}`, [250])).lines.join(' ').toUpperCase();

    if (!config.secure && capabilities.includes('STARTTLS')) {
      await connection.command('STARTTLS', [220]);
      await connection.upgrade(config.host, !!config.allowInvalidCerts);
      capabilities = (await connection.command(`EHLO ${hostname}`, [250])).lines.join(' ').toUpperCase();
    }

    if (config.user && config.pass) {
      if (capabilities.includes('AUTH') && capabilities.includes('PLAIN')) {
        const token = Buffer.from(`\0${config.user}\0${config.pass}`).toString('base64');
        await connection.command(`AUTH PLAIN ${token}`, [235]);
      } else {
        await connection.command('AUTH LOGIN', [334]);
        await connection.command(Buffer.from(config.user).toString('base64'), [334]);
        await connection.command(Buffer.from(config.pass).toString('base64'), [235]);
      }
    }

    await connection.command(`MAIL FROM:<${mail.from}>`, [250]);
    await connection.command(`RCPT TO:<${mail.to}>`, [250, 251]);
    await connection.command('DATA', [354]);

    const body = buildMessage(mail, messageId);
    // Dot-stuffing: a line that is just "." would otherwise end the message.
    connection.write(body.replace(/\r?\n\./g, '\r\n..'));
    connection.write('.');
    const stored = await connection.read();
    if (stored.code !== 250) throw new Error(`SMTP rejected the message: ${stored.lines.join(' ')}`);

    await connection.command('QUIT', [221]).catch(() => undefined);
    return messageId;
  } finally {
    connection.end();
  }
}

/* ------------------------------------------------------------------ message */

/** RFC 2047 encoding, so subjects with umlauts survive. */
const encodeHeader = (value: string): string =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;

const base64Lines = (value: string): string =>
  (Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

export function buildMessage(mail: Mail, messageId: string): string {
  const boundary = `kolibri-${createHash('sha1').update(messageId).digest('hex').slice(0, 24)}`;
  const from = mail.fromName ? `${encodeHeader(mail.fromName)} <${mail.from}>` : mail.from;
  const headers: string[] = [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];
  if (mail.replyTo) headers.push(`Reply-To: ${mail.replyTo}`);
  for (const [key, value] of Object.entries(mail.headers ?? {})) {
    if (value) headers.push(`${key}: ${value.replace(/[\r\n]/g, ' ')}`);
  }

  if (!mail.html) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${base64Lines(mail.text)}`;
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** `smtp://user:pass@host:587` / `smtps://…` -> config. */
export function parseSmtpUrl(raw: string): SmtpConfig | null {
  try {
    const url = new URL(raw);
    const secure = url.protocol === 'smtps:';
    return {
      host: url.hostname,
      port: Number(url.port) || (secure ? 465 : 587),
      secure,
      user: url.username ? decodeURIComponent(url.username) : undefined,
      pass: url.password ? decodeURIComponent(url.password) : undefined,
      allowInvalidCerts: url.searchParams.get('insecure') === 'true',
    };
  } catch {
    return null;
  }
}
