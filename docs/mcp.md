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

### The address in the metadata has to be the address you typed

Every value in both discovery documents comes from one place, and `issuer` is checked by the client
against the URL it fetched the document from — RFC 8414 §3.3 makes that a MUST. A mismatch is a hard
refusal, and it happens before any request the server could log.

That is what a proxy forwarding the host but not the scheme produces: `http://your-real-domain` as
the issuer of a document served over https. The symptom is precise and misleading — a connector
reads all three documents, gets `200` for each, never calls the registration endpoint, and reports
*"registration failed"*.

Set **`KOLIBRI_PUBLIC_URL`** and the question does not arise. Without it the scheme is inferred:
`x-forwarded-proto`, then the socket, then a guess — a bare hostname reached this process through
something that terminated TLS, while a host carrying a port is somebody's laptop.

```bash
curl -s https://your-host/.well-known/oauth-authorization-server | jq '.issuer, .registration_endpoint'
```

Both must start with the `https://your-host` you typed. If either says `http://`, that is the bug,
and no amount of work on the endpoints behind them will help.

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

The response hands back **the client's registered metadata**, not just an id — RFC 7591 §3.2.1 asks
for it, and the reason it matters is `scope`. A client that asks for a scope and is told nothing
about scope has not been told yes, and a strict one reads the silence as a refusal. Values this
server substitutes rather than accepts (`scope`, `token_endpoint_auth_method`, the grant types) come
back as what was registered, so the client can see which of the two happened. The descriptive fields
— `client_uri`, `logo_uri`, `policy_uri`, `tos_uri`, `software_id` — are echoed exactly; they are
how a client names itself on the consent screen and mean nothing else here.

Errors carry RFC 7591's own codes — `invalid_redirect_uri` rather than a generic one — so a client
can say which field it got wrong instead of reporting *"registration failed"*.

### When a connector fails and the client is on somebody else's servers

`/oauth/*`, `/mcp` and the `.well-known` documents each log a line — method, path, status, user
agent. Nothing else does: those are the only paths quiet enough for it, and they are the only ones
whose failures nobody can watch from outside.

```
INFO  POST /oauth/register → 201  (Claude-User/1.0)
WARN  POST /oauth/register → 400  (Claude-User/1.0)
```

That answers the first question, which is not *why* it failed but **whether the request arrived at
all**. A connector that reports "registration failed" with nothing in the log never reached this
server, and the fault is in the metadata it read or the network in front — not in this endpoint.

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
| `list_tasks` | filter by `project`, `state` (name or group), `assignee` (`"me"` works), `priority`, `label`, `cycle` (`"current"` works), `module`, `due_before`, `query` |
| `get_task` | one task with description, sub-tasks, relations, comments and recent activity |
| `search` | full text across tasks, pages, projects, comments, cycles, modules |
| `list_cycles` | sprints with `total`/`done` counts |
| `list_modules` | milestones with `total`/`done` counts, ordered by target date. Given a project: its own plus the shared ones it works on |
| `list_pages` / `get_page` | wiki pages, markdown included |
| `list_templates` | pre-written tasks, with the checklist each one carries |
| `list_time` | logged time, narrowed by task, project, date range or `mine`, with the total |
| `list_members` | people with role and open task count |
| `list_labels` | labels with the count of open tasks carrying each; `project` narrows to that project's own plus the workspace-wide ones |
| `list_states` | a project's workflow states in board order, each with its `group`, colour, task count, and which one is the default |
| `list_attachments` | files on a task or a page, with the URL to fetch each |
| `project_status` | counts by state group and priority, overdue list, unassigned count, active cycle, recent activity |
| `my_work` | the token owner's open tasks, split into overdue / today / upcoming / unscheduled |

### Reports

Six aggregations that were answerable before only by pulling the backlog and doing the arithmetic
in the model. All are read-only, so a `scopes: "read"` token may call every one.

**They are workspace tools, and `project` narrows them.** That is the default because the questions
are: *who is overloaded* is a question about a person, and a person works in several projects;
*what is going to slip this fortnight* is a question about a fortnight, not about a board. Passing a
`project` — a key or a name — scopes the answer to it. Every reply says which it gave you:

```json
{ "scope": "workspace", "project": null, "projects": ["API", "MOB", "WEB"] }
{ "scope": "project",   "project": "WEB", "projects": ["WEB"] }
```

