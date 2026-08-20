import { get, type Row } from '../db/index.ts';
import { authenticate } from '../lib/auth.ts';
import { handleRpc, PROTOCOL_VERSION, toolNames, type McpCtx } from '../lib/mcp.ts';
import { readJson, send, unauthorized, type Ctx, type Router } from '../lib/http.ts';
import { resourceUrl } from './oauth.ts';

/**
 * Streamable-HTTP MCP endpoint.
 *
 * A POST carries one JSON-RPC message (or a batch) and gets one JSON response;
 * notifications get 202 with no body. That is the subset of the transport every
 * MCP client supports, and it needs no session state on our side.
 */
export function registerMcpRoutes(router: Router): void {
  router.post('/mcp', async (ctx: Ctx) => {
    const mcpCtx = contextFor(ctx);
    const body = await readJson<unknown>(ctx);
    const messages = Array.isArray(body) ? body : [body];
    const responses = messages
      .map((message) => handleRpc(message as Record<string, unknown>, mcpCtx))
      .filter((r): r is Record<string, unknown> => r !== null);

    if (!responses.length) {
      send(ctx.res, 202, null);
      return undefined;
    }
    send(ctx.res, 200, Array.isArray(body) ? responses : responses[0], { 'mcp-protocol-version': PROTOCOL_VERSION });
    return undefined;
  });

  /**
   * A GET is two different questions, and answering the wrong one breaks the
   * connector.
   *
   * With `Accept: text/event-stream` the client is opening the optional
   * server-to-client stream. This server has nothing to push — it is stateless,
   * every answer is the response to a POST — and the transport's own answer for
   * that case is **405 with an `Allow` header**, not a body. Returning the
   * discovery JSON instead is what broke claude.ai: it opened the stream, got
   * `application/json`, read to the end of the content length and saw the
   * stream close, which it reports as "your connection was interrupted". Claude
   * Code never opens that stream, which is why the same server worked there and
   * not on the web.
   *
   * Without that header it is a person or a script asking what this endpoint
   * is, and a list of tools is a more useful reply than a 405.
   *
   * Order matters: the auth check comes first so that an unauthenticated probe
   * still gets the 401 that carries `WWW-Authenticate`. That header is the
   * whole of how a connector added at claude.ai finds the sign-in from nothing
   * but a URL, and a 405 would hide it.
   */
  router.get('/mcp', (ctx: Ctx) => {
    if (!ctx.auth) throw challenge(ctx);
    if (String(ctx.req.headers.accept ?? '').includes('text/event-stream')) return noStream(ctx);
    return {
      protocolVersion: PROTOCOL_VERSION,
      transport: 'streamable-http',
      tools: toolNames(),
      workspace: contextFor(ctx).defaultWorkspace,
    };
  });

  /**
   * Session termination, for a transport with no sessions.
   *
   * The client may send this when it disconnects. There is nothing to tear
   * down, and the transport says to answer 405 rather than pretend — a 404
   * says "wrong address", which is a different and more alarming thing to tell
   * a client that has been talking to this endpoint all along.
   */
  router.delete('/mcp', (ctx: Ctx) => noStream(ctx));
}

/** "This endpoint exists, and does not do that." */
function noStream(ctx: Ctx): undefined {
  send(ctx.res, 405, {
    error: 'method_not_allowed',
    message: 'This endpoint answers POST. It keeps no session and opens no server-to-client stream.',
  }, { allow: 'POST' });
  return undefined;
}

function contextFor(ctx: Ctx): McpCtx {
  const auth = ctx.auth ?? authenticate(ctx);
  if (!auth) throw challenge(ctx);
  const pinned = auth.tokenId
    ? get<Row>(`SELECT workspace_id FROM api_tokens WHERE id = ?`, auth.tokenId)?.workspace_id ?? null
    : null;
  return { auth, defaultWorkspace: pinned };
}

/**
 * The 401 that starts a sign-in.
 *
 * A client arriving with no credentials has to be told not just "no" but where
 * to go — `WWW-Authenticate` names the metadata document that leads to the
 * authorization server, which is the whole of how a connector added at
 * claude.ai finds its way in from nothing but a URL. See `oauth.ts`.
 */
function challenge(ctx: Ctx): ReturnType<typeof unauthorized> {
  const metadata = `${resourceUrl(ctx).replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource`;
  ctx.res.setHeader('www-authenticate', `Bearer resource_metadata="${metadata}"`);
  return unauthorized('Sign in, or send an API token: Authorization: Bearer kol_…');
}
