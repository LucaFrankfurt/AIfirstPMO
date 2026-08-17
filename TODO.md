# To-do

Everything that is knowingly missing, unverified or deliberately deferred, honestly listed.
Ticked boxes are done; the rest is open. Ordered by "would I run this in production without it?".

Legend: **P1** blocks a real deployment · **P2** wanted soon · **P3** nice to have.

---

## P1 — before putting real data in it

### Security hardening

- [ ] **Rate limiting** on `/api/auth/login`, `/api/auth/register` and `/api/invites/:code/accept`.
      Today an attacker can guess passwords as fast as the network allows. A per-IP + per-account
      token bucket in memory is enough for a single-node deployment.
- [ ] **Content-Security-Policy header.** The app is same-origin only and markdown is escaped before
      rendering, but a CSP (`default-src 'self'`, no inline scripts) turns a future XSS bug from a
      breach into a console error. Needs the inline `<style>`-free build we already have.
- [ ] **Explicit `content-type` check on JSON routes.** CSRF is currently prevented by
      `SameSite=Lax` cookies alone (cross-site POSTs carry no cookie). That is correct today, but
      rejecting anything that is not `application/json` is one line and removes the dependency on
      one browser default.
- [ ] **Session management UI** — list active sessions per device and revoke individually.
      Changing the password already invalidates all of them, which is the blunt version.
- [ ] Optional **2FA (TOTP)** for owner/admin accounts.

### Operations

- [ ] **Verify the deployment on a real daemon.** The Dockerfile and both compose files were
      written and reviewed but never executed — there was no Docker daemon in the environment they
      were authored in. The `deploy` job in CI brings the whole stack up and asserts the wiring
      (provisioned owner account, upload landing in MinIO, test mail arriving in Mailpit, restart
      idempotence, plus the lite variant); that job has not run yet.
- [ ] **Test a restore.** The backup procedure in `docs/deployment.md` (`VACUUM INTO` + uploads
      tarball) is written from first principles, not from a rehearsed restore.
- [ ] **`kolibri doctor` / maintenance commands** — integrity check, `VACUUM`, and a search-index
      rebuild. If the FTS table ever drifts from the tables (a crash mid-transaction, a manual
      edit), there is currently no supported way to rebuild it.

### Correctness

- [ ] **Replace the pull-pagination heuristic.** The client decides whether to ask for another page
      by checking if any entity returned exactly `PAGE_SIZE` rows (`hadFullPage` in `lib/sync.ts`).
      The server should return an explicit `hasMore` flag instead — the heuristic is right but
      fragile, and it is the one place where a wrong guess means a client silently stops syncing.
- [ ] **Guest role in the UI.** Guests are correctly refused by the server, but the interface still
      shows them buttons that will fail. Hide or disable write affordances when `role === 'guest'`.
- [ ] **Client-side tests.** The store, the outbox and the merge path have no unit tests of their
      own; they are only covered indirectly through the API tests and the browser smoke run.

---

## P2 — the obvious next features

- [ ] **Saved views UI.** The `view` entity syncs, the seed creates one, the server serves them —
      there is no interface to save the current filter set or load a shared view. This is the
      largest gap between the data model and what you can actually click.
- [x] **@mentions in comments and descriptions**, with notifications. Handles resolve by first
      name, display name or email address.
- [x] **Email notifications** — batched per person, per-user preferences, signed one-click
      unsubscribe, queued with retry. Invites are delivered by mail when a relay is configured.
      See [`docs/notifications.md`](docs/notifications.md).
- [ ] **Mention autocomplete in the editor.** Typing `@` should offer the workspace members
      instead of relying on the writer knowing the handle.
- [ ] **Scheduled digests** (daily/weekly summary) on top of the existing batching window.
- [ ] **Due-date reminders.** The `due_soon` notification kind is reserved but nothing emits it.
- [ ] **Bulk actions in the list view.** `POST /api/workspaces/:ws/tasks/bulk` exists and is tested;
      the UI has no multi-select.
- [ ] **Trash / archive browser.** Everything is soft-deleted and recoverable in the database, but
      there is no screen to see or restore deleted tasks and pages.
- [ ] **Avatar upload.** `users.avatar_url` is respected everywhere; nothing sets it.
- [ ] **Precise drop position on the board.** A drop currently appends to the end of the target
      column. Fractional indexing already supports inserting between two neighbours — the drop
      handler just needs the index under the cursor.