Every row names the project it is in, and every workspace-wide answer carries a `by_project` count
beside the list — so *which project is on fire* is answered rather than left to be re-aggregated.
Do not read the project off the front of `WEB-42`: an identifier is a label, and the field is there
on both paths.

Each returns a **reason**, not just a list. That is the whole point of them: *overdue* is a fact
anybody can compute from a due date, and *"due Thursday, still in Backlog, nobody on it"* is the
sentence somebody acts on.

| Tool | Answers | Without a `project` |
|---|---|---|
| `changes_since` | What happened in a window — `days`, default 7. Grouped by person and by kind of change, with what was finished, what was filed, and the ten tasks that moved most | The whole workspace, plus workspace-level activity that belongs to no project |
| `deadlines_at_risk` | Dated work unlikely to land inside `days` (default 14), each tagged `overdue`, `blocked`, `not_started` or `unassigned`, with the blockers named and a `severity` to sort on | Every project at once — which is the only way to see a person's real week |
| `workload` | Open work per person: count, overdue, due this week, unestimated, points, and their most urgent item. Unassigned work is a bucket of its own rather than hidden | Each person's load **split by project**: eight tasks in one project and eight across five are different weeks |
| `blocked_tasks` | What is waiting on what — and, separately, `stale_links`: relations whose blocker is already finished, which nobody remembers to remove | Cross-project blockers included, each flagged `in_another_project` |
| `stale_tasks` | Tasks in an in-progress state untouched for `days` (default 14), with how long each has been quiet | Every project |
| `cycle_review` | A cycle's outcome: planned against completed, what carried over, what was cancelled, and what was **added after the start date** — the thing a burn-down hides and a retro needs | **Every cycle running right now**, one review each and a workspace total. A `cycle` name matches across projects, which is what a team running one shared fortnight wants |

A note on `cycle_review`, because it is the one that differs in kind. It always answers
`{ cycles: [...], totals: {...} }`, one entry per cycle, whether you named a project or not — a
workspace review is several reviews and a sum.

A cycle covers **one project, a chosen few, or all of them** — one fortnight several teams share
rather than a copy of it in each. `create_cycle` says which with two arguments:

| Arguments | Scope |
|---|---|
| `project: "WEB"` | WEB's own cycle. The usual one |
| `projects: ["WEB", "MOB"]` | Exactly those two run it. A list of one is the line above, and stored that way |
| neither | Every project in the workspace, including ones made later — as `create_label` does |

Passing both is refused rather than resolved — a caller who sent each of them meant one, and
which one is not the server's to guess.

**A module is scoped the same way**, by the same two arguments on `create_module`, and for the same
reason: a launch is routinely three projects working towards one date. `list_modules` narrows the
same way `list_cycles` does — a project's own plus the shared ones it works on.

`update_cycle` takes the same two and will re-scope a running cycle. It never moves the work:
narrowing a cycle that Mobile has tasks in returns `stranded_tasks` naming them, still in the
cycle, for you to move or widen rather than discover missing later. That list holds only the work
your token can see, for the same reason the reports do — a private project's identifiers are not
in it, and its tasks are not moved either.

Each review says which kind it is:

| Field | Means |
|---|---|
| `cycle_scope` | `project`, `projects` or `workspace` |
| `project` | The owning project's key, or `null` when more than one runs it |
| `cycle_projects` | The projects it is *for*, when it names some. A project in a cycle that contributed nothing is still in it |
| `projects_involved` | The projects that actually put work in it — the answer a shared cycle's own row cannot give |

A cycle that several projects run appears in each of their reviews as well as the workspace's,
**narrowed to the projects in scope**: asked about `WEB`, "how did the shared fortnight go" means WEB's half of it;
asked about the workspace, all of it. The progress bar in the interface is the other way round and
deliberately so — a shared cycle shows the shared total on every project's tab, because the same
cycle showing different numbers depending on where you opened it would be worse than either.

It is also the only one that can refuse. Naming a project with no cycle running is an error,
because the caller asked for something specific and got nothing; a workspace with no cycle running
anywhere is an ordinary Tuesday, and the honest reply is an empty list.

Three more details worth knowing before you trust a number:

- **A private project the token cannot see is absent from every one of them**, including from the
  aggregate counts and from `projects`. A total that moved when a private task changed would say
  something about that task, so the projects are resolved once, in one place, rather than per tool.
  Asking for one by name is refused rather than answered emptily.
