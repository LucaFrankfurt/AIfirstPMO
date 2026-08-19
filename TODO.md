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
- [x] **Session management UI** — every browser signed in as you, which one you are reading it on,
      and revoke one at a time. Revoking the current one signs you out here too, which is what
      somebody means when they revoke it from this list.
- [x] **2FA (TOTP)**, for any account. Written out against RFC 6238's published vectors rather
      than against itself, so it agrees with the app on somebody's phone. A half-finished setup
      never gates the door; recovery codes are shown once and stored hashed, one use each.
- [x] **Single sign-on (OIDC).** Authorization code with PKCE, and deliberately nothing else: no
      implicit flow, no refresh tokens held here, no SAML. Anything with a discovery document works.
      Accounts made through the provider carry no password; an address is taken only when the
      provider marks it verified. `KOLIBRI_OIDC_ONLY` closes the password door server-side, not
      just in the interface. Driven in test against a provider that signs real RS256 tokens, so
      the refusals — a forged signature, `alg: none`, wrong audience, wrong issuer, an expired
      token, a mismatched nonce, a replayed state — are proven rather than assumed.
      Groups from the provider map to workspace roles: `KOLIBRI_OIDC_ROLE_MAP` reads a claim (a
      dotted path, because Keycloak buries it three levels down and Entra does not), takes the
      *highest* role of every group somebody is in — access is the union of what they have been
      given — and applies it on every sign-in. It demotes as well as promotes, because a map that
      only ever added access would be decoration; the one exception is the last owner of a
      workspace, which is not a policy so much as a locked door. `KOLIBRI_OIDC_DEFAULT_ROLE=none` is
      how "only these groups may sign in" is written. And an account made through the provider now
      joins the instance's only workspace rather than starting a private one, which was the
      behaviour that made single sign-on look configured and useless.
      **SAML and LDAP are deliberate non-goals, not a to-do.** SAML means verifying XML digital
      signatures, which means XML canonicalisation — a specification with a long history of
      signature-wrapping bugs in libraries written by people who work on nothing else. LDAP means an
      ASN.1/BER client. Both are security-critical parsers, both are far past what this project's
      zero-dependency rule can honestly carry, and a hand-rolled XML DSig verifier is exactly the
      kind of thing that looks fine until it does not. Every provider worth naming — Entra, Okta,
      Keycloak, Authentik, Google Workspace, Authelia, Zitadel — speaks OpenID Connect, and an
      LDAP directory reaches this through one of those. If your identity provider speaks SAML and
      nothing else, put a broker in front of it; that is a better answer than this project pretending
      to a competence it does not have.
- [x] **Workspace-wide audit log**, admins only, paged backwards. Private projects an admin is not
      a member of stay out of it: being an admin is not the same as being invited.

### Operations

- [x] **Verified the deployment on a real daemon.** This carried the honest caveat for a long time
      that the Dockerfile and the compose files had been written and reviewed but never executed —
      there was no Docker daemon in the environment they were authored in. The CI `deploy` job has
      now run, and passed. What it actually proves, in one pass on a real daemon:
      the image builds; MinIO and the app both come up healthy; `/api/health` reports `ready`,
      `storage: s3` and `mail: off`; the owner account provisioned from the environment can sign in
      and owns the workspace it names; a file uploaded through the API round-trips **and its bytes
      are listed in the MinIO bucket** rather than sitting on the app's disk; a test mail is refused
      with 400 while no relay is configured; a restart leaves exactly one user, so provisioning is
      idempotent; `kolibri doctor` finds nothing broken; a backup is taken, verified and *restored*
      inside the container, with a sign-in afterwards as the proof the account survived the round
      trip; the dev overlay reports `mail: test-inbox` and a message reaches Mailpit; and the lite
      variant comes up with `storage: disk`.
      What is still only a compose file is the Coolify variant, below.
- [ ] **Verify the Coolify deployment.** The one deployment claim still resting on documentation
      rather than on a run. `docker-compose.coolify.yml` is written against Coolify's
      documented behaviour (no `container_name`, `expose` instead of `ports`, `SERVICE_FQDN_*` and
      `SERVICE_PASSWORD_*` magic variables) but has never been deployed to a real Coolify instance.
      The magic-variable substitution in particular is the part most likely to need a tweak.
