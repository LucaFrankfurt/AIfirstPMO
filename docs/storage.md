# File storage

Uploads have two possible homes. Both are content-addressed: the key is the SHA-256 of the bytes,
so uploading the same image twice costs one object, and a stored file's URL never changes.

(`disk` is the application default and what `docker-compose.lite.yml` uses; the full compose stack
sets `s3` and runs MinIO for it.)

| | `disk` | `s3` |
|---|---|---|
| Where | the data volume | any S3-compatible bucket |
| Extra services | none | MinIO / Ceph / R2 / AWS |
| Backups | included in the volume backup | the bucket's own lifecycle |
| Downloads | streamed by the app | short-lived pre-signed URL, straight from the store |
| Good for | most self-hosted teams | large media libraries, several app nodes, existing object storage |

## MinIO: already running

The default `docker compose up -d` starts MinIO and points the app at it — there is nothing to
configure. On boot the app creates the bucket if it is missing, and if MinIO is still starting it
waits and retries rather than failing. The console is on `:9001` (bound to localhost), logging in
with `KOLIBRI_S3_ACCESS_KEY` / `KOLIBRI_S3_SECRET_KEY`.

The wiring it does for you:

```bash
KOLIBRI_STORAGE=s3
KOLIBRI_S3_ENDPOINT=http://minio:9000     # inside the compose network
KOLIBRI_S3_BUCKET=kolibri
KOLIBRI_S3_ACCESS_KEY=kolibri
KOLIBRI_S3_SECRET_KEY=kolibri-secret-change-me   # ← change this
KOLIBRI_S3_PATH_STYLE=true
```

**Change the secret key** before the machine is reachable by anyone else: it is both the S3
credential and the MinIO console login.

Prefer no object store at all? `docker compose -f docker-compose.lite.yml up -d` runs the single
container with uploads on the volume.

## AWS, Cloudflare R2, Backblaze

Same variables, different addressing — these use a bucket **subdomain** rather than a path:

```bash
# AWS
KOLIBRI_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
KOLIBRI_S3_REGION=eu-central-1
KOLIBRI_S3_PATH_STYLE=false

# Cloudflare R2
KOLIBRI_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
KOLIBRI_S3_REGION=auto
KOLIBRI_S3_PATH_STYLE=false
```

Give the credentials a policy limited to `GetObject`, `PutObject`, `DeleteObject` and
`ListBucket` on that one bucket. Nothing else is used.

## How downloads work

A request for `/files/<hash>/<name>` is authenticated and checked against workspace membership
first. Then:

- **disk** — the app streams the file with `Content-Disposition` and `X-Content-Type-Options:
  nosniff`. Only a safe list of types is served inline; everything else downloads.
- **s3** — the app answers `302` to a pre-signed URL valid for `KOLIBRI_S3_PRESIGN_SECONDS`
  (default 5 minutes), so the bytes never pass through the app server.

A pre-signed URL is signed **for the host the browser will connect to**, which is not
`http://minio:9000` — that name only resolves inside the compose network. So pre-signing is off in
the default stack and downloads are proxied by the app, which works from anywhere. To turn it on,
publish MinIO and tell Kolibri the address the browser can reach it at:

```bash
KOLIBRI_S3_PRESIGN=true
KOLIBRI_S3_PUBLIC_ENDPOINT=https://files.example.com
```

The pre-signed URL then carries its own authorisation for its lifetime — the standard trade-off for
offloading bandwidth, which is why the permission check happens before one is minted.

**Keep the bucket private.** Kolibri never needs public read access, and a public bucket would make
every uploaded file world-readable to anyone who learns a hash.

## Switching backends

Each row in the `files` table records the backend that holds it, so switching is safe: old files
keep being served from disk while new ones go to S3. To move the existing ones, copy the upload
directory into the bucket with the same layout (`ab/cd/<hash><ext>`) and update the column:

```bash
mc mirror /var/lib/docker/volumes/kolibri_kolibri-data/_data/uploads local/kolibri
# then, in the database:
#   UPDATE files SET storage = 's3';
```

Verify a few downloads before deleting anything from the old location.

## Client-side image handling

Before upload, the browser downscales images to 2000px and re-encodes them as WebP when that is
smaller. A 12 MB phone photo becomes a few hundred kilobytes, which matters most on the device with
the worst connection. The server stores what it is given — it runs no image library, which is one
native dependency and one attack surface fewer.
