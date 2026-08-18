# To-do

Everything that is knowingly missing, unverified or deliberately deferred, honestly listed.
Ticked boxes are done; the rest is open. Ordered by "would I run this in production without it?".

Legend: **P1** blocks a real deployment · **P2** wanted soon · **P3** nice to have.

Where the edges are against Confluence, Plane and OpenProject — and the order I would close
them in — is in [`docs/comparison.md`](docs/comparison.md).

---

## P1 — before putting real data in it

### Security hardening

- [x] **Rate limiting** on `/api/auth/login`, `/api/auth/register` and both invite routes.
      A token bucket per IP **and** per account, in memory — the account key is the one that stops a
      botnet working through a single account from a thousand addresses. See `lib/ratelimit.ts`.
- [x] **Content-Security-Policy header.** `default-src 'self'` with no inline or `eval`'d script,
      `frame-ancestors 'none'`. Computed rather than constant: with an object store and pre-signed
      downloads the browser is redirected off-origin, so that origin is named. See `lib/csp.ts`.
- [x] **Explicit `content-type` check on JSON routes.** The three types a cross-site form can
      produce (`x-www-form-urlencoded`, `multipart/form-data`, `text/plain`) are refused with 415,
      so CSRF no longer rests on the `SameSite=Lax` default alone.
- [ ] **Session management UI** — list active sessions per device and revoke individually.
      Changing the password already invalidates all of them, which is the blunt version.
- [ ] Optional **2FA (TOTP)** for owner/admin accounts.
- [ ] **Single sign-on** (OIDC, SAML or LDAP). All three tools Kolibri is compared to have it, and
      past roughly fifty people it stops being optional. Nothing in the auth layer anticipates it
      yet, so this is a project rather than a patch.
- [ ] **Workspace-wide audit log.** Activity is recorded per task; there is no view that answers
      "what happened in this workspace last week", which is the first thing an auditor asks for.

### Operations

- [ ] **Verify the deployment on a real daemon.** The Dockerfile and both compose files were
      written and reviewed but never executed — there was no Docker daemon in the environment they
      were authored in. The `deploy` job in CI brings the whole stack up and asserts the wiring
      (provisioned owner account, upload landing in MinIO, mail refused while no relay is
      configured, the dev overlay delivering into the capture inbox, restart idempotence, plus the
      lite variant); that job has not run yet.
- [ ] **Verify the Coolify deployment.** `docker-compose.coolify.yml` is written against Coolify's
      documented behaviour (no `container_name`, `expose` instead of `ports`, `SERVICE_FQDN_*` and
      `SERVICE_PASSWORD_*` magic variables) but has never been deployed to a real Coolify instance.
      The magic-variable substitution in particular is the part most likely to need a tweak.
- [ ] **Test a restore.** The backup procedure in `docs/deployment.md` (`VACUUM INTO` + uploads
      tarball) is written from first principles, not from a rehearsed restore.
- [ ] **`kolibri doctor` / maintenance commands** — integrity check, `VACUUM`, and a search-index
      rebuild. If the FTS table ever drifts from the tables (a crash mid-transaction, a manual
      edit), there is currently no supported way to rebuild it.

### Correctness

- [x] **Replaced the pull-pagination heuristic.** The server returns `hasMore`, which it knows for
      certain because it asks for one row more than a page. The client no longer guesses from
      "was any page exactly full", which was right until a workspace had exactly one page of
      changes. Covered by a test that actually creates 2 025 rows.
- [ ] **Guest role in the UI.** Guests are correctly refused by the server, but the interface still
      shows them buttons that will fail. Hide or disable write affordances when `role === 'guest'`.
- [ ] **Client-side tests.** The store, the outbox and the merge path have no unit tests of their
      own; they are only covered indirectly through the API tests and the browser smoke run.

---

## P2 — the obvious next features

- [x] **Saved views UI.** Save the current filter set under a name, from a project or from My work,
      shared with the team by default. A dot marks a view you have changed since saving. Still open:
      pinning one as a project's default, and an icon per view (`views.icon` is stored, nothing sets
      it).
- [x] **@mentions in comments and descriptions**, with notifications. Handles resolve by first
      name, display name or email address.
