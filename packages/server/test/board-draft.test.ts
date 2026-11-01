/**
 * Asking Claude to draw a board on a canvas, or to redraw one.
 *
 * Against a provider that answers however the test says, so three things can
 * be pinned without a key or a bill:
 *
 * - what leaves the building: the rules a board has to follow, the frame's
 *   size, the instruction — and, for a redraw or a matching look, the boards'
 *   own HTML, which is somebody's content and is sent only when it is asked for;
 * - how a reply is read: a document cut out of a fence or a sentence, and a
 *   reply with no page in it refused rather than put on the canvas;
 * - who may ask: a member who can see the canvas, in a workspace that switched
 *   the model on, on a server that has one.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-board-draft-${process.pid}`;

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const { server } = await import('../src/index.ts');
const { resetRateLimits } = await import('../src/kernel/identity/ratelimit.ts');
const { env } = await import('../src/kernel/platform/env.ts');
const { BOARD_SYSTEM, htmlFromReply } = await import('../src/modules/ai-review/board.ts');

let base = '';
interface Person { cookie: string; id: string }

async function call(path: string, options: { cookie?: string; body?: unknown; method?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, setCookie: response.headers.get('set-cookie') };
}

async function ok<T = any>(path: string, options: Parameters<typeof call>[1] = {}): Promise<T> {
  const result = await call(path, options);
  if (result.status >= 400) throw new Error(`${result.status} ${path}: ${result.body?.message ?? ''}`);
  return result.body as T;
}

/* --------------------------------------------------- a provider to ask */

let provider: Server;
let sent: any[] = [];
let answer: () => string = () => '';

const PAGE = '<!doctype html>\n<html><head><title>Pipeline review</title></head><body><h1 style="color: #14161c">Pipeline</h1></body></html>';

let ada: Person;
let lin: Person;
let workspace = '';
let canvas = '';

before(async () => {
  provider = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      sent.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: answer() }], stop_reason: 'end_turn' }));
    });
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  process.env.KOLIBRI_AI_PROVIDER = 'anthropic';
  Object.assign(env.ai, { key: 'test-key', model: 'test-model', baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, burst: 100 });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const register = async (email: string): Promise<Person> => {
    resetRateLimits();
    const result = await call('/api/auth/register', { body: { email, name: email.split('@')[0], password: 'correct horse battery' } });
    return { cookie: result.setCookie!.split(';')[0], id: result.body.user.id };
  };
  ada = await register('draft-ada@example.com');
  workspace = (await ok('/api/session', { cookie: ada.cookie })).workspaces[0].id;
  const invite = await ok(`/api/workspaces/${workspace}/invites`, { cookie: ada.cookie, body: { role: 'member' } });
  lin = await register('draft-lin@example.com');
  await ok(`/api/invites/${invite.code}/accept`, { cookie: lin.cookie, body: {} });
  await ok(`/api/workspaces/${workspace}`, { cookie: ada.cookie, method: 'PATCH', body: { features: { ai: true } } });
  canvas = (await ok(`/api/workspaces/${workspace}/pages`, { cookie: ada.cookie, body: { title: 'SetSide CRM', format: 'canvas' } })).id;
});

after(() => {
  delete process.env.KOLIBRI_AI_PROVIDER;
  provider.close();
  server.close();
  rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true });
});

const draft = (who: Person, page: string, body: Record<string, unknown>) =>
  call(`/api/pages/${page}/boards/draft`, { cookie: who.cookie, body });

describe('reading a page out of a reply', () => {
  it('takes the document as it comes', () => {
    assert.equal(htmlFromReply(PAGE), PAGE);
  });

  it('cuts it out of a code fence or a sentence', () => {
    assert.equal(htmlFromReply('```html\n' + PAGE + '\n```'), PAGE);
    assert.equal(htmlFromReply('Here is your board:\n\n' + PAGE + '\n\nEnjoy!'), PAGE);
  });

  it('gives a body of markup a document of its own', () => {
    assert.match(htmlFromReply('<main><h1>Hi</h1></main>')!, /^<!doctype html>[\s\S]*<main><h1>Hi<\/h1><\/main>[\s\S]*<\/html>$/);
  });

  it('refuses a reply with no page in it', () => {
    assert.equal(htmlFromReply('I cannot help with that.'), null);
  });
});

