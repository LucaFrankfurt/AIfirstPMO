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

Forty-odd tools, covering the same ground as the interface:

| | |
|---|---|
| **Read** | `list_workspaces` `list_projects` `list_tasks` `get_task` `search` `list_pages` `get_page` `list_members` `list_states` `list_labels` `list_cycles` `list_templates` `list_attachments` `list_time` `project_status` `my_work` |
| **Reports** | `changes_since` `deadlines_at_risk` `workload` `blocked_tasks` `stale_tasks` `cycle_review` |
| **Write** | `create_task` `create_tasks_batch` `update_task` `delete_task` `comment_task` `create_task_relation` `create_project` `update_project` `create_page` `update_page` `create_cycle` `update_cycle` `delete_cycle` `create_state` `update_state` `create_label` `update_label` `apply_template` `upload_attachment` `delete_attachment` `log_time` |

Plus three prompts — `standup`, `sprint_planning` and `triage` — which are the three questions
people actually ask, written out so the assistant does not have to invent the shape.

A batch is **one transaction**: `create_tasks_batch` either lands entirely or not at all, so a
half-imported backlog is not a state you can end up in.

## The reports

The six in the middle row are worth knowing about by name, because they answer the questions
people actually open a tracker to ask — and each answers with a **reason** rather than a list:

| Ask it | It calls |
|---|---|
| *"What did we get done last week?"* | `changes_since` — grouped by person and by kind of change, with what was finished and what was filed |
| *"What is going to slip?"* | `deadlines_at_risk` — every dated task tagged *overdue*, *blocked*, *not started* or *unassigned*, worst first |
| *"Who is overloaded?"* | `workload` — open, overdue, due this week and points, per person, with unassigned work counted rather than hidden |
| *"What is stuck?"* | `blocked_tasks` — what waits on what, plus the links whose blocker is already finished |
| *"What has gone quiet?"* | `stale_tasks` — in progress and untouched for a fortnight |
| *"How did the sprint go?"* | `cycle_review` — planned against completed, what carried over, and what was added after it started |

**They answer for the whole workspace by default**, and that is the right default rather than a
convenience: *who is overloaded* is a question about a person, and a person works in several
projects at once; *what is going to slip this fortnight* is a question about a fortnight, not about
one board. Naming a project narrows any of them, and the reply always says which you got.

That matters most in two places. `workload` splits each person's load **by project** — eight tasks
in one project and eight across five are different weeks, and a single number says they are the
same. And `blocked_tasks` includes blockers that live in *another* project, flagged as such,
because a task held up by something on a board you were not looking at is exactly the one nobody
notices.

`cycle_review` is the one that differs in kind. A cycle belongs to a project, so asked about the
whole workspace it reviews **every cycle running right now**, one each, and totals them — which is
what a team running the same fortnight across three projects actually wants.

All six are read-only, so a read-only token can call every one of them. And none of them can see a
private project you are not in — not merely *list* nothing from it, but count nothing from it
either, because a total that moved when a private task changed would say something about that
task.

The difference between these and asking a model to work it out from `list_tasks` is not speed. It
is that *overdue* is a fact anybody can compute from a due date, and *"due Thursday, still in
Backlog, nobody on it"* is the sentence somebody acts on.

## What it is good at

- *"What did we not finish last cycle, and what is blocking each one?"* — one `cycle_review` and one
  `blocked_tasks`, where by hand it is two joins and a lot of scrolling.
- *"Write the standup from what changed since Friday."* — `changes_since` with `days: 3`.
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