- [x] **Rehearsed the restore.** `kolibri backup` takes the copy through `VACUUM INTO` — the only
      way to copy a live SQLite database that is consistent by construction — and puts the uploads
      and a manifest beside it. `verify` opens the copy and asks SQLite whether it is intact before
      anything is replaced; `restore` moves the existing database aside rather than deleting it and
      drops the stale `-wal`. `test/maintenance.test.ts` backs one instance up, restores it into an
      empty one *in a separate process*, and asks that instance what it holds. The CI `deploy` job
      does the same against the real image on a real volume.
- [x] **`kolibri doctor` and the rest of the maintenance commands.** Integrity check, foreign-key
      check, search-index drift in *both* directions, free space, write-ahead log size, expired rows,
      and whether every stored file's bytes are still readable. `--fix` rebuilds the index, prunes
      and compacts, then re-checks so what it prints is the state afterwards. `--json` for
      monitoring, which exits non-zero only on a damaged database or missing bytes — a warning is a
      thing to do on a Tuesday. Also `reindex`, `vacuum`, `backup`, `verify`, `restore` and
      `files move`. See the maintenance section of [`docs/deployment.md`](docs/deployment.md).

### Correctness

- [x] **Replaced the pull-pagination heuristic.** The server returns `hasMore`, which it knows for
      certain because it asks for one row more than a page. The client no longer guesses from
      "was any page exactly full", which was right until a workspace had exactly one page of
      changes. Covered by a test that actually creates 2 025 rows.
- [x] **Guest role in the UI.** One `useCanWrite()` hook rather than `role !== 'guest'` repeated in
      fifteen components; the write affordances a guest cannot use are not shown.
- [x] **Client-side tests.** `packages/web/test` runs the *real* store, outbox and sync engine
      under Node against the *real* server, with a shim for the four browser things they touch and a
      network that can be switched off mid-test. It proves what a server test cannot: a change typed
      offline is visible immediately, survives in IndexedDB, arrives when the network returns, and
      merges per field with an edit somebody else made meanwhile. A reload is modelled honestly — a
      second copy of the sync module over the same IndexedDB — and the queued change is still there.

---

## P2 — the obvious next features

- [x] **Saved views UI.** Save the current filter set under a name, from a project or from My work,
      shared with the team by default. A dot marks a view you have changed since saving. One view can
      be pinned as what a project *opens* on — stored on the project rather than as a flag on the
      view, so two people pinning two different ones merge into one answer instead of two rows both
      claiming to be the default; a device that has chosen for itself keeps its choice, because a
      setting that overruled somebody every morning is one that fights its users. And a dozen icons,
      typed against the icon set so a shape that does not exist is a compile error rather than a row
      of three quiet dots.
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
- [x] **Inline comments.** Select a passage on a page and comment on that passage. The anchor is a
      quote with its surroundings rather than an offset, because an offset is wrong the moment
      somebody types a word above it: found again by an exact match, then by whichever copy's
      neighbours match best, and otherwise not at all — a comment silently re-attached to the wrong
      sentence is worse than one that says the sentence it was about is gone. Anchored passages are
      underlined in the page and painted onto the rendering after the fact, because a highlight is a
      view of a comment rather than part of the document.
- [x] **Page extras that make a wiki a wiki**: labels and filtering by them, watching a page,
      a version *diff*, page templates, the `access` column exposed, and export as a markdown
      bundle (the page and everything under it). PDF is deliberately not built — see below.
- [x] **Printing, which is how a PDF is made.** Deliberately the browser's own print path rather
      than a renderer on the server: a PDF engine is a large dependency, a font problem and a
      security surface, and every browser already has one that honours the reader's paper size.
      What Kolibri supplies is a document worth printing — the page and its whole tree, rendered,
      with the app's furniture gone and page breaks that do not split a heading off its paragraph.
      Shared links print the same way.
- [x] **Work item types.** Every project starts with Task, Bug and Feature and can edit the list;
      a task carries one, and views group and filter by it. Deliberately *not* type-dependent
      fields: a form that changes per type is custom fields, which is the next entry.