describe('drawing a board', () => {
  it('answers with the page, its title, and which model drew it', async () => {
    sent = [];
    answer = () => PAGE;
    const result = await draft(ada, canvas, { instruction: 'A pipeline overview for the sales team', w: 1440, h: 900 });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { title: 'Pipeline review', html: PAGE, model: 'test-model' });

    const [request] = sent;
    assert.equal(request.system, BOARD_SYSTEM);
    assert.match(request.system, /reaches no network/, 'the model was not told the board cannot fetch');
    assert.match(request.messages[0].content, /Canvas: SetSide CRM/);
    assert.match(request.messages[0].content, /Frame: 1440 × 900/);
    assert.match(request.messages[0].content, /A pipeline overview for the sales team/);
    assert.equal(request.max_tokens, 16000);
    assert.equal(request.output_config.effort, 'medium');
  });

  it('sends the other boards for their look, and only when asked', async () => {
    await ok(`/api/workspaces/${workspace}/artboards`, { cookie: ada.cookie, body: { page_id: canvas, title: 'Existing', content: '<p style="color: #2e2e8f">Our look</p>' } });
    sent = [];
    await draft(ada, canvas, { instruction: 'A second screen' });
    assert.match(sent[0].messages[0].content, /Our look/);
    sent = [];
    await draft(ada, canvas, { instruction: 'A second screen', match: false });
    assert.doesNotMatch(sent[0].messages[0].content, /Our look/, 'a board was sent although matching was turned off');
  });

  it('redraws a board from its current HTML, at its own size', async () => {
    const board = await ok(`/api/workspaces/${workspace}/artboards`, {
      cookie: ada.cookie, body: { page_id: canvas, title: 'Script', content: '<h1>Cold call script v1</h1>', w: 760, h: 720 },
    });
    sent = [];
    const result = await draft(ada, canvas, { instruction: 'Make the heading friendlier', board: board.id });
    assert.equal(result.status, 200);
    const prompt = sent[0].messages[0].content;
    assert.match(prompt, /The board to change, as it is now:\n<h1>Cold call script v1<\/h1>/);
    assert.match(prompt, /What to change:\nMake the heading friendlier/);
    assert.match(prompt, /Frame: 760 × 720/);
  });

  it('draws on a board page as well as a canvas', async () => {
    answer = () => PAGE;
    const page = (await ok(`/api/workspaces/${workspace}/pages`, { cookie: ada.cookie, body: { title: 'One-pager', format: 'board' } })).id;
    sent = [];
    const result = await draft(ada, page, { instruction: 'A one-pager for the board meeting' });
    assert.equal(result.status, 200);
    assert.match(sent[0].messages[0].content, /Canvas: One-pager/);
  });

  it('refuses a reply that is not a page, and puts nothing anywhere', async () => {
    answer = () => 'Sorry, I cannot draw that.';
    const result = await draft(ada, canvas, { instruction: 'Anything' });
    assert.equal(result.status, 502);
    answer = () => PAGE;
  });
});

describe('who may ask', () => {
  it('not somebody who cannot see the canvas', async () => {
    const shut = (await ok(`/api/workspaces/${workspace}/pages`, { cookie: ada.cookie, body: { title: 'Private', format: 'canvas', access: 'private' } })).id;
    sent = [];
    assert.equal((await draft(lin, shut, { instruction: 'Show me' })).status, 404);
    assert.equal(sent.length, 0, 'a refused request still reached the model');
  });

  it('not on a page that holds no boards', async () => {
    const text = (await ok(`/api/workspaces/${workspace}/pages`, { cookie: ada.cookie, body: { title: 'Text' } })).id;
    assert.equal((await draft(ada, text, { instruction: 'Draw' })).status, 400);
  });

  it('not without an instruction', async () => {
    assert.equal((await draft(ada, canvas, { instruction: '  ' })).status, 400);
  });

  it('not where the workspace has it switched off', async () => {
    await ok(`/api/workspaces/${workspace}`, { cookie: ada.cookie, method: 'PATCH', body: { features: { ai: false } } });
    assert.equal((await draft(ada, canvas, { instruction: 'Draw' })).status, 403);
    await ok(`/api/workspaces/${workspace}`, { cookie: ada.cookie, method: 'PATCH', body: { features: { ai: true } } });
  });

  it('not on a server with no model', async () => {
    const key = env.ai.key;
    env.ai.key = '';
    assert.equal((await draft(ada, canvas, { instruction: 'Draw' })).status, 400);
    env.ai.key = key;
  });
});
