# Deployment

```bash
docker compose up -d --build
```

That is the deployment. Everything below is detail.

## What comes up

| Service | Published on | Purpose |
|---|---|---|
| `kolibri` | `:4000` | the app |
| `minio` | `127.0.0.1:9000`, console `127.0.0.1:9001` | uploads; the bucket is created by the app on boot |
| `caddy` | `:80`, `:443` — profile `tls` | automatic HTTPS for `KOLIBRI_DOMAIN` |
| `mailpit` | `127.0.0.1:8025` — dev overlay only | a capture inbox for trying email out |

The app waits for the object store instead of crash-looping if MinIO is slow to start, creates the
bucket itself, and — if `KOLIBRI_ADMIN_EMAIL`/`KOLIBRI_ADMIN_PASSWORD` are set — creates the owner
account and its first workspace. All of that is idempotent, so restarts and redeploys converge
rather than duplicate. `GET /api/health` reports `"ready": true` once it is done.

Two things to set before this is more than a local experiment:

1. `KOLIBRI_S3_SECRET_KEY` — it is also the MinIO console password.
2. `KOLIBRI_SMTP_URL` — email is off until it points at a relay. Notifications still work; they
   live in the in-app inbox. See [`notifications.md`](notifications.md).

To try email locally, add the dev overlay — it runs a capture inbox and points the app at it:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build   # inbox on :8025
```

A capture inbox is never presented as working delivery: the log warns on boot, `/api/health`
reports `"mail": "test-inbox"`, and the settings screen shows a banner.

For the smallest possible install — one container, uploads on the volume, no mail —
`docker compose -f docker-compose.lite.yml up -d --build`.

## Environment

### First-run provisioning

| Variable | Default | Meaning |
|---|---|---|
| `KOLIBRI_ADMIN_EMAIL` | empty | Creates the owner account on an empty database. Without it, the first person to sign up owns the instance. |
| `KOLIBRI_ADMIN_PASSWORD` | empty | Required with the above; at least 8 characters or the bootstrap is skipped with a warning. |
| `KOLIBRI_ADMIN_NAME` | `Owner` | Display name for that account |
| `KOLIBRI_WORKSPACE_NAME` | `Kolibri` | Name of the workspace created with it |
| `KOLIBRI_SEED_DEMO` | `false` | Fill an empty database with the demo workspace |

### Core

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | Listen port inside the container |
| `KOLIBRI_SECRET` | generated | Signs sessions and API tokens. Generated once and stored in the data volume if unset. **Changing it signs everyone out.** |
| `KOLIBRI_PUBLIC_URL` | empty | Absolute base URL. Invite links, email links, and **every address in the OAuth metadata**. Set it — see below |
| `KOLIBRI_ALLOW_SIGNUP` | `true` | Set to `false` once the team has accounts; invites still work |
| `KOLIBRI_MAX_UPLOAD_MB` | `25` | Per-file upload ceiling |
| `KOLIBRI_SESSION_DAYS` | `60` | Browser session lifetime |
| `KOLIBRI_DATA_DIR` | `/data` | SQLite file, uploads, generated secret |
| `KOLIBRI_LOG_LEVEL` | `info` | `debug` `info` `warn` `error` |
| `KOLIBRI_DEFAULT_LOCALE` | `en` | Language for notifications and emails to someone who has not picked one (`en`, `de`). See [`i18n.md`](i18n.md). |
| `KOLIBRI_TRUST_PROXY` | `true` | Read the client address from `x-forwarded-for`. Correct behind the bundled Caddy; **set it to `false` if the container is published directly**, or every client can pick its own address. See below. |
| `KOLIBRI_ALLOW_PRIVATE_WEBHOOKS` | `false` | Let outgoing webhooks and push endpoints reach private addresses (loopback, RFC 1918, link-local). Off by default; see [below](#what-the-server-does-to-protect-itself). |
| `TZ` | `UTC` | Affects date rendering on the server side |

### Email (optional — see [`notifications.md`](notifications.md))

| Variable | Default | Meaning |
|---|---|---|
| `KOLIBRI_SMTP_URL` | empty | `smtp://user:pass@host:587` or `smtps://…:465`. Empty means in-app notifications only. |
| `KOLIBRI_MAIL_FROM` | `kolibri@localhost` | Envelope and header sender — use a domain you control |
| `KOLIBRI_MAIL_FROM_NAME` | `Kolibri` | Display name |
| `KOLIBRI_MAIL_REPLY_TO` | empty | Optional `Reply-To` |
| `KOLIBRI_MAIL_BATCH_SECONDS` | `120` | How long notifications are collected before one summary mail goes out |
| `KOLIBRI_MAIL_MAX_ATTEMPTS` | `6` | Retries before a message is marked failed |
| `KOLIBRI_SMTP_INSECURE` | `false` | Accept a self-signed certificate on an internal relay |