- [x] **Custom fields, including the type-dependent ones.** Nine kinds (text, long text, number,
      one-of, several-of, date, yes/no, link, person), edited in project settings, shown on a task,
      offered as a table column, readable and writable over MCP by name. A field can name the work
      item types it applies to, which is what OpenProject means by a type-dependent field: a Bug
      asks for steps to reproduce, a Feature does not. An answer is a row of its own with an id
      derived from the task and the field, so two people filling in two different fields merge and
      two devices answering the same one converge. `required` is a prompt rather than a gate — a
      task can arrive from a rule, the API or a phone that was offline, and a form that refuses to
      save teaches people to type a full stop. Views filter and group by one: several answers on a
      field are an OR and two fields an AND, a several-of answer counts in every group it names, and
      a field with no list of options is asked the only two questions it has — is there an answer,
      and is there not, which is how you find the bugs missing their steps to reproduce. Dropping a
      card into a column on a board grouped by a field writes the answer, adding to a several-of
      rather than replacing it for the same reason a rule appends a label.
- [x] **CSV import.** Column mapping guessed from the header names in both languages and in Jira /
      Plane / OpenProject's words, a dry run that writes nothing, and a report that names the
      spreadsheet row of everything it could not read. Semicolon files from a German Excel included.
      See [`docs/import.md`](docs/import.md).
- [x] **The parts CSV could not carry.** A `Parent`, `Blocks` or `Blocked by` column is resolved on
      a second pass, once every row exists — by key where the file has one, by title otherwise.
      Anything naming a task that is not in the file is reported rather than guessed at: a parent
      link to the wrong task is harder to notice than a missing one. Comments still need the JSON
      format, below.
- [x] **Outgoing webhooks** — the generic answer, rather than one integration per service. Signed
      with HMAC-SHA256 so a receiver can tell the call came from this instance, fire-and-forget with
      a five-second timeout, failures recorded on the row and never retried.
- [x] **Named integrations, both directions.** Outgoing: a hook can send Slack/Mattermost or
      Discord's shape instead of the signed Kolibri envelope — the transport is unchanged and only
      the body differs, which is the whole of what a named integration needs to be. Incoming: a hook
      can be given a URL to *receive* on, and a commit message naming a task gets commented on it —
      `fixes SRV-12` moves it to Done. Reads GitHub and GitLab push payloads, and anything sending
      the same three fields; a payload it does not recognise is accepted and ignored, because
      answering with an error trains people to turn the integration off.
- [x] **Analytics.** Project → Insights: open/finished counts, median cycle time, time logged,
      throughput per week, a burn-up over the active cycle, and breakdowns by kind and by person.
      Computed from the local mirror, so it works offline. See [`docs/insights.md`](docs/insights.md).
- [x] **The portfolio.** One screen for every project at once: a roadmap laying each project out
      from its start to its target date with progress inside the bar and today drawn through all of
      them, the counts added up across projects, open work per project, and a table of where
      everything stands. Computed from the local mirror like the per-project insights, so it works
      offline. A project past its target with work still open says *late* in words as well as in
      colour, on a phone too.
- [x] **Mention autocomplete in the editor.** Typing `@` offers the workspace members; arrows and
      Enter or Tab pick one.
- [x] **Scheduled digests** — off, daily or weekly, on top of the batching window. Mentions and
      assignments still arrive on their own; a digest that swallows those is one people turn off.
- [x] **Due-date reminders.** Swept hourly, once per task per due date — moving a deadline earns a
      new reminder, missing one does not earn a daily repeat of the same sentence.
- [x] **Task templates and automation rules.** Templates with a checklist that becomes sub-tasks,
      usable by hand, from the quick-add sheet and over MCP; rules that file one when a task enters
      a state or is created, with recipients as selectors rather than names.
      See [`docs/automation.md`](docs/automation.md).
- [x] **A second rule action: change the task it watched.** Deliberately narrow — the priority
      only. `state_id` is not settable, because a rule that moves a task can trigger a rule that
      moves it back, and two rules editing one row is a merge problem rather than a feature flag.
