---
title: Connecting an assistant
description: Point an MCP client at your instance and give it a token — what it can then do, and how to make sure it cannot write.
sidebar:
  order: 5
---

Kolibri speaks the Model Context Protocol. An AI client can be pointed at your instance and given
a token, and from then on it works with the same nouns you do: projects, tasks, cycles, pages,
labels, states, time.

Not by driving a browser, and not through a scraped API — through tools the server exposes on
purpose.

## Getting a token

*Settings → API & MCP → New token.* Two things to decide:

**Scope.** A token issued **read-only** is refused by every tool that writes. That is checked on
the server, not in the client, so a read-only token is a genuine view of the backlog rather than
a request that the assistant behave.

**What it can reach.** A token carries the permissions of the person who created it. An
assistant given your token can see what you can see — including private projects you are in. If
that is more than you meant, make a guest account for the assistant and add it to the projects it
should have.

Copy the token when it is shown. It is not shown again.

## Connecting

Anything that speaks streamable HTTP needs nothing installed:

```bash
claude mcp add --transport http kolibri https://kolibri.example.com/mcp \
  --header "Authorization: Bearer kol_…"
```

A client that only speaks stdio runs the bridge in `packages/mcp`, which pipes JSON-RPC to that
same endpoint.

**Claude on the web** takes neither: add the instance URL as a custom connector and sign in when
it asks. The instance is an OAuth authorization server for exactly that case, and what it grants
is an ordinary token you can revoke in Settings like any other.

## What it can do

Thirty-odd tools, covering the same ground as the interface:

| | |
|---|---|
| **Read** | `list_workspaces` `list_projects` `list_tasks` `get_task` `search` `list_pages` `get_page` `list_members` `list_states` `list_labels` `list_cycles` `list_templates` `list_attachments` `list_time` `project_status` `my_work` |
| **Write** | `create_task` `create_tasks_batch` `update_task` `delete_task` `comment_task` `create_task_relation` `create_project` `update_project` `create_page` `update_page` `create_cycle` `update_cycle` `delete_cycle` `create_state` `update_state` `create_label` `update_label` `apply_template` `upload_attachment` `delete_attachment` `log_time` |

Plus three prompts — `standup`, `sprint_planning` and `triage` — which are the three questions
people actually ask, written out so the assistant does not have to invent the shape.

A batch is **one transaction**: `create_tasks_batch` either lands entirely or not at all, so a
half-imported backlog is not a state you can end up in.

## What it is good at

- *"What did we not finish last cycle, and what is blocking each one?"* — reading and joining, which
  is tedious by hand and instant here.
- *"File these fourteen findings as tasks in API, labelled `security`, blocked by API-30."* —
  writing structure that is boring to type.
- *"Summarise the decisions in the pages under Architecture and write it as a new page."*
- *"Move everything labelled `legacy` that is still open into the icebox cycle."*

## What to be careful about

**Give it a read-only token first.** Watch what it does for a week. Then decide.

**A token is a credential.** It is in a config file on whatever machine runs the client. Revoke
it in *Settings → API & MCP* the moment that machine is not yours, and rotate them on the same
schedule you rotate anything else.

**Quick-add is opt-in.** `create_task` takes `title` literally — always. An assistant that writes
*"Discuss with @ada"* as a title means those words, and a parser that quietly removed them and
assigned the task would be a surprise nobody asked for. There is a separate `quick_add` field for
relaying a line a *person* typed. See [the quick-add reference](/reference/quick-add/#over-mcp).

**It is not sandboxed from your workspace.** Everything it does is a real change by a real
account, in the activity trail with the token's owner's name on it. That is deliberate — an audit
trail that said *"assistant"* would tell you nothing about who let it — but it does mean you are
accountable for what it writes.

:::note
Every tool, its arguments and the traps in each are documented in `docs/mcp.md` in the
repository.
:::