- **`changes_since` counts finished and filed work from the tasks, not from the activity log.** A
  task completed offline syncs carrying the moment it was completed; counting log rows would date
  it to when the connection came back. It also means the two lists are right on a workspace that
  was imported or seeded, where there is no activity log to read.
- **`workload` counts a task with two people on it for both of them**, the way the app's own
  per-person chart does, so the totals exceed the task count. That is the honest answer to "how
  much is on you". It also flags anyone still holding work who has left the workspace.

```json
{ "name": "deadlines_at_risk", "arguments": { "days": 7 } }
```

```json
{
  "horizon_days": 7,
  "scope": "workspace",
  "project": null,
  "projects": ["API", "MOB", "WEB"],
  "counts": { "overdue": 3, "not_started": 7 },
  "by_project": { "WEB": 4, "API": 3, "MOB": 3 },
  "at_risk": [
    {
      "identifier": "WEB-3",
      "title": "Ship dark mode across the marketing site",
      "project": "WEB",
      "state": "Todo",
      "assignee_names": ["Grace Hopper"],
      "due_date": "2026-08-24",
      "days_until_due": -1,
      "reasons": ["overdue"],
      "blocked_by": [],
      "severity": 101
    }
  ]
}
```

### Writing

| Tool | Notes |
|---|---|
| `create_task` | project + title required — unless `quick_add` carries both; **labels that do not exist yet are created**, which is why `list_labels` is worth calling first |
| `update_task` | any field, including `state`, `assignees`, `cycle`, `module`, `due_date`, `archived` |
| `create_tasks_batch` | up to 100 tasks in one call, as **one transaction** — a rejected entry takes the whole batch with it, so a retry cannot double what already went in |
| `create_task_relation` | `blocks`, `blocked_by`, `relates_to`, `duplicates`, `duplicated_by` — written once, in the direction given |
| `upload_attachment` | base64 bytes onto a task, where they appear in its Files section |
| `delete_attachment` | detaches a file; soft, and the shared bytes stay put |
| `create_state` / `update_state` | add a board column, or change its name, colour, group or WIP limit |
| `update_cycle` / `delete_cycle` | edit a sprint's dates, name and which projects run it; deleting is soft and keeps the tasks |
| `create_label` / `update_label` | a label made on purpose, with a colour — refused if one by that name is already usable in scope |
| `update_project` | name, icon, description, status, lead, dates, archived — **not** the key |
| `delete_task` | soft delete, flagged `destructiveHint` for clients that confirm |
| `comment_task` | markdown; notifies assignees and subscribers |
| `create_project` | includes the default workflow states and labels |
| `create_cycle` | sprint with start/end dates, for one project, several, or all |
| `create_module` | a milestone with a lead and a target date, for one project, several, or all |
| `update_module` / `delete_module` | edit a milestone's dates, lead, status and which projects work on it; deleting is soft and keeps the tasks |
| `create_page` / `update_page` | `update_page` takes `content` (replace) or `append` |
| `apply_template` | files a real task from a template, checklist and all — the same path the automations use |
| `log_time` | records time spent; takes `90`, `1h30`, `1.5h` or `1:30`, defaults to today and to the token owner |

Writes are attributed to the token owner and appear in the activity trail and everyone's live sync
like any other change. A read-only token gets `This token is read-only` from every write tool.

### Labels, and the trap in them

`create_task` and `update_task` take label **names** and create the ones they do not recognise. That
is deliberate — a label is cheap to invent, and refusing an unknown one would mean an assistant
cannot label anything it did not already know about. The cost is that an assistant with no idea what
exists files things under `bugs` beside the `bug` that was already there. Case is forgiven; a plural
is not.

So **call `list_labels` first.** It returns each label with how many open tasks carry it, which is
the number that separates a label the team actually uses from one somebody invented in March.
`project` narrows it to that project's own labels plus the workspace-wide ones — the same set
`create_task` will match against.

### States, and the two ways an unknown one goes wrong

`create_task` and `update_task` both take a state by **name**, and they treat one they do not
recognise differently. `update_task` refuses with an error — a failed move is at least a visible
one. `create_task` falls back silently to the project's default column, so a misspelled state files
the task somewhere unintended and reports success. Both are avoided the same way: read the list
first.