- [ ] **Comment reactions.** The `reactions` field is stored and synced; no picker, no display.
- [ ] **Table and Gantt layouts.** `LAYOUTS` in `packages/shared/src/types.ts` declares five layouts;
      three are implemented (list, board, calendar). Either build them or trim the type.
- [ ] **Internationalisation.** The interface is English only. Given who this was built for, German
      is the obvious first translation. No i18n scaffolding exists yet — strings are inline.
- [ ] **Image lightbox** for attachments and inline images (the `.gallery` styles are unused).
- [ ] **Per-task notification opt-out** (`subscribers` is stored and used, but nothing toggles it).

---

## P3 — bigger bets, only with a reason

- [ ] **Real-time collaborative page editing.** Page bodies merge last-writer-wins; simultaneous
      typing resolves to one version with the other kept in history. A text CRDT (Yjs/Automerge) on
      the `content` field would fix it — see the closing section of [`docs/sync.md`](docs/sync.md).
- [ ] **Multi-node deployment.** The sequence counter, the SSE bus and the mail worker live in the
      process. Running two replicas needs an external counter, a shared bus and a locked queue —
      this is the one scenario where Redis or Postgres genuinely earns its place.
- [ ] **Bounce and complaint handling.** Failed sends are recorded in `email_queue.last_error`, but
      a hard bounce does not disable that address automatically.
- [ ] **Custom fields** per project.
- [ ] **Time tracking** (estimates exist, logged time does not).
- [ ] **Recurring tasks** and **task templates**.
- [ ] **Webhooks and integrations** (GitHub/GitLab commit linking, Slack notifications).
- [ ] **Import/export** from Jira, Linear, Plane, OpenProject, and a plain JSON round-trip.
- [ ] **Native push notifications** (Web Push needs VAPID keys and a subscription store).
- [ ] **Object-storage migration command.** Switching `disk` → `s3` keeps serving old files from
      disk, but moving them is a manual `mc mirror` plus an `UPDATE` today (see
      [`docs/storage.md`](docs/storage.md)).
- [ ] **Roadmap / portfolio view** across projects.
- [ ] **Public share links** for a page or a filtered task list.

---

## Verified, for contrast

So the list above is read in proportion — these are covered by automated tests
(`npm test`, 31 cases) or by the browser walkthrough (`node scripts/smoke.mjs`):

- [x] Registration, login, sessions, API tokens, read-only scopes
- [x] Task identifiers allocated without gaps or duplicates
- [x] `completed_at` set and cleared by workflow state group
- [x] Delta pull returns only what changed since the cursor
- [x] A replayed push does not create a duplicate task
- [x] Concurrent offline edits merge per field (newer title wins, older priority survives)
- [x] Private projects invisible to non-members in REST *and* in sync pulls
- [x] Uploads content-addressed, dimensions detected, unauthenticated download refused
- [x] Page history written on body change
- [x] MCP `initialize` / `tools/list` / `tools/call`, and a write refused on a read-only token
- [x] Full-text search finds a task by a word in its title
- [x] SMTP against a real server socket: EHLO, AUTH, dot-stuffing, MIME, UTF-8 subjects
- [x] Notification batching, per-user preferences, unsubscribe signature, retry with backoff
- [x] S3 against a fake store that **verifies the SigV4 signature**: bucket creation, round trip,
      percent-encoded keys, delete, pre-signed URL, tampered-secret rejection
- [x] First-run provisioning: owner account, workspace and starter project created from the
      environment, idempotent on restart, storage retry with backoff before giving up
- [x] Browser: login → board → task detail → create task → server round trip → pages → ⌘K
- [x] Browser: phone viewport, dark mode, and rendering with the network switched off

## Known-unknowns

Things nobody has measured yet, so treat any claim about them as a guess:

- Performance with a large workspace (>10k tasks, >100 concurrent SSE clients).
- Real iOS Safari and Android Chrome behaviour — only Chromium's device emulation was used.
  IndexedDB eviction under storage pressure on iOS is the specific risk.
- Behaviour when the disk fills up mid-write.
- Real SMTP relays (Postmark, SES, Gmail) — the client is tested against a server written for the
  test, which cannot catch a provider's quirks or a deliverability problem.
- Real MinIO/AWS — the S3 client is verified by an independent signature implementation and the CI
  deploy job runs it against a real MinIO, but no one has yet run it against AWS, R2 or Ceph.
- Automatic HTTPS (the `tls` profile) needs a public domain, so it cannot be exercised in CI.
- Long-running clock skew between clients (the HLC converges after one exchange, but that path
  has not been exercised against a device with a badly wrong clock).