- [x] **Rule actions beyond the priority.** A rule can now add a label, assign somebody, and set a
      due date a number of days out. Two of those are not fields: adding a label is an *append*,
      because replacing the list would quietly strip what somebody had put there, and "due in three
      days" is a calculation against the day the rule ran. Still never the state, for the reason it
      never was: two rules editing one row is a merge problem rather than a feature flag.
- [x] **Scheduled triggers.** `due_in`, swept once a day by `lib/scheduler.ts`. It records the day
      it ran, so a restart does not re-fire it.
- [x] **Rules that watch a page edit or a comment.** Both fire against the task or page they hang
      off; previously only a task changing state could trigger one.
- [x] **Bulk actions in the list and table views.** Tick a row, shift-click for a range, long press
      on a touch screen; then state, labels, cycle, priority, assignee, archive or delete for all of
      them. The actions that belong to a project disappear when the selection spans two, because
      states and labels do. Written locally like every other change, so it works offline —
      `POST /tasks/bulk` stays for API and MCP callers, who have no outbox.
- [x] **Trash and archive browser, and the end of the trash.** Settings → Data lists what was
      deleted or archived, with a way back. The browser needed no new endpoint: a delete keeps the
      row and syncs it as a tombstone — that is how two devices agree it is gone — so the data was
      already on the device and simply had no screen asking for it. Admins can now end that:
      **emptying the trash** removes the rows, the uploaded bytes nothing else still points at, and
      the audit entries that quoted the deleted thing by name — a button whose promise is "gone"
      cannot leave the last copy of a title in a list an admin can read. It cannot simply drop the
      rows, because the tombstone *is* the deletion: every device holding one would keep showing the
      thing in its own trash with a button offering to put it back. So a purge leaves a marker in
      each row's place, which syncs like anything else and tells every device to forget the same
      things. `KOLIBRI_TRASH_DAYS` does it on a clock, and is **off** by default — a retention
      policy is a decision about somebody else's data, not one this project gets to make quietly.
- [x] **Avatar upload.** In the profile, downscaled in the browser like any other image.
- [x] **Precise drop position on the board.** A line shows the gap the card will land in, and it
      lands there. It used to append to the end of the target
      column. Fractional indexing already supports inserting between two neighbours — the drop
      handler just needs the index under the cursor.
- [x] **Comment reactions.** Six of them, counted, with who reacted in the tooltip.
- [x] **Gantt layout, and the scheduling behind it.** All five layouts are built. Bars are dragged
      to move and resized at the edges, `blocks` relations are drawn as arrows, and moving a task
      moves everything waiting on it — one rule, in `@kolibri/shared` so the server applies the same
      one: a task may not start before everything blocking it has finished. Nothing is ever pulled
      *earlier*; a plan that snaps backwards the moment a dependency lands early is arguing with
      whoever wrote it. Rescheduling is written as ordinary local changes, so it works offline.
      A `blocks` link can carry a **wait** in working days — "the paint has to
      dry" — and never a negative one, because a lead time is permission to start before the blocker
      finishes, which is the sentence the whole file exists to keep. A project says which weekdays it
      works on, and the scheduler counts those: a task pushed across a weekend keeps its length in
      *working* days rather than being stretched to five, and lands on a day the team actually works.
      Off days are shaded on the timeline rather than blocked — a bar dragged onto a Saturday stays
      there, because somebody who did that meant it. The calendar sits on the project rather than the
      workspace, since a support rota and an office team disagree about it inside one company, and
      the team planner looks it up per task for the same reason.
- [x] **The schedule applied where the interface is not the caller.** The Gantt has always written
      the shifted successors itself, so it works offline — which left a hole nobody could see from
      inside the app: a date set over REST, over MCP, by an import or by a rule moved one task and
      left everything waiting on it behind its blocker. The server now runs the same shared rule on
      the write path. The cascade writes as the system, so it earns no activity entry, no
      notification and no rule of its own: the schedule moving a task is not a person editing it.
- [x] **Internationalisation.** English and German, both as catalogue files — the interface, the
      notification titles and the emails, each written in the recipient's own language. Other
      locales are typed against English, so a missing key is a compile error.
      See [`docs/i18n.md`](docs/i18n.md).
