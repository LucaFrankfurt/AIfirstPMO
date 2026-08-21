# MCP server

Kolibri implements the [Model Context Protocol](https://modelcontextprotocol.io) so an assistant can
work the board the way a teammate would: read the backlog, file issues, move them, comment, write
pages. It is a first-class client, not a scraping target.

Protocol version `2025-06-18`. Two transports and two ways to sign in, one implementation:

- **Streamable HTTP** — `POST /mcp` with `Authorization: Bearer kol_…`
- **stdio** — `packages/mcp`, a small bridge that pipes JSON-RPC to that same endpoint

Authentication is an API token in a header, or OAuth for clients that cannot hold one — which is
what Claude on the web needs. See [Signing in](#signing-in-for-clients-that-cannot-hold-a-header).

## Setup

1. **Settings → API & MCP → Create token.** Pin it to a workspace so tools do not need a
   `workspace_id` argument. Use scope `read` for an assistant that should only look.
2. Point your client at the instance. Which of the two transports you want depends only on what the
   client speaks — the tools are the same either way, because they are the same implementation.

**A client that speaks HTTP** needs nothing installed. Claude Code, for example:

```bash
claude mcp add --transport http kolibri https://kolibri.example.com/mcp \
  --header "Authorization: Bearer kol_…"
```

**A client that only speaks stdio** runs the bridge, which pipes JSON-RPC to that same endpoint:

```jsonc
{
  "mcpServers": {
    "kolibri": {
      "command": "node",
      "args": ["/path/to/kolibri/packages/mcp/src/index.ts"],
      "env": {
        "KOLIBRI_URL": "https://kolibri.example.com",
        "KOLIBRI_TOKEN": "kol_…"
      }
    }
  }
}
```

A path into a checkout, and not `npx @kolibri/mcp`, because **the bridge is not published to npm
yet** — this said otherwise for a while and the instruction simply failed with a 404. It needs Node
22.18 or newer, which is what runs the server too; nothing is built or installed.

**Claude on the web** takes neither: a connector added at claude.ai has nowhere to put a header and
signs in instead. Paste the instance URL — `https://kolibri.example.com` — as a custom connector and
press Connect. See the next section for what happens then.

## Signing in, for clients that cannot hold a header

A token in a header is the whole story for Claude Code, an editor, a script. It is no story at all
for a connector on the web, which has one text box for a URL and no way to carry a secret. So the
instance is an OAuth 2.1 authorization server as well as a resource server, and everything the
client needs has to be reachable from that one URL.

| | |
|---|---|
| `GET /.well-known/oauth-protected-resource` | what guards `/mcp`, and which server authorises it |
| `GET /.well-known/oauth-authorization-server` | where to send somebody, and where to redeem the code |
| `POST /oauth/register` | a client registers itself (RFC 7591) |
| `GET`/`POST /oauth/authorize` | the consent screen, and the decision |
| `POST /oauth/token` | code → token, and refresh → token |
| `POST /oauth/revoke` | give one back |

A `401` from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="…"`, so a client that
arrives with nothing still finds the first of those.

Four things are worth stating plainly, because each is a decision rather than an implementation
detail:

- **Registration is open, and grants nothing.** A remote assistant cannot exist here before somebody
  pastes the URL into it, and there is no admin standing by to approve an app nobody has heard of.
  Registering yields a name and a set of redirect URIs. What grants access is a person signing in
  and pressing Allow.
- **PKCE with S256, or nothing.** These clients are public and cannot keep a secret, so the proof
  that whoever redeems a code is whoever asked for it is the verifier. `plain` is not offered.
- **A code is single use and lives for a minute.** It travels through a browser redirect, which
  means through an address bar and a history. Redeeming it — successfully or not — burns it.
- **A refresh token rotates.** Using one revokes it and issues the next, so a leaked copy is worth
  one race and then nothing.

What comes out is an **ordinary API token**. It appears in *Settings → API & MCP* beside the
hand-made ones with the connector's name on it, and the same Revoke button stops it. One place to
look, one thing to press.

The consent screen is server-rendered rather than part of the app, because it has to work inside a
popup the client opened, with no router in the way. It names the client, names the account, says
whether write access was asked for, and lets somebody pick which workspace — the granted token is
pinned to it and cannot reach another.

One detail that cost an afternoon and is worth remembering: the instance sends
`form-action 'self'` on every response, and a browser applies that to where a form's **redirect**
lands, not just where it posts. The consent page therefore serves a policy naming the client's
origin — widened by exactly the one address the consent is about. Without it Chrome silently refuses
to submit the form and the flow stops on a page that looks perfectly fine. No server-side test can
see that, which is why the walkthrough presses the button in a real browser.

Verify from a shell:

```bash
curl -s -X POST $URL/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

### Registration is not a login

`POST /oauth/register` is dynamic client registration (RFC 7591) — anyone may call it, which is the
point: it is how a connector added at claude.ai gets a `client_id` from nothing but a URL.

It used to be rate-limited like a sign-up form: five per two minutes, per address, with a refused
attempt costing a token of its own. Both halves were wrong here, and together they made the
connector unusable:

- **Claude on the web registers a fresh client for every connection** — its own dialog says so — and
  every one of those arrives from a handful of shared egress addresses. Five per two minutes is not
  a safeguard for an instance, it is a queue that the fourth person never gets out of.
- **A refusal that costs a token is right for a password form** and wrong for a program that is
  merely being paced. Told to wait 120 seconds, a client waits, retries, is refused again and now
  owes more than before. With a burst of five that turns a two-minute pause into twenty — so trying
  again, which is the obvious thing to do, was the one thing that made it worse.

The endpoint now allows 30 in a burst and one every 10 seconds, and a refusal costs nothing: the
`Retry-After` it sends is the truth.

What bounds registration instead is **rows, not requests**. A registration that was never used to
get a token is worth nothing to anybody, so only the newest 200 of those are kept and the rest are
dropped oldest-first on the next registration. A client that has actually signed somebody in is
never pruned, however old it is.

Errors carry RFC 7591's own codes — `invalid_redirect_uri` rather than a generic one — so a client
can say which field it got wrong instead of reporting *"registration failed"*.

```bash
curl -s -X POST $URL/oauth/register -H 'content-type: application/json' \
  -d '{"client_name":"probe","redirect_uris":["https://example.com/cb"]}' | jq .client_id
```

### The half of the transport that is not a POST

Every answer this server gives is the response to a POST. It keeps no session and has nothing to
push, so the two other verbs the transport defines both answer **405 with `Allow: POST`**:

| | |
|---|---|
| `GET /mcp` with `Accept: text/event-stream` | the optional server-to-client stream, which this server does not open |
| `DELETE /mcp` | session teardown, for a transport with no sessions |

That is the transport's own answer for a stateless server, and getting it wrong is subtle in a way
worth writing down. This endpoint used to answer that GET with `200` and a JSON description of
itself. **Claude Code worked and Claude on the web did not**: Code never opens the stream, the web
client does, and what it got was a document that ended at its content length — a stream that closed
the moment it opened, reported as *"your connection was interrupted"*. Everything else about the
connector — discovery, OAuth, the token — was fine, which is what made it hard to see.

A plain `GET /mcp` with no `Accept: text/event-stream` still answers `200` with the protocol
version, the transport and the tool list. That is for people and scripts, and it is a more useful
reply than a 405 to someone typing the URL.

The auth check runs **before** the 405. An unauthenticated probe must still receive the `401` that
carries `WWW-Authenticate`, because that header is the whole of how a connector added at claude.ai
finds the sign-in from nothing but a URL — answering 405 first would hide it.

```bash
curl -is $URL/mcp -H "Authorization: Bearer $TOKEN" -H 'Accept: text/event-stream' | head -2
# HTTP/1.1 405 Method Not Allowed
# allow: POST
```

## Tools

Tasks are addressed by id or by the identifier humans use (`WEB-42`). Projects accept id, key or
name. Users accept id, email or name — so an assistant can pass what it read in the conversation.

### Reading

| Tool | Returns |
|---|---|
| `list_workspaces` | workspaces this token can reach, with the caller's role |
| `list_projects` | projects with open/done task counts |
| `list_tasks` | filter by `project`, `state` (name or group), `type` (Bug, Feature, …), `assignee` (`"me"` works), `priority`, `cycle` (`"current"` works), `due_before`, `query` |
| `get_task` | one task with description, sub-tasks, relations, comments and recent activity |
| `search` | full text across tasks, pages, projects, comments, cycles, modules |
| `list_cycles` | sprints with `total`/`done` counts |
| `list_pages` / `get_page` | wiki pages, markdown included |
| `list_templates` | pre-written tasks, with the checklist each one carries |
| `list_time` | logged time, narrowed by task, project, date range or `mine`, with the total |
| `list_members` | people with role and open task count |
| `project_status` | counts by state group and priority, overdue list, unassigned count, active cycle, recent activity |
| `my_work` | the token owner's open tasks, split into overdue / today / upcoming / unscheduled |

### Writing

| Tool | Notes |
|---|---|
| `create_task` | project + title required; `type` names one of the project's kinds of work; labels that do not exist yet are created |
| `update_task` | any field, including `state`, `type`, `assignees`, `cycle`, `due_date`, `archived`. An unknown `type` is refused rather than created |
| `delete_task` | soft delete, flagged `destructiveHint` for clients that confirm |
| `comment_task` | markdown; notifies assignees and subscribers |
| `create_project` | includes the default workflow states and labels |
| `create_cycle` | sprint with start/end dates |
| `create_page` / `update_page` | `update_page` takes `content` (replace) or `append` |
| `apply_template` | files a real task from a template, checklist and all — the same path the automations use |
| `log_time` | records time spent; takes `90`, `1h30`, `1.5h` or `1:30`, defaults to today and to the token owner |

Writes are attributed to the token owner and appear in the activity trail and everyone's live sync
like any other change. A read-only token gets `This token is read-only` from every write tool.

### Example

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "create_task",
    "arguments": {
      "project": "WEB",
      "title": "Cut largest-contentful-paint below 1.5s",
      "priority": "urgent",
      "assignees": ["grace@kolibri.dev"],
      "labels": ["performance"],
      "due_date": "2026-09-01"
    }
  }
}
```

```json
{
  "content": [{ "type": "text", "text": "{ … }" }],
  "structuredContent": {
    "id": "0b8a…", "identifier": "WEB-12", "title": "Cut largest-contentful-paint below 1.5s",
    "state": "Backlog", "priority": "urgent", "url": "https://kolibri.example.com/t/0b8a…"
  }
}
```

Every tool returns both a text block (for models that read text) and `structuredContent` (for
clients that parse), so no client has to guess.

## Prompts

`prompts/list` exposes three workflows that chain the tools sensibly:

- **`standup`** *(project)* — what moved, what is in flight, what is overdue, the top risk
- **`sprint_planning`** *(project, capacity?)* — propose the next cycle's scope from the backlog
- **`triage`** *(project)* — propose priority, owner and label for untriaged work, table first

They deliberately ask for confirmation before writing anything.

## Resources

`resources/list` returns the workspace's wiki pages as `kolibri://page/<id>` with
`mimeType: text/markdown`; `resources/read` returns the markdown. Tasks are readable the same way
via `kolibri://task/<id>`. This lets a client attach a handbook page as context without a tool call.

## Permissions

The token owner's permissions apply, always:

- private projects they are not a member of are invisible to every tool,
- guests cannot write,
- a token pinned to a workspace cannot reach another one, even if the account is a member.

Revoke a token in **Settings → API & MCP**; it stops working immediately. A connector authorised on
the web is listed there under its own name and is revoked the same way — the OAuth flow issues an
ordinary token, so there is one list and one button rather than two of each.
