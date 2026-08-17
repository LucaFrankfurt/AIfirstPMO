# REST API

Base URL is your instance, e.g. `https://kolibri.example.com`. All responses are JSON; errors look
like `{ "error": "forbidden", "message": "Project is private" }` with a matching HTTP status.

## Authentication

Two options, both accepted everywhere:

```bash
# 1. Session cookie (what the web app uses)
curl -c jar -X POST $URL/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"…"}'
curl -b jar $URL/api/session

# 2. API token (what scripts and MCP use)
curl -H "Authorization: Bearer kol_…" $URL/api/session
```

Create tokens in **Settings → API & MCP** or via `POST /api/tokens`
(`{ name, workspaceId?, scopes?: "read" | "read,write", expiresInDays? }`). The plaintext value is
returned exactly once — only its hash is stored. A `read` token is rejected on every write.

## Entities

Every entity in the registry gets the same five routes. Collections: `tasks`, `projects`, `states`,
`labels`, `cycles`, `modules`, `pages`, `comments`, `attachments`, `views`, `teams`, `team-members`,
`project-members`, `relations`, `notifications`.

```
GET    /api/workspaces/:ws/:collection      list, filterable by any field
POST   /api/workspaces/:ws/:collection      create
GET    /api/:collection/:id                 read
PATCH  /api/:collection/:id                 update (partial)
DELETE /api/:collection/:id                 soft delete
```

Query parameters on list: any field name (`?project_id=…&priority=urgent`, `?cycle_id=null`),
plus `limit` (≤1000), `offset`, `order_by`, `order=asc|desc`, `include_deleted=1`.

```bash
# The open, urgent work in a project
curl -H "Authorization: Bearer $TOKEN" \
  "$URL/api/workspaces/$WS/tasks?project_id=$PROJECT&priority=urgent&order_by=due_date"

# File a task
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"project_id":"'$PROJECT'","title":"Rate-limit the public API","priority":"high"}' \
  "$URL/api/workspaces/$WS/tasks"
```

Creating a **project** is special-cased: it also creates the default workflow states, the default
labels and the creator's membership, in one transaction.

### Task extras

```
GET  /api/tasks/:id/activity                 field-level change history
GET  /api/tasks/:id/children                 sub-tasks
GET  /api/workspaces/:ws/by-identifier/WEB-42
POST /api/workspaces/:ws/tasks/bulk          { ids, patch }  or  { ids, op: "delete" }
```

### Pages

```
GET  /api/pages/:id/versions
GET  /api/pages/:id/versions/:versionId
POST /api/pages/:id/versions   { "restore": "<versionId>" }
```

A new revision is stored whenever the body changes, collapsing edits by the same author within ten
minutes so a typing session does not produce hundreds of versions.

## Workspaces, members, invites

```
POST   /api/workspaces                      { name }
PATCH  /api/workspaces/:id                  { name, logo_url }      admin+
GET    /api/workspaces/:id/members
PATCH  /api/workspaces/:id/members/:userId  { role }                admin+
DELETE /api/workspaces/:id/members/:userId  (or yourself, to leave)
GET    /api/workspaces/:id/invites                                   admin+
POST   /api/workspaces/:id/invites          { role, expiresInDays } admin+
GET    /api/invites/:code                   public preview
POST   /api/invites/:code/accept
```

Roles: `owner` > `admin` > `member` > `guest`. Guests read but cannot write. A workspace always
keeps at least one owner.

## Files

Uploads are raw bodies, not multipart — one request, one blob, trivially retryable:

```bash
curl -X POST "$URL/api/workspaces/$WS/files?task_id=$TASK" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: image/png' \
  -H 'x-filename: screenshot.png' \
  --data-binary @screenshot.png
# → { "url": "/files/<sha256>/screenshot.png", "width": 1280, "height": 720, "attachment": {…} }
```

Content is addressed by SHA-256, so uploading the same file twice costs one row and no extra bytes.
Passing `task_id`, `page_id` or `comment_id` also creates the attachment record that shows up in the
UI; without it you just get a URL to embed in markdown.

Downloads (`GET /files/:hash/:name`) require a session or token and membership in the owning
workspace. Only a safe list of types is served inline; everything else downloads with
`Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.

The browser client downscales images to 2000px WebP before upload, so a phone photo does not push
12 MB through a mobile connection.

## Search

```
GET /api/workspaces/:ws/search?q=cookie+banner&kind=task,page&limit=20
```

SQLite FTS5 over tasks, pages, comments, projects, cycles and modules. Words are turned into prefix
terms, so `des rev` already finds *Design review*. Results are filtered by project visibility.

## Sync

```
GET  /api/sync/pull?workspace=:id&since=:cursor
POST /api/sync/push      { workspaceId, clientId, mutations: [...] }
GET  /api/sync/stream?workspace=:id&client=:clientId     (Server-Sent Events)
```

See [`sync.md`](sync.md) for the protocol. `EventSource` cannot set headers, so the stream also
accepts `?access_token=` for token clients.

## Misc

```
GET /api/health     { status, seq, uptime }
GET /api/config     { allowSignup, hasUsers, maxUploadBytes, version }
GET /api/session    the signed-in user and their workspaces
PATCH /api/me       { name, avatar_url, timezone, bio }
POST /api/me/password  { current, next }   signs other devices out
```
