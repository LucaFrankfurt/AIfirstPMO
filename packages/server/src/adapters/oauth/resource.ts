/**
 * Where the protected resource lives.
 *
 * One line, and it sits here rather than in `routes/oauth.ts` because two route
 * files answer with it: the OAuth metadata says what it protects, and the MCP
 * route points a client at that metadata. A route importing another route makes
 * both impossible to replace, which is what the layering rule is about.
 */
import { publicOrigin } from '../../kernel/platform/origin.ts';
import type { Ctx } from '../../kernel/platform/http.ts';

export const resourceUrl = (ctx: Ctx): string => `${publicOrigin(ctx)}/mcp`;