- [x] **A third language: French.** The scaffolding did take one typed file and nothing else, which
      was the claim. What was left was the judgement, and it went the other way in the end: a
      catalogue nobody has read back is worse than a good one and *better than none* — provided the
      app says which it is. It does, under the language picker, in the language somebody has just
      chosen. All 1 335 keys, machine-written, and a correction is now the cheapest contribution
      this project accepts: one file, no build step, and the types refuse a missing key.
      The claim that `Intl.PluralRules` handles languages with more than `_one`/`_other` is no
      longer untested: `i18n.test.ts` drives Polish's four categories through the same two lines the
      interface uses — proved against the real ones, rather than found out from a Polish speaker.
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
- [x] **Image lightbox** for images in any rendered markdown — delegated, because the renderer
      produces plain HTML and has no components to hand a handler to.
- [x] **Per-task notification opt-in and out**, in the task menu.

---

## P3 — bigger bets, only with a reason

- [x] **Real-time collaborative page editing.** A page body is now a **text CRDT** — RGA, stored as
      runs, written from first principles like everything else hard in this project. Two people
      typing at once is a merge rather than a race: both paragraphs survive, in the same order on
      every device, whichever order the rows arrived in.
      The shape fits the sync engine rather than fighting it. This app syncs *rows*, each reaching
      every device exactly once in any order, which is an unusually good fit for a **state-based**
      CRDT where merging is a pure function of two states: the document lives in one column, the
      merge replaces last-writer-wins for that one column, and nothing else about sync changes. An
      operation per keystroke as its own row would have grown without bound and needed a compaction
      scheme nobody can make safe, because "every device has certainly seen this" is not knowable
      offline-first.
      `pages.content` stays as what the CRDT reads as, so search, export, sharing, the renderer, the
      REST API and MCP all carry on reading plain text and know nothing about it. Plain text written
      by the API *replaces* the CRDT, because somebody who sent a whole document meant it.
      Convergence is proved rather than asserted: commutativity, associativity and idempotence each
      have their own case, and three replicas gossip at random from five seeds and must read
      identically at the end.
      Still open, and stated in [`docs/sync.md`](docs/sync.md) rather than left to be discovered:
      two people typing at the *same instant at the same position* can interleave at run boundaries
      — RGA keeps each person's run together, which a position-key scheme does not, but Fugue and
      Peritext handle the last cases properly and this does not. There is no cursor presence. And
      tombstones accumulate: `kolibri doctor --fix` folds away the ones nothing points at, on
      purpose rather than on a schedule.
- [ ] **Multi-node deployment.** The sequence counter, the SSE bus and the mail worker live in the
      process. Running two replicas needs an external counter, a shared bus and a locked queue —
      this is the one scenario where Redis or Postgres genuinely earns its place.
- [x] **Bounce and complaint handling.** A 5xx from the relay is treated as final — retrying it
      five more times only tells the receiving domain that nobody here is listening — and the
      address is suppressed. Providers can report the rest: `POST /api/mail/bounces` reads Postmark's
      shape, Amazon SES-over-SNS, and an obvious generic one, behind a shared secret rather than a
      per-provider signature. Only *permanent* bounces and complaints suppress; a full mailbox is a
      bad afternoon. Suppressed addresses are listed in Settings and can be cleared, because the
      person it happened to is the one who knows it is fixed.
- [x] **Custom fields** per project — see P2 above.
- [x] **Time tracking.** Log time on a task, or run a timer — which is a row with a start and no
      minutes yet, so it survives a reload, a second device and a tunnel. One clock per person.
      Totals per task and per project, and `log_time` / `list_time` over MCP.
- [ ] **What time tracking is a prerequisite for**: hourly rates, budgets, cost and utilisation
      reports, and a timesheet view across projects and weeks. Also: `tasks.estimate` is in points,
      so "spent vs. estimated" cannot be shown until an estimate carries a unit — which is a
      decision about how a team plans, not a formatting problem.
- [x] **Gantt with real scheduling, and baselines.** See P2 above. A baseline keeps the dates as
      they stood under a name — the whole plan in one row, because it is something somebody *took*
      and must not drift as tasks are added afterwards — and the timeline draws it as a thin rule
      under each bar, so a task that has not moved shows nothing worth looking at.
