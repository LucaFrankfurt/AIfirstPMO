# MCP server

Kolibri implements the [Model Context Protocol](https://modelcontextprotocol.io) so an assistant can
work the board the way a teammate would: read the backlog, file issues, move them, comment, write
pages. It is a first-class client, not a scraping target.

Protocol version `2025-06-18`. Two transports, one implementation:

- **Streamable HTTP** — `POST /mcp` with `Authorization: Bearer kol_…`
- **stdio** — `npx @kolibri/mcp`, which pipes JSON-RPC to that same endpoint

## Setup

1. **Settings → API & MCP → Create token.** Pin it to a workspace so tools do not need a
   `workspace_id` argument. Use scope `read` for an assistant that should only look.
2. Add it to your client:

```jsonc
{
  "mcpServers": {
    "kolibri": {
      "command": "npx",
      "args": ["-y", "@kolibri/mcp"],
      "env": {
        "KOLIBRI_URL": "https://kolibri.example.com",
        "KOLIBRI_TOKEN": "kol_…"
      }
    }
  }
}
```

Verify from a shell:

```bash
curl -s -X POST $URL/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

## Tools

Tasks are addressed by id or by the identifier humans use (`WEB-42`). Projects accept id, key or
name. Users accept id, email or name — so an assistant can pass what it read in the conversation.

### Reading

| Tool | Returns |
|---|---|
| `list_workspaces` | workspaces this token can reach, with the caller's role |
| `list_projects` | projects with open/done task counts |
| `list_tasks` | filter by `project`, `state` (name or group), `assignee` (`"me"` works), `priority`, `cycle` (`"current"` works), `due_before`, `query` |
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
| `create_task` | project + title required; labels that do not exist yet are created |
| `update_task` | any field, including `state`, `assignees`, `cycle`, `due_date`, `archived` |
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

Revoke a token in **Settings → API & MCP**; it stops working immediately.
