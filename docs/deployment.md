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
| `KOLIBRI_PUBLIC_URL` | empty | Absolute base URL, used in invite links and MCP output |
| `KOLIBRI_ALLOW_SIGNUP` | `true` | Set to `false` once the team has accounts; invites still work |
| `KOLIBRI_MAX_UPLOAD_MB` | `25` | Per-file upload ceiling |
| `KOLIBRI_SESSION_DAYS` | `60` | Browser session lifetime |
| `KOLIBRI_DATA_DIR` | `/data` | SQLite file, uploads, generated secret |
| `KOLIBRI_LOG_LEVEL` | `info` | `debug` `info` `warn` `error` |
| `KOLIBRI_DEFAULT_LOCALE` | `en` | Language for notifications and emails to someone who has not picked one (`en`, `de`). See [`i18n.md`](i18n.md). |
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
that the database still holds the metadata that makes those objects findable.) With the container
running, take a consistent copy through SQLite rather than `cp`:

```bash
docker compose exec kolibri sh -c \
  'node --experimental-sqlite -e "
     const {DatabaseSync}=require(\"node:sqlite\");
     new DatabaseSync(\"/data/kolibri.sqlite\").exec(\"VACUUM INTO \\\"/data/backup.sqlite\\\"\")
   "'
docker compose cp kolibri:/data/backup.sqlite ./backup-$(date +%F).sqlite
tar czf uploads-$(date +%F).tar.gz -C "$(docker volume inspect -f '{{.Mountpoint}}' kolibri_kolibri-data)" uploads
```

Restoring is putting those files back and starting the container. Keep `.secret` with the backup
(or set `KOLIBRI_SECRET` explicitly) — without it, existing sessions and API tokens are void.

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

## Hardening checklist

- [ ] `KOLIBRI_ALLOW_SIGNUP=false` after your team has signed up
- [ ] `KOLIBRI_SECRET` set explicitly and stored in your secret manager
- [ ] TLS terminated in front, `KOLIBRI_PUBLIC_URL` set to the https URL
- [ ] Volume backed up on a schedule, restore tested once
- [ ] API tokens scoped to `read` where write access is not needed, and expiring
- [ ] If email is on: SPF/DKIM/DMARC set for the sending domain, and a test mail sent from
      Settings → Notifications
- [ ] If S3 is on: the bucket is **private**, and the credentials are limited to it
- [ ] Container runs as the non-root `node` user (it does by default — keep it that way)