- [x] **A team planner, and capacity in the units this app has.** One row per person, their dated
      work stacked so nothing hides behind anything, and a load strip counting how many tasks are
      running on each day. Dragging a bar sideways moves the dates through the same scheduler the
      timeline uses; dropping it on another row hands the task over. Load is counted in **tasks at
      once, not hours**: `tasks.estimate` is in points, so an hour figure here would be invented,
      and an invented number in a capacity report is how a team ends up planning against a
      spreadsheet nobody believes. The comfortable number is set by whoever is looking, because it
      is their judgement rather than a property of the data.
- [x] **Sub-projects and project templates.** A project can sit under another — nesting in the
      sidebar and in the portfolio, deliberately *not* a permission boundary, and the server refuses
      a loop rather than trusting the interface. And any project can be copied, which is what a
      project template is here: a project that has been run for six months describes how a team
      works better than a form somebody filled in once. Structure always comes across; members,
      rules, pages and tasks are each a choice. One transaction on the server, because half a copied
      project is worse than none.
- [x] **Status transition rules per role.** A column can name the roles allowed to move work into
      it. Enforced on the write path, so it holds for REST, for MCP and for a phone that was offline
      while the rule was written — and the interface simply does not offer a column somebody may not
      use, so nobody finds out by being refused. A rejected mutation now re-reads the row it was
      wrong about, because an optimistic change the server refused would otherwise sit on screen
      until the next full sync.
- [x] **Work-in-progress limits** per column. Shown as a fraction and marked when it is broken,
      never enforced by refusing a drop: a board that will not take a card teaches people to keep
      their work somewhere it cannot be seen.
- [x] **Recurring tasks.** Daily, weekly, fortnightly or monthly. The next one is created when the
      last is *finished*, not when a date passes: a weekly task nobody did four times is one late
      task, not four nobody will do.
- [x] **Incoming** integrations — see the named-integrations entry above.
- [x] **A plain JSON round trip.** A project exports as one readable document — structure, tasks,
      relations, comments, pages, fields and their answers, templates and rules — and imports back
      as a new project with every reference rewritten. Deliberately not the backup format: a backup
      has to be exact and copies the database, while this survives a schema that has moved on.
      People are matched by email address, the only identifier that means the same thing on two
      instances; anybody not found is named in the report and their work arrives unassigned, rather
      than being given to somebody who is not there.
- [x] **Reading the other tools' own exports.** A Jira search response, a Linear query result, a
      Plane issue list and an OpenProject collection are recognised by their *shape* rather than by
      what the browser called the download, and converted into the document above so the ordinary
      importer does the rest. What comes across is what those tools agree with Kolibri about — a
      title, a description, a state and which bucket the state is in, a priority, dates, labels, an
      assignee, a parent and comments. The team's own column names are kept, because a team that has
      spent two years arguing about what to call a column should get that column. What does not come
      across is everything each tool invented for itself, and the screen lists it *before* the
      import rather than after: sprints and workflows, Linear's cycles, OpenProject's categories,
      Plane's people (it sends ids and no addresses, so nothing can be matched and the tasks arrive
      unassigned). A converter that quietly dropped those would produce a project that looks
      imported and is wrong in a way nobody notices for a month.
      **Honestly stated, in the code and on the screen:** these were written against each tool's
      *documented* API shape and have never been run against a real export from a real instance. The
      recognisers are narrow, an unrecognised file is refused rather than half-read, and the import
      always makes a new project, so trying it costs nothing.
- [x] **Native push notifications.** Web Push, with no encryption stack: the push carries **no
      payload at all**, which the spec allows, and the service worker asks `/api/notifications/latest`
      what to say — same origin, same session. That removes several hundred lines of ECDH, HKDF and
      AES-GCM, and means nothing of anybody's sits encrypted on a push service's disk. The VAPID key
      pair is generated into the data directory on first use (or set explicitly, to survive a
      restore), a subscription that returns 404 or 410 is deleted because that is how a push service
      says "gone", and permission is asked for only when somebody presses the switch — a site that
      asks on load is a site people block, and a blocked permission cannot be asked for twice.
