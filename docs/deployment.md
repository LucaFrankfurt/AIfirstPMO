# Deployment

One container, one volume. Everything below is optional polish on top of `docker compose up -d`.

## Environment

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
| `TZ` | `UTC` | Affects date rendering on the server side |

The first account created owns the instance. Turn signup off afterwards.

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

Everything is in the data volume: `kolibri.sqlite`, `uploads/`, `.secret`. With the container
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
- **Disk, not object storage.** Uploads live on the volume. Point `KOLIBRI_UPLOAD_DIR` at a network
  mount if you need them elsewhere.
- **One instance per host process.** Multiple containers must not share the same SQLite file.

## Hardening checklist

- [ ] `KOLIBRI_ALLOW_SIGNUP=false` after your team has signed up
- [ ] `KOLIBRI_SECRET` set explicitly and stored in your secret manager
- [ ] TLS terminated in front, `KOLIBRI_PUBLIC_URL` set to the https URL
- [ ] Volume backed up on a schedule, restore tested once
- [ ] API tokens scoped to `read` where write access is not needed, and expiring
- [ ] Container runs as the non-root `node` user (it does by default — keep it that way)