- [x] **Email notifications** — batched per person, per-user preferences, signed one-click
      unsubscribe, queued with retry. Invites are delivered by mail when a relay is configured.
      See [`docs/notifications.md`](docs/notifications.md).
- [x] **Page comments.** A thread under every page, the same component the task detail uses.
      Its audience is whoever wrote the page and whoever has already spoken on it — a page has no
      assignees, and notifying everyone who *can* see it would teach people to ignore the bell.
- [x] **@mentions inside page bodies.** Only newly added handles notify, because a page autosaves
      while you type and being pinged once a second for the same name is worse than not at all.
- [ ] **Inline comments** — select a passage, comment on that passage. The same feature one step
      further, and the reason Confluence is used at all. Needs an anchor that survives an edit to
      the text it points at, which is the whole problem.
- [ ] **Page extras that make a wiki a wiki**: labels and filtering by them, watching a page,
      version *diff* (history and restore exist, "what changed" does not), page templates, and
      exposing the `access` column (`workspace`/`project`/`private`) that is already stored but
      set by no screen. Export to PDF or a markdown bundle belongs here too.
- [ ] **Work item types** (bug / feature / epic) with type-dependent fields. There is no `type` on
      a task today — only labels, which do not change the form.
- [x] **CSV import.** Column mapping guessed from the header names in both languages and in Jira /
      Plane / OpenProject's words, a dry run that writes nothing, and a report that names the
      spreadsheet row of everything it could not read. Semicolon files from a German Excel included.
      See [`docs/import.md`](docs/import.md).
- [ ] **Import beyond CSV**, and the parts CSV cannot carry: sub-task parents, relations and
      comments need a second pass once the rows exist. Jira XML/JSON if anybody asks.
- [ ] **Repository and chat integrations** — GitHub/GitLab commit linking, Slack. Outgoing webhooks
      would cover most of it generically; rules only act inwards today.
- [ ] **Analytics** — burn-down/up, throughput, cycle time. The data is all there; nothing reads it.
- [ ] **Mention autocomplete in the editor.** Typing `@` should offer the workspace members
      instead of relying on the writer knowing the handle.
- [ ] **Scheduled digests** (daily/weekly summary) on top of the existing batching window.
- [ ] **Due-date reminders.** The `due_soon` notification kind is reserved but nothing emits it.
- [x] **Task templates and automation rules.** Templates with a checklist that becomes sub-tasks,
      usable by hand, from the quick-add sheet and over MCP; rules that file one when a task enters
      a state or is created, with recipients as selectors rather than names.
      See [`docs/automation.md`](docs/automation.md).
- [ ] **More rule actions than "file a task".** Setting a field, adding a label or moving a task
      would all be useful, and all raise the same question: two rules editing one row is a merge
      problem, not a feature flag.
- [ ] **Scheduled triggers.** Nothing fires because a date passed — a rule needs something to
      happen to a task. "Three days before the due date" would need a poller like the mail worker.
- [ ] **Rules that watch anything but tasks.** A page edit or a comment could reasonably trigger
      one; only task writes are wired up.
- [x] **Bulk actions in the list and table views.** Tick a row, shift-click for a range, long press
      on a touch screen; then state, labels, cycle, priority, assignee, archive or delete for all of
      them. The actions that belong to a project disappear when the selection spans two, because
      states and labels do. Written locally like every other change, so it works offline —
      `POST /tasks/bulk` stays for API and MCP callers, who have no outbox.
- [x] **Trash and archive browser.** Settings → Data lists what was deleted or archived, with a way
      back. It needed no new endpoint: a delete keeps the row and syncs it as a tombstone — that is
      how two devices agree it is gone — so the data was already on the device and simply had no
      screen asking for it. Still open: emptying the trash on purpose, and a retention policy.
- [ ] **Avatar upload.** `users.avatar_url` is respected everywhere; nothing sets it.
- [ ] **Precise drop position on the board.** A drop currently appends to the end of the target
      column. Fractional indexing already supports inserting between two neighbours — the drop
      handler just needs the index under the cursor.
- [ ] **Comment reactions.** The `reactions` field is stored and synced; no picker, no display.
- [ ] **Gantt layout.** `LAYOUTS` declares five; four are built (list, board, table, calendar).
      Gantt is the one left, and it is not a layout so much as a scheduler — see the entry on
      dependency scheduling below. Either build it or trim the type.
