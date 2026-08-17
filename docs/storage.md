# File storage

Uploads have two possible homes. Both are content-addressed: the key is the SHA-256 of the bytes,
so uploading the same image twice costs one object, and a stored file's URL never changes.

| | `disk` (default) | `s3` |
|---|---|---|
| Where | the data volume | any S3-compatible bucket |
| Extra services | none | MinIO / Ceph / R2 / AWS |
| Backups | included in the volume backup | the bucket's own lifecycle |
| Downloads | streamed by the app | short-lived pre-signed URL, straight from the store |
| Good for | most self-hosted teams | large media libraries, several app nodes, existing object storage |

## MinIO in one command

```bash
docker compose --profile s3 up -d
```

Then point Kolibri at it:

```bash
KOLIBRI_STORAGE=s3
KOLIBRI_S3_ENDPOINT=http://minio:9000
KOLIBRI_S3_BUCKET=kolibri
KOLIBRI_S3_ACCESS_KEY=kolibri
KOLIBRI_S3_SECRET_KEY=kolibri-secret
KOLIBRI_S3_PATH_STYLE=true
```

The bucket is created on start if it does not exist, and a misconfigured store fails the boot with
a clear message rather than failing the first upload an hour later. The MinIO console is on
`:9001`.

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

The pre-signed URL carries its own authorisation for its lifetime. That is the standard trade-off
for offloading bandwidth; set `KOLIBRI_S3_PRESIGN=false` to proxy everything through the app
instead, at the cost of the app's bandwidth and event loop.

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