`KOLIBRI_PUBLIC_URL` must be set for the links in those emails to point anywhere useful.

### Set `KOLIBRI_PUBLIC_URL`, and check what it produced

Not only for links. **Three things** are built from it, and all three go quiet rather than loud when
it is wrong:

- **`issuer` in the OAuth metadata.** A client is *required* to reject metadata whose issuer does not
  match the URL it fetched the document from (RFC 8414 §3.3). A connector then reads all three
  documents, refuses them, never calls the registration endpoint, and reports that registration
  failed — with nothing in the server log to look at, because from the server's side nothing broke.
- **`Secure` on the session cookie.** Without it a browser will send the session token over plain
  HTTP.
- **`Strict-Transport-Security`.** Only sent where there is TLS to insist on, so a laptop is never
  locked to https by a header it cannot honour.

Without it, the scheme is inferred: `x-forwarded-proto` from the proxy if it sends one, then the
socket, and failing both a bare hostname is assumed to be TLS while a host with a port is assumed to
be somebody's laptop. That inference is right in the common cases and it is still an inference.

One command says whether it is right on your instance:

```bash
curl -s https://your-host/.well-known/oauth-authorization-server | jq .issuer
# "https://your-host"   ← must be exactly the URL you just typed, https and all

curl -sI https://your-host/api/health | grep -i strict-transport
# strict-transport-security: max-age=15552000
```

Both come from one function, so if one is right the other is.

### Single sign-on (optional)

Kolibri speaks OpenID Connect — the authorization-code flow with PKCE, and
nothing else: no implicit flow, no SAML, no refresh tokens held on the server.

SAML and LDAP are not on the list. SAML means verifying XML digital signatures,
which means XML canonicalisation — a specification with a long history of
signature-wrapping bugs in libraries maintained by people who work on nothing
else; LDAP means an ASN.1/BER client. Both are security-critical parsers well
past what a project with no runtime dependencies can honestly carry. Every
provider named below speaks OIDC, and an LDAP directory reaches Kolibri through
one of them. If yours speaks SAML and nothing else, put a broker in front of
it — that is a better answer than a hand-rolled signature verifier here.
Anything with a discovery document works — Keycloak, Authentik, Authelia,
Zitadel, Entra ID, Google Workspace, Okta.

Register Kolibri at your provider as a **confidential web application** with the
redirect URI `https://your-domain/api/auth/oidc/callback`, then:

| Variable | Default | Meaning |
|---|---|---|
| `KOLIBRI_OIDC_ISSUER` | empty | Issuer URL, e.g. `https://id.example.com/realms/main`. Empty disables single sign-on entirely. |
| `KOLIBRI_OIDC_CLIENT_ID` | empty | Client ID from the provider |
| `KOLIBRI_OIDC_CLIENT_SECRET` | empty | Client secret; keep it out of the compose file and in the secret store |
| `KOLIBRI_OIDC_SCOPE` | `openid email profile` | Scopes requested. `email` is required — it is how an account is matched. |
| `KOLIBRI_OIDC_LABEL` | `Single sign-on` | What the button on the sign-in screen says |
| `KOLIBRI_OIDC_AUTO_CREATE` | `true` | Create an account for anybody the provider vouches for. Set `false` to admit only people invited first. |
| `KOLIBRI_OIDC_ONLY` | `false` | Hide the password form, and refuse password sign-in and sign-up server-side |