- [x] **Internationalisation.** English and German, both as catalogue files — the interface, the
      notification titles and the emails, each written in the recipient's own language. Other
      locales are typed against English, so a missing key is a compile error.
      See [`docs/i18n.md`](docs/i18n.md).
- [ ] **More languages than English and German.** The scaffolding takes a third in one typed file
      and nothing else, but a catalogue nobody can read back is worse than none — this one is
      waiting on a speaker, not on code. Languages with more plural forms than `_one`/`_other` are
      supported by `Intl.PluralRules` but have never been exercised.
- [x] **Right-to-left groundwork.** The stylesheet is free of physical properties, the root carries
      `dir` from `LOCALE_DIR`, and icons that mean *forwards* mirror. Verified only by forcing
      `dir="rtl"` — with no RTL locale to ship, nobody has seen it with real text, and the
      catalogue is still the easy half.
- [x] **Translated workflow states in the seed.** A new project's states and labels are written in
      the creator's language. Ordinary editable rows afterwards.
- [x] **An explanation of the product inside the product.** Four sections under `?`: an overview
      with an animated build-up of the model, an explorer for the hierarchy with the rule behind
      each level, one narrated animation per feature, and the shortcuts.
- [x] **A first-run tour.** Runs once per device and *does* things rather than pointing at them:
      language and appearance, a real project, a copied invite link. It adapts — a member who
      cannot invite is not shown the step. Re-runnable from the guide.
- [x] **A setup checklist** on My work, ticked from the actual data rather than from what has been
      clicked, so it is honest on a second device and after a restore. Hides itself when there is
      nothing left, and is dismissible before that.
- [x] **Contextual help.** Every empty screen and the settings screens that raise a question link
      into the guide card that answers it, which scrolls to that card and marks it.
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
- [x] **Time tracking.** Log time on a task, or run a timer — which is a row with a start and no
      minutes yet, so it survives a reload, a second device and a tunnel. One clock per person.
      Totals per task and per project, and `log_time` / `list_time` over MCP.
- [ ] **What time tracking is a prerequisite for**: hourly rates, budgets, cost and utilisation
      reports, and a timesheet view across projects and weeks. Also: `tasks.estimate` is in points,
      so "spent vs. estimated" cannot be shown until an estimate carries a unit — which is a
      decision about how a team plans, not a formatting problem.
- [ ] **Gantt with real scheduling.** Relations exist but nothing reschedules — moving a
      predecessor moves nothing. Baselines (plan vs. actual) sit on top of the same work.
- [ ] **Resource and capacity planning**, a team planner.
- [ ] **Sub-projects and project templates.** Projects are flat; teams group them but do not nest
      them, and copying a whole project is not possible.
- [ ] **Status transition rules per role** — who may move a task from where to where.
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
(`npm test`, 45 cases) or by the browser walkthrough (`node scripts/smoke.mjs`):

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
- [x] Browser: the same walkthrough through the German interface (`KOLIBRI_LOCALE=de`)
- [x] Browser: the guide opens from `?`, all four sections render without a raw translation key,
      every one of the 32 animation steps is narrated, and all 18 hierarchy nodes explain themselves
- [x] Browser: the first-run tour greets a new device, offers five steps to an owner and three to a
      member, creates a real project, and stays gone after a reload
- [x] Browser: the setup checklist reads the seeded workspace correctly, a contextual hint lands on
      the card it names and scrolls to it, and `?tab=` opens the settings screen it promised
- [x] Browser: right-to-left is no worse than left-to-right — no horizontal scroll and nothing
      pushed out of frame on five screens at desktop and phone widths
- [x] A German account creating a project gets a German workflow, German labels, a German feedback
      template and a German rule — including on sign-up, where the browser now sends its language
- [x] A rule files a feedback task with its checklist, assigns the people its selectors resolve to,
      links it back, and notifies them; refuses to act on tasks a rule created; fires again on a
      second review round unless told once; drops recipients who cannot see a private project; and
      records why whenever it decides to do nothing
- [x] The guide does not animate on its own when the OS asks for reduced motion, and stays steppable
- [x] Catalogue parity: same keys both ways, no placeholder lost in translation, plural pairs
      complete, every key the interface uses exists, and no user-visible string left hard-coded
- [x] A notification written for a German recipient by an English actor arrives in German

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
