#!/usr/bin/env node
/**
 * Kolibri MCP bridge (stdio -> HTTP).
 *
 * Clients that only speak stdio (Claude Desktop, most editors) get a local
 * process; the actual tools live in the server, so there is exactly one
 * implementation to keep correct.
 *
 *   KOLIBRI_URL=https://kolibri.example.com KOLIBRI_TOKEN=kol_… kolibri-mcp
 */
import { createInterface } from 'node:readline';

const url = (process.env.KOLIBRI_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const token = process.env.KOLIBRI_TOKEN ?? '';
const endpoint = `${url}/mcp`;

if (!token) {
  process.stderr.write(
    'kolibri-mcp: set KOLIBRI_TOKEN to an API token (Settings -> API tokens in the app).\n',
  );
  process.exit(2);
}

const write = (payload: unknown): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

async function forward(message: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(message),
    });

    if (response.status === 202) return; // notification, nothing to answer
    const text = await response.text();
    if (!response.ok) {
      process.stderr.write(`kolibri-mcp: ${response.status} ${text}\n`);
      if (message.id !== undefined && message.id !== null) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `Kolibri responded ${response.status}: ${text.slice(0, 200)}` } });
      }
      return;
    }
    if (text.trim()) process.stdout.write(`${text.trim()}\n`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`kolibri-mcp: cannot reach ${endpoint} (${detail})\n`);
    if (message.id !== undefined && message.id !== null) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: `Cannot reach Kolibri at ${url}: ${detail}` } });
    }
  }
}

// Requests are processed strictly in order so responses cannot overtake each
// other on the wire, which some clients rely on.
let queue: Promise<void> = Promise.resolve();

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  queue = queue.then(() => forward(message));
});

process.stdin.on('close', () => process.exit(0));
