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

  /** Discovery for humans and for clients that probe with GET. */
  router.get('/mcp', (ctx: Ctx) => {
    if (!ctx.auth) throw challenge(ctx);
    return {
      protocolVersion: PROTOCOL_VERSION,
      transport: 'streamable-http',
      tools: toolNames(),
      workspace: contextFor(ctx).defaultWorkspace,
    };
  });
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