- [x] **Object-storage migration command.** `kolibri files move <disk|s3>` reads each blob from
      wherever its row says it is and updates the row only once the bytes have landed, so an
      interrupted move leaves an instance that still works. The old copies are left in place on
      purpose; `kolibri doctor` counts what is stranded on the backend no longer in use.
- [x] **Roadmap / portfolio view** across projects — see P2 above.
- [x] **Intake and triage — an inbox for reports from outside.** A share link that is a *form*
      rather than a document: no account, no session, no JavaScript, because somebody reporting a
      problem with your product is exactly the person whose browser might be doing something
      unusual. What it writes is an `intake` row and never a task, which is the whole defence — the
      tight bucket per address, the honeypot field and the length caps are worth having, but the
      reason spam cannot reach the board is that *nothing* reaches the board until a member accepts
      it. Accepting is a route rather than a field, because it creates a task and a task has to be
      numbered, defaulted and announced; the title is editable in the same breath, since what
      somebody outside calls a problem and what the team calls the work are rarely the same
      sentence. A declined report is kept and marked rather than deleted, so nobody triages it
      twice. Whoever leads the project is told — a queue nobody hears about is a queue nobody reads
      — and that notification lands on the report rather than near it, which took a `project_id` on
      notifications and a `?tab=` on the project route.
- [x] **A shared task view shows what the view shows.** The filter set was read with the interface's
      names (`state`, `type`, `cycle`) against the table's (`state_id`…), so only `priority` ever
      applied and a shared link quietly showed *more* tasks than the view it was made from — a leak
      by another name. Fixed, custom fields included.
- [x] **Public share links** for a page or a saved task view. Rendered by the *server* as one
      small self-contained document rather than handed to the app: somebody outside the workspace
      has no session, a link that opens as a document works in any browser, and the smaller the
      surface an anonymous request can reach the easier it is to be sure of it. The token is minted
      server-side and never taken from the caller, links can expire, and how often one was opened is
      counted — by whom deliberately is not. A page link can also invite a **note** back: a box at
      the bottom, off until somebody ticks it, whose contents land in the page's comments marked as
      coming from outside with a name that is shown as unverified because it is. Deliberately a box
      rather than a thread — a page's discussion is usually internal, and a tickbox called "allow
      comments" is nobody's idea of consent to publishing what colleagues have already said about
      the document.

---

## Verified, for contrast

So the list above is read in proportion — these are covered by automated tests
(`npm test`, 381 cases across the server and the client) or by the browser walkthrough
(`node scripts/smoke.mjs`, which runs in English, German and French):

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
- [x] Single sign-on against a provider that signs real RS256 tokens, including every refusal — a
      forged signature, `alg: none`, wrong audience, wrong issuer, expired, replayed state — and the
      directory-to-role mapping, demotion and last-owner rule
- [x] The text CRDT: commutativity, associativity and idempotence each on their own, three replicas
      gossiping at random from five seeds and having to agree, and two real browsers typing ten
      characters each into the same position at once
- [x] The dependency scheduler applied on the server, not only in the timeline: a chain, a wait on a
      link, a plan that must not snap backwards, and a circular one that has to return at all
- [x] Emptying the trash: the marker that makes every device forget the same row, the blob that
      survives because a page still shows it, and the audit entry that goes because it was the last
      copy of a deleted title
- [x] Intake from outside: the honeypot answered politely, the rate limit reached, a report that
      cannot be triaged twice, and a page-share link refusing to take one
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
- [x] Single sign-on against a provider signing real RS256 tokens: a forged signature, `alg: none`,
      the wrong audience or issuer, an expired token, a mismatched nonce, an unverified email and a
      replayed state are each refused, and `KOLIBRI_OIDC_ONLY` closes the password door server-side
- [x] The client, run for real under Node against a real server: an offline write is visible at
      once, survives in IndexedDB, arrives when the network returns, and merges per field with an
      edit another device made in the meantime — reload included
- [x] A snapshot taken with `kolibri backup`, verified, and restored into an empty instance in a
      separate process, which then reports a healthy database holding the rows that were backed up
- [x] The doctor notices a search index that has drifted in either direction, a file row whose bytes
      are gone, and rows the housekeeping sweep would have removed

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
