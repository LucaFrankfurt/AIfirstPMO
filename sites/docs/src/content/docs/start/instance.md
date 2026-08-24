---
title: Getting an instance
description: Where a Kolibri lives — somebody else's, one of your own, or the public demo — and where the operator documentation is.
sidebar:
  order: 4
---

Kolibri is self-hosted. There is no kolibri.day account to sign up for; there is software you or
somebody you work with runs. That leaves three cases.

## Somebody already runs one

Then you have a URL and either an invite link or a password, and nothing on this page applies.
Go to [your first hour](/start/first-hour/).

## You want to try it without installing anything

[demo.kolibri.day](https://demo.kolibri.day) is a real instance with a workspace already in it —
three projects, a running cycle, a backlog with a realistic spread, some pages and some
comments. Everything in this manual can be tried there.

:::caution[It resets, and it is public]
The demo is wiped back to its starting state on a schedule, and anybody can sign in. Do not put
anything in it you would mind a stranger reading, and do not expect what you wrote yesterday to
still be there.
:::

## You want to run one

One command, on any machine with Docker:

```bash
git clone https://github.com/LucaFrankfurt/AIfirstPMO.git kolibri
cd kolibri
docker compose up -d --build
```

That brings up the app on `http://localhost:4000` **and** an S3-compatible object store for
uploads, already wired to each other — the bucket is created on first boot and nothing has to be
configured afterwards. The first account you create in the browser owns the instance.

There is a single-container variant that keeps uploads on the volume instead:

```bash
docker compose -f docker-compose.lite.yml up -d --build
```

And it runs without Docker at all — Node 22.18 or newer is the only requirement, because the
server runs TypeScript directly and SQLite is built into Node.

## Where the operator documentation is

This site is the manual for *using* Kolibri. Running it is a different document, and it lives in
the repository rather than here, because it changes with the code it describes:

| | |
|---|---|
| `docs/deployment.md` | TLS, backups, upgrades, every environment variable, and the Coolify path |
| `docs/architecture.md` | How the pieces fit, and why there is no Redis or Postgres |
| `docs/sync.md` | The offline protocol, the conflict rules and the failure modes |
| `docs/security.md` | The threat model — what is checked, where, and what has not been reviewed |
| `docs/notifications.md` | Wiring up a mail relay, Web Push and Telegram |
| `docs/storage.md` | Disk versus S3, pre-signed downloads, migrating between them |
| `docs/api.md` | The REST API |
| `docs/mcp.md` | Every MCP tool, prompt and resource |
| `TODO.md` | What is missing, what is unverified, and what was deferred on purpose |

All of them are at
[github.com/LucaFrankfurt/AIfirstPMO](https://github.com/LucaFrankfurt/AIfirstPMO/tree/main/docs).

## The guide inside the app

Press <kbd>?</kbd> anywhere in Kolibri. There is a guide built into the app with animated
diagrams of each area and an explorer for how the pieces nest — and unlike this site it knows
which version you are actually running. A screen with nothing on it yet links to the card that
explains what goes there.
