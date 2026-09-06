/**
 * The MCP surface, for the half of the audience that came for exactly this.
 *
 * "MCP-native" is a claim with a lot of cover behind it right now, so this set
 * spends its slides on the things that are checkable: what the tools are
 * actually called, what the two transports are, what a token is pinned to, and
 * what happens when a client that cannot hold a header asks to sign in. All of
 * it is `docs/mcp.md`, and the tool names are the real ones — a made-up
 * `add_item` on a slide is the fastest way to be found out by the one reader
 * who was going to install it.
 *
 * The count on the third slide is a *figure*: it is claimed in
 * `scripts/figures.mjs`, counted from the tools directory, and `npm run
 * check:figures -- --fix` rewrites it. That is the same treatment the README's
 * copy of the number gets, and it is here rather than typed because a marketing
 * slide is precisely where a stale count survives longest.
 */
import { tools } from '../../product';
import { ToolCall } from '../../components/ToolCall';
import type { Carousel } from '../slide';

const W = 912;

export const assistant: Carousel = {
  id: 'SocialAssistant',
  about: 'MCP — the tools, the two transports, the token, and what a connector may do',
  slides: [
    {
      kind: 'cover',
      kicker: 'MCP-native',
      headline: 'An assistant is a first-class user.',
      sub: 'Not a scraping target, and not a plug-in bolted to the side. The same permissions, the same workspace, the same audit trail as anybody else.',
    },
    {
      kind: 'point',
      kicker: 'A call',
      headline: 'It files the task and tells you what it filed.',
      sub: 'Read the backlog, open issues, move them through the workflow, write pages — with exactly the permissions you grant.',
      visual: {
        height: 350,
        node: <ToolCall frame={110} width={W} size={21} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      kicker: 'The surface',
      headline: `${tools.count} tools and ${tools.prompts} prompts, not a wrapper around one.`,
      sub: 'Tasks, projects, cycles, pages, time, budgets, KPIs, the infrastructure register and mail — each is the same implementation the web app calls.',
      chips: [
        'my_work',
        'list_tasks',
        'create_task',
        'comment_task',
        'blocked_tasks',
        'deadlines_at_risk',
        'project_status',
        'cycle_review',
        'workload',
        'create_page',
        'search',
      ],
      mono: true,
    },
    {
      kind: 'point',
      kicker: 'Two transports',
      headline: 'HTTP if the client speaks it. A bridge if it does not.',
      sub: 'Streamable HTTP is a POST and a bearer token, with nothing to install. Everything else runs the stdio bridge, which pipes JSON-RPC to that same endpoint — one implementation, so the tools cannot disagree.',
      code: 'claude mcp add --transport http kolibri \\\n  https://kolibri.example.com/mcp \\\n  --header "Authorization: Bearer kol_…"',
    },
    {
      kind: 'point',
      kicker: 'The token',
      headline: 'Pinned to one workspace, and scoped.',
      sub: 'Scope it read for an assistant that should only look. Pin it to a workspace and the tools stop needing a workspace argument — and stop being able to reach another one.',
    },
    {
      kind: 'point',
      kicker: 'Connectors',
      headline: 'Registration is open, and grants nothing.',
      sub: 'A client with one text box and nowhere to keep a secret signs in instead: OAuth 2.1, PKCE with S256 or nothing, a code that is single use and lives for a minute, and a refresh token that rotates. What grants access is a person pressing Allow.',
    },
    {
      kind: 'point',
      kicker: 'And afterwards',
      headline: 'It is an ordinary API token.',
      sub: 'It appears in Settings → API & MCP beside the hand-made ones, with the connector’s name on it, and the same Revoke button stops it. One place to look, one thing to press.',
    },
    {
      kind: 'close',
      kicker: 'MCP-native',
      headline: 'Your board, on your server, in your assistant.',
      sub: 'Protocol 2025-06-18. The bridge is in the repository; nothing is published to npm.',
    },
  ],
};