`KOLIBRI_PUBLIC_URL` should be set: the redirect URI is built from it, and a
provider will refuse a redirect URI it does not recognise.

Accounts created this way carry no password, so they can only be signed into
through the provider. An address is accepted only if the provider marks it
verified — otherwise anyone who can type their own address at the provider could
claim an existing Kolibri account. Turning `KOLIBRI_OIDC_ONLY` on closes the
password door for accounts that still carry one from before the switch, so make
sure the provider can actually let you back in before you set it.

#### Which workspace, and which role

By default an account made through the provider joins the instance's **only**
workspace, because a company directory pointed at a one-workspace instance means
that workspace — not one empty workspace per colleague. With several and nothing
configured it gets its own, exactly like signing up; name one to be sure:

| Variable | Default | Meaning |
|---|---|---|
| `KOLIBRI_OIDC_WORKSPACE` | empty | Slug or id of the workspace new accounts join. Empty: the only workspace, if there is exactly one. |
| `KOLIBRI_OIDC_GROUPS_CLAIM` | `groups` | Where the groups are in the token. A dotted path — Keycloak puts them at `resource_access.<client>.roles`. |
| `KOLIBRI_OIDC_ROLE_MAP` | empty | `group=role` pairs, comma-separated. Empty leaves roles alone. |
| `KOLIBRI_OIDC_DEFAULT_ROLE` | `member` | The role for somebody in no mapped group. `none` refuses the sign-in. |

```bash
KOLIBRI_OIDC_ROLE_MAP="kolibri-admins=admin, kolibri-users=member, contractors=guest"
KOLIBRI_OIDC_DEFAULT_ROLE=none      # only those three groups may sign in at all
```

The **highest** matching role wins: somebody in both `kolibri-users` and
`kolibri-admins` is an admin, because a person's access is the union of what they
have been given and taking the lowest would make adding a group able to quietly
remove access.

Two things worth knowing before you set a map:

- **It is applied on every sign-in, and it demotes.** Once the directory is the
  authority on roles it has to be the authority both ways, or the map is
  decoration — so a role changed inside Kolibri is overwritten the next time that
  person signs in. Leave `KOLIBRI_OIDC_ROLE_MAP` empty if you would rather manage
  roles here.
- **The last owner of a workspace is never demoted.** A misspelt group name
  should cost somebody an afternoon, not the instance.

Groups are read from the ID token. If your provider only puts them in the
userinfo response, add the claim to the token — every provider named above can.

### Object storage (optional — see [`storage.md`](storage.md))

| Variable | Default | Meaning |
|---|---|---|
| `KOLIBRI_STORAGE` | `disk` | `disk` keeps uploads in the volume, `s3` puts them in a bucket |
| `KOLIBRI_S3_ENDPOINT` | `http://minio:9000` | Object store endpoint |
| `KOLIBRI_S3_BUCKET` | `kolibri` | Created on start if missing |
| `KOLIBRI_S3_REGION` | `us-east-1` | `auto` for R2 |
| `KOLIBRI_S3_ACCESS_KEY` / `KOLIBRI_S3_SECRET_KEY` | empty | Credentials; scope them to this one bucket |
| `KOLIBRI_S3_PATH_STYLE` | `true` | `true` for MinIO/Ceph, `false` for AWS/R2 |
| `KOLIBRI_S3_PRESIGN` | `true` | Serve downloads by redirect to a signed URL instead of proxying |
| `KOLIBRI_S3_PRESIGN_SECONDS` | `300` | Lifetime of those URLs |

The first account created owns the instance. Turn signup off afterwards.

## Coolify (and other PaaS)

Use the **Docker Compose** build pack with `docker-compose.coolify.yml`, not the Dockerfile one:
the app needs MinIO next to it, and Compose keeps both in a single resource that deploys, restarts
and backs up together. The Dockerfile pack would mean running MinIO as a second resource and wiring
the two by hand.

Coolify → *Add Resource* → *Docker Compose* → this repository → compose file
`docker-compose.coolify.yml`. Then, in the UI:

1. give the `kolibri` service a domain pointing at port **4000**,
2. set `KOLIBRI_ADMIN_EMAIL` and `KOLIBRI_ADMIN_PASSWORD` so the owner account exists on the first
   deploy,
3. set `KOLIBRI_SMTP_URL` if you want email,
4. check that `KOLIBRI_PUBLIC_URL` really resolved to your `https://` domain — invite and email
   links are built from it.

The Coolify file differs from `docker-compose.yml` only where the platform owns the host:

| | `docker-compose.yml` | `docker-compose.coolify.yml` |
|---|---|---|
| Container names | fixed (`kolibri`, `kolibri-minio`) | none — Coolify suffixes with a UUID so deployments cannot collide |
| Networking | `ports:` published on the host | `expose:` only; Coolify's proxy routes to the port you gave a domain |
| TLS | optional Caddy (`--profile tls`) | Coolify's proxy |
| Object storage credentials | defaults in the file | `SERVICE_USER_MINIO` / `SERVICE_PASSWORD_MINIO`, generated and stored by Coolify |

The same shape works on any PaaS that consumes a compose file. On one that only takes a Dockerfile
(Fly, Railway's simple mode, a plain container host), deploy the image on its own with
`KOLIBRI_STORAGE=disk` and a persistent volume at `/data` — that is `docker-compose.lite.yml`
without the compose part, and it needs no second service.

## TLS

Kolibri speaks plain HTTP and expects a reverse proxy for TLS. Caddy is two lines
(see the commented service in `docker-compose.yml`). With nginx, the only thing to get right is
Server-Sent Events:

```nginx
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;

    # The change stream is a long-lived response: do not buffer it, do not time it out.
    proxy_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 30m;   # keep above KOLIBRI_MAX_UPLOAD_MB
}
```

Set `KOLIBRI_PUBLIC_URL=https://…` so invite links point at the right host, and remove the port
mapping from the app service so only the proxy is exposed.

## Backups

Everything is in the data volume: `kolibri.sqlite`, `uploads/`, `.secret`. (With `KOLIBRI_STORAGE=s3`
the uploads live in the bucket instead — back that up with the object store's own tooling, and note
that the database still holds the metadata that makes those objects findable.)

Do not `cp` the database while the container is running: SQLite may be halfway through a write, and
the copy restores into a corrupt file. `kolibri backup` takes the copy through SQLite instead, which
is consistent by construction, and puts the uploads beside it:

```bash
docker compose exec kolibri kolibri backup /data/backups/$(date +%F)
docker compose cp kolibri:/data/backups/$(date +%F) ./kolibri-$(date +%F)
tar czf kolibri-$(date +%F).tar.gz kolibri-$(date +%F)
```

The snapshot is a directory holding `kolibri.sqlite`, `uploads/` and a `manifest.json` saying when it
was taken and what is in it. Check it before you trust it — this reads the copy and asks SQLite
whether it is intact:

```bash
docker compose exec kolibri kolibri verify /data/backups/2026-08-19
```

Outside a container the same commands are `npm run kolibri -- <command>` from the repository, with
`KOLIBRI_DATA_DIR` pointing at the instance.

### Restoring

With the server **stopped**, and `KOLIBRI_DATA_DIR` pointing at the instance being restored into:

```bash
docker compose stop kolibri
docker compose run --rm --entrypoint kolibri kolibri restore /data/backups/2026-08-19 --force
docker compose start kolibri
```

The snapshot is verified before anything is replaced, and a database that was already there is moved
aside rather than deleted (`kolibri.sqlite.replaced-<timestamp>`) — the moment somebody restores the
wrong snapshot is the moment they want the old one back. Stale `-wal`/`-shm` files are removed, since
a write-ahead log belonging to the previous database would otherwise be replayed into the new one.
Uploads are merged rather than replaced: they are content-addressed, so a name that exists in both
holds the same bytes.

Keep `.secret` with the backup (or set `KOLIBRI_SECRET` explicitly) — without it, existing sessions
and API tokens are void. It is deliberately *not* in the snapshot: a copy of the database and the key
that signs its sessions, in one tarball, is a worse trade than an operator remembering one file.

This procedure is rehearsed by `packages/server/test/maintenance.test.ts`, which backs one instance
up, restores it into an empty one in a separate process, and asks that instance what it holds.

## Maintenance

```bash
docker compose exec kolibri kolibri doctor
```

Checks the database's internal consistency, that every foreign key points at something, that the
full-text index matches the tables, how much of the file is free space, the size of the write-ahead
log, expired rows nobody swept, and whether every stored file's bytes are still readable.

| Command | What it does |
|---|---|
| `doctor` | Reports. `--json` for monitoring; exits non-zero only on a *damaged* database or missing bytes, not on a warning |
| `doctor --fix` | Rebuilds the search index, removes expired sessions and old replay records, folds away deleted text in page bodies (see [`sync.md`](sync.md)), then compacts the file — and re-checks, so what it prints is the state afterwards |
| `reindex` | Rebuilds the full-text index alone. This is the supported way back if the index ever drifts |
| `vacuum` | Checkpoints the write-ahead log and returns free pages to the disk |
| `backup <dir>` / `verify <dir>` / `restore <dir>` | Above |
| `files move <disk\|s3>` | Moves stored blobs onto the other backend — see [`storage.md`](storage.md) |

`doctor --json` is the one to put on a schedule; a `status` of `fail` is the only thing that should
page anybody.

### The trash, and how long it keeps

A delete is reversible: the row is marked and kept, which is what lets two devices agree it is gone,
and **Settings → Data** lists everything deleted or archived with a way back.

Admins can end that with **Empty the trash**. It removes the rows, the uploaded bytes nothing else
points at, and the audit entries that quoted the deleted thing by name — a button whose promise is
"gone" cannot leave the last copy of a title in a list. Every other device forgets the same things on
its next sync, through the purge markers described in [`sync.md`](sync.md).

`KOLIBRI_TRASH_DAYS` does the same thing on a clock:

```bash
KOLIBRI_TRASH_DAYS=90    # deleted things are removed for good after ninety days
```

It is **off by default** (`0`). A default that quietly destroyed things after a month would be a
retention policy this project has no business choosing for somebody else's data — and it is the sort
of default nobody discovers until the thing they wanted back is not there.

## Upgrades

```bash
git pull
docker compose up -d --build
```

The schema is applied with `CREATE TABLE IF NOT EXISTS` on every boot and new columns are added
idempotently, so upgrading is a restart. Take a backup first anyway.

Clients update themselves: the service worker fetches the new shell on the next navigation, and the
sync protocol is version-tolerant — an old tab keeps working until it reloads.

## Health and monitoring

```
GET /api/health → { "status": "ok", "seq": 1832, "uptime": 90421 }
```

`seq` is the workspace change counter; if it never moves, nothing is being written. The container
ships a `HEALTHCHECK` using this endpoint, so `docker compose ps` reports real health.

Logs go to stdout as single lines with a timestamp and level — `docker compose logs -f kolibri`.

## Scale expectations

A single Node process with SQLite in WAL mode comfortably serves a team of dozens: reads are served
from memory-mapped pages, writes are short transactions, and each client only pulls deltas.

The limits worth knowing:

- **One node.** The sequence counter and the SSE bus are in-process, so running two replicas behind
  a load balancer is not supported today.
- **Uploads on the volume by default.** Switch to `KOLIBRI_STORAGE=s3` for an object store, or
  point `KOLIBRI_UPLOAD_DIR` at a network mount.
- **One mail worker.** Email is sent by a single polling loop inside the app process. Fine for a
  team's volume; it is not a bulk sender.
- **One instance per host process.** Multiple containers must not share the same SQLite file.

## What the server does to protect itself

Four things. Three are on by default and not configurable — there is no setting
to get wrong — and the fourth has one switch, because a self-hosted instance can
have a good reason to turn it off.

**Rate limits** on the routes where guessing is the attack: signing in,
registering, and looking up an invite code. Each is a token bucket, in memory,
and a refusal costs a token too, so hammering after a `429` does not reset the
clock. The response says how many seconds to wait.

Signing in is limited **per account as well as per address**. An address-only
limit is blind to the case that actually takes accounts over: one account, a
thousand machines, ten attempts each.

The address a request claims is not necessarily where it came from. When
`KOLIBRI_TRUST_PROXY` is on — the default, because the bundled Caddy needs it —
`x-forwarded-for` is believed, so an instance published *without* a proxy would
let a client invent a fresh address, and a fresh allowance, per request. The
socket address is therefore charged as well, against a much wider bucket: wide
enough that everybody behind one proxy never meets it, finite enough that
inventing addresses buys a bounded number of attempts. Setting
`KOLIBRI_TRUST_PROXY=false` when nothing is in front is still the right answer;
this is what happens if you forget.

**A Content-Security-Policy** on every response: `default-src 'self'`, no inline
script and no `eval`, `frame-ancestors 'none'`. Markdown is escaped before it is
rendered, so this is the second lock rather than the first — it turns a future
injection bug into a console message instead of a stolen session.

The policy is computed, not fixed. With `KOLIBRI_S3_PRESIGN` on, a download
redirects the browser to MinIO or S3, so that origin is named in `img-src`,
`media-src` and `connect-src` — otherwise attachments would arrive and be
discarded. Nothing widens `script-src`, ever.

**Where the server is willing to connect.** Two features hand it a URL: an
outgoing webhook, whose address a workspace admin types in, and a Web Push
subscription, whose endpoint the browser supplies. Both are also the classic way
to make a server reach what the person asking cannot — the container beside it,
the database on the private network, the cloud metadata service on
`169.254.169.254` that hands out credentials to anything asking from inside.

So the address is resolved **before** the connection rather than during it,
every address the name answers with is checked, and the socket is then pinned to
the address that passed. Pinning is the part that matters: without it a name can
answer publicly for the check and privately a moment later for the connection.
Redirects are followed by hand, three at most, with the same check each time and
without the original headers — a public URL that `302`s to the metadata service
is the same attack wearing a hat. Loopback, the RFC 1918 ranges, link-local,
carrier-grade NAT, multicast, and every way IPv6 has of spelling an IPv4 address
(`::ffff:127.0.0.1`, NAT64, 6to4) are all refused, and so is any scheme that is
not `http` or `https`.

`KOLIBRI_ALLOW_PRIVATE_WEBHOOKS=1` turns the check off. Set it when posting to
`http://n8n:5678` on your own docker network is the point — that is a normal
thing to want. It is not a safe default for the instance that has not thought
about it, particularly one where anybody may sign up and make a workspace of
their own.

**Addresses are refused at the socket, not only at the form.** An email address
with a carriage return in it is not a typo, it is a second SMTP command; a
header name with one in it writes a header nobody asked for. Both are refused
where the message is built, so an address that reached the queue from a form, an
identity provider, a restored backup or an environment variable meets the same
check.

**A row may only point at rows in its own workspace.** `parent_id`,
`project_id`, `state_id` and the rest are checked against the workspace the
write arrived in, so a page cannot be hung off a page somebody else owns — which
a public share link would then have published, under their name.

## Hardening checklist

- [ ] `KOLIBRI_ALLOW_SIGNUP=false` after your team has signed up
- [ ] `KOLIBRI_ALLOW_PRIVATE_WEBHOOKS` left unset unless webhooks genuinely need to reach your own network
- [ ] `KOLIBRI_TRUST_PROXY=false` if nothing terminates TLS in front of the container
- [ ] `KOLIBRI_SECRET` set explicitly and stored in your secret manager
- [ ] TLS terminated in front, `KOLIBRI_PUBLIC_URL` set to the https URL
- [ ] Volume backed up on a schedule, restore tested once
- [ ] API tokens scoped to `read` where write access is not needed, and expiring
- [ ] If email is on: SPF/DKIM/DMARC set for the sending domain, and a test mail sent from
      Settings → Notifications
- [ ] If S3 is on: the bucket is **private**, and the credentials are limited to it
- [ ] Container runs as the non-root `node` user (it does by default — keep it that way)
