/**
 * A minimal IMAP client: sign in, select, search, fetch, hang up.
 *
 * Read-only, and that is a guarantee rather than an omission. `SELECT` is sent
 * as `EXAMINE`, which puts the session in a mode where the server itself
 * refuses to change a flag or delete a message — so a bug here cannot mark
 * somebody's inbox as read, and a compromised instance cannot empty it. The
 * feature is "search four inboxes from one place", and nothing about it needs
 * write access; asking for less is the cheapest security property available.
 *
 * `protocol.ts` holds the grammar and the reasoning about why this is written
 * by hand at all. What is here is the conversation and its three sharp edges:
 *
 * **Literals.** `{4021}` means the next 4 021 bytes are data, newlines
 * included, and a reader that splits on CRLF first will cut a message in half.
 * So the reader reads a line, and if it ends in a literal length, reads exactly
 * that many bytes before looking for the next line.
 *
 * **STARTTLS is required when asked for, not attempted.** Same rule as the SMTP
 * client, same reason: a server that does not advertise the upgrade is either
 * having a bad day or is not the server it claims to be, and the next thing
 * this client would otherwise do is send `LOGIN user password` in the clear.
 *
 * **A tag is per command, and replies interleave.** Untagged lines — `* 42
 * EXISTS`, `* SEARCH …` — arrive between the command and its completion, and
 * some arrive unbidden. So everything up to the tagged line is collected, and
 * the caller reads what it wanted out of the collection.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { hasSecret, type MailboxConfig } from '../../kernel/mail/mailbox.ts';
import { tokenise, type Segment, type Token } from './protocol.ts';

export interface Response {
  /** Untagged lines, each already tokenised. */
  untagged: Token[][];
  /** `OK`, `NO` or `BAD`, from the tagged completion. */
  status: string;
  text: string;
}

export class ImapError extends Error {
  /** True when retrying will not help: a wrong password, a folder that is not there. */
  permanent: boolean;

  constructor(message: string, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

const DEFAULT_TIMEOUT = 30_000;

export class ImapConnection {
  private socket: Socket | TLSSocket;
  private timeoutMs: number;
  private buffer = Buffer.alloc(0);
  private waiting: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  private counter = 0;

  private constructor(socket: Socket | TLSSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.attach();
  }

  /** Connect, upgrade if asked, sign in. Throws with the server's own words. */
  static async open(config: MailboxConfig): Promise<ImapConnection> {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
    const implicit = config.encryption === 'tls';
    // Either kind of credential. A bearer token on a plaintext connection is a
    // mailbox for whoever is listening; that it expires in an hour is the only
    // way it beats a password.
    if (config.encryption === 'none' && hasSecret(config.credential)) {
      throw new ImapError(
        `Refusing to send a credential to ${config.host}:${config.port} unencrypted — set the encryption to starttls or tls`,
        true,
      );
    }

    const socket = implicit
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: !config.allowInvalidCerts })
      : netConnect({ host: config.host, port: config.port });

    await new Promise<void>((resolve, reject) => {
      const ready = () => { socket.off('error', failed); resolve(); };
      const failed = (error: Error) => {
        socket.off('secureConnect', ready);
        socket.off('connect', ready);
        reject(new ImapError(`Cannot reach ${config.host}:${config.port} — ${error.message}`));
      };
      socket.once(implicit ? 'secureConnect' : 'connect', ready);
      socket.once('error', failed);
      socket.setTimeout(timeoutMs, () => failed(new Error('timed out')));
    });
    socket.setTimeout(0);

    const connection = new ImapConnection(socket, timeoutMs);
    const greeting = await connection.readUntagged();
    // `* PREAUTH` means the server has already decided who we are — a local
    // socket, usually. Rare, and worth handling rather than failing on.
    const preauth = /^\*\s+PREAUTH/i.test(greeting);
    if (!preauth && !/^\*\s+OK/i.test(greeting)) {
      connection.end();
      throw new ImapError(`Unexpected IMAP greeting: ${greeting.trim().slice(0, 200)}`);
    }

    if (config.encryption === 'starttls') {
      const capability = await connection.command('CAPABILITY');
      if (!flat(capability).toUpperCase().includes('STARTTLS')) {
        connection.end();
        throw new ImapError(
          `${config.host}:${config.port} does not offer STARTTLS — refusing to continue unencrypted`,
          true,
        );
      }
      await connection.expect('STARTTLS');
      await connection.upgrade(config.host, !!config.allowInvalidCerts);
    }

    if (!preauth) {
      if (config.credential.kind === 'oauth') {
        // Capabilities are read *after* any upgrade, for the reason the SMTP
        // client re-reads them: what a server advertises before TLS is not
        // binding, and AUTH in particular is commonly withheld until it is safe.
        const capabilities = flat(await connection.command('CAPABILITY')).toUpperCase();
        await connection.authenticateXOAuth2(config.username, config.credential.accessToken, capabilities);
      } else {
        // Quoted and escaped, because a password with a `"` or a `\` in it is
        // otherwise a syntax error at best — and at worst an extra argument.
        const login = `LOGIN ${quote(config.username)} ${quote(config.credential.password)}`;
        const result = await connection.command(login);
        if (result.status !== 'OK') {
          connection.end();
          // Reported as permanent: a wrong password does not become right on a
          // retry, and retrying is how an account gets locked.
          throw new ImapError(`Sign-in refused: ${result.text || 'no reason given'}`, true);
        }
      }
    }
    return connection;
  }

