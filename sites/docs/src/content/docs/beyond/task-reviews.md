---
title: Asking a model to read a task
description: An optional, manual, off-by-default button that suggests clearer wording — what leaves the instance when you press it, and what does not.
sidebar:
  order: 6
---

There is a button on a task that asks a model to read it back and suggest better wording: a title
that names an outcome, acceptance criteria you could actually check, or *"this is three tasks"* —
with the replacement text already written.

Three things about it, in the order they matter.

## It is off unless somebody turned it on

The button does not exist unless whoever runs the instance has configured an API key for
Anthropic, Gemini or OpenRouter. On an instance with no key there is nothing to switch on and
nothing to leak.

## It is manual, always

Nothing is reviewed automatically. No background sweep, no "reviewing your backlog overnight", no
rule that can trigger it. It happens when a person presses the button on a task, and only to that
task.

## What leaves the instance when you press it

The task's title and description, and the project's name. Not the comments, not the attachments,
not the other tasks, not who is on it.

If that is more than your workspace can send anywhere, do not enable the feature — and if it is
already enabled and you are not sure, *Settings → API & MCP* says which provider is configured,
and `/api/health` says so too.

## What it gives back

A list of findings, each with:

- **What it thinks is wrong** — the title is not an outcome, there are no acceptance criteria,
  this is several tasks in a coat.
- **The replacement text, already written.**
- Or, when it cannot answer the question itself — *what does "done" mean here?* — that question
  is posted as an ordinary **comment** for whoever can answer it.

**Nothing is applied without a click.** The suggestion sits beside the field with an Apply
button. Not applying it is one keystroke and leaves no trace.

## What it is not

- **Not a reviewer.** It reads the words on the task. It has no idea whether the work is right,
  whether the estimate is sane, or whether you should be doing it at all.
- **Not a gate.** Nothing is blocked by it and nothing waits for it.
- **Not a way to keep a backlog tidy.** A model rewriting three hundred titles produces three
  hundred plausible titles, which is worse than the mess it replaced. Use it on the task somebody
  is about to pick up.

:::note
The exact prompt, the two switches, and the one function that trusts a model's output are
documented in `docs/ai.md` in the repository.
:::
