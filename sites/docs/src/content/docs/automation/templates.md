---
title: Task templates
description: A task written in advance — title, description, priority and a checklist that becomes real sub-tasks.
sidebar:
  order: 1
---

*Settings → Templates & rules.* A template is a task you wrote once and file repeatedly.

## What it holds

| | |
|---|---|
| **Title** and **description** | Both may contain [placeholders](/automation/rules/#placeholders) when filed by a rule |
| **Priority**, **labels**, **estimate** | The usual fields |
| **A checklist** | Each line becomes a **real sub-task**, with its own identifier and its own place on the board |
| **A kind** | Feedback, review, task, bug or checklist. Only affects the icon and how templates are grouped |

The checklist is the reason to use a template rather than copying a task. A five-line checklist
is five tasks somebody can assign, drag and close individually — which is what "did we actually
do the release steps" needs, and what a markdown checkbox in a description cannot give you.

## Three ways to file one

**By hand** — from *Settings → Templates & rules*, or from the template picker in the quick-add
sheet.

**By a rule** — see [rules](/automation/rules/). Something happens and the template is filed
automatically, addressed to whoever the rule names.

**By an assistant** — `list_templates` returns the templates a token can reach, with each
checklist, and `apply_template` files one. Both go through the same code as the button, so an
assistant asked to *open a feedback ticket for WEB-42* produces exactly what a person would.

## What every new project starts with

Creating a project seeds one template and one rule, in the creator's language:

- A **Feedback request** template — title `Feedback: {identifier} {title}`, with three checklist
  questions.
- A rule that files it **when a task enters review**, giving it to the project lead.

It is switched on and cannot fire until somebody moves a task into review, by which point the
project is being worked in. One switch turns it off, and deleting it is fine — nothing else
depends on it.

## Filed by hand, placeholders stay visible

A template's placeholders refer to *the task that triggered the rule*. Applied by hand there is
no such task, so only `{project}` and `{actor}` are filled and the rest stay in the text as
themselves — visibly unfilled rather than silently blanked, so you can see what to replace.
