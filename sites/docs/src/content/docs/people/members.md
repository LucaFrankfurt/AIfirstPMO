---
title: Members and roles
description: Four roles, invite links, private projects, and the account settings worth changing on day two.
sidebar:
  order: 4
---

*Settings → Members.*

## The four roles

| Role | May |
|---|---|
| **Owner** | Everything, including deleting the workspace and changing other owners. The last owner cannot be demoted |
| **Admin** | Manage members, projects, teams, workspace settings, the trash and the audit log |
| **Member** | The ordinary role: create and change projects, tasks and pages |
| **Guest** | See only the projects they have been added to. Cannot browse the workspace |

Guest is the role for a client, a contractor or anybody who should see one project and no
evidence that the others exist.

## Inviting

**Invite** creates a link, optionally tied to an email address and a role. Following it creates
the account and drops the person into the workspace.

Invite lookup is rate limited, per address as well as per requester, because an invite endpoint
that answers quickly is a way to find out which addresses have accounts.

If the instance also allows open signup, turn that off once your team is in —
`KOLIBRI_ALLOW_SIGNUP=false`, set by whoever runs it. Invites keep working.

## Private projects

A project can be private, in which case only its members see it — it is not in the sidebar, not
in search, not in the portfolio, and not reachable by URL for anybody else.

Two consequences that catch people out:

- **A [rule](/automation/rules/) cannot file into a private project for somebody who is not in
  it.** Recipients who cannot see the project are dropped, and the rule's log says so.
- **A [shared view](/views/saved/#sharing-one) resolves as the person who shared it.** If your
  view spans a private project, the link shares that project's tasks.

## Who may move work where

Per-column rules on a board: a workflow state can be restricted so that only certain roles may
move a task into it. That is how *Done* stops being something anybody can click on a Friday
afternoon.

## The audit log

*Settings → Workspace → Audit log.* Who changed permissions, who invited whom, who emptied the
trash, who revoked what. It is a record, not a feed — nothing writes to it but the system.

## Your own account

*Settings → Profile.* Three things are worth doing on day two:

**Two-factor authentication.** With recovery codes. Put them somewhere that is not the laptop
you are sitting at.

**Look at your devices.** Every session that has signed in as you, with what and when. Anything
you do not recognise, revoke — it signs that device out immediately.

**Set your language.** English, German or French, and it applies to the interface *and* to the
emails you receive, each written in your own language rather than the sender's.

:::note[Single sign-on]
If your organisation uses OpenID Connect, whoever runs the instance can wire it up, including
mapping directory groups to Kolibri roles. Then there is no password here to manage and this
section is somebody else's problem.
:::