**`list_states` is the answer to that.** It returns a project's columns in board order, and the field
worth reading is `group` rather than `name`. Names are per project; the group is the fixed vocabulary
underneath — `backlog`, `unstarted`, `started`, `completed`, `cancelled` — and it is what every count
and filter in Kolibri is actually computed from. Match on the name when it is an exact hit, and on
the group when it is not.

### Editing the board itself

`create_state` appends a column; `update_state` changes its name, colour, group or WIP limit. Two
things are worth knowing before either.

**`cancelled` has two Ls.** Every "what is finished" count in Kolibri — the board, the project
digest, the cycle burn-down, `list_tasks`, the label counts — is `group_key IN ('completed',
'cancelled')`. A state stored as `canceled` would look perfectly right in the settings screen and be
silently missing from all of them. The American spelling is therefore accepted and normalised rather
than stored, here and in `update_project`'s status.

**There are five groups, not four**: `backlog`, `unstarted`, `started`, `completed`, `cancelled`.
`backlog` is the group the default first column belongs to, so leaving it out would make the one
kind of column MCP could not create the commonest one.

Changing a state's **group** is the consequential edit. It moves no task, but it changes what every
count in the app says about the tasks already sitting in that column — dragging a column from
`started` to `completed` marks that work finished everywhere at once.

### Cycles, and a status nothing reads yet

`update_cycle` and `delete_cycle` complete the set. Two honest caveats:

**`status` is recorded, not acted on.** The column is in the model and this writes it, but nothing in
Kolibri reads it: which cycle is *current* is worked out from the dates
(`start_date <= today <= end_date`), and that is what `cycle: "current"` resolves through, what the
burn-down uses and what the project digest reports. Setting a status records an intention. **The
dates are the part with teeth.** It round-trips through `list_cycles` so at least it is observable.

**Deleting is soft**, the same delete the interface does: the cycle goes to the trash and can be
restored for `KOLIBRI_TRASH_DAYS`. Tasks in it are kept — they simply lose their cycle — and the
answer reports how many, so nobody has to guess what a sprint deletion just did.

`update_cycle` also accepts `"current"` as the cycle, so "extend the current sprint" needs no lookup.

### A batch is one transaction

`create_tasks_batch` takes up to 100 tasks and files them **all or none**. The reason is not the
round trips. Twenty separate `create_task` calls can fail on the eleventh and leave ten tasks behind
that nobody asked for on their own; an assistant that then retries the list makes ten more. With one
transaction a failed batch leaves nothing, so retrying it is safe and needs no counting. That
includes the effects a database rollback cannot reach: webhooks and push notifications for a batch
are held until it commits, so a failed batch announces nothing and a retried one announces things
once.

Entries land on the board **in the order given** — the batch sits as one block at the top, first
entry first.

Each entry takes exactly what `create_task` takes, through the same code — `quick_add` included — so
a batch cannot quietly follow different rules from a single call. `project` names the project once
and any entry may override it, which is how one call files a feature into `WEB` and its
infrastructure work into `OPS`. An error names the entry: `tasks[7]: Which project?`.

### Relations are written once, in one direction

`create_task_relation` writes a single row. The other task shows the mirror image automatically —
`WEB-1 blocks WEB-2` reads as "blocked by WEB-1" on WEB-2 — so there is no second call to make, and
asking for the mirror image of a link that already exists returns the existing one with
`already: true` rather than drawing it twice.

The five kinds are `blocks`, `blocked_by`, `relates_to`, `duplicates` and `duplicated_by`.
(`duplicate` is understood as `duplicates`, since it is the obvious thing to reach for.)
`blocked_by` is stored as the equivalent `blocks` row — the same statement, in the direction the
planner, the Gantt chart and the scheduling cascade actually read, and the direction that lets a
`lag` mean something.

`blocks` is load-bearing beyond the task detail: the planner and the Gantt chart schedule from it,
and `lag` — whole working days, 0–365 — is the breathing room between a blocker finishing and its
dependant starting. **A cycle of blockers is refused**, because nothing in such a ring can ever
start. Nothing else in the server checks this, since until now the only way to build one was by hand
in the interface, one link at a time, looking at both tasks. An assistant working from a list can
build a ten-task ring without ever seeing it.

### Attachments

