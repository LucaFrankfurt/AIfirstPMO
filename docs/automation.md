# Templates and rules

Two things, useful separately and better together.

A **template** is a task written in advance: a title, a description, a priority
and a checklist that becomes sub-tasks. Use one by hand — from **Settings →
Templates & rules**, from the quick-add sheet, or through MCP — and you get a
real task with everything already filled in.

A **rule** watches for one thing happening to a task and files a template for
you. The one everybody wants: *when a task enters review, ask somebody for
feedback.* Every new project starts with exactly that, switched on.

Find both under **Settings → Templates & rules**.

## What a rule is made of

| | |
|---|---|
| **Scope** | One project, or the whole workspace so every project behaves the same |
| **When** | A task enters a named state · a task enters a state *group* · a task is created |
| **File this** | Which template |
| **Give it to** | A list of selectors — see below |
| **How many** | One task with everybody on it, or one task each |
| **Link back** | `relates to`, `blocks`, … or nothing |
| **At most once** | Off by default, so a second review round asks again |
| **Also apply to generated tasks** | Off by default, so a rule cannot feed itself |

## Who gets it

Recipients are **selectors, not names**. A rule that says "whoever leads the
project" keeps meaning that after the lead changes; a stored user id does not.

| Selector | Resolves to |
|---|---|
| A named person | exactly them |
| Whoever is on the task | the source task's assignees |
| Whoever created the task | its `created_by` |
| Whoever triggered it | the person whose change fired the rule |
| The project lead | the target project's `lead_id` |
| Everyone in a team | that team's members |
| Everyone with a role | everybody who is `owner`, `admin` or `member` |

Several combine and the result is de-duplicated, so "the lead and the design
team" is one rule, not two. Two things then narrow it:

- **Skip whoever triggered it** (on by default) — you rarely review your own
  work. Asking for the actor *explicitly* wins over this, so the two settings
  cannot contradict each other.
- Anyone who cannot see the project the task lands in is dropped. A rule is not
  a way around a private project.

If nothing is left, the rule files nothing and **says so** in its log rather
than creating a ticket nobody is on. On a one-person workspace the seeded rule
therefore does nothing at all, correctly, and the log explains it.

## Placeholders

The title and description of a template may refer to the task that triggered
the rule. Anything else is left as written rather than turned into a hole.

| | |
|---|---|
| `{identifier}` | `WEB-42` |
| `{title}` | the source task's title |
| `{project}` | its project's name |
| `{actor}` | who caused the trigger |
| `{state}` | the state it entered |
| `{url}` | a link straight to it — needs `KOLIBRI_PUBLIC_URL` to be absolute |

Applied by hand there is no source task, so only `{project}` and `{actor}` are
filled and the rest stay visible as themselves.

## Why it will not run away

Three guards, because a rule engine that files tasks about its own tasks is
worse than no rule engine:

1. Tasks a rule created are recognisable — every run is recorded with the id of
   what it made — and rules skip them unless you deliberately turn
   *also apply to generated tasks* on.
2. A depth counter stops any chain at three, even if you do turn that on.
3. `state_group_entered` only fires when the group actually changes, so moving
   between two `started` states is not "entering in progress" a second time.

## The log

Every decision a rule makes is written down, including the decisions to do
nothing, and readable under **Log** next to the rule:

| Reason | Means |
|---|---|
| *filed WEB-43* | it worked |
| *nobody to give it to* | every selector resolved to nobody, or to people who cannot see the project |
| *already done for this task* | `at most once` is on and it has run before |
| *that task came from a rule* | the trigger was a generated task |
| *the template is gone* | somebody deleted it |

This is the first place to look when a rule seems quiet. It is almost always
the second row.

## What every new project starts with

`createProject` seeds one template and one rule, in the creator's language:

- **Feedback request** — a `feedback` template whose title is
  `Feedback: {identifier} {title}`, with three checklist questions.
- **Ask for feedback when a task enters review** — pointed at the seeded
  *In Review* state, giving it to the project lead, one task, linked back with
  *relates to*, skipping whoever moved the task. **Enabled.**

It cannot fire until somebody moves a task into review, by which point the
project is being worked in. One switch turns it off, and deleting it is fine —
nothing else depends on it.

## Through MCP

`list_templates` returns the templates a token can reach, with each checklist.
`apply_template` files one as a real task. Both go through the same code as the
button and the rules, so an assistant asked to "open a feedback ticket for
WEB-42" produces exactly what a person would.

## Limits worth knowing

- Rules run **on the server, in the write path**. A change made offline fires
  its rule when the device syncs, not before — so the feedback task appears a
  moment after the board move reaches the server, not on the device that made
  it.
- There is no schedule trigger. Nothing fires because a date passed; something
  has to happen to a task.
- A rule cannot yet change the task it watched — it only files new ones. Adding
  an "also set the priority" action is a bigger idea than it looks, because two
  rules editing one task is a merge problem.