  /* -------------------------------------------------------------- plumbing */

  private attach(): void {
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.waiting?.resolve();
    });
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', () => this.fail(new ImapError('The mail server closed the connection')));
  }

  private fail(error: Error): void {
    this.failure = error;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
  }

  /** Wait until more bytes arrive, or the deadline passes. */
  private more(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ImapError('The mail server stopped responding')), this.timeoutMs);
      this.waiting = {
        resolve: () => { clearTimeout(timer); this.waiting = null; resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
  }

  /** One CRLF-terminated line, as bytes, without the terminator. */
  private async readLine(): Promise<Buffer> {
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end >= 0) {
        const line = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 2);
        return line;
      }
      await this.more();
    }
  }

  /** Exactly `count` bytes, however many reads that takes. */
  private async readBytes(count: number): Promise<Buffer> {
    while (this.buffer.length < count) await this.more();
    const bytes = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return bytes;
  }

  /**
   * One response *unit*: a line, plus every literal it announces and whatever
   * follows them.
   *
   * The loop is the whole trick. A line ending in `{4021}` is not finished —
   * the 4 021 bytes and the rest of the line come next, and that rest can
   * itself end in another literal, which is exactly what a fetch of two parts
   * looks like.
   */
  private async readSegments(): Promise<Segment[]> {
    const segments: Segment[] = [];
    for (;;) {
      const line = await this.readLine();
      const text = line.toString('latin1');
      // `{123+}` is a non-synchronising literal the *client* sends; only the
      // plain form appears in what a server says.
      const literal = /\{(\d+)\}$/.exec(text);
      // The announcement is framing, not a value, and it is dropped here — the
      // one place that knows it is framing. Left in, it tokenises as an atom
      // between the item name and its bytes, which shifts every following pair
      // by one: `BODY[1]` then reads as the string `{41}` and the bytes are
      // orphaned. Nothing throws, and the message simply has no body.
      segments.push({ text: literal ? text.slice(0, -literal[0].length) : text });
      if (!literal) return segments;
      segments.push({ literal: await this.readBytes(Number(literal[1])) });
    }
  }

  private async readUntagged(): Promise<string> {
    const segments = await this.readSegments();
    return segments.map((one) => ('text' in one ? one.text : '')).join('');
  }

  private async upgrade(host: string, allowInvalidCerts: boolean): Promise<void> {
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
    this.buffer = Buffer.alloc(0);
    this.attach();
  }

  /* -------------------------------------------------------------- commands */

  /**
   * Send one command and collect everything until its own tagged completion.
   *
   * The tag is what makes this safe against the untagged chatter a server emits
   * whenever it feels like it — `* 12 EXPUNGE`, `* OK [ALERT] …` — and against
   * the last command's leftovers.
   */
  async command(text: string): Promise<Response> {
    this.counter += 1;
    const tag = `k${this.counter}`;
    this.socket.write(`${tag} ${text}\r\n`);

    const untagged: Token[][] = [];
    for (;;) {
      const segments = await this.readSegments();
      const first = 'text' in segments[0] ? segments[0].text : '';
      if (first.startsWith(`${tag} `)) {
        const [, status = '', rest = ''] = /^\S+\s+(\S+)\s*([\s\S]*)$/.exec(first) ?? [];
        return { untagged, status: status.toUpperCase(), text: rest.trim() };
      }
      // A `+` line is the server asking for more, which only happens in flows
      // this client does not use. Reading past it rather than hanging.
      if (first.startsWith('+')) continue;
      untagged.push(tokenise(segments));
    }
  }

  /** A command whose failure is the caller's problem, stated in the server's words. */
  async expect(text: string): Promise<Response> {
    const result = await this.command(text);
    if (result.status !== 'OK') {
      throw new ImapError(`${text.split(' ')[0]} failed: ${result.text || result.status}`, result.status === 'NO');
    }
    return result;
  }

  /**
   * `AUTHENTICATE XOAUTH2`, which is two protocols in a trench coat.
   *
   * The credential is a SASL blob — `user=…^Aauth=Bearer …^A^A`, base64'd —
   * and there are two ways to send it. A server advertising `SASL-IR` takes it
   * on the command line; one that does not wants the command alone, answers
   * with a bare `+`, and reads the blob as the next line. Both are in the
   * field, so both are here.
   *
   * The failure path is the part worth writing down, because getting it wrong
   * does not produce an error — it produces a hang. When the token is refused,
   * the server does **not** reply `NO`: it replies with a `+` continuation
   * carrying a base64 JSON explanation, and it then waits for the client to
   * acknowledge with an empty line before it will say `NO`. A client that
   * treats that `+` as noise and keeps reading waits for a tagged reply that
   * will never come, until the socket times out thirty seconds later — and the
   * mailbox is recorded as unreachable rather than as signed out, which sends
   * whoever is debugging it to the firewall instead of to the consent screen.
   */
  async authenticateXOAuth2(username: string, token: string, capabilities: string): Promise<void> {
    if (!capabilities.includes('XOAUTH2')) {
      this.end();
      throw new ImapError('This mail server does not accept OAuth sign-in (no AUTH=XOAUTH2)', true);
    }
    const blob = Buffer.from(`user=${username}\x01auth=Bearer ${token}\x01\x01`).toString('base64');
    this.counter += 1;
    const tag = `k${this.counter}`;
    const inline = capabilities.includes('SASL-IR');
    this.socket.write(inline ? `${tag} AUTHENTICATE XOAUTH2 ${blob}\r\n` : `${tag} AUTHENTICATE XOAUTH2\r\n`);

    let sent = inline;
    for (;;) {
      const segments = await this.readSegments();
      const line = 'text' in segments[0] ? segments[0].text : '';
      if (line.startsWith('+')) {
        // The first `+` on the two-step path is the server asking for the blob.
        // Any later one is the refusal above, and the empty line is what lets
        // the server finish the sentence.
        this.socket.write(sent ? '\r\n' : `${blob}\r\n`);
        sent = true;
        continue;
      }
      if (!line.startsWith(`${tag} `)) continue; // untagged chatter
      const [, status = '', rest = ''] = /^\S+\s+(\S+)\s*([\s\S]*)$/.exec(line) ?? [];
      if (status.toUpperCase() === 'OK') return;
      this.end();
      // Permanent: an expired token is refreshed by the caller and a revoked
      // one needs a person. Neither is helped by trying again immediately, and
      // trying again is how a provider starts rate-limiting the account.
      throw new ImapError(`OAuth sign-in refused: ${rest.trim() || status || 'no reason given'}`, true);
    }
  }

  end(): void {
    try {
      this.socket.write('k0 LOGOUT\r\n');
      this.socket.end();
    } catch {
      /* already gone */
    }
  }
}

/** Everything a response said, as one string — for a capability check. */
export const flat = (response: Response): string =>
  response.untagged.map((tokens) => tokens.map(textOf).join(' ')).join(' ');

const textOf = (token: Token): string => {
  if (token.kind === 'list') return token.items.map(textOf).join(' ');
  if (token.kind === 'literal') return token.value.toString('latin1');
  return token.value;
};

/**
 * An IMAP quoted string.
 *
 * Both escapes matter and the order does: escaping the quote first would then
 * have its own backslash escaped by the second pass. A password with a
 * backslash in it is not exotic — it is what a generator produces.
 */
export const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