`upload_attachment` puts bytes on a task, where they appear in its own Files section rather than
somewhere only an assistant knows about. It closes a real gap: an assistant could already write,
comment and move tasks, but anything it *produced* — a CSV, a generated report, an image — had
nowhere to go except pasted into a comment as text.

Content is base64, because MCP carries JSON. That is a genuine cost — the encoding adds a third
again, and the whole thing is a string in memory at both ends — so the upload limit
(`KOLIBRI_MAX_UPLOAD_MB`, 25 MB by default) is enforced against the **decoded** size and checked
before decoding, rather than after allocating the very buffer the limit exists to prevent.

`mime` is optional and guessed from the file name. Input that is not base64 is refused rather than
stored: `Buffer.from(x, 'base64')` skips what it cannot read instead of failing, so raw text handed
to it becomes a short buffer of nonsense — stored, attached, and downloaded later as a corrupt file
with nothing anywhere saying so.

### Attachments, listed and removed

`list_attachments` takes a `task` **or** a `page` — the model hangs files off either, and a tool that
could only see half of them would send an assistant looking for a file that is plainly there. The
URLs it returns need the same authorisation as the call; they are not public links, and on an
object-store deployment they become short-lived signed URLs at the moment they are followed.

`delete_attachment` removes the attachment — the row that puts the file on the task — and **not the
bytes**. Storage is content-addressed and shared: the same file uploaded to two workspaces is one
blob with two rows, so deleting the blob would take it out from under somebody else. Sweeping blobs
that nothing points at any more is a separate job.

### Labels and project metadata

`create_label` is the deliberate counterpart to the accidental path. `create_task` invents a label it
does not recognise — that is what puts `bugs` next to `bug` — and this one is **refused** when a label
by that name is already usable in scope, which is exactly the collision the accidental path cannot
see. Scope counts: a workspace-wide `bug` and a project-local `bug` look identical on a task, so both
are checked.

`update_label` will widen a project label to the whole workspace but not the reverse: narrowing one
would strip it from the tasks in every *other* project that already carry it, and deleting a label is
a different act that should not happen by implication.

`update_project` takes name, icon, description, status, lead, dates and archived. It does **not** take
the key, deliberately. A key is the prefix of every identifier the project has ever minted, so
changing it does not rename `WEB-42` — it leaves that task named after a prefix the project no longer
has. The settings screen allows it because a person doing it is looking at the project; that is not
the position an assistant is in, and the server settles a rejected key silently through `forced`
rather than throwing, so a refusal would not even reach the caller as an error.

### Quick-add syntax, when a person typed the line

`create_task` also takes `quick_add`, a whole task on one line:

```json
{ "quick_add": "Redraw the empty state !high @ada #WEB *design due:friday" }
```

It sets the title, priority, assignees, project, labels, due date and repeat from what it recognises,
and `project` is not needed when `#KEY` names one. The syntax is in [`query.md`](query.md).

**`title` is never parsed, and that is the point.** A tool with a schema should mean what the schema
says: an assistant writing *"Discuss with @ada"* as a title means those words, and a parser that
quietly removed them and assigned the task would be a surprise nobody asked for. `quick_add` is for
the other case — relaying a line a person actually typed, sigils and all.

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

`resources/list` returns wiki pages as `kolibri://page/<id>` with `mimeType: text/markdown`;
`resources/read` returns the markdown. Tasks are readable the same way via `kolibri://task/<id>`.
This lets a client attach a handbook page as context without a tool call.

**Across every workspace the token can reach**, and each entry says which one it came from when
there is more than one. Unlike a tool, this call takes no arguments — so whatever it leaves out is
unreachable from the client's "add from Kolibri" menu, and listing one workspace meant somebody in
two saw half of what they had. A token pinned to a workspace still sees only that one; that pin is
a boundary somebody set on purpose.

Note that this is a different list from the tools. Modules, cycles and everything else are **tools**
and appear wherever your client shows those; resources are pages, and prompts are the three named
below. A client that shows only prompts and pages under "add from Kolibri" is showing you that
menu, not the tool list.

## Permissions

The token owner's permissions apply, always:

- private projects they are not a member of are invisible to every tool,
- guests cannot write,
- a token pinned to a workspace cannot reach another one, even if the account is a member.

Revoke a token in **Settings → API & MCP**; it stops working immediately. A connector authorised on
the web is listed there under its own name and is revoked the same way — the OAuth flow issues an
ordinary token, so there is one list and one button rather than two of each.
